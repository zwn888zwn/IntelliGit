import * as path from "path";
import * as vscode from "vscode";
import type { GitBlameLine } from "../types";
import type { RepositoryEntry } from "./RepositoryContextService";

const BLAME_COMMAND = "intelligit.toggleSymbolBlame";
const MAX_LINES = 20000;
const MAX_CHARACTERS = 1024 * 1024;

export function summarizeAuthors(lines: GitBlameLine[], start: number, end: number) {
    const authors = new Map<string, { name: string; lines: number }>();
    for (const line of lines) {
        if (line.line < start || line.line > end || line.isUncommitted) continue;
        const key = line.authorEmail?.toLowerCase() || line.author;
        const author = authors.get(key) ?? { name: line.author, lines: 0 };
        author.lines++;
        authors.set(key, author);
    }
    return [...authors.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
}

class SymbolInsightLens extends vscode.CodeLens {
    constructor(
        readonly document: vscode.TextDocument,
        readonly version: number,
        readonly symbolRange: vscode.Range,
        readonly anchor: vscode.Position,
        readonly metric: "references" | "authors",
    ) {
        super(new vscode.Range(anchor.line, 0, anchor.line, 0));
    }
}

export class SymbolInsightsProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private readonly cache = new Map<string, {
        version: number; root: string; abort: AbortController; promise: Promise<GitBlameLine[]>;
    }>();
    private readonly references = new Map<string, { version: number; values: Map<string, Promise<vscode.Location[] | undefined>> }>();
    private activeReferenceRequests = 0;
    private readonly referenceQueue: Array<() => void> = [];
    private readonly symbolRetries = new Map<string, { version: number; attempts: number }>();
    private generation = 0;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly repositoryForUri: (uri: vscode.Uri) => RepositoryEntry | null,
        toggleBlame: (document: vscode.TextDocument) => Promise<void>,
    ) {
        this.subscriptions = [
            vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
            vscode.commands.registerCommand(BLAME_COMMAND, async (uri: vscode.Uri, version: number) => {
                const document = await vscode.workspace.openTextDocument(uri);
                if (document.version !== version) {
                    this.invalidate();
                    return;
                }
                await toggleBlame(document);
            }),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length) this.invalidate(event.document.uri);
            }),
            vscode.workspace.onDidSaveTextDocument((document) => this.invalidate(document.uri)),
            vscode.workspace.onDidCloseTextDocument((document) => this.drop(document.uri.toString())),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("intelligit.symbolInsights")) this.invalidate();
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => {
                const visible = new Set(vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString()));
                for (const key of this.cache.keys()) if (!visible.has(key)) this.drop(key);
                this.scheduleRefresh();
            }),
            // Language servers may publish symbols only after their initial project load.
            vscode.languages.onDidChangeDiagnostics(() => {
                this.references.clear();
                this.scheduleRefresh();
            }),
        ];
    }

    private enabled(document: vscode.TextDocument): boolean {
        return !this.disposed && !document.isClosed && document.uri.scheme === "file" &&
            document.lineCount <= MAX_LINES &&
            document.offsetAt(document.lineAt(document.lineCount - 1).range.end) <= MAX_CHARACTERS &&
            vscode.workspace.getConfiguration("intelligit", document.uri).get("symbolInsights.enabled", true);
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested || !this.enabled(document)) return [];
        const repository = this.repositoryForUri(document.uri);
        if (!repository) return [];
        const version = document.version;
        const stale = () => token.isCancellationRequested || !this.enabled(document) || document.version !== version;
        try {
            const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
                "vscode.executeDocumentSymbolProvider", document.uri,
            );
            if (stale()) return [];
            if (!symbols?.length) {
                // gopls can register after our provider; an empty diagnostics list need not fire an event.
                const key = document.uri.toString();
                const previous = this.symbolRetries.get(key);
                const attempts = previous?.version === version ? previous.attempts + 1 : 1;
                if (this.symbolRetries.size >= 8 && !previous) this.symbolRetries.delete(this.symbolRetries.keys().next().value!);
                this.symbolRetries.set(key, { version, attempts });
                if (attempts <= 10) this.scheduleRefresh();
                return [];
            }
            this.symbolRetries.delete(document.uri.toString());
            const kinds = new Set([
                vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor,
                vscode.SymbolKind.Class, vscode.SymbolKind.Struct, vscode.SymbolKind.Interface,
                vscode.SymbolKind.Enum, vscode.SymbolKind.Constant, vscode.SymbolKind.Variable,
            ]);
            const targets: { range: vscode.Range; anchor: vscode.Position; references: boolean }[] = [];
            const seen = new Set<number>();
            const visit = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, inFunction = false, parentKind?: vscode.SymbolKind) => {
                for (const symbol of items) {
                    const range = "range" in symbol ? symbol.range : symbol.location.range;
                    const anchor = "selectionRange" in symbol ? symbol.selectionRange.start : range.start;
                    const sameFile = "range" in symbol || symbol.location.uri.toString() === document.uri.toString();
                    const go = document.languageId === "go";
                    const isFunction = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor].includes(symbol.kind);
                    const entryPoint = go && symbol.kind === vscode.SymbolKind.Function && (
                        ["main", "init"].includes(symbol.name) ||
                        (document.uri.fsPath.endsWith("_test.go") && /^(?:(?:Test|Benchmark|Fuzz)(?:$|[^a-z])|Example)/.test(symbol.name))
                    );
                    const eligible = !inFunction && (!go || parentKind !== vscode.SymbolKind.Interface);
                    if (sameFile && eligible && kinds.has(symbol.kind)) {
                        if (seen.has(anchor.line)) {
                            const existing = targets.find(target => target.anchor.line === anchor.line);
                            if (existing && existing.anchor.character !== anchor.character) existing.references = false;
                            continue;
                        }
                        seen.add(anchor.line);
                        targets.push({ range, anchor, references: !entryPoint });
                    }
                    if ("children" in symbol) visit(symbol.children, inFunction || isFunction, symbol.kind);
                }
            };
            visit(symbols ?? []);
            const lenses: vscode.CodeLens[] = [];
            for (const target of targets) {
                if (target.references) lenses.push(new SymbolInsightLens(document, version,
                    target.range, target.anchor, "references"));
                lenses.push(new SymbolInsightLens(document, version,
                    target.range, target.anchor, "authors"));
            }
            return stale() ? [] : lenses;
        } catch { return []; }
    }

    async resolveCodeLens(lens: vscode.CodeLens, token: vscode.CancellationToken, attempt = 0): Promise<vscode.CodeLens> {
        if (!(lens instanceof SymbolInsightLens)) return lens;
        const { document, version, symbolRange, anchor } = lens;
        const generation = this.generation;
        const stale = () => token.isCancellationRequested || !this.enabled(document) ||
            document.version !== version;
        if (stale()) return lens;
        if (lens.metric === "references") {
            const references = await this.loadReferences(document, anchor);
            if (stale()) return lens;
            if (generation !== this.generation) return attempt < 1
                ? this.resolveCodeLens(lens, token, attempt + 1) : lens;
            lens.command = references ? {
                title: `${references.length} ${references.length === 1 ? "usage" : "usages"}`,
                tooltip: "单击查看引用",
                command: "editor.action.peekLocations",
                arguments: [document.uri, anchor, references, "peek"],
            } : { title: "", command: "" };
        } else {
            const repository = this.repositoryForUri(document.uri);
            if (!repository) return lens;
            const lines = await this.loadBlame(document, repository);
            if (stale()) return lens;
            if (generation !== this.generation) return attempt < 1
                ? this.resolveCodeLens(lens, token, attempt + 1) : lens;
            const end = symbolRange.end.line > symbolRange.start.line && symbolRange.end.character === 0
                ? symbolRange.end.line - 1 : symbolRange.end.line;
            const authors = summarizeAuthors(lines, symbolRange.start.line, end);
            if (!authors.length) {
                lens.command = { title: "", command: "" };
            } else {
                const name = authors[0].name.replace(/\$\(/g, "＄(").replace(/[\r\n\t]/g, " ");
                lens.command = {
                    title: `$(intelligit-author) ${name}${authors.length > 1 ? ` +${authors.length - 1}` : ""}`,
                    tooltip: `${authors.map(author => `${author.name} · ${author.lines} 行`).join("\n")}\n按当前代码的 Git blame 统计，未提交行不计入。单击展开 / 收起当前文件左侧的 Git blame。`,
                    command: BLAME_COMMAND,
                    arguments: [document.uri, version],
                };
            }
        }
        return lens;
    }

    private loadBlame(document: vscode.TextDocument, repository: RepositoryEntry): Promise<GitBlameLine[]> {
        const key = document.uri.toString();
        let entry = this.cache.get(key);
        if (!entry || entry.version !== document.version || entry.root !== repository.root) {
            this.cache.get(key)?.abort.abort();
            this.cache.delete(key);
            if (this.cache.size >= 8) this.drop(this.cache.keys().next().value!);
            const abort = new AbortController();
            const relative = path.relative(repository.root, document.uri.fsPath).split(path.sep).join("/");
            entry = {
                version: document.version, root: repository.root, abort,
                promise: repository.gitOps.getBlame(relative, { contents: document.getText(), signal: abort.signal }).catch(() => []),
            };
            this.cache.set(key, entry);
        }
        return entry.promise;
    }

    private loadReferences(document: vscode.TextDocument, anchor: vscode.Position): Promise<vscode.Location[] | undefined> {
        const key = document.uri.toString();
        let entry = this.references.get(key);
        if (!entry || entry.version !== document.version) {
            entry = { version: document.version, values: new Map() };
            this.references.set(key, entry);
        }
        const position = `${anchor.line}:${anchor.character}`;
        let result = entry.values.get(position);
        if (!result) {
            result = this.queryReferences(document, anchor).then(locations => {
                if (!locations) return undefined;
                const seen = new Set<string>();
                return locations.filter(location => {
                    if (location.uri.toString() === key && location.range.contains(anchor)) return false;
                    const id = `${location.uri.toString()}:${location.range.start.line}:${location.range.start.character}:${location.range.end.line}:${location.range.end.character}`;
                    if (seen.has(id)) return false;
                    seen.add(id); return true;
                });
            }, () => undefined);
            entry.values.set(position, result);
        }
        return result;
    }

    private async queryReferences(document: vscode.TextDocument, anchor: vscode.Position): Promise<vscode.Location[] | undefined> {
        const version = document.version;
        const generation = this.generation;
        if (this.activeReferenceRequests >= 4) await new Promise<void>(resolve => this.referenceQueue.push(resolve));
        else this.activeReferenceRequests++;
        try {
            if (this.disposed || document.isClosed || document.version !== version || this.generation !== generation) return undefined;
            return await vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, anchor);
        } finally {
            const next = this.referenceQueue.shift();
            if (next) next();
            else this.activeReferenceRequests--;
        }
    }

    invalidate(uri?: vscode.Uri): void {
        if (uri) this.drop(uri.toString());
        else {
            this.generation++;
            this.references.clear();
            for (const key of this.cache.keys()) this.drop(key);
        }
        this.scheduleRefresh();
    }

    private drop(key: string): void {
        this.cache.get(key)?.abort.abort();
        this.cache.delete(key);
        this.references.delete(key);
        this.symbolRetries.delete(key);
    }

    private scheduleRefresh(): void {
        if (this.disposed) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.changed.fire(), 500);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        for (const key of this.cache.keys()) this.drop(key);
        for (const subscription of this.subscriptions) subscription.dispose();
        this.changed.dispose();
    }
}
