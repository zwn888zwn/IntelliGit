import * as vscode from "vscode";
import { resolveBranchChanges } from "../services/branchComparison";
import type { ProjectComparisonFile, ProjectComparisonTarget } from "../types";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import {
    getDiffRefFromUri,
    getDiffOriginalFilePathFromUri,
    getProjectComparisonIdFromUri,
    getRepoRelativeFilePathFromUri,
    openBranchComparisonFileDiff,
} from "../services/diffService";
import { openBranchComparisonChanges } from "../services/multiDiffService";
import { getErrorMessage } from "../utils/errors";
import { buildWebviewShellHtml } from "./webviewHtml";
import { IconThemeService } from "./shared";
import type {
    ProjectComparisonInbound,
    ProjectComparisonOutbound,
    ProjectComparisonViewState,
} from "../webviews/react/project-comparison/types";
import type { DiffNavigationState } from "./CommitPanelViewProvider";
import { showComparisonInOverlay, type ComparisonOverlay } from "../services/DiffOverlayController";

export class ProjectBranchComparisonPanel implements vscode.Disposable {
    static readonly viewType = "intelligit.projectBranchComparison";
    private static readonly panels: ProjectBranchComparisonPanel[] = [];
    private static nextPanelId = 1;
    private static activePanel: ProjectBranchComparisonPanel | null = null;

    private panel!: vscode.WebviewPanel;
    private readonly iconTheme: IconThemeService;
    private readonly comparisonId = String(ProjectBranchComparisonPanel.nextPanelId++);
    private files: ProjectComparisonFile[] = [];
    private activeFile: ProjectComparisonFile | null = null;
    private lastError: string | null = null;
    private editorLayoutAdjusted = false;
    private disposed = false;
    private readonly overlayReady: Promise<ComparisonOverlay | undefined>;
    private diffRequest = 0;
    private refreshRequest = 0;
    private comparisonRef: string;
    private comparisonTarget: ProjectComparisonTarget;
    private displayRef: string;
    private viewState: ProjectComparisonViewState | undefined;

    static open(
        extensionUri: vscode.Uri,
        repository: RepositoryEntry,
        branchName: string,
        target: ProjectComparisonTarget,
        onNavigationStateChange: () => void = () => {},
    ): ProjectBranchComparisonPanel {
        return new ProjectBranchComparisonPanel(
            extensionUri,
            repository,
            branchName,
            target,
            onNavigationStateChange,
        );
    }

    static getActivePanel(): ProjectBranchComparisonPanel | null {
        return ProjectBranchComparisonPanel.activePanel;
    }

    static syncActiveEditor(editor: vscode.TextEditor | undefined): void {
        const uri = editor?.document.uri;
        const matchingPanel = uri
            ? [...ProjectBranchComparisonPanel.panels]
                  .reverse()
                  .find((panel) => panel.getFileForUri(uri) !== null)
            : null;
        const panel = matchingPanel ?? ProjectBranchComparisonPanel.activePanel;
        if (!panel) return;
        if (matchingPanel) panel.markActive();
        panel.syncActiveEditor(editor);
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly repository: RepositoryEntry,
        private readonly branchName: string,
        private readonly target: ProjectComparisonTarget,
        private readonly onNavigationStateChange: () => void,
    ) {
        this.comparisonRef = branchName;
        this.displayRef = branchName;
        this.comparisonTarget = target;
        this.iconTheme = new IconThemeService(extensionUri);
        this.createPanel(false);
        ProjectBranchComparisonPanel.panels.push(this);
        this.markActive();
        this.overlayReady = showComparisonInOverlay(this.panel, () => this.createPanel(true));
        void this.refresh().catch((error) => this.reportError(error));
    }

    private createPanel(preserveFocus: boolean): vscode.WebviewPanel {
        const previous = this.panel;
        const panel = vscode.window.createWebviewPanel(
            ProjectBranchComparisonPanel.viewType,
            this.target.fromMergeBase
                ? `共同祖先比较 · 相对 ${this.branchName}（${this.target.kind === "working-tree" ? "包含未提交修改" : "仅已提交"}）`
                : `Difference Between ${this.branchName} and ${this.target.label}`,
            preserveFocus ? { viewColumn: vscode.ViewColumn.One, preserveFocus: true } : vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
            },
        );
        this.panel = panel;
        this.iconTheme.attachWebview(panel.webview);

