import * as vscode from "vscode";

// Native inline links show implementation counts without adding rows above methods.
export class GoImplementationHints implements vscode.InlayHintsProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this.changed.event;
    private readonly subscriptions: vscode.Disposable[];
    private readonly results = new Map<string, { version: number; hints: vscode.InlayHint[]; signature: string }>();
    private readonly pending = new Map<string, {
        version: number;
        revision: number;
        promise: Promise<vscode.InlayHint[] | undefined>;
    }>();
    private revision = 0;
    private disposed = false;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        this.subscriptions = [
            vscode.languages.registerInlayHintsProvider({ language: "go", scheme: "file" }, this),
            vscode.window.onDidChangeVisibleTextEditors(() => this.invalidate()),
            vscode.workspace.onDidChangeTextDocument((event) => {
                if (event.document.languageId === "go" && event.contentChanges.length) this.invalidate(true);
            }),
            vscode.workspace.onDidSaveTextDocument((document) => {
                if (document.languageId === "go") this.invalidate();
            }),
            vscode.workspace.onDidCloseTextDocument((document) => {
                this.results.delete(document.uri.toString());
                this.pending.delete(document.uri.toString());
            }),
            // Includes gopls finishing package loading and changes in other Go files.
            vscode.languages.onDidChangeDiagnostics((event) => {
                if (event.uris.some((uri) => uri.scheme === "file" && uri.path.endsWith(".go"))) this.invalidate();
            }),
        ];
    }

    private invalidate(sourceChanged = false): void {
        if (this.disposed) return;
        if (sourceChanged) this.revision++;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        if (!vscode.window.visibleTextEditors.some((editor) => editor.document.languageId === "go")) return;
        this.refreshTimer = setTimeout(async () => {
            const documents = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document));
            const updates = await Promise.all([...documents].filter((document) =>
                document.languageId === "go" && document.uri.scheme === "file",
            ).map(async (document) => {
                const previous = this.results.get(document.uri.toString())?.hints;
                const hints = await this.loadInlayHints(document);
                return hints !== undefined && hints !== previous;
            }));
            if (!this.disposed && updates.some(Boolean)) this.changed.fire();
        }, 300);
    }

    async provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlayHint[]> {
        if (this.disposed || token.isCancellationRequested || document.isClosed ||
            document.languageId !== "go" || document.uri.scheme !== "file") return [];
        const cached = this.results.get(document.uri.toString());
        const hints = cached?.version === document.version ? cached.hints : await this.loadInlayHints(document);
        return token.isCancellationRequested ? [] : (hints ?? []).filter((hint) => range.contains(hint.position));
    }

    private loadInlayHints(document: vscode.TextDocument): Promise<vscode.InlayHint[] | undefined> {
        const key = document.uri.toString();
        const revision = this.revision;
        const version = document.version;
        const running = this.pending.get(key);
        if (running?.version === version && running.revision === revision) return running.promise;
        const promise = this.queryInlayHints(document, revision).then((hints) => {
            if (this.disposed || document.isClosed || document.version !== version) return undefined;
            const cached = this.results.get(key);
            // Keep the last valid display while the language server is unavailable.
            if (!hints) return cached?.version === version ? cached.hints : undefined;
            const signature = JSON.stringify(hints);
            if (cached?.version === version && cached.signature === signature) return cached.hints;
            this.results.set(key, { version, hints, signature });
            return hints;
        }).finally(() => {
            if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
        });
        this.pending.set(key, { version, revision, promise });
        return promise;
    }

    private async queryInlayHints(
        document: vscode.TextDocument,
        revision: number,
    ): Promise<vscode.InlayHint[] | undefined> {
        const version = document.version;
        const stale = () => this.disposed || document.isClosed ||
            document.version !== version || this.revision !== revision;
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider", document.uri,
            );
            if (stale() || !symbols) return undefined;
            const methods: vscode.DocumentSymbol[] = [];
            const collect = (items: vscode.DocumentSymbol[], inInterface = false) => {
                for (const symbol of items) {
                    if (inInterface && symbol.kind === vscode.SymbolKind.Method && symbol.selectionRange) {
                        methods.push(symbol);
                    }
                    collect(symbol.children ?? [], symbol.kind === vscode.SymbolKind.Interface);
                }
            };
            collect(symbols ?? []);
            const hints: vscode.InlayHint[] = [];
            // Bound requests so a large interface does not flood the language server.
            for (let offset = 0; offset < methods.length; offset += 4) {
                if (stale()) return undefined;
                const batch = await Promise.all(methods.slice(offset, offset + 4).map(async (method) => {
                    const position = method.selectionRange.start;
                    const targets = await vscode.commands.executeCommand<
                        (vscode.Location | vscode.LocationLink)[]
                    >("vscode.executeImplementationProvider", document.uri, position);
                    if (!targets) throw new Error("Implementation provider is unavailable");
                    const locations: vscode.Location[] = [];
                    const seen = new Set<string>();
                    for (const target of targets ?? []) {
                        const location = "targetUri" in target
                            ? new vscode.Location(target.targetUri, target.targetSelectionRange ?? target.targetRange)
                            : target;
                        const { start, end } = location.range;
                        const key = `${location.uri.toString()}:${start.line}:${start.character}:${end.line}:${end.character}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            locations.push(location);
                        }
                    }
                    if (!locations.length) return undefined;
                    const label = new vscode.InlayHintLabelPart(`${locations.length} 个实现`);
                    label.tooltip = "转到实现（macOS 默认 ⌘+单击，Windows/Linux 默认 Ctrl+单击）";
                    label.command = {
                        title: "转到实现",
                        command: "editor.action.peekLocations",
                        arguments: [document.uri, position, locations, "peek"],
                    };
                    const hint = new vscode.InlayHint(document.lineAt(method.range.end.line).range.end, [label]);
                    hint.paddingLeft = true;
                    return hint;
                }));
                for (const hint of batch) if (hint) hints.push(hint);
            }
            if (stale()) return undefined;
            return hints;
        } catch {
            return undefined;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.results.clear();
        this.pending.clear();
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        for (const subscription of this.subscriptions) subscription.dispose();
        this.changed.dispose();
    }
}
