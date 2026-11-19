// WebviewViewProvider for the Commit panel in the sidebar.
// Shows working tree changes with checkboxes, commit message input,
// commit/push buttons, amend toggle, and shelf (stash) management.
// Frontend is a React + Chakra UI app loaded from dist/webview-commitpanel.js.

import * as vscode from "vscode";
import { GitOps, UpstreamPushDeclinedError } from "../git/operations";
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
import { showPushSuccessWithRequestLink } from "../utils/pushMergeRequest";
import {
    getDiffOriginalFilePathFromUri,
    getRepoRelativeFilePathFromUri,
    openShelvedFileDiff,
    openWorkingTreeFileDiff,
} from "../services/diffService";
import {
    openShelvedChanges,
    openWorkingTreeChanges,
} from "../services/multiDiffService";
import { buildFileTree, type TreeEntry } from "../webviews/react/shared/fileTree";
import type { InboundMessage } from "../webviews/react/commit-panel/types";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import type { RepositoryEntry } from "../services/RepositoryContextService";
type WorkingDiffTarget = RepoPathRef & { previewFiles?: RepoPathRef[] };

export interface DiffNavigationState {
    active: boolean;
    hasPrevious: boolean;
    hasNext: boolean;
    currentFile: number;
    totalFiles: number;
}

