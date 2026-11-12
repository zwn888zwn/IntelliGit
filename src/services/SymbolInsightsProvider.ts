import * as path from "path";
import * as vscode from "vscode";
import type { GitBlameLine } from "../types";
import type { RepositoryEntry } from "./RepositoryContextService";

const HISTORY_COMMAND = "intelligit.showAuthorCodeHistory";
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

export class SymbolInsightsProvider implements vscode.InlayHintsProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private readonly cache = new Map<string, {
        version: number; root: string; abort: AbortController; promise: Promise<GitBlameLine[]>;
    }>();
    private readonly references = new Map<string, { version: number; values: Map<string, Promise<vscode.Location[] | undefined>> }>();
    private generation = 0;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        private readonly repositoryForUri: (uri: vscode.Uri) => RepositoryEntry | null,
        showHistory: (document: vscode.TextDocument, range: vscode.Range) => Promise<void>,
    ) {
        this.subscriptions = [
            vscode.languages.registerInlayHintsProvider({ scheme: "file" }, this),
            vscode.commands.registerCommand(HISTORY_COMMAND, async (uri: vscode.Uri, range: vscode.Range, version: number) => {
                const document = await vscode.workspace.openTextDocument(uri);
                if (document.version !== version) {
                    this.invalidate();
                    return;
                }
                await showHistory(document, range);
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

    async provideInlayHints(document: vscode.TextDocument, visibleRange: vscode.Range, token: vscode.CancellationToken): Promise<vscode.InlayHint[]> {
        if (token.isCancellationRequested || !this.enabled(document)) return [];
        const repository = this.repositoryForUri(document.uri);
        if (!repository) return [];
        const version = document.version;
        const generation = this.generation;
        const stale = () => token.isCancellationRequested || !this.enabled(document) || document.version !== version || generation !== this.generation;
        try {
            const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
                "vscode.executeDocumentSymbolProvider", document.uri,
            );
            if (stale()) return [];
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
                    if (sameFile && eligible && kinds.has(symbol.kind) && anchor.line >= visibleRange.start.line &&
                        anchor.line <= visibleRange.end.line) {
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
            if (!targets.length) return [];
            const blame = this.loadBlame(document, repository);
            const hints: vscode.InlayHint[] = [];
            // Only visible declarations, four reference requests at a time.
            for (let offset = 0; offset < targets.length; offset += 4) {
                if (stale()) return [];
                const batch = await Promise.all(targets.slice(offset, offset + 4).map(async ({range, anchor, references: showReferences}) => {
                    const [lines, references] = await Promise.all([blame, showReferences ? this.loadReferences(document, anchor) : undefined]);
                    if (stale()) return;
                    const parts: vscode.InlayHintLabelPart[] = [];
                    if (references) {
                        const part = new vscode.InlayHintLabelPart(`${references.length} ${references.length === 1 ? "usage" : "usages"}`);
                        part.tooltip = "查看引用（⌘/Ctrl + 单击）";
                        part.command = { title: "查看引用", command: "editor.action.peekLocations",
                            arguments: [document.uri, anchor, references, "peek"] };
                        parts.push(part);
                    }
                    const end = range.end.line > range.start.line && range.end.character === 0 ? range.end.line - 1 : range.end.line;
                    const authors = summarizeAuthors(lines, range.start.line, end);
                    if (authors.length) {
                        if (parts.length) parts.push(new vscode.InlayHintLabelPart(" · "));
                        const name = authors[0].name.replace(/[\r\n\t]/g, " ");
                        const part = new vscode.InlayHintLabelPart(`${name}${authors.length > 1 ? ` +${authors.length - 1}` : ""}`);
                        part.tooltip = `${authors.map(author => `${author.name} · ${author.lines} 行`).join("\n")}\n按当前代码的 Git blame 统计，未提交行不计入。⌘/Ctrl + 单击查看代码历史。`;
                        part.command = { title: "查看代码历史", command: HISTORY_COMMAND, arguments: [document.uri, range, version] };
                        parts.push(part);
                    }
                    if (!parts.length) return;
                    const hint = new vscode.InlayHint(document.lineAt(anchor.line).range.end, parts);
                    hint.paddingLeft = true;
                    return hint;
                }));
                for (const hint of batch) if (hint) hints.push(hint);
            }
            return stale() ? [] : hints;
        } catch { return []; }
    }

    private loadBlame(document: vscode.TextDocument, repository: RepositoryEntry): Promise<GitBlameLine[]> {
        const key = document.uri.toString();
        let entry = this.cache.get(key);
        if (!entry || entry.version !== document.version || entry.root !== repository.root) {
            this.drop(key);
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
            result = Promise.resolve(vscode.commands.executeCommand<vscode.Location[]>(
                "vscode.executeReferenceProvider", document.uri, anchor,
            )).then(locations => {
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
