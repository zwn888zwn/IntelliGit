import * as vscode from "vscode";
import type { ProjectComparisonFile } from "../types";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import {
    getRepoRelativeFilePathFromUri,
    openBranchComparisonFileDiff,
} from "../services/diffService";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath } from "../utils/fileOps";
import { buildWebviewShellHtml } from "./webviewHtml";
import { IconThemeService } from "./shared";
import type {
    ProjectComparisonInbound,
    ProjectComparisonOutbound,
} from "../webviews/react/project-comparison/types";

interface DiffHunkRange {
    start: number;
    end: number;
}

export class ProjectBranchComparisonPanel implements vscode.Disposable {
    static readonly viewType = "intelligit.projectBranchComparison";
    private static activePanel: ProjectBranchComparisonPanel | null = null;

    private readonly panel: vscode.WebviewPanel;
    private readonly iconTheme: IconThemeService;
    private files: ProjectComparisonFile[] = [];
    private activeFile: ProjectComparisonFile | null = null;
    private activeHunkIndex: number | null = null;
    private navigationContextSeq = 0;
    private disposed = false;

    static open(
        extensionUri: vscode.Uri,
        repository: RepositoryEntry,
        branchName: string,
    ): ProjectBranchComparisonPanel {
        return new ProjectBranchComparisonPanel(extensionUri, repository, branchName);
    }

    static getActivePanel(): ProjectBranchComparisonPanel | null {
        return ProjectBranchComparisonPanel.activePanel;
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly repository: RepositoryEntry,
        private readonly branchName: string,
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

    private async openFileDiff(
        file: ProjectComparisonFile,
        initialHunk: "first" | "last" = "first",
    ): Promise<void> {
        await openBranchComparisonFileDiff(
            file,
            this.branchName,
            this.repository.root,
            this.repository.gitOps,
        );
        const changeRanges = await this.getFileChangeRanges(file);
        const targetHunkIndex =
            initialHunk === "last" ? Math.max(0, changeRanges.length - 1) : 0;
        if (initialHunk === "last" && changeRanges.length > 1) {
            await waitForEditorCommand();
            await vscode.commands.executeCommand(getNativeDiffNavigationCommand("previous"));
            await waitForEditorCommand();
        }
        this.activeHunkIndex = targetHunkIndex;
        this.setActiveFile(file);
    }

    private setActiveFile(file: ProjectComparisonFile | null): void {
        this.activeFile = file;
        this.post({ type: "setActiveFile", path: file?.path ?? null });
        this.updateNavigationContexts();
    }

    private getAdjacentFile(direction: "next" | "previous"): ProjectComparisonFile | null {
        if (this.files.length === 0) return null;
        if (!this.activeFile) {
            return direction === "next" ? this.files[0] : this.files[this.files.length - 1];
        }
        const currentIndex = this.files.findIndex((file) => file.path === this.activeFile?.path);
        if (currentIndex < 0) {
            return direction === "next" ? this.files[0] : this.files[this.files.length - 1];
        }
        const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
        return this.files[nextIndex] ?? null;
    }

    syncActiveEditor(editor: vscode.TextEditor | undefined): void {
        const file = this.getFileForUri(editor?.document.uri);
        if (file && file.path !== this.activeFile?.path) {
            this.activeHunkIndex = 0;
            this.setActiveFile(file);
            return;
        }
        this.updateNavigationContexts();
    }

    async navigateChange(direction: "next" | "previous"): Promise<void> {
        if (!(await this.canNavigateChange(direction))) return;
        if (!this.activeFile) {
            const firstTarget = this.getAdjacentFile(direction);
            if (firstTarget) await this.openFileDiff(firstTarget);
            return;
        }

        const changeRanges = await this.getActiveFileChangeRanges();
        const targetHunkIndex = getAdjacentHunkIndex(
            changeRanges,
            this.activeHunkIndex,
            direction,
        );
        if (targetHunkIndex !== null) {
            await vscode.commands.executeCommand(getNativeDiffNavigationCommand(direction));
            await waitForEditorCommand();
            this.activeHunkIndex = targetHunkIndex;
            this.updateNavigationContexts();
            return;
        }

        const target = this.getAdjacentFile(direction);
        if (!target) return;
        await this.openFileDiff(target, direction === "previous" ? "last" : "first");
    }

    private async canNavigateChange(direction: "next" | "previous"): Promise<boolean> {
        if (!this.activeFile) return this.files.length > 0;
        const changeRanges = await this.getActiveFileChangeRanges();
        const hasAdjacentChange =
            getAdjacentHunkIndex(changeRanges, this.activeHunkIndex, direction) !== null;
        return hasAdjacentChange || Boolean(this.getAdjacentFile(direction));
    }

    private async getActiveFileChangeRanges(): Promise<DiffHunkRange[]> {
        if (!this.activeFile) return [];
        return this.getFileChangeRanges(this.activeFile);
    }

    private async getFileChangeRanges(file: ProjectComparisonFile): Promise<DiffHunkRange[]> {
        const safePath = assertRepoRelativePath(file.path);
        const trimmedRef = this.branchName.trim();
        if (!trimmedRef) return [];
        const diff = await this.repository.executor
            .run(["diff", "--find-renames", "--unified=0", trimmedRef, "--", safePath])
            .catch(() => "");
        return parseChangedNewFileHunks(diff);
    }

    private getFileForUri(uri: vscode.Uri | undefined): ProjectComparisonFile | null {
        const path = getProjectComparisonPathFromUri(uri, this.repository.root);
        if (!path) return null;
        return this.files.find((file) => file.path === path || file.oldPath === path) ?? null;
    }

    private updateNavigationContexts(): void {
        const requestId = ++this.navigationContextSeq;
        const hasActiveDiff = Boolean(this.activeFile);
        void (async () => {
            const hasPreviousFile = Boolean(this.getAdjacentFile("previous"));
            const hasNextFile = Boolean(this.getAdjacentFile("next"));
            const changeRanges = await this.getActiveFileChangeRanges();
            if (requestId !== this.navigationContextSeq) return;
            const hasPreviousChange =
                getAdjacentHunkIndex(changeRanges, this.activeHunkIndex, "previous") !== null;
            const hasNextChange =
                getAdjacentHunkIndex(changeRanges, this.activeHunkIndex, "next") !== null;
            await Promise.all([
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.projectComparison.activeDiff",
                    hasActiveDiff,
                ),
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.projectComparison.hasPreviousDiffFile",
                    hasPreviousChange || hasPreviousFile,
                ),
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.projectComparison.hasNextDiffFile",
                    hasNextChange || hasNextFile,
                ),
            ]);
        })().catch(() => {});
    }

    private clearNavigationContexts(): void {
        ++this.navigationContextSeq;
        void Promise.all([
            vscode.commands.executeCommand(
                "setContext",
                "intelligit.projectComparison.activeDiff",
                false,
            ),
            vscode.commands.executeCommand(
                "setContext",
                "intelligit.projectComparison.hasPreviousDiffFile",
                false,
            ),
            vscode.commands.executeCommand(
                "setContext",
                "intelligit.projectComparison.hasNextDiffFile",
                false,
            ),
        ]).catch(() => {});
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

function waitForEditorCommand(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 80));
}