        this.panel.webview.onDidReceiveMessage((message) => {
            if (this.panel !== panel) return;
            this.markActive();
            this.updateNavigationContexts();
            void this.handleMessage(message).catch((error) => {
                this.reportError(error);
            });
        });
        this.panel.onDidChangeViewState((event) => {
            if (!event.webviewPanel.active) return;
            this.markActive();
            this.updateNavigationContexts();
        });
        panel.onDidDispose(() => { if (this.panel === panel) this.dispose(); });
        this.panel.webview.html = this.getHtml();
        previous?.dispose();
        return panel;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const panelIndex = ProjectBranchComparisonPanel.panels.indexOf(this);
        if (panelIndex >= 0) ProjectBranchComparisonPanel.panels.splice(panelIndex, 1);
        if (ProjectBranchComparisonPanel.activePanel === this) {
            ProjectBranchComparisonPanel.activePanel =
                ProjectBranchComparisonPanel.panels[
                    ProjectBranchComparisonPanel.panels.length - 1
                ] ?? null;
        }
        this.iconTheme.dispose();
        this.clearNavigationContexts();
    }

    private async refresh(): Promise<void> {
        this.post({ type: "refreshing", active: true });
        const request = ++this.refreshRequest;
        ++this.diffRequest;
        try {
            let ref = this.branchName;
            let target = this.target;
            let displayRef = this.branchName;
            if (target.fromMergeBase) {
                const snapshot = await resolveBranchChanges(this.repository.executor, this.branchName);
                ref = snapshot.base;
                target = target.kind === "current-branch"
                    ? { kind: "current-branch", ref: snapshot.head, label: `HEAD ${snapshot.head.slice(0, 8)} · 本分支已提交改动` }
                    : { kind: "working-tree", label: "Working Tree" };
                displayRef = `${this.branchName} 共同祖先 ${snapshot.base.slice(0, 8)}`;
            }
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateProjectComparisonFiles(
                await this.repository.gitOps.getBranchComparisonFiles(ref, target),
            );
            const folderIconsByName =
                await this.iconTheme.getFolderIconsByProjectComparisonFiles(files);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            if (this.disposed || request !== this.refreshRequest) return;
            this.comparisonRef = ref;
            this.comparisonTarget = target;
            this.displayRef = displayRef;
            this.files = files;
            this.lastError = null;
            if (this.activeFile && !files.some((file) => file.path === this.activeFile?.path)) {
                this.setActiveFile(null);
            }
            this.post({
                type: "update",
                branchName: this.displayRef,
                targetLabel: this.comparisonTarget.label,
                scopeLabel: this.target.fromMergeBase
                    ? this.target.kind === "working-tree" ? "从共同祖先比较 · 包含未提交修改" : "本分支已提交改动 · 不含工作区修改"
                    : undefined,
                repository: this.repository.info,
                files,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName,
                iconFonts,
            });
            if (this.target.fromMergeBase && this.activeFile) {
                const selected = files.find((file) => file.path === this.activeFile?.path);
                if (selected) await this.openFileDiff(selected);
            }
        } catch (error) {
            if (request !== this.refreshRequest || this.disposed) return;
            this.files = [];
            this.setActiveFile(null);
            this.post({ type: "update", branchName: this.displayRef,
                targetLabel: this.comparisonTarget.label, repository: this.repository.info, files: [] });
            throw error;
        } finally {
            if (request === this.refreshRequest) this.post({ type: "refreshing", active: false });
        }
    }

    private async handleMessage(message: ProjectComparisonOutbound): Promise<void> {
        switch (message.type) {
            case "ready":
                this.post({
                    type: "update",
                    branchName: this.displayRef,
                    targetLabel: this.comparisonTarget.label,
                scopeLabel: this.target.fromMergeBase
                    ? this.target.kind === "working-tree" ? "从共同祖先比较 · 包含未提交修改" : "本分支已提交改动 · 不含工作区修改"
                    : undefined,
                    repository: this.repository.info,
                    files: this.files,
                    iconFonts: this.iconTheme.getIconFonts(),
                    viewState: this.viewState ?? null,
                });
                if (this.lastError) {
                    this.post({ type: "error", message: this.lastError });
                }
                return;
            case "viewState":
                this.viewState = message.state;
                return;
            case "refresh":
                await this.refresh();
                return;
            case "openDiff": {
                const file = this.files.find((item) => item.path === message.path);
                if (!file) return;
                await this.openFileDiff(file);
                return;
            }
            case "openAllDiffs": {
                if (this.files.length === 0) return;
                const open = () => openBranchComparisonChanges(
                    this.files,
                    this.comparisonRef,
                    this.comparisonTarget,
                    this.repository.root,
                    this.repository.executor,
                    this.displayRef,
                );
                const overlay = await this.overlayReady;
                if (overlay) await overlay.openChanges(open);
                else await open();
                return;
            }
        }
    }

    private async openFileDiff(file: ProjectComparisonFile): Promise<void> {
        const request = ++this.diffRequest;
        const overlay = await this.overlayReady;
        if (this.disposed || request !== this.diffRequest) return;
        this.markActive();
        const shouldAdjustLayout =
            !this.editorLayoutAdjusted || vscode.window.tabGroups.all.length === 1;
        await openBranchComparisonFileDiff(
            file,
            this.comparisonRef,
            this.comparisonTarget,
            this.repository.root,
            this.repository.gitOps,
            this.repository.executor,
            this.getAdjacentEditorColumn(),
            this.comparisonId,
            overlay ? async (original, modified, title) => {
                if (!this.disposed && request === this.diffRequest) await overlay.openDiff(original, modified, title);
            } : undefined,
            this.displayRef,
        );
        if (this.disposed || request !== this.diffRequest) return;
        if (!overlay) await this.adjustEditorLayout(shouldAdjustLayout);
        this.setActiveFile(file);
    }

    private setActiveFile(file: ProjectComparisonFile | null): void {
        this.activeFile = file;
        this.post({ type: "setActiveFile", path: file?.path ?? null });
        this.updateNavigationContexts();
    }

    private getAdjacentFile(
        direction: "next" | "previous",
        activeFile: ProjectComparisonFile | null = this.activeFile,
    ): ProjectComparisonFile | null {
        if (this.files.length === 0) return null;
        if (!activeFile) {
            return direction === "next" ? this.files[0] : this.files[this.files.length - 1];
        }
        const currentIndex = this.files.findIndex((file) => file.path === activeFile.path);
        if (currentIndex < 0) {
            return direction === "next" ? this.files[0] : this.files[this.files.length - 1];
        }
        const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
        return this.files[nextIndex] ?? null;
    }

    syncActiveEditor(editor: vscode.TextEditor | undefined): void {
        const file = this.getFileForUri(editor?.document.uri);
        if (file && file.path !== this.activeFile?.path) {
            this.setActiveFile(file);
            return;
        }
        this.updateNavigationContexts();
    }

    async navigateFile(direction: "next" | "previous"): Promise<void> {
        const target = this.getAdjacentFile(direction);
        if (!target) return;
        await this.openFileDiff(target);
    }

    async getDiffNavigationState(
        editor: vscode.TextEditor | null | undefined = undefined,
    ): Promise<DiffNavigationState> {
        if (editor === null) {
            return {
                active: false,
                hasPrevious: false,
                hasNext: false,
                currentFile: 0,
                totalFiles: 0,
            };
        }
        const activeFile = editor ? this.getFileForUri(editor.document.uri) : this.activeFile;
        const currentIndex = activeFile
            ? this.files.findIndex((file) => file.path === activeFile.path)
            : -1;
        if (currentIndex < 0) {
            return {
                active: false,
                hasPrevious: false,
                hasNext: false,
                currentFile: 0,
                totalFiles: 0,
            };
        }
        return {
            active: true,
            hasPrevious: currentIndex > 0,
            hasNext: currentIndex < this.files.length - 1,
            currentFile: currentIndex + 1,
            totalFiles: this.files.length,
        };
    }

    private getFileForUri(uri: vscode.Uri | undefined): ProjectComparisonFile | null {
        const path = this.getProjectComparisonPathFromUri(uri);
        if (!path) return null;
        return this.files.find((file) => file.path === path || file.oldPath === path) ?? null;
    }

    private getProjectComparisonPathFromUri(uri: vscode.Uri | undefined): string | null {
        if (!uri) return null;
        if (uri.scheme === "file") {
            if (this.target.kind !== "working-tree") return null;
            return getRepoRelativeFilePathFromUri(uri, this.repository.root);
        }
        const ref = getDiffRefFromUri(uri);
        const targetRef = this.comparisonTarget.kind === "current-branch" ? this.comparisonTarget.ref ?? "HEAD" : "working-tree";
        if (ref !== this.comparisonRef && ref !== targetRef) return null;
        if (getProjectComparisonIdFromUri(uri) !== this.comparisonId) return null;
        return getDiffOriginalFilePathFromUri(uri);
    }

    private getAdjacentEditorColumn(): vscode.ViewColumn {
        const panelColumn = this.panel.viewColumn;
        return typeof panelColumn === "number" && panelColumn > 0 && panelColumn < 9
            ? (panelColumn + 1)
            : vscode.ViewColumn.Beside;
    }

    private async adjustEditorLayout(shouldAdjust: boolean): Promise<void> {
        if (!shouldAdjust || vscode.window.tabGroups.all.length !== 2) return;
        this.editorLayoutAdjusted = true;
        await vscode.commands.executeCommand("vscode.setEditorLayout", {
            orientation: 0,
            groups: [{ size: 0.25 }, { size: 0.75 }],
        });
    }

    private markActive(): void {
        if (this.disposed) return;
        const panelIndex = ProjectBranchComparisonPanel.panels.indexOf(this);
        if (panelIndex >= 0) ProjectBranchComparisonPanel.panels.splice(panelIndex, 1);
        ProjectBranchComparisonPanel.panels.push(this);
        ProjectBranchComparisonPanel.activePanel = this;
    }

    private reportError(error: unknown): void {
        const message = getErrorMessage(error);
        this.lastError = message;
        void vscode.window.showErrorMessage(message);
        this.post({ type: "error", message });
    }

    private updateNavigationContexts(): void {
        this.onNavigationStateChange();
    }

    private clearNavigationContexts(): void {
        this.onNavigationStateChange();
    }

    private post(message: ProjectComparisonInbound): void {
        void this.panel.webview.postMessage(message);
    }

    private getHtml(): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview: this.panel.webview,
            scriptFile: "webview-projectcomparison.js",
            title: "Project Branch Comparison",
        });
    }
}
