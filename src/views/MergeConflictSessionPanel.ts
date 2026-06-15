import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import type { MergeConflictFile } from "../types";
import type { MergeConflictSessionData } from "../webviews/react/merge-conflicts-session/types";

interface MergeConflictSessionLabels {
    sourceBranch?: string;
    targetBranch?: string;
}

interface MergeConflictSessionCallbacks {
    onOpenMergeConflict: (filePath: string) => Promise<void>;
    onConflictStateChanged: (resolvedPath?: string) => Promise<void>;
}

interface MergeConflictSessionContext {
    repoRoot?: string;
}

export class MergeConflictSessionPanel {
    private static currentPanel: MergeConflictSessionPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private sourceBranch = "incoming branch";
    private targetBranch = "current branch";
    private lastFiles: MergeConflictFile[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        private callbacks: MergeConflictSessionCallbacks,
        private repoRoot?: string,
    ) {
        this.panel = panel;
        this.updateLabels(labels);

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (error) {
                if (!this.isAlive()) return;
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(message);
                try {
                    if (!this.isAlive()) return;
                    await this.panel.webview.postMessage({ type: "loadError", message });
                } catch {
                    // Panel may have been disposed between the active check and postMessage.
                }
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            if (MergeConflictSessionPanel.currentPanel === this) {
                MergeConflictSessionPanel.currentPanel = undefined;
            }
        });
    }

    static async open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        callbacks: MergeConflictSessionCallbacks,
        sessionContext: MergeConflictSessionContext = {},
    ): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (existing && !existing.disposed) {
            existing.updateSession(gitOps, labels, callbacks, sessionContext);
            existing.panel.reveal(vscode.ViewColumn.Active);
            await existing.postSessionData({ closeWhenResolved: false });
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeConflictSession",
            "Conflicts",
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );

        const instance = new MergeConflictSessionPanel(
            panel,
            extensionUri,
            gitOps,
            labels,
            callbacks,
            sessionContext.repoRoot,
        );
        MergeConflictSessionPanel.currentPanel = instance;
        await instance.postSessionData({ closeWhenResolved: false });
    }

    static async refreshIfOpen(
        options: { resolvedPath?: string; repoRoot?: string } = {},
    ): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (!existing || existing.disposed) return;
        if (options.repoRoot && existing.repoRoot && existing.repoRoot !== options.repoRoot) return;
        await existing.postSessionData({
            closeWhenResolved: true,
            resolvedPath: options.resolvedPath,
        });
    }

    static isOpen(repoRoot?: string): boolean {
        const panel = MergeConflictSessionPanel.currentPanel;
        if (!panel || panel.disposed) return false;
        return !repoRoot || !panel.repoRoot || panel.repoRoot === repoRoot;
    }

    private updateLabels(labels: MergeConflictSessionLabels): void {
        const source = labels.sourceBranch?.trim();
        const target = labels.targetBranch?.trim();
        this.sourceBranch = source || this.sourceBranch;
        this.targetBranch = target || this.targetBranch;
    }

    private updateCallbacks(callbacks: MergeConflictSessionCallbacks): void {
        this.callbacks = callbacks;
    }

    private updateSession(
        gitOps: GitOps,
        labels: MergeConflictSessionLabels,
        callbacks: MergeConflictSessionCallbacks,
        sessionContext: MergeConflictSessionContext,
    ): void {
        this.gitOps = gitOps;
        this.repoRoot = sessionContext.repoRoot;
        this.sourceBranch = "incoming branch";
        this.targetBranch = "current branch";
        this.updateLabels(labels);
        this.updateCallbacks(callbacks);
        this.lastFiles = [];
    }

    private async handleMessage(msg: { type?: unknown; filePath?: unknown }): Promise<void> {
        const type = typeof msg.type === "string" ? msg.type : "";
        switch (type) {
            case "ready":
            case "refresh":
                await this.postSessionData({ closeWhenResolved: false });
                return;

            case "openMerge": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await this.callbacks.onOpenMergeConflict(filePath);
                await this.postSessionData({ closeWhenResolved: true, selectedPath: filePath });
                return;
            }

            case "acceptYours": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                await this.callbacks.onConflictStateChanged(filePath);
                await this.postSessionData({ closeWhenResolved: true, resolvedPath: filePath });
                return;
            }

            case "acceptTheirs": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                await this.callbacks.onConflictStateChanged(filePath);
                await this.postSessionData({ closeWhenResolved: true, resolvedPath: filePath });
                return;
            }

            case "close":
                this.panel.dispose();
                return;

            default:
                return;
        }
    }

    private getFilePath(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const filePath = value.trim();
        return filePath ? filePath : null;
    }

    private isAlive(): boolean {
        return !this.disposed;
    }

    private async postSessionData(options: {
        closeWhenResolved: boolean;
        resolvedPath?: string;
        selectedPath?: string;
    }): Promise<void> {
        if (!this.isAlive()) return;
        const previousFiles = this.lastFiles;
        const files = await this.gitOps.getConflictFilesDetailed();
        if (!this.isAlive()) return;
        if (files.length === 0 && options.closeWhenResolved) {
            this.lastFiles = [];
            vscode.window.showInformationMessage("All merge conflicts are resolved.");
            this.panel.dispose();
            return;
        }

        const selectedPath =
            options.selectedPath ??
            this.pickNextSelectedPath(files, previousFiles, options.resolvedPath);
        this.lastFiles = files;

        const data: MergeConflictSessionData = {
            sourceBranch: this.sourceBranch,
            targetBranch: this.targetBranch,
            files,
            selectedPath,
        };

        if (!this.isAlive()) return;
        await this.panel.webview.postMessage({ type: "setSessionData", data });
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeconflictsession.js",
            styleFiles: ["webview-mergeconflictsession.css"],
            title: "Conflicts",
        });
    }

    private pickNextSelectedPath(
        files: MergeConflictFile[],
        previousFiles: MergeConflictFile[],
        resolvedPath?: string,
    ): string | null {
        if (!resolvedPath) return null;
        if (files.some((file) => file.path === resolvedPath)) return resolvedPath;

        const previousIndex = previousFiles.findIndex((file) => file.path === resolvedPath);
        if (previousIndex < 0) return files[0]?.path ?? null;

        const remaining = new Set(files.map((file) => file.path));
        for (let i = previousIndex + 1; i < previousFiles.length; i++) {
            const path = previousFiles[i]?.path;
            if (path && remaining.has(path)) return path;
        }
        for (let i = 0; i < previousIndex; i++) {
            const path = previousFiles[i]?.path;
            if (path && remaining.has(path)) return path;
        }
        return files[0]?.path ?? null;
    }
}