function getNativeDiffNavigationCommand(direction: "next" | "previous"): string {
    return direction === "next"
        ? "workbench.action.compareEditor.nextChange"
        : "workbench.action.compareEditor.previousChange";
}

function getProjectComparisonPathFromUri(
    uri: vscode.Uri | undefined,
    repoRoot: string,
): string | null {
    if (!uri) return null;
    if (uri.scheme === "file") {
        return getRepoRelativeFilePathFromUri(uri, repoRoot);
    }
    if (uri.scheme !== "intelligit-diff") return null;
    const normalizedPath = uri.path.replace(/^\/+/, "");
    if (!normalizedPath) return null;
    return assertRepoRelativePath(normalizedPath);
}

function parseChangedNewFileHunks(diff: string): DiffHunkRange[] {
    const ranges: DiffHunkRange[] = [];
    const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match: RegExpExecArray | null;
    while ((match = hunkPattern.exec(diff)) !== null) {
        const start = Number.parseInt(match[1] ?? "0", 10);
        const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
        const zeroBasedStart = Math.max(0, start - 1);
        const zeroBasedEnd = zeroBasedStart + Math.max(1, count) - 1;
        ranges.push({ start: zeroBasedStart, end: zeroBasedEnd });
    }
    return ranges.sort((left, right) => left.start - right.start);
}

function getAdjacentHunkIndex(
    ranges: DiffHunkRange[],
    currentIndex: number | null,
    direction: "next" | "previous",
): number | null {
    if (ranges.length <= 1) return null;
    const boundedIndex =
        currentIndex === null
            ? 0
            : Math.min(Math.max(currentIndex, 0), ranges.length - 1);
    const targetIndex = direction === "next" ? boundedIndex + 1 : boundedIndex - 1;
    return targetIndex >= 0 && targetIndex < ranges.length ? targetIndex : null;
}
