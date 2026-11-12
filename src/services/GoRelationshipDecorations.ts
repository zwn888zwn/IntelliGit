import * as vscode from "vscode";
import { Declaration, declarationId, GoRelationshipQuery, Relation, RelationKind } from "./go/relationships";

const labels: Record<RelationKind, { title: string; icon: string; detail: string }> = {
    "I↑": { title: "接口", icon: "intelligit-implementing", detail: "实现的接口 / 接口方法" },
    "I↓": { title: "实现", icon: "intelligit-implemented", detail: "实际实现声明，已合并共享方法" },
    "O↑": { title: "嵌入方法", icon: "intelligit-overriding", detail: "被当前方法遮蔽的嵌入类型方法（Go 组合，不是类继承）" },
    "O↓": { title: "覆盖方法", icon: "intelligit-overridden", detail: "外层类型声明的同名方法" },
    recursive: { title: "递归调用", icon: "intelligit-recursive", detail: "当前函数体内对自身的直接调用" },
};

export class GoRelationshipDecorations implements vscode.CodeLensProvider, vscode.InlayHintsProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;
    readonly onDidChangeInlayHints = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private readonly answers = new Map<string, { declaration: Declaration; relations: Relation[] }>();
    private readonly pending = new Map<string, Promise<Relation[]>>();
    private generation = 0;
    private disposed = false;
    private retry = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private query = this.newQuery();

    constructor(registerProvider = true) {
        this.subscriptions = [
            vscode.languages.registerInlayHintsProvider({ language: "go", scheme: "file" }, this),
            ...(registerProvider ? [vscode.languages.registerCodeLensProvider({ language: "go", scheme: "file" }, this)] : []),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refresh(true)),
            vscode.window.onDidChangeTextEditorVisibleRanges(() => this.refresh(false)),
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document.languageId === "go" && event.contentChanges.length) this.refresh(true);
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.languageId === "go") this.refresh(true);
            }),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration("intelligit.goRelationships") || event.affectsConfiguration("editor.inlayHints.enabled")) this.refresh(true);
            }),
            vscode.languages.onDidChangeDiagnostics(event => {
                if (event.uris.some(uri => uri.path.endsWith(".go"))) this.refresh(true, 1000);
            }),
        ];
    }

    private newQuery(): GoRelationshipQuery {
        const generation = this.generation;
        return new GoRelationshipQuery(() => this.disposed || generation !== this.generation);
    }

    private enabled(document: vscode.TextDocument): boolean {
        return !this.disposed && !document.isClosed && document.languageId === "go" && document.uri.scheme === "file" &&
            vscode.workspace.getConfiguration("intelligit", document.uri).get<boolean>("goRelationships.enabled", true);
    }

    private refresh(invalidate: boolean, delay = 350): void {
        if (this.disposed) return;
        if (invalidate) {
            this.generation++;
            this.query = this.newQuery();
            this.answers.clear(); this.pending.clear();
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (!this.disposed) this.changed.fire(); }, delay);
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (!this.enabled(document)) return [];
        const generation = this.generation;
        const version = document.version;
        const stale = () => !this.enabled(document) || token.isCancellationRequested ||
            generation !== this.generation || version !== document.version;
        try {
            const declarations = await this.query.declarations(document.uri);
            if (stale()) return [];
            if (!declarations.length) {
                if (this.retry++ < 10) this.refresh(true, 1000);
                return [];
            }
            const editors = vscode.window.visibleTextEditors.filter(editor => editor.document === document);
            const visible = declarations.filter(item => editors.some(editor => editor.visibleRanges.some(range =>
                item.symbol.selectionRange.start.line >= range.start.line - 5 && item.symbol.selectionRange.start.line <= range.end.line + 5,
            ))).slice(0, 64);
            // Only visible declarations are queried. Off-screen known lenses stay cached.
            for (let offset = 0; offset < visible.length; offset += 4) {
                if (stale()) return [];
                await Promise.all(visible.slice(offset, offset + 4).map(item => this.load(item)));
            }
            if (stale()) return [];
            const lenses: vscode.CodeLens[] = [];
            for (const { declaration, relations } of this.answers.values()) {
                if (declaration.document !== document) continue;
                // The clickable count is the only action needed for a lone I↓ relation.
                // Retain the icon if native inlay hints are disabled or conditionally hidden.
                const countVisible = vscode.workspace.getConfiguration("editor", document.uri).get("inlayHints.enabled", "on") === "on";
                if (declaration.inInterface && relations.length === 1 && relations[0].kind === "I↓" && countVisible) continue;
                for (const relation of relations) {
                    const label = labels[relation.kind];
                    lenses.push(new vscode.CodeLens(new vscode.Range(declaration.symbol.selectionRange.start.line, 0, declaration.symbol.selectionRange.start.line, 0), {
                        title: `$(${label.icon})`,
                        tooltip: `${label.title}：${relation.incomplete ? "至少 " : ""}${relation.targets.length} 处\n${label.detail}\n单击查看${relation.incomplete ? "（关系较多，已达查询上限，仅列出已确认的目标）" : ""}`,
                        command: "editor.action.peekLocations",
                        arguments: [document.uri, declaration.symbol.selectionRange.start, relation.targets, "peek"],
                    }));
                }
            }
            return lenses;
        } catch { return []; }
    }

    async provideInlayHints(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.InlayHint[]> {
        if (!this.enabled(document) || token.isCancellationRequested) return [];
        const version = document.version;
        const generation = this.generation;
        await this.provideCodeLenses(document, token);
        if (!this.enabled(document) || token.isCancellationRequested || document.version !== version || generation !== this.generation) return [];
        const hints: vscode.InlayHint[] = [];
        for (const { declaration, relations } of this.answers.values()) {
            if (declaration.document !== document || !declaration.inInterface) continue;
            const implementation = relations.find(relation => relation.kind === "I↓");
            if (!implementation?.targets.length) continue;
            const position = document.lineAt(declaration.symbol.selectionRange.start.line).range.end;
            if (!range.contains(position)) continue;
            const count = implementation.targets.length;
            const label = new vscode.InlayHintLabelPart(`${count} ${count === 1 ? "implementation" : "implementations"}`);
            label.tooltip = `${process.platform === "darwin" ? "⌘" : "Ctrl"}+单击查看实现（共享方法已合并）`;
            label.command = {
                title: "查看实现",
                command: "editor.action.peekLocations",
                arguments: [document.uri, declaration.symbol.selectionRange.start, implementation.targets, "peek"],
            };
            const hint = new vscode.InlayHint(position, [label]);
            hint.paddingLeft = true;
            hints.push(hint);
        }
        return hints;
    }

    private load(declaration: Declaration): Promise<Relation[]> {
        const key = declarationId(declaration);
        const cached = this.answers.get(key);
        if (cached) return Promise.resolve(cached.relations);
        let promise = this.pending.get(key);
        if (!promise) {
            const generation = this.generation;
            promise = this.query.relations(declaration).then(relations => {
                if (!this.disposed && this.generation === generation) this.answers.set(key, { declaration, relations });
                return relations;
            }).catch(() => []).finally(() => {
                if (this.pending.get(key) === promise) this.pending.delete(key);
            });
            this.pending.set(key, promise);
        }
        return promise;
    }

    dispose(): void {
        this.disposed = true; this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.answers.clear(); this.pending.clear();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.changed.dispose();
    }
}