export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitPanel";

    private view?: vscode.WebviewView;
    private files: WorkingFile[] = [];
    private stashes: StashEntry[] = [];
    private selectedShelfIndex: number | null = null;
    private shelfFiles: WorkingFile[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private lastFileCount = 0;
    private committing = false;
    private shelfActionInProgress = false;
    private readonly previewTabs = new WeakMap<vscode.Tab, WorkingDiffTarget>();
    private activeFile: WorkingDiffTarget | null = null;
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
        private readonly onNavigationStateChange: () => void = () => {},
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
            const writesShelf = ["shelveSave", "shelfApply", "shelfPop", "shelfDelete"].includes(msg.type);
            if (writesShelf && this.shelfActionInProgress) return;
            if (writesShelf) this.shelfActionInProgress = true;
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
                this.postToWebview({ type: "error", message });
            } finally {
                if (writesShelf) this.shelfActionInProgress = false;
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
            this.setActiveFile(null);
            this._onDidChangeFileCount.fire(0);
            this.updateViewCount(0);
            this.postToWebview({
                type: "update",
                repositories: this.getRepositories().map((entry) => entry.info),
                conflictSessionRoots: [],
                amendableRoots: [],
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
            const statuses = await Promise.all(repositories.map(async entry => {
                const [files, operation, canAmend] = await Promise.all([
                    entry.gitOps.getStatus().then(files => this.iconTheme.decorateWorkingFiles(files)),
                    entry.gitOps.getConflictOperation(),
                    entry.gitOps.canAmendHead().catch(() => false),
                ]);
                return { root: entry.root, files, operation, canAmend };
            }));
            const files = statuses.flatMap(status => status.files);
            const stashes = await this.gitOps.listShelved();
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();

            const previous = this.stashes.find(entry => entry.index === this.selectedShelfIndex);
            const selectedStash = stashes.find(entry => entry.hash === previous?.hash) ?? stashes[0];
            const selectedShelfIndex = selectedStash?.index ?? null;
            const shelfFiles =
                selectedShelfIndex !== null
                    ? await this.iconTheme.decorateWorkingFiles(
                          await this.gitOps.getShelvedFiles(selectedShelfIndex, selectedStash.hash),
                      )
                    : [];
            const suggestedCommitMessage = await this.gitOps.getPendingCommitMessage();
            this.folderIconsByName = await this.iconTheme.getFolderIconsByWorkingFiles([
                ...files,
                ...shelfFiles,
            ]);

            this.files = files;
            if (this.activeFile && !this.hasWorkingFile(this.activeFile)) {
                this.setActiveFile(null);
            }
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
                conflictSessionRoots: statuses.filter(status => status.operation).map(status => status.root),
                amendableRoots: statuses.filter(status => status.canAmend).map(status => status.root),
                files,
                stashes,
                shelfFiles,
                selectedShelfIndex,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
                suggestedCommitMessage,
            });
            this.postActiveFile();
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

    private hasWorkingFile(target: RepoPathRef): boolean {
        return this.files.some(
            (file) => file.repoRoot === target.repoRoot && file.path === target.path,
        );
    }

    private setActiveFile(target: WorkingDiffTarget | null): void {
        if (
            this.activeFile?.repoRoot === target?.repoRoot &&
            this.activeFile?.path === target?.path &&
            this.activeFile?.previewFiles === target?.previewFiles
        ) {
            this.updateNavigationContexts();
            return;
        }
        this.activeFile = target;
        this.postActiveFile();
        this.updateNavigationContexts();
    }

    private postActiveFile(): void {
        const file = this.activeFile;
        this.postToWebview({ type: "setActiveFile", target: file && { path: file.path, repoRoot: file.repoRoot } });
    }

    private updateNavigationContexts(): void {
        this.onNavigationStateChange();
    }

    async getDiffNavigationState(
        editor: vscode.TextEditor | null | undefined = undefined,
    ): Promise<DiffNavigationState> {
        const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const preview = tab && this.previewTabs.get(tab);
        if (editor === null && !preview) {
            return {
                active: false,
                hasPrevious: false,
                hasNext: false,
                currentFile: 0,
                totalFiles: 0,
            };
        }
        const activeFile = editor ? this.getEditorTarget(editor) : preview ?? this.activeFile;
        const files = this.getVisibleWorkingFileTargets(activeFile);
        let currentIndex = activeFile
            ? files.findIndex(
                  (file) =>
                      file.repoRoot === activeFile.repoRoot && file.path === activeFile.path,
              )
            : -1;
        if (!activeFile) {
            return {
                active: false,
                hasPrevious: false,
                hasNext: false,
                currentFile: 0,
                totalFiles: 0,
            };
        }
        if (currentIndex < 0) {
            files.push(activeFile);
            currentIndex = files.length - 1;
        }
        return {
            active: true,
            hasPrevious: currentIndex > 0,
            hasNext: currentIndex < files.length - 1,
            currentFile: currentIndex + 1,
            totalFiles: files.length,
        };
    }

    private getEditorTarget(editor: vscode.TextEditor): WorkingDiffTarget | null {
        const uri = editor.document.uri;
        const groups = vscode.window.tabGroups;
        const group = groups?.all.find(candidate => candidate.viewColumn === editor.viewColumn) ?? groups?.activeTabGroup;
        const tab = group?.activeTab;
        const preview = tab && this.previewTabs.get(tab);
        if (preview) return preview;
        return this.getTargetForUri(uri);
    }

    private getTargetForUri(uri: vscode.Uri | undefined): WorkingDiffTarget | null {
        if (!uri) return null;
        const diffTarget = this.getCommitDiffTargetForUri(uri);
        if (diffTarget) return diffTarget;
        for (const repository of this.getRepositories()) {
            const filePath = getRepoRelativeFilePathFromUri(uri, repository.root);
            if (!filePath) continue;
            const target = { repoRoot: repository.root, path: filePath };
            return this.hasWorkingFile(target) ? target : null;
        }
        return null;
    }

    private getCommitDiffTargetForUri(uri: vscode.Uri): WorkingDiffTarget | null {
        if (uri.scheme !== "intelligit-diff" && uri.scheme !== "intelligit-diff-editable") {
            return null;
        }
        const query = new URLSearchParams(uri.query);
        const ref = query.get("ref");
        if (ref !== "HEAD" && ref !== "working-tree") return null;
        const filePath = getDiffOriginalFilePathFromUri(uri);
        if (!filePath) return null;
        if (this.activeFile?.path === filePath) return { repoRoot: this.activeFile.repoRoot, path: filePath };
        for (const repository of this.getRepositories()) {
            const target = { repoRoot: repository.root, path: filePath };
            if (this.hasWorkingFile(target)) return target;
        }
        return null;
    }

    syncActiveEditor(editor: vscode.TextEditor | undefined): void {
        if (!editor?.document.uri) {
            this.updateNavigationContexts();
            return;
        }
        const uri = editor.document.uri;
        const target = this.getEditorTarget(editor);
        if (target) {
            this.setActiveFile(target);
            return;
        }
        if (uri.scheme === "file") {
            this.setActiveFile(null);
            return;
        }
        if (uri.scheme === "intelligit-diff" || uri.scheme === "intelligit-diff-editable") {
            this.setActiveFile(null);
            return;
        }
        this.updateNavigationContexts();
    }

    getAdjacentWorkingFileTarget(
        direction: "next" | "previous",
        activeFile: WorkingDiffTarget | null = this.activeFile,
    ): RepoPathRef | null {
        if (!activeFile) return null;
        const uniqueTargets = this.getVisibleWorkingFileTargets(activeFile);
        const index = uniqueTargets.findIndex(
            (target) =>
                target.repoRoot === activeFile.repoRoot &&
                target.path === activeFile.path,
        );
        if (index < 0) return null;
        const nextIndex = direction === "next" ? index + 1 : index - 1;
        return uniqueTargets[nextIndex] ?? null;
    }

    private getVisibleWorkingFileTargets(scope: WorkingDiffTarget | null): RepoPathRef[] {
        if (scope?.previewFiles) return scope.previewFiles;
        const targets: RepoPathRef[] = [];
        const seen = new Set<string>();
        for (const repository of this.getRepositories()) {
            const repoFiles = this.files.filter((file) => file.repoRoot === repository.root);
            const tracked = repoFiles.filter((file) => file.status !== "?");
            const unversioned = repoFiles.filter((file) => file.status === "?");
            this.pushVisibleTreeTargets(targets, seen, buildFileTree(tracked));
            this.pushVisibleTreeTargets(targets, seen, buildFileTree(unversioned));
        }
        return targets;
    }

    private pushVisibleTreeTargets(
        targets: RepoPathRef[],
        seen: Set<string>,
        entries: TreeEntry<WorkingFile>[],
    ): void {
        for (const entry of entries) {
            if (entry.type === "folder") {
                this.pushVisibleTreeTargets(targets, seen, entry.children);
                continue;
            }
            const key = `${entry.file.repoRoot}\u0000${entry.file.path}`;
            if (seen.has(key)) continue;
            seen.add(key);
            targets.push({ repoRoot: entry.file.repoRoot, path: entry.file.path });
        }
    }

    async openWorkingFileDiff(target: RepoPathRef, previewFiles?: RepoPathRef[]): Promise<void> {
        const repository = this.getRepositoryEntry(target.repoRoot);
        const safePath = assertRepoRelativePath(target.path);
        const active = { repoRoot: repository.root, path: safePath, previewFiles };
        this.setActiveFile(active);
        const file =
            this.files.find((item) => item.repoRoot === repository.root && item.path === safePath) ??
            ({
                repoRoot: repository.root,
                path: safePath,
                status: "M",
                staged: false,
            } as WorkingFile);
        const index = previewFiles?.findIndex(item => item.path === safePath && item.repoRoot === repository.root);
        const title = previewFiles && index !== undefined
            ? `${safePath} (HEAD ↔ Working Tree) · ${index + 1}/${previewFiles.length}` : undefined;
        const tab = await openWorkingTreeFileDiff(file, repository.root, repository.gitOps, title);
        if (tab) this.previewTabs.delete(tab);
        if (previewFiles) {
            if (tab) this.previewTabs.set(tab, active);
            this.setActiveFile(active);
        }
    }

    async navigateFile(direction: "next" | "previous", editor?: vscode.TextEditor): Promise<void> {
        const tab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
        const active = editor ? this.getEditorTarget(editor) : (tab && this.previewTabs.get(tab)) ?? this.activeFile;
        const target = this.getAdjacentWorkingFileTarget(direction, active);
        if (target) await this.openWorkingFileDiff(target, active?.previewFiles);
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

    private hasPartiallyStagedTarget(targets: RepoPathRef[]): boolean {
        return targets.some((target) => {
            const matchingFiles = this.files.filter(
                (file) => file.repoRoot === target.repoRoot && file.path === target.path,
            );
            return (
                matchingFiles.some((file) => file.staged) &&
                matchingFiles.some((file) => !file.staged)
            );
        });
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

    private async commitCheckedFiles(repository: RepositoryEntry, paths: string[], message: string, amend: boolean): Promise<void> {
        const selected = new Set(paths);
        const renameSources = new Set<string>();
        const toStage = new Set(paths);
        for (const file of this.files) {
            if (file.repoRoot !== repository.root || !selected.has(file.path)) continue;
            if (file.renamedFrom && !selected.has(file.renamedFrom)) renameSources.add(file.renamedFrom);
            // A staged deletion is already absent from the index. If the user
            // recreated it, the unstaged row below will add its new contents.
            if (file.staged && file.status === "D") toStage.delete(file.path);
            if (!file.staged) toStage.add(file.path);
        }
        if (toStage.size) await repository.gitOps.stageFiles([...toStage]);
        if (renameSources.size) {
            await repository.gitOps.commitWithRenameSources(message, amend, paths, [...renameSources]);
        } else {
            await repository.gitOps.commit(message, amend, paths);
        }
    }

    private async commitFromPanel(msg: { type: string; [key: string]: unknown }): Promise<void> {
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        const amend = msg.amend === true;
        const push = msg.type === "commitAndPush" || msg.push === true;
        const selected = msg.type === "commitSelected";
        const targets = selected ? this.getMessageTargets(msg) : [];
        if (!message && !amend) {
            void vscode.window.showWarningMessage("Enter a commit message.");
            return;
        }
        if (selected && !amend && !targets.length) {
            void vscode.window.showWarningMessage("Select files to commit.");
            return;
        }
        const grouped = this.groupTargetsByRepository(targets);
        if (amend && grouped.size > 1) {
            void vscode.window.showWarningMessage("Amend one repository at a time. Select files from a single repository.");
            return;
        }
        if (!grouped.size) grouped.set(this.getRepositoryRoot().fsPath, []);
        // Preflight every selected repository before staging or committing in any of them.
        for (const root of grouped.keys()) {
            const repository = this.getRepositoryEntry(root);
            const operation = await repository.gitOps.getConflictOperation();
            if (operation) {
                void vscode.window.showWarningMessage(`${repository.info.name}: Finish the ${operation} in the Merge Conflicts panel.`);
                await this.refreshData();
                return;
            }
            if (amend && !(await repository.gitOps.canAmendHead())) {
                void vscode.window.showWarningMessage(`${repository.info.name}: Amend requires an unpushed commit. Create a new commit instead.`);
                await this.refreshData();
                return;
            }
        }

        if (this.hasPartiallyStagedTarget(targets)) {
            const answer = await vscode.window.showWarningMessage(
                "该文件还有未暂存的新修改，继续提交会将最新工作区版本一并暂存和提交。",
                { modal: true }, "继续提交",
            );
            if (answer !== "继续提交") return;
        }

        const commitErrors: string[] = [];
        const completed: string[] = [];
        const pushed: { name: string; output: string }[] = [];
        await runWithNotificationProgress(push ? "Committing and pushing..." : "Committing...", async () => {
            for (const [root, paths] of grouped) {
                const repository = this.getRepositoryEntry(root);
                const name = repository.info.relativePath ?? repository.info.name;
                const git = repository.gitOps;
                try {
                    if (selected) {
                        await this.commitCheckedFiles(repository, paths, message, amend);
                    } else {
                        await git.commit(message, amend);
                    }
                    completed.push(name);
                } catch (error) {
                    commitErrors.push(`${name}: ${getErrorMessage(error)}`);
                    continue;
                }
                if (push) {
                    const head = await git.getPushHead().catch(() => "");
                    try {
                        pushed.push({ name, output: await git.push() });
                    } catch (error) {
                        if (error instanceof UpstreamPushDeclinedError) {
                            void vscode.window.showInformationMessage(`${name}: Committed locally. Push canceled.`);
                        } else {
                            void this.reportPushFailure(repository, head, error);
                        }
                    }
                }
            }
        });
        if (!commitErrors.length) {
            const draftRevision = typeof msg.draftRevision === "number" ? msg.draftRevision : undefined;
            this.postCommitCompleted(message, amend, draftRevision);
        }
        await this.refreshData();
        if (pushed.length) {
            void showPushSuccessWithRequestLink(
                `Committed and pushed: ${pushed.map(item => item.name).join(", ")}`,
                pushed.map(item => item.output).join("\n"),
            );
        }
        if (commitErrors.length) {
            throw new Error(`Committed ${completed.length} repos.\n${commitErrors.join("\n")}`);
        }
        if (!push) {
            void vscode.window.showInformationMessage(`Committed successfully: ${completed.join(", ")}`);
        }
    }

    private async reportPushFailure(repository: RepositoryEntry, head: string, error: unknown): Promise<void> {
        const name = repository.info.name;
        const hash = head.split("\n")[0].slice(0, 8);
        const message = `${name}: Committed locally${hash ? " (" + hash + ")" : ""}. Push failed: ${getErrorMessage(error)}`;
        const retry = "Retry Push";
        const action = await vscode.window.showErrorMessage(message, ...(head ? [retry] : []));
        if (action !== retry) return;
        try {
            if (await repository.gitOps.getPushHead() !== head) {
                void vscode.window.showWarningMessage(`${name}: The branch or commit has changed. Push from the branch you want to publish.`);
                return;
            }
            const output = await runWithNotificationProgress("Pushing...", () => repository.gitOps.push());
            void showPushSuccessWithRequestLink(`Pushed ${name} successfully.`, output);
        } catch (retryError) {
            void vscode.window.showErrorMessage(`${name}: Push failed: ${getErrorMessage(retryError)}`);
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

    private getShelfSelection(msg: { [key: string]: unknown }) {
        const hash = this.assertString(msg.hash, "hash");
        const root = this.assertString(msg.repoRoot, "repoRoot");
        const entry = this.stashes.find(stash => stash.hash === hash);
        if (root !== this.repository?.root || !entry) throw new Error("Stash selection changed. Refresh the stash list.");
        return { entry, repository: this.getRepositoryEntry(root) };
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.refreshData();
                break;

            case "refresh":
                await this.refreshData();
                break;

            case "commitSelected":
            case "commit":
            case "commitAndPush": {
                if (this.committing) return;
                this.committing = true;
                try {
                    await this.commitFromPanel(msg);
                } finally {
                    this.committing = false;
                }
                break;
            }

            case "getLastCommitMessage": {
                const root = msg.repoRoot;
                if (typeof root === "string") {
                    const message = await this.getRepositoryEntry(root).gitOps.getLastCommitMessage();
                    this.postToWebview({ type: "amendMessage", repoRoot: root, message });
                } else {
                    const message = await this.gitOps.getLastCommitMessage();
                    this.postToWebview({ type: "lastCommitMessage", message });
                }
                break;
            }

            case "rollback": {
                const targets = this.getMessageTargets(msg);
                const grouped = this.groupTargetsByRepository(targets);
                if (!grouped.size) grouped.set(this.getRepositoryRoot().fsPath, []);
                const repositories = Array.from(grouped.keys(), root => this.getRepositoryEntry(root));
                const confirm = await vscode.window.showWarningMessage(
                    targets.length ? `Rollback ${targets.length} file(s)?` : "Rollback all changes?",
                    { modal: true }, "Rollback",
                );
                if (confirm !== "Rollback") return;
                // Check all selected repositories before changing any of them.
                for (const repository of repositories) {
                    const operation = await repository.gitOps.getConflictOperation();
                    if (operation) {
                        void vscode.window.showWarningMessage(`${repository.info.name}: Use the Merge Conflicts panel to finish or abort the ${operation}.`);
                        await this.refreshData();
                        return;
                    }
                }
                if (!targets.length) {
                    await repositories[0].gitOps.rollbackAll();
                } else {
                    await this.runGroupedTargets(targets, (repository, paths) => repository.gitOps.rollbackFiles(paths));
                }
                vscode.window.showInformationMessage("Changes rolled back.");
                await this.refreshData();
                break;
            }

            case "openMergeSession": {
                const root = this.assertString(msg.repoRoot, "repoRoot");
                await vscode.commands.executeCommand("intelligit.openConflictSession", this.getRepositoryEntry(root).root);
                break;
            }

            case "previewCheckedDiffs": {
                const targets = this.getMessageTargets(msg).filter(file => this.hasWorkingFile(file));
                if (targets.length) await this.openWorkingFileDiff(targets[0], targets);
                break;
            }

            case "showDiff": {
                const target = this.getMessageTarget(msg);
                await this.openWorkingFileDiff(target);
                break;
            }

            case "showAllDiffs": {
                const repoRoot = this.assertString(msg.repoRoot, "repoRoot");
                const repository = this.getRepositoryEntry(repoRoot);
                const files = this.files.filter((file) => file.repoRoot === repository.root);
                if (files.length > 0) {
                    await openWorkingTreeChanges(files, repository.root, repository.executor);
                }
                break;
            }

            case "shelveSave": {
                const name = typeof msg.name === "string" ? msg.name : "Shelved changes";
                const keepIndex = msg.keepIndex === true;
                const repoRoot = typeof msg.repoRoot === "string" ? msg.repoRoot : undefined;
                const targets = this.getMessageTargets(msg);
                if (targets.length === 0) {
                    const repository = repoRoot ? this.getRepositoryEntry(repoRoot) : null;
                    await (repository?.gitOps ?? this.gitOps).shelveSave(undefined, name, {
                        keepIndex,
                    });
                } else {
                    await this.runGroupedTargets(targets, async (repository, paths) => {
                        await repository.gitOps.shelveSave(paths, name, { keepIndex });
                    });
                }
                vscode.window.showInformationMessage("Changes shelved.");
                await this.refreshData();
                break;
            }

            case "shelfPop":
            case "shelfApply":
            case "shelfDelete": {
                const { entry, repository } = this.getShelfSelection(msg);
                const { hash } = entry;
                if (msg.type === "shelfDelete") {
                    const confirm = await vscode.window.showWarningMessage(
                        `Delete stash “${entry.message}” (${hash.slice(0, 8)})?`,
                        { modal: true }, "Delete",
                    );
                    if (confirm !== "Delete") return;
                }
                try {
                    if (msg.type === "shelfDelete") await repository.gitOps.shelveDelete(hash);
                    else if (msg.type === "shelfApply") await repository.gitOps.shelveApply(hash);
                    else await repository.gitOps.shelvePop(hash);
                } finally {
                    await this.refreshData();
                }
                void vscode.window.showInformationMessage(msg.type === "shelfDelete" ? "Shelved change deleted." : "Applied shelved changes.");
                break;
            }

            case "shelfSelect": {
                const { entry, repository } = this.getShelfSelection(msg);
                this.selectedShelfIndex = entry.index;
                const files = await this.iconTheme.decorateWorkingFiles(
                    await repository.gitOps.getShelvedFiles(entry.index, entry.hash),
                );
                if (this.repository?.root !== repository.root ||
                    this.stashes.find(stash => stash.index === this.selectedShelfIndex)?.hash !== entry.hash) break;
                this.shelfFiles = files;
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
                const { entry, repository } = this.getShelfSelection(msg);
                const filePath = assertRepoRelativePath(this.assertString(msg.path, "path"));
                await openShelvedFileDiff(entry.index, filePath, repository.root, repository.gitOps, entry.hash);
                break;
            }

            case "showAllShelfDiff": {
                const index = this.assertNumber(msg.index, "index");
                const hash = this.assertString(msg.hash, "hash");
                const repoRoot = this.assertString(msg.repoRoot, "repoRoot");
                const repository = this.getRepositoryEntry(repoRoot);
                if (this.repository?.root !== repository.root) {
                    throw new Error("The selected repository changed. Refresh the commit panel.");
                }
                if (!this.stashes.some((stash) => stash.index === index && stash.hash === hash)) {
                    throw new Error(`Stash is no longer available: ${index}`);
                }
                await openShelvedChanges(index, repository.root, repository.executor, hash);
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

    private postCommitCompleted(message: string, amend: boolean, draftRevision?: number): void {
        const clearCommitMessage = vscode.workspace
            .getConfiguration("intelligit")
            .get<boolean>("clearLastCommit", true);
        this.postToWebview({
            type: "committed",
            draftRevision,
            amend,
            message: clearCommitMessage ? "" : message,
        });
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
