// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type {
    RepoPathRef,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    WorkingFile,
    StashEntry,
} from "../types";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "../utils/fileOps";
import { runWithNotificationProgress } from "../utils/notifications";
import type { InboundMessage } from "../webviews/react/commit-panel/types";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import type { RepositoryEntry } from "../services/RepositoryContextService";

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private lastFileCount = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;
    private repository: RepositoryContextInfo | null = null;

    private readonly _onDidChangeFileCount = new vscode.EventEmitter<number>();
    readonly onDidChangeFileCount = this._onDidChangeFileCount.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly getRepoRootUri: () => vscode.Uri | undefined = () =>
            vscode.workspace.workspaceFolders?.[0]?.uri,
        private readonly listRepositories: () => RepositoryEntry[] = () => [],
        private readonly getRepositoryByRoot: (root: string) => RepositoryEntry | null = () => null,
        private readonly switchRepository: (root: string) => Promise<void> = async () => {},
    ) {
        this.iconTheme = new IconThemeService(this.extensionUri);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.disposeThemeChangeDisposables();
        this.iconTheme.dispose();
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();
        const thisView = webviewView;
        webviewView.onDidDispose(() => {
            if (this.view === thisView) {
                this.view = undefined;
                this.iconTheme.dispose();
                this.disposeThemeChangeDisposables();
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);
        this.postToWebview({ type: "setRepositoryContext", repository: this.repository });
        this.updateViewCount(this.lastFileCount);
        this.refreshDataWithErrorHandling();
    }

    async refresh(): Promise<void> {
        await this.refreshData();
    }

    setRepositoryContext(repository: RepositoryContextInfo | null): void {
        this.repository = repository;
        this.postToWebview({ type: "setRepositoryContext", repository });
        if (!repository) {
            void Promise.resolve(
                vscode.commands.executeCommand("setContext", "intelligit.commitPanel.refreshing", false),
            ).catch(() => {});
            this.files = [];
            this.stashes = [];
            this.selectedShelfIndex = null;
            this.shelfFiles = [];
            this.folderIconsByName = {};
            this._onDidChangeFileCount.fire(0);
            this.updateViewCount(0);
            this.postToWebview({
                type: "update",
                repositories: this.getRepositories().map((entry) => entry.info),
                files: [],
                stashes: [],
                shelfFiles: [],
                selectedShelfIndex: null,
            });
        }
    }

    private async refreshData(): Promise<void> {
        if (!this.repository) {
            this.setRepositoryContext(null);
            return;
        }
        this.postToWebview({ type: "refreshing", active: true });
        void Promise.resolve(
            vscode.commands.executeCommand("setContext", "intelligit.commitPanel.refreshing", true),
        ).catch(() => {});
        try {
            await this.iconTheme.initIconThemeData();
            const repositories = this.getRepositories();
            const files = (
                await Promise.all(
                    repositories.map(async (entry) =>
                        this.iconTheme.decorateWorkingFiles(await entry.gitOps.getStatus()),
                    ),
                )
            ).flat();
            const stashes = await this.gitOps.listShelved();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();

            const hasSelected =
                this.selectedShelfIndex !== null &&
                stashes.some((entry) => entry.index === this.selectedShelfIndex);
            let selectedShelfIndex: number | null;
            if (hasSelected) {
                selectedShelfIndex = this.selectedShelfIndex;
            } else {
                selectedShelfIndex = stashes.length > 0 ? stashes[0].index : null;
            }

            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex),
                      )
                    : [];
            this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);

            this.files = files;
            this.stashes = stashes;
            this.selectedShelfIndex = selectedShelfIndex;
            this.shelfFiles = shelfFiles;

            const uniquePaths = new Set(files.map((f) => `${f.repoRoot}\u0000${f.path}`));
            const count = uniquePaths.size;
            this._onDidChangeFileCount.fire(count);
            this.updateViewCount(count);
            this.postToWebview({
                type: "update",
                repositories: repositories.map((entry) => entry.info),
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
            });
        } finally {
            this.postToWebview({ type: "refreshing", active: false });
            void Promise.resolve(
                vscode.commands.executeCommand(
                    "setContext",
                    "intelligit.commitPanel.refreshing",
                    false,
                ),
            ).catch(() => {});
        }
    }

    private assertStringArray(value: unknown, field: string): string[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected string[] for '${field}', got ${typeof value}`);
        }
        if (!value.every((item): item is string => typeof item === "string")) {
            throw new Error(`Expected all elements of '${field}' to be strings`);
        }
        return value;
    }

    private assertRepoTargets(value: unknown, field: string): RepoPathRef[] {
        if (!Array.isArray(value)) {
            throw new Error(`Expected RepoPathRef[] for '${field}', got ${typeof value}`);
        }
        return value.map((item, index) => this.assertRepoTarget(item, `${field}[${index}]`));
    }

    private assertString(value: unknown, field: string): string {
        if (typeof value !== "string") {
            throw new Error(`Expected string for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertNumber(value: unknown, field: string): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`Expected number for '${field}', got ${typeof value}`);
        }
        return value;
    }

    private assertRepoTarget(value: unknown, field: string): RepoPathRef {
        if (!value || typeof value !== "object") {
            throw new Error(`Expected RepoPathRef for '${field}', got ${typeof value}`);
        }
        const raw = value as Partial<RepoPathRef>;
        return {
            repoRoot: this.assertString(raw.repoRoot, `${field}.repoRoot`),
            path: assertRepoRelativePath(this.assertString(raw.path, `${field}.path`)),
        };
    }

    private getRepositories(): RepositoryEntry[] {
        const repositories = this.listRepositories();
        if (repositories.length > 0) return repositories;
        const repoRoot = this.getRepoRootUri();
        if (!repoRoot || !this.repository) return [];
        return [
            {
                root: repoRoot.fsPath,
                uri: repoRoot,
                info: this.repository,
                gitOps: this.gitOps,
                executor: {} as RepositoryEntry["executor"],
            },
        ];
    }

    private getRepositoryEntry(root: string): RepositoryEntry {
        const repository =
            this.getRepositoryByRoot(root) ??
            this.getRepositories().find((entry) => entry.root === root) ??
            null;
        if (!repository) {
            throw new Error(`No IntelliGit repository found for '${root}'.`);
        }
        return repository;
    }

    private groupTargetsByRepository(targets: RepoPathRef[]): Map<string, string[]> {
        const grouped = new Map<string, string[]>();
        for (const target of targets) {
            const paths = grouped.get(target.repoRoot);
            if (paths) {
                paths.push(target.path);
            } else {
                grouped.set(target.repoRoot, [target.path]);
            }
        }
        return grouped;
    }

    private async runGroupedTargets(
        targets: RepoPathRef[],
        callback: (repository: RepositoryEntry, paths: string[]) => Promise<void>,
    ): Promise<void> {
        const failures: string[] = [];
        for (const [repoRoot, paths] of this.groupTargetsByRepository(targets)) {
            const repository = this.getRepositoryEntry(repoRoot);
            try {
                await callback(repository, paths);
            } catch (error) {
                const message = getErrorMessage(error);
                failures.push(`${repository.info.relativePath ?? repository.info.name}: ${message}`);
            }
        }
        if (failures.length > 0) {
            throw new Error(failures.length === 1 ? failures[0].replace(/^[^:]+:\s*/, "") : failures.join("\n"));
        }
    }

    private getMessageTargets(
        msg: { [key: string]: unknown },
        field: string = "targets",
        legacyField: string = "paths",
    ): RepoPathRef[] {
        if (msg[field] !== undefined) {
            return this.assertRepoTargets(msg[field], field);
        }
        if (msg[legacyField] !== undefined) {
            const repoRoot = this.getRepositoryRoot().fsPath;
            return this.assertStringArray(msg[legacyField], legacyField).map((path) => ({
                repoRoot,
                path: assertRepoRelativePath(path),
            }));
        }
        return [];
    }

    private getMessageTarget(
        msg: { [key: string]: unknown },
        field: string = "target",
        legacyField: string = "path",
    ): RepoPathRef {
        if (msg[field] !== undefined) {
            return this.assertRepoTarget(msg[field], field);
        }
        if (msg[legacyField] !== undefined) {
            return {
                repoRoot: this.getRepositoryRoot().fsPath,
                path: assertRepoRelativePath(this.assertString(msg[legacyField], legacyField)),
            };
        }
        throw new Error(`Expected RepoPathRef for '${field}', got undefined`);
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.refreshData();
                break;

            case "refresh":
                await this.refreshData();
                break;

            case "stageFiles": {
                const targets = this.getMessageTargets(msg);
                await this.runGroupedTargets(targets, async (repository, paths) => {
                    await repository.gitOps.stageFiles(paths);
                });
                await this.refreshData();
                break;
            }

            case "unstageFiles": {
                const targets = this.getMessageTargets(msg);
                await this.runGroupedTargets(targets, async (repository, paths) => {
                    await repository.gitOps.unstageFiles(paths);
                });
                await this.refreshData();
                break;
            }

            case "commitSelected": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                const push = msg.push === true;
                const targets = this.getMessageTargets(msg);
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                if (targets.length === 0 && !amend) {
                    vscode.window.showWarningMessage("Select files to commit.");
                    return;
                }
                if (amend || targets.length === 0) {
                    await runWithNotificationProgress(
                        push ? "Committing and pushing..." : "Committing...",
                        async () => {
                            if (push) {
                                await this.gitOps.commitAndPush(message, amend);
                            } else {
                                await this.gitOps.commit(message, amend);
                            }
                        },
                    );
                    vscode.window.showInformationMessage(
                        push ? "Committed and pushed successfully." : "Committed successfully.",
                    );
                } else {
                    const grouped = this.groupTargetsByRepository(targets);
                    const successes: string[] = [];
                    const failures: string[] = [];
                    await runWithNotificationProgress(
                        push ? "Committing and pushing..." : "Committing...",
                        async () => {
                            for (const [repoRoot, paths] of grouped) {
                                const repository = this.getRepositoryEntry(repoRoot);
                                try {
                                    await repository.gitOps.stageFiles(paths);
                                    if (push) {
                                        await repository.gitOps.commitAndPush(message, false, paths);
                                    } else {
                                        await repository.gitOps.commit(message, false, paths);
                                    }
                                    successes.push(repository.info.relativePath ?? repository.info.name);
                                } catch (error) {
                                    failures.push(
                                        `${repository.info.relativePath ?? repository.info.name}: ${getErrorMessage(error)}`,
                                    );
                                }
                            }
                        },
                    );
                    if (failures.length > 0) {
                        throw new Error(
                            `Committed ${successes.length} repos.\n${failures.join("\n")}`,
                        );
                    }
                    vscode.window.showInformationMessage(
                        `${push ? "Committed and pushed" : "Committed"} ${successes.length} repos: ${successes.join(", ")}`,
                    );
                }
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "commit": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                await runWithNotificationProgress("Committing...", async () => {
                    await this.gitOps.commit(message, amend);
                });
                vscode.window.showInformationMessage("Committed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "commitAndPush": {
                const message = (typeof msg.message === "string" ? msg.message : "").trim();
                const amend = msg.amend === true;
                if (!message && !amend) {
                    vscode.window.showWarningMessage("Enter a commit message.");
                    return;
                }
                await runWithNotificationProgress("Committing and pushing...", async () => {
                    await this.gitOps.commitAndPush(message, amend);
                });
                vscode.window.showInformationMessage("Committed and pushed successfully.");
                this.postToWebview({ type: "committed" });
                await this.refreshData();
                break;
            }

            case "getLastCommitMessage": {
                const lastMsg = await this.gitOps.getLastCommitMessage();
                this.postToWebview({ type: "lastCommitMessage", message: lastMsg });
                break;
            }

            case "rollback": {
                const targets = this.getMessageTargets(msg);
                if (targets.length === 0) {
                    const confirm = await vscode.window.showWarningMessage(
                        "Rollback all changes?",
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.gitOps.rollbackAll();
                } else {
                    const confirm = await vscode.window.showWarningMessage(
                        `Rollback ${targets.length} file(s)?`,
                        { modal: true },
                        "Rollback",
                    );
                    if (confirm !== "Rollback") return;
                    await this.runGroupedTargets(targets, async (repository, paths) => {
                        await repository.gitOps.rollbackFiles(paths);
                    });
                }
                vscode.window.showInformationMessage("Changes rolled back.");
                await this.refreshData();
                break;
            }

            case "showDiff": {
                const target = this.getMessageTarget(msg);
                const repository = this.getRepositoryEntry(target.repoRoot);
                const uri = vscode.Uri.joinPath(repository.uri, target.path);
                await vscode.commands.executeCommand("git.openChange", uri);
                break;
            }

            case "shelveSave": {
                const name = typeof msg.name === "string" ? msg.name : "Shelved changes";
                const targets = this.getMessageTargets(msg);
                if (!targets || targets.length === 0) {
                    await this.gitOps.shelveSave(undefined, name);
                } else {
                    await this.runGroupedTargets(targets, async (repository, paths) => {
                        await repository.gitOps.shelveSave(paths, name);
                    });
                }
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshData();
                break;
            }

            case "shelfPop": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelvePop(index);
                vscode.window.showInformationMessage("Unshelved changes.");
                await this.refreshData();
                break;
            }

            case "shelfApply": {
                const index = this.assertNumber(msg.index, "index");
                await this.gitOps.shelveApply(index);
                vscode.window.showInformationMessage("Applied shelved changes.");
                await this.refreshData();
                break;
            }

            case "shelfDelete": {
                const index = this.assertNumber(msg.index, "index");
                const confirm = await vscode.window.showWarningMessage(
                    "Delete this shelved change?",
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                await this.gitOps.shelveDelete(index);
                vscode.window.showInformationMessage("Shelved change deleted.");
                await this.refreshData();
                break;
            }

            case "shelfSelect": {
                this.selectedShelfIndex = this.assertNumber(msg.index, "index");
                this.shelfFiles = await this.iconTheme.decorateWorkingFiles(
                    await this.gitOps.getShelvedFiles(this.selectedShelfIndex),
                );
                this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                    ...this.files,
                    ...this.shelfFiles,
                ]);
                const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
                this.postToWebview({
                    type: "update",
                    repositories: this.getRepositories().map((entry) => entry.info),
                    files: this.files,
                    stashes: this.stashes,
                    shelfFiles: this.shelfFiles,
                    selectedShelfIndex: this.selectedShelfIndex,
                    folderIcon: folderIcons.folderIcon,
                    folderExpandedIcon: folderIcons.folderExpandedIcon,
                    folderIconsByName: this.folderIconsByName,
                    iconFonts,
                });
                break;
            }

            case "showShelfDiff": {
                const index = this.assertNumber(msg.index, "index");
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                const patch = await this.gitOps.getShelvedFilePatch(index, filePath);
                const doc = await vscode.workspace.openTextDocument({
                    content: patch || `No shelved diff found for ${filePath}.`,
                    language: "diff",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }

            case "openFile": {
                const target = this.getMessageTarget(msg);
                const repository = this.getRepositoryEntry(target.repoRoot);
                const uri = vscode.Uri.joinPath(repository.uri, target.path);
                await vscode.window.showTextDocument(uri);
                break;
            }

            case "deleteFile": {
                const target = this.getMessageTarget(msg);
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${target.path}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;
                const repository = this.getRepositoryEntry(target.repoRoot);
                const deleted = await deleteFileWithFallback(
                    repository.gitOps,
                    repository.uri,
                    target.path,
                );
                if (!deleted) return;
                vscode.window.showInformationMessage(`Deleted ${target.path}`);
                await this.refreshData();
                break;
            }

            case "showHistory": {
                const target = this.getMessageTarget(msg);
                const history = await this.getRepositoryEntry(target.repoRoot).gitOps.getFileHistory(
                    target.path,
                );
                const doc = await vscode.workspace.openTextDocument({
                    content: history || "No history found.",
                    language: "git-commit",
                });
                await vscode.window.showTextDocument(doc, { preview: true });
                break;
            }

            case "setCurrentRepository": {
                const repoRoot = this.assertString(msg.repoRoot, "repoRoot");
                await this.switchRepository(repoRoot);
                break;
            }
        }
    }

    private updateViewCount(count: number): void {
        this.lastFileCount = count;
        if (!this.view) return;
        this.view.description = count > 0 ? `${count}` : "";
    }

    private postToWebview(msg: InboundMessage): void {
        this.view?.webview.postMessage(msg);
    }

    private getRepositoryRoot(): vscode.Uri {
        const repoRoot = this.getRepoRootUri();
        if (!repoRoot) {
            throw new Error("No IntelliGit repository is selected.");
        }
        return repoRoot;
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitpanel.js",
            title: "Commit",
            backgroundVar: "var(--vscode-sideBar-background, var(--vscode-editor-background))",
        });
    }

    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onDidChangeFileCount.dispose();
    }

    private refreshDataWithErrorHandling(): void {
        this.refreshData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(message);
            this.postToWebview({ type: "error", message });
        });
    }

    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() => this.refreshDataWithErrorHandling()),
        );
    }

    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
