import * as vscode from "vscode";
import type { ProjectComparisonFile, ProjectComparisonTarget } from "../types";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import {
    getDiffRefFromUri,
    getDiffOriginalFilePathFromUri,
    getProjectComparisonIdFromUri,
    getRepoRelativeFilePathFromUri,
    openBranchComparisonFileDiff,
} from "../services/diffService";
import { getErrorMessage } from "../utils/errors";
import { buildWebviewShellHtml } from "./webviewHtml";
import { IconThemeService } from "./shared";
import type {
    ProjectComparisonInbound,
    ProjectComparisonOutbound,
} from "../webviews/react/project-comparison/types";
import type { DiffNavigationState } from "./CommitPanelViewProvider";

export class ProjectBranchComparisonPanel implements vscode.Disposable {
    static readonly viewType = "intelligit.projectBranchComparison";
    private static readonly panels: ProjectBranchComparisonPanel[] = [];
    private static nextPanelId = 1;
    private static activePanel: ProjectBranchComparisonPanel | null = null;

    private readonly panel: vscode.WebviewPanel;
    private readonly iconTheme: IconThemeService;
    private readonly comparisonId = String(ProjectBranchComparisonPanel.nextPanelId++);
    private files: ProjectComparisonFile[] = [];
    private activeFile: ProjectComparisonFile | null = null;
    private lastError: string | null = null;
    private editorLayoutAdjusted = false;
    private disposed = false;

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
        this.panel = vscode.window.createWebviewPanel(
            ProjectBranchComparisonPanel.viewType,
            `Difference Between ${branchName} and ${target.label}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        ProjectBranchComparisonPanel.panels.push(this);
        this.markActive();
        this.iconTheme = new IconThemeService(extensionUri);
        this.iconTheme.attachWebview(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((message) => {
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
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.html = this.getHtml();
        void this.refresh().catch((error) => this.reportError(error));
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
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateProjectComparisonFiles(
                await this.repository.gitOps.getBranchComparisonFiles(this.branchName, this.target),
            );
            const folderIconsByName =
                await this.iconTheme.getFolderIconsByProjectComparisonFiles(files);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            this.files = files;
            this.lastError = null;
            if (this.activeFile && !files.some((file) => file.path === this.activeFile?.path)) {
                this.setActiveFile(null);
            }
            this.post({
                type: "update",
                branchName: this.branchName,
                targetLabel: this.target.label,
                repository: this.repository.info,
                files,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName,
                iconFonts,
            });
        } finally {
            this.post({ type: "refreshing", active: false });
        }
    }

    private async handleMessage(message: ProjectComparisonOutbound): Promise<void> {
        switch (message.type) {
            case "ready":
                this.post({
                    type: "update",
                    branchName: this.branchName,
                    targetLabel: this.target.label,
                    repository: this.repository.info,
                    files: this.files,
                    iconFonts: this.iconTheme.getIconFonts(),
                });
                if (this.lastError) {
                    this.post({ type: "error", message: this.lastError });
                }
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
        }
    }

    private async openFileDiff(file: ProjectComparisonFile): Promise<void> {
        this.markActive();
        const shouldAdjustLayout =
            !this.editorLayoutAdjusted || vscode.window.tabGroups.all.length === 1;
        await openBranchComparisonFileDiff(
            file,
            this.branchName,
            this.target,
            this.repository.root,
            this.repository.gitOps,
            this.repository.executor,
            this.getAdjacentEditorColumn(),
            this.comparisonId,
        );
        await this.adjustEditorLayout(shouldAdjustLayout);
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
        const targetRef = this.target.kind === "current-branch" ? "HEAD" : "working-tree";
        if (ref !== this.branchName && ref !== targetRef) return null;
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
