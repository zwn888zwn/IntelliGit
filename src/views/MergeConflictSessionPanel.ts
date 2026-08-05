import * as vscode from "vscode";
import * as path from "path";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import { parseConflictVersions } from "../mergeEditor/conflictParser";
import {
    buildResultContent,
    isTrueConflict,
} from "../webviews/react/merge-editor/mergeState";
import { assertRepoRelativePath } from "../utils/fileOps";
import type { MergeConflictFile } from "../types";
import type {
    MergeConflictSessionData,
    MergeConflictSessionFile,
} from "../webviews/react/merge-conflicts-session/types";

interface MergeConflictSessionLabels {
    sourceBranch?: string;
    targetBranch?: string;
}

interface MergeConflictSessionCallbacks {
    onOpenMergeConflict: (
        filePath: string,
        applyNonConflicting: boolean,
    ) => Promise<void>;
    onConflictStateChanged: (resolvedPath?: string) => Promise<void>;
    onFinish: () => Promise<boolean>;
    onMergeAborted: () => Promise<void>;
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
    private readonly sessionFiles = new Map<string, MergeConflictFile>();
    private readonly conflictCounts = new Map<
        string,
        { resolvedConflictCount: number; totalConflictCount: number }
    >();
    private readonly workingFileSnapshots = new Map<string, Uint8Array>();
    private simpleConflictsResolved = false;

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
            await existing.postSessionData();
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
        await instance.postSessionData();
    }

    static async refreshIfOpen(
        options: { resolvedPath?: string; repoRoot?: string } = {},
    ): Promise<void> {
        const existing = MergeConflictSessionPanel.currentPanel;
        if (!existing || existing.disposed) return;
        if (options.repoRoot && existing.repoRoot && existing.repoRoot !== options.repoRoot) return;
        await existing.postSessionData({ resolvedPath: options.resolvedPath });
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
        this.sessionFiles.clear();
        this.conflictCounts.clear();
        this.workingFileSnapshots.clear();
        this.simpleConflictsResolved = false;
    }

    private async handleMessage(msg: { type?: unknown; filePath?: unknown }): Promise<void> {
        const type = typeof msg.type === "string" ? msg.type : "";
        switch (type) {
            case "ready":
            case "refresh":
                await this.postSessionData();
                return;

            case "openMerge": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                await this.callbacks.onOpenMergeConflict(
                    filePath,
                    this.simpleConflictsResolved,
                );
                await this.postSessionData({ selectedPath: filePath });
                return;
            }

            case "resolveAllSimple":
                await this.resolveAllSimpleConflicts();
                return;

            case "acceptYours":
            case "acceptTheirs": {
                const filePath = this.getFilePath(msg.filePath);
                if (!filePath) return;
                const side = type === "acceptYours" ? "ours" : "theirs";
                await runWithNotificationProgress(
                    `Accepting ${side} for ${filePath}...`,
                    async () => {
                        await this.gitOps.acceptConflictSide(filePath, side);
                    },
                );
                await this.callbacks.onConflictStateChanged(filePath);
                await this.postSessionData({ resolvedPath: filePath });
                return;
            }

            case "acceptAndFinish": {
                if ((await this.gitOps.getConflictFilesDetailed()).length > 0) return;
                if (await this.callbacks.onFinish()) this.panel.dispose();
                return;
            }

            case "close": {
                if (!(await this.gitOps.isMergeInProgress())) {
                    this.panel.dispose();
                    return;
                }
                const confirm = await vscode.window.showWarningMessage(
                    "Abort merge?",
                    { modal: true },
                    "Abort",
                );
                if (confirm !== "Abort") return;
                await runWithNotificationProgress("Aborting merge...", async () => {
                    await this.gitOps.abortMerge();
                });
                await this.callbacks.onMergeAborted();
                vscode.window.showInformationMessage("Merge aborted.");
                this.panel.dispose();
                return;
            }

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

    private async postSessionData(
        options: {
            resolvedPath?: string;
            selectedPath?: string;
        } = {},
    ): Promise<void> {
        if (!this.isAlive()) return;
        const previousFiles = this.lastFiles;
        const files = await this.gitOps.getConflictFilesDetailed();
        if (!this.isAlive()) return;
        for (const file of files) {
            this.sessionFiles.set(file.path, file);
            if (this.repoRoot && !this.workingFileSnapshots.has(file.path)) {
                const safePath = assertRepoRelativePath(file.path);
                let snapshot: Uint8Array | undefined;
                try {
                    snapshot = await vscode.workspace.fs.readFile(
                        vscode.Uri.file(path.join(this.repoRoot, safePath)),
                    );
                } catch {
                    snapshot = undefined;
                }
                if (snapshot) this.workingFileSnapshots.set(file.path, snapshot);
            }
        }

        const selectedPath =
            options.selectedPath ??
            this.pickNextSelectedPath(files, previousFiles, options.resolvedPath);
        this.lastFiles = files;
        const unresolvedPaths = new Set(files.map((file) => file.path));
        const sessionFiles: MergeConflictSessionFile[] = Array.from(this.sessionFiles.values()).map(
            (file) => {
                const resolved = !unresolvedPaths.has(file.path);
                const counts = this.conflictCounts.get(file.path);
                return {
                    ...file,
                    resolved,
                    resolvedConflictCount:
                        resolved && counts
                            ? counts.totalConflictCount
                            : counts?.resolvedConflictCount,
                    totalConflictCount: counts?.totalConflictCount,
                };
            },
        );

        const data: MergeConflictSessionData = {
            sourceBranch: this.sourceBranch,
            targetBranch: this.targetBranch,
            files: sessionFiles,
            selectedPath,
            simpleConflictsResolved: this.simpleConflictsResolved,
        };

        if (!this.isAlive()) return;
        await this.panel.webview.postMessage({ type: "setSessionData", data });
    }

    private async resolveAllSimpleConflicts(): Promise<void> {
        if (this.simpleConflictsResolved) return;
        const files = await this.gitOps.getConflictFilesDetailed();
        let changed = false;

        await runWithNotificationProgress("Resolving simple conflicts...", async () => {
            for (const file of files) {
                const versions = await this.gitOps.getConflictFileVersions(file.path);
                const segments = parseConflictVersions(
                    versions.base,
                    versions.ours,
                    versions.theirs,
                );
                const conflictSegments = segments.filter((segment) => segment.type === "conflict");
                const unresolvedSegments = conflictSegments.filter(isTrueConflict);
                this.conflictCounts.set(file.path, {
                    resolvedConflictCount: conflictSegments.length - unresolvedSegments.length,
                    totalConflictCount: conflictSegments.length,
                });

                if (conflictSegments.length === 0 || unresolvedSegments.length > 0) continue;
                const safePath = assertRepoRelativePath(file.path);
                if (!this.repoRoot) continue;
                const fileUri = vscode.Uri.file(path.join(this.repoRoot, safePath));
                const snapshot = this.workingFileSnapshots.get(file.path);
                let current: Uint8Array | undefined;
                try {
                    current = await vscode.workspace.fs.readFile(fileUri);
                } catch {
                    current = undefined;
                }
                if (
                    !snapshot ||
                    !current ||
                    !Buffer.from(current).equals(Buffer.from(snapshot))
                ) {
                    vscode.window.showWarningMessage(
                        `Skipped ${file.path} because it changed after the conflict session opened.`,
                    );
                    continue;
                }
                const eol = versions.ours.includes("\r\n") ? "\r\n" : "\n";
                const content = buildResultContent(
                    {
                        filePath: safePath,
                        segments,
                        oursLabel: this.targetBranch,
                        theirsLabel: this.sourceBranch,
                        eol,
                        hasTrailingNewline: versions.ours.endsWith(eol),
                    },
                    {},
                );
                if (/^(?:<<<<<<<|=======|>>>>>>>)/m.test(Buffer.from(current).toString("utf8"))) {
                    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
                }
                await this.gitOps.stageFile(safePath);
                changed = true;
            }
        });

        this.simpleConflictsResolved = true;
        if (changed) await this.callbacks.onConflictStateChanged();
        await this.postSessionData();
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
