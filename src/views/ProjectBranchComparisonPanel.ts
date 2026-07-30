import * as vscode from "vscode";
import type { ProjectComparisonFile } from "../types";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import {
    getDiffOriginalFilePathFromUri,
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
    private static activePanel: ProjectBranchComparisonPanel | null = null;

    private readonly panel: vscode.WebviewPanel;
    private readonly iconTheme: IconThemeService;
    private files: ProjectComparisonFile[] = [];
    private activeFile: ProjectComparisonFile | null = null;
    private disposed = false;

    static open(
        extensionUri: vscode.Uri,
        repository: RepositoryEntry,
        branchName: string,
        onNavigationStateChange: () => void = () => {},
    ): ProjectBranchComparisonPanel {
        return new ProjectBranchComparisonPanel(
            extensionUri,
            repository,
            branchName,
            onNavigationStateChange,
        );
    }

    static getActivePanel(): ProjectBranchComparisonPanel | null {
        return ProjectBranchComparisonPanel.activePanel;
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly repository: RepositoryEntry,
        private readonly branchName: string,
        private readonly onNavigationStateChange: () => void,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            ProjectBranchComparisonPanel.viewType,
            `Difference Between ${branchName} and Current`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        ProjectBranchComparisonPanel.activePanel = this;
        this.iconTheme = new IconThemeService(extensionUri);
        this.iconTheme.attachWebview(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message).catch((error) => {
                const text = getErrorMessage(error);
                vscode.window.showErrorMessage(text);
                this.post({ type: "error", message: text });
            });
        });
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.html = this.getHtml();
        void this.refresh();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (ProjectBranchComparisonPanel.activePanel === this) {
            ProjectBranchComparisonPanel.activePanel = null;
        }
        this.iconTheme.dispose();
        this.clearNavigationContexts();
    }

    private async refresh(): Promise<void> {
        this.post({ type: "refreshing", active: true });
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateProjectComparisonFiles(
                await this.repository.gitOps.getBranchComparisonFiles(this.branchName),
            );
            const folderIconsByName =
                await this.iconTheme.getFolderIconsByProjectComparisonFiles(files);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            this.files = files;
            if (this.activeFile && !files.some((file) => file.path === this.activeFile?.path)) {
                this.setActiveFile(null);
            }
            this.post({
                type: "update",
                branchName: this.branchName,
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
                    repository: this.repository.info,
                    files: this.files,
                    iconFonts: this.iconTheme.getIconFonts(),
                });
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
        await openBranchComparisonFileDiff(
            file,
            this.branchName,
            this.repository.root,
            this.repository.gitOps,
            this.repository.executor,
        );
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
            return getRepoRelativeFilePathFromUri(uri, this.repository.root);
        }
        if (uri.scheme !== "intelligit-diff") return null;
        const ref = new URLSearchParams(uri.query).get("ref");
        if (ref !== this.branchName && ref !== "current") return null;
        return getDiffOriginalFilePathFromUri(uri);
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
