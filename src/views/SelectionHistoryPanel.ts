import * as vscode from "vscode";
import * as path from "path";
import { readSelectionHistory, type SelectionHistoryEntry, type SelectionHistorySnapshot } from "../git/selectionHistory";
import { createSelectionHistoryDiffUris } from "../services/diffService";
import { showComparisonInOverlay, type ComparisonOverlay } from "../services/DiffOverlayController";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";

export class SelectionHistoryPanel implements vscode.Disposable {
    private panel!: vscode.WebviewPanel;
    private disposed = false;
    private entries: SelectionHistoryEntry[] = [];
    private selected: string | undefined;
    private hasMore = false;
    private loading = false;
    private error: string | undefined;
    private limit = 100;
    private request = 0;
    private readonly overlay: Promise<ComparisonOverlay | undefined>;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly root: string,
        private readonly snapshot: SelectionHistorySnapshot,
        private readonly sourceLine: number,
    ) {
        this.createPanel(false);
        this.overlay = showComparisonInOverlay(this.panel, () => this.createPanel(true));
        void this.load();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        ++this.request;
        this.panel.dispose();
    }

    private createPanel(preserveFocus: boolean): vscode.WebviewPanel {
        const previous = this.panel;
        const panel = vscode.window.createWebviewPanel("intelligit.selectionHistory",
            `代码历史 · ${path.basename(this.snapshot.filePath)}`,
            { viewColumn: vscode.ViewColumn.One, preserveFocus },
            { enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")] });
        this.panel = panel;
        panel.webview.onDidReceiveMessage((message: { type?: string; hash?: string }) => {
            if (this.panel !== panel || this.disposed) return;
            if (message.type === "ready") this.update();
            if (message.type === "more" && this.hasMore && !this.loading) { this.limit += 100; void this.load(); }
            if (message.type === "select" && typeof message.hash === "string") void this.select(message.hash);
        });
        panel.onDidDispose(() => { if (this.panel === panel) this.dispose(); });
        panel.webview.html = buildWebviewShellHtml({ extensionUri: this.extensionUri,
            webview: panel.webview, scriptFile: "webview-selectionhistory.js", title: "代码历史" });
        previous?.dispose();
        return panel;
    }

    private update(): void {
        if (this.disposed) return;
        void this.panel.webview.postMessage({ type: "update", filePath: this.snapshot.filePath,
            range: this.snapshot.range, head: this.snapshot.head, mapped: this.snapshot.mapped,
            entries: this.entries.map(({ hash, author, date, subject }) => ({ hash, author, date, subject })),
            selected: this.selected, hasMore: this.hasMore, loading: this.loading, error: this.error });
    }

    private async load(): Promise<void> {
        this.loading = true;
        this.error = undefined;
        this.update();
        try {
            const result = await readSelectionHistory(this.root, this.snapshot, this.limit);
            if (this.disposed) return;
            this.entries = result.entries;
            this.hasMore = result.hasMore;
            if (!this.selected && this.entries[0]) await this.select(this.entries[0].hash);
        } catch (error) {
            this.error = getErrorMessage(error);
        } finally {
            this.loading = false;
            this.update();
        }
    }

    private async select(hash: string): Promise<void> {
        const entry = this.entries.find((item) => item.hash === hash);
        if (!entry) return;
        const request = ++this.request;
        try {
            const overlay = await this.overlay;
            if (this.disposed || request !== this.request) return;
            const { original, modified } = await createSelectionHistoryDiffUris(this.snapshot.filePath,
                path.join(this.root, this.snapshot.filePath), this.sourceLine, hash, entry.before, entry.after);
            if (this.disposed || request !== this.request) return;
            const title = `${path.basename(this.snapshot.filePath)} · ${hash.slice(0, 8)} · 选中片段（历史行 ${entry.beforeLine || "新增"} → ${entry.afterLine || "删除"}）`;
            if (overlay) await overlay.openDiff(original, modified, title);
            else await vscode.commands.executeCommand("vscode.diff", original, modified, title,
                { viewColumn: (this.panel.viewColumn ?? 1) + 1, preview: true });
            this.selected = hash;
            this.error = undefined;
        } catch (error) {
            this.error = getErrorMessage(error);
        }
        this.update();
    }
}
