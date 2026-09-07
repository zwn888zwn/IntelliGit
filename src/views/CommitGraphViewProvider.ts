// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type {
    Branch,
    Commit,
    CommitDetail,
    GraphRefInfo,
    GitTag,
    GitWorktree,
    RepositoryContextInfo,
    ThemeFolderIconMap,
} from "../types";
import type {
    BranchAction,
    BranchPopupAction,
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
    CreateWorktreePayload,
    OpenWorktreeDialogPayload,
    WorktreePathPayload,
} from "../webviews/react/commitGraphTypes";
import { getErrorMessage } from "../utils/errors";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import { parseWorktreeListPorcelain } from "../services/worktreeService";

interface CommitGraphRefreshOptions {
    reset?: boolean;
}

export class CommitGraphViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "intelligit.commitGraph";

    private view?: vscode.WebviewView;
    private currentBranch: string | null = null;
    private filterText = "";
    private offset = 0;
    private loadingMore = false;
    private webviewReady = false;
    private pendingRevealHash: string | null = null;
    private pendingBranchPopup = false;
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;
    private repository: RepositoryContextInfo | null = null;

    private branches: Branch[] = [];
    private branchSnapshotsByRoot: Record<string, Branch[]> = {};
    private worktreeSnapshotsByRoot: Record<string, GitWorktree[]> = {};
    private selectedCommitDetail: CommitDetail | null = null;
    private loadedCommits: Commit[] = [];
    private folderIconsByName: ThemeFolderIconMap = {};
    private branchFolderIconsByName: ThemeFolderIconMap = {};
    private commitDetailSeq = 0;
    private themeChangeDisposables: vscode.Disposable[] = [];
    private readonly iconTheme: IconThemeService;

    private readonly _onCommitSelected = new vscode.EventEmitter<{ hash: string; repoRoot: string }>();
    readonly onCommitSelected = this._onCommitSelected.event;

    private readonly _onBranchFilterChanged = new vscode.EventEmitter<string | null>();
    readonly onBranchFilterChanged = this._onBranchFilterChanged.event;

    private readonly _onBranchAction = new vscode.EventEmitter<{
        action: BranchAction;
        branchName: string;
        repoRoot?: string;
        allRepositories?: boolean;
    }>();
    readonly onBranchAction = this._onBranchAction.event;

    private readonly _onBranchPopupAction = new vscode.EventEmitter<{
        action: BranchPopupAction;
        root?: string;
        refName?: string;
        allRepositories?: boolean;
    }>();
    readonly onBranchPopupAction = this._onBranchPopupAction.event;

    private readonly _onChooseWorktreeLocation = new vscode.EventEmitter<{
        currentLocation?: string;
    }>();
    readonly onChooseWorktreeLocation = this._onChooseWorktreeLocation.event;

    private readonly _onCreateWorktree = new vscode.EventEmitter<CreateWorktreePayload>();
    readonly onCreateWorktree = this._onCreateWorktree.event;

    private readonly _onOpenWorktree = new vscode.EventEmitter<WorktreePathPayload>();
    readonly onOpenWorktree = this._onOpenWorktree.event;

    private readonly _onDeleteWorktree = new vscode.EventEmitter<WorktreePathPayload>();
    readonly onDeleteWorktree = this._onDeleteWorktree.event;

    private readonly _onCommitAction = new vscode.EventEmitter<{
        action: CommitAction;
        hash: string;
        repoRoot: string;
    }>();
    readonly onCommitAction = this._onCommitAction.event;

    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
        repoRoot: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly listRepositories: () => RepositoryEntry[] = () => [],
        private readonly getRepositoryByRoot: (root: string) => RepositoryEntry | null = () => null,
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
        this.webviewReady = false;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        };
        this.iconTheme.attachWebview(webviewView.webview);
        this.registerThemeChangeListeners();

        webviewView.onDidDispose(() => {
            if (this.view === webviewView) {
                this.view = undefined;
                this.webviewReady = false;
                this.iconTheme.dispose();
                this.disposeThemeChangeDisposables();
            }
        });

        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg: CommitGraphOutbound) => {
            try {
                switch (msg.type) {
                    case "ready":
                        this.webviewReady = true;
                        await this.iconTheme.initIconThemeData();
                        await this.sendBranches();
                        await this.loadInitial();
                        this.postCommitDetailState();
                        if (this.pendingRevealHash) {
                            const hash = this.pendingRevealHash;
                            this.pendingRevealHash = null;
                            await this.revealCommit(hash);
                        }
                        if (this.pendingBranchPopup) {
                            this.pendingBranchPopup = false;
                            this.postToWebview({ type: "openBranchPopup" });
                        }
                        break;
                    case "selectCommit":
                        if (msg.repoRoot) {
                            this._onCommitSelected.fire({ hash: msg.hash, repoRoot: msg.repoRoot });
                        } else {
                            this._onCommitSelected.fire(msg.hash as never);
                        }
                        break;
                    case "revealCommit":
                        await this.revealCommit(msg.hash);
                        break;
                    case "loadMore":
                        await this.loadMore();
                        break;
                    case "filterText":
                        await this.filterByText(msg.text);
                        break;
                    case "filterBranch":
                        this.currentBranch = msg.branch;
                        this.filterText = "";
                        this._onBranchFilterChanged.fire(msg.branch);
                        this.postToWebview({ type: "setSelectedBranch", branch: msg.branch });
                        this.postToWebview({ type: "setFilterText", text: "" });
                        await this.loadInitial();
                        break;
                    case "branchAction":
                        this._onBranchAction.fire({
                            action: msg.action,
                            branchName: msg.branchName,
                            repoRoot: msg.repoRoot,
                            allRepositories: msg.allRepositories,
                        });
                        break;
                    case "branchPopupAction":
                        this._onBranchPopupAction.fire({
                            action: msg.action,
                            root: msg.root,
                            refName: msg.refName,
                            allRepositories: msg.allRepositories,
                        });
                        break;
                    case "chooseWorktreeLocation":
                        this._onChooseWorktreeLocation.fire({
                            currentLocation: msg.currentLocation,
                        });
                        break;
                    case "createWorktree":
                        this._onCreateWorktree.fire(msg.payload);
                        break;
                    case "openWorktree":
                        this._onOpenWorktree.fire(msg.payload);
                        break;
                    case "deleteWorktree":
                        this._onDeleteWorktree.fire(msg.payload);
                        break;
                    case "commitAction":
                        if (msg.repoRoot) {
                            this._onCommitAction.fire({
                                action: msg.action,
                                hash: msg.hash,
                                repoRoot: msg.repoRoot,
                            });
                        } else {
                            this._onCommitAction.fire({
                                action: msg.action,
                                hash: msg.hash,
                            } as never);
                        }
                        break;
                    case "openCommitFileDiff":
                        if (msg.repoRoot) {
                            this._onOpenCommitFileDiff.fire({
                                commitHash: msg.commitHash,
                                filePath: msg.filePath,
                                repoRoot: msg.repoRoot,
                            });
                        } else {
                            this._onOpenCommitFileDiff.fire({
                                commitHash: msg.commitHash,
                                filePath: msg.filePath,
                            } as never);
                        }
                        break;
                }
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Commit graph error: ${message}`);
                this.postToWebview({ type: "error", message });
            }
        });
    }

    setBranches(branches: Branch[]): void {
        this.branches = branches;
    }

    openBranchPopup(): void {
        if (!this.webviewReady) {
            this.pendingBranchPopup = true;
            return;
        }

        this.postToWebview({ type: "openBranchPopup" });
    }

    openWorktreeDialog(payload: OpenWorktreeDialogPayload): void {
        this.postToWebview({ type: "openWorktreeDialog", payload });
    }

    setWorktreeLocationSelected(location: string): void {
        this.postToWebview({ type: "worktreeLocationSelected", location });
    }

    setWorktreeCreateResult(result: { success: true; path: string } | { success: false; message: string }): void {
        this.postToWebview(
            result.success
                ? { type: "worktreeCreateResult", success: true, path: result.path }
                : { type: "worktreeCreateResult", success: false, message: result.message },
        );
    }

    setRepositoryWorktrees(root: string, worktrees: GitWorktree[]): void {
        this.worktreeSnapshotsByRoot = {
            ...this.worktreeSnapshotsByRoot,
            [root]: worktrees,
        };
        this.postToWebview({
            type: "setRepositoryWorktrees",
            worktreesByRoot: this.worktreeSnapshotsByRoot,
        });
    }

    openWorktreesDialog(root?: string): void {
        this.postToWebview(
            root
                ? { type: "openWorktreesDialog", repoRoot: root }
                : { type: "openWorktreesDialog" },
        );
    }

    setWorktreeDeleteResult(result: { success: true; path: string } | { success: false; message: string }): void {
        this.postToWebview(
            result.success
                ? { type: "worktreeDeleteResult", success: true, path: result.path }
                : { type: "worktreeDeleteResult", success: false, message: result.message },
        );
    }

    setRepositoryContext(repository: RepositoryContextInfo | null): void {
        this.repository = repository;
        this.postToWebview({ type: "setRepositoryContext", repository });
        if (!repository) {
            this.currentBranch = null;
            this.filterText = "";
            this.offset = 0;
            this.loadingMore = false;
            this.loadedCommits = [];
            this.postToWebview({ type: "setSelectedBranch", branch: null });
            this.postToWebview({ type: "setFilterText", text: "" });
            this.postToWebview({
                type: "loadCommits",
                commits: [],
                hasMore: false,
                append: false,
                unpushedHashes: [],
            });
            this.postToWebview({ type: "clearCommitDetail" });
        }
    }

    async filterByBranch(branch: string | null): Promise<void> {
        this.currentBranch = branch;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch });
        this.postToWebview({ type: "setFilterText", text: "" });
        await this.loadInitial();
    }

    async refresh(options: CommitGraphRefreshOptions = {}): Promise<void> {
        // The ready handler loads the initial snapshot once the webview can receive it.
        if (!this.webviewReady) return;
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        if (options.reset) {
            await this.loadInitial();
            return;
        }
        await this.reloadCurrentWindow();
    }

    setCommitDetail(detail: CommitDetail): void {
        const requestId = ++this.commitDetailSeq;
        this.selectedCommitDetail = detail;
        this.folderIconsByName = {};
        this.postCommitDetailState();
        this.decorateAndStoreCommitDetail(detail, requestId).catch((err) => {
            if (requestId !== this.commitDetailSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Commit detail error: ${message}`);
        });
    }

    clearCommitDetail(): void {
        this.commitDetailSeq += 1;
        this.selectedCommitDetail = null;
        this.folderIconsByName = {};
        this.postCommitDetailState();
    }

    private getRepositories(): RepositoryEntry[] {
        const repositories = this.listRepositories();
        if (repositories.length > 0) return repositories;
        if (!this.repository) return [];
        return [
            {
                root: this.repository.root,
                uri: { fsPath: this.repository.root, path: this.repository.root } as vscode.Uri,
                info: this.repository,
                gitOps: this.gitOps,
                executor: {} as RepositoryEntry["executor"],
            },
        ];
    }

    async revealCommit(hash: string): Promise<void> {
        this.pendingRevealHash = hash;
        if (!this.webviewReady) return;

        const requestId = ++this.requestSeq;
        this.loadingMore = false;
        this.currentBranch = null;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch: null });
        this.postToWebview({ type: "setFilterText", text: "" });

        try {
            const [loadResult, unpushedHashes] = await Promise.all([
                this.loadCommitsUntilHash(hash, requestId),
                this.getUnpushedHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            const commits = loadResult.commits;
            const foundCommit = commits.find((commit) => this.matchesCommitHash(commit, hash)) ?? null;
            this.loadedCommits = commits;
            this.offset = commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: loadResult.hasMore,
                append: false,
                unpushedHashes,
            });

            if (!foundCommit) {
                if (this.pendingRevealHash === hash) {
                    this.pendingRevealHash = null;
                }
                vscode.window.showWarningMessage(`Commit '${hash.slice(0, 8)}' was not found.`);
                return;
            }

            this.postToWebview({ type: "revealCommit", hash: foundCommit.hash });
            if (this.pendingRevealHash === hash) {
                this.pendingRevealHash = null;
            }

            try {
                const detail = foundCommit.repoRoot
                    ? await this.getRepositoryEntry(foundCommit.repoRoot).gitOps.getCommitDetail(foundCommit.hash)
                    : await this.gitOps.getCommitDetail(foundCommit.hash);
                if (requestId !== this.requestSeq) return;
                this.setCommitDetail(detail);
            } catch (err) {
                if (requestId !== this.requestSeq) return;
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Commit graph error: ${message}`);
                this.postToWebview({ type: "error", message });
            }
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Commit graph error: ${message}`);
            this.postToWebview({ type: "error", message });
        }
    }

    private async sendBranches(): Promise<void> {
        const repositories = this.getRepositories();
        const branchesByRoot: Record<string, Branch[]> = {};
        const tagsByRoot: Record<string, GitTag[]> = {};
        const worktreesByRoot: Record<string, GitWorktree[]> = {};
        await Promise.all(
            repositories.map(async (entry) => {
                if (entry.root === this.repository?.root) {
                    branchesByRoot[entry.root] = this.branches;
                } else {
                    branchesByRoot[entry.root] = await entry.gitOps.getBranches().catch(() => []);
                }
                tagsByRoot[entry.root] =
                    typeof (entry.gitOps as Partial<GitOps>).getTags === "function"
                        ? await entry.gitOps.getTags().catch(() => [])
                        : [];
                worktreesByRoot[entry.root] = await this.getWorktrees(entry);
            }),
        );
        this.branchSnapshotsByRoot = branchesByRoot;
        this.worktreeSnapshotsByRoot = worktreesByRoot;
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setRepositories",
            repositories: repositories.map((entry) => entry.info),
        });
        this.postToWebview({ type: "setRepositoryBranches", branchesByRoot });
        this.postToWebview({ type: "setRepositoryTags", tagsByRoot });
        this.postToWebview({ type: "setRepositoryWorktrees", worktreesByRoot });
        this.postToWebview({ type: "setRepositoryContext", repository: this.repository });
        this.postToWebview({
            type: "setBranches",
            branches: this.branches,
            folderIcon: folderIcons.folderIcon,
            folderExpandedIcon: folderIcons.folderExpandedIcon,
            folderIconsByName: this.branchFolderIconsByName,
            iconFonts,
        });
    }

    private async getWorktrees(entry: RepositoryEntry): Promise<GitWorktree[]> {
        if (typeof entry.executor?.run !== "function") return [];
        try {
            return parseWorktreeListPorcelain(
                await entry.executor.run(["worktree", "list", "--porcelain"]),
            );
        } catch {
            return [];
        }
    }

    private async loadInitial(): Promise<void> {
        const requestId = ++this.requestSeq;
        this.offset = 0;
        this.loadingMore = false;

        if (this.getRepositories().length === 0) {
            this.loadedCommits = [];
            this.postToWebview({
                type: "loadCommits",
                commits: [],
                hasMore: false,
                append: false,
                unpushedHashes: [],
            });
            return;
        }

        if (this.currentBranch && !this.branches.some((b) => b.name === this.currentBranch)) {
            this.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
        }

        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.loadPage(0),
                this.getUnpushedHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset = commits.length;
            this.loadedCommits = commits;
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: false,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        }
    }

    private async reloadCurrentWindow(): Promise<void> {
        if (this.loadedCommits.length === 0) {
            await this.loadInitial();
            return;
        }

        const requestId = ++this.requestSeq;
        this.loadingMore = false;

        if (this.getRepositories().length === 0) {
            this.loadedCommits = [];
            this.offset = 0;
            this.postToWebview({
                type: "loadCommits",
                commits: [],
                hasMore: false,
                append: false,
                unpushedHashes: [],
            });
            return;
        }

        if (this.currentBranch && !this.branches.some((branch) => branch.name === this.currentBranch)) {
            this.currentBranch = null;
            this.postToWebview({ type: "setSelectedBranch", branch: null });
            await this.loadInitial();
            return;
        }

        const windowSize = Math.max(this.loadedCommits.length, this.offset, this.PAGE_SIZE);

        try {
            const [loadResult, unpushedHashes] = await Promise.all([
                this.loadWindow(windowSize),
                this.getUnpushedHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.loadedCommits = loadResult.commits;
            this.offset = loadResult.commits.length;
            this.postToWebview({
                type: "loadCommits",
                commits: loadResult.commits,
                hasMore: loadResult.hasMore,
                append: false,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        }
    }

    private async loadMore(): Promise<void> {
        if (this.getRepositories().length === 0 || this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.loadPage(this.offset),
                this.getUnpushedHashes(),
            ]);
            if (requestId !== this.requestSeq) return;
            this.offset += commits.length;
            this.loadedCommits = [...this.loadedCommits, ...commits];
            this.postToWebview({
                type: "loadCommits",
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
                append: true,
                unpushedHashes,
            });
        } catch (err) {
            if (requestId !== this.requestSeq) return;
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Git log error: ${message}`);
            this.postToWebview({ type: "loadError", message });
        } finally {
            if (requestId === this.requestSeq) {
                this.loadingMore = false;
            }
        }
    }

    private async filterByText(text: string): Promise<void> {
        this.filterText = text;
        await this.loadInitial();
    }

    private async loadCommitsUntilHash(
        hash: string,
        requestId: number,
    ): Promise<{ commits: Commit[]; hasMore: boolean }> {
        if (this.currentBranch) {
            const commits = await this.loadPage(0);
            return {
                commits,
                hasMore: commits.length >= this.PAGE_SIZE,
            };
        }
        const commits: Commit[] = [];
        let skip = 0;

        for (;;) {
            const page = await this.loadPage(skip);
            if (requestId !== this.requestSeq) return { commits, hasMore: false };
            commits.push(...page);
            if (page.some((commit) => this.matchesCommitHash(commit, hash))) {
                return { commits, hasMore: page.length >= this.PAGE_SIZE };
            }
            if (page.length < this.PAGE_SIZE) {
                return { commits, hasMore: false };
            }
            skip += page.length;
        }
    }

    private async loadWindow(count: number): Promise<{ commits: Commit[]; hasMore: boolean }> {
        const limit = Math.max(count, 1);
        if (this.isHashFilterQuery(this.filterText)) {
            const commits = await this.loadHashSearchResults(this.filterText, limit);
            return {
                commits: this.decorateCommitsWithGraphRefs(commits.slice(0, limit)),
                hasMore: commits.length > limit,
            };
        }

        if (this.currentBranch) {
            if (!this.repository) return { commits: [], hasMore: false };
            const commits = await this.gitOps.getLog(
                limit + 1,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
                0,
            );
            return {
                commits: commits.slice(0, limit),
                hasMore: commits.length > limit,
            };
        }

        const pages = await Promise.all(
            this.getRepositories().map(async (entry) =>
                entry.gitOps.getLog(limit + 1, undefined, this.filterText || undefined, 0),
            ),
        );

        const merged = this.decorateCommitsWithGraphRefs(
            pages.length === 1
                ? pages[0]
                : pages.flat().sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
        );
        return {
            commits: merged.slice(0, limit),
            hasMore: merged.length > limit,
        };
    }

    private matchesCommitHash(commit: Commit, hash: string): boolean {
        const normalizedHash = hash.trim().toLowerCase();
        if (!normalizedHash) return false;

        const fullHash = commit.hash.toLowerCase();
        const shortHash = commit.shortHash.toLowerCase();
        return (
            fullHash === normalizedHash ||
            shortHash === normalizedHash ||
            fullHash.startsWith(normalizedHash) ||
            shortHash.startsWith(normalizedHash)
        );
    }

    private async loadPage(skip: number): Promise<Commit[]> {
        if (this.isHashFilterQuery(this.filterText)) {
            const commits = await this.loadHashSearchResults(
                this.filterText,
                skip + this.PAGE_SIZE,
            );
            return commits.slice(skip, skip + this.PAGE_SIZE);
        }

        if (this.currentBranch) {
            if (!this.repository) return [];
            return this.decorateCommitsWithGraphRefs(
                await this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    skip,
                ),
            );
        }

        const pages = await Promise.all(
            this.getRepositories().map(async (entry) =>
                entry.gitOps.getLog(
                    this.PAGE_SIZE + skip,
                    undefined,
                    this.filterText || undefined,
                    0,
                ),
            ),
        );

        return this.decorateCommitsWithGraphRefs((pages.length === 1
            ? pages[0]
            : pages.flat().sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        )).slice(skip, skip + this.PAGE_SIZE);
    }

    private async getUnpushedHashes(): Promise<string[]> {
        if (this.currentBranch) {
            return this.gitOps.getUnpushedCommitHashes();
        }
        const hashes = await Promise.all(
            this.getRepositories().map((entry) => entry.gitOps.getUnpushedCommitHashes()),
        );
        return Array.from(new Set(hashes.flat()));
    }

    private isHashFilterQuery(text: string): boolean {
        const normalized = text.trim();
        return normalized.length >= 4 && /^[0-9a-f]+$/i.test(normalized);
    }

    private async loadHashSearchResults(hashPrefix: string, limit: number): Promise<Commit[]> {
        if (this.currentBranch) {
            if (!this.repository) return [];
            return this.decorateCommitsWithGraphRefs(
                await this.gitOps.findCommitsByHashPrefix(hashPrefix, limit + 1, this.currentBranch),
            );
        }

        const pages = await Promise.all(
            this.getRepositories().map((entry) =>
                entry.gitOps.findCommitsByHashPrefix(hashPrefix, limit + 1),
            ),
        );

        return this.decorateCommitsWithGraphRefs((pages.length === 1
            ? pages[0]
            : pages.flat().sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        )).slice(0, limit + 1);
    }

    private decorateCommitsWithGraphRefs(commits: Commit[]): Commit[] {
        // Shared histories can appear in several repositories. Deduplicate before
        // pagination so each hash has exactly one row and one graph node.
        const seenHashes = new Set<string>();
        return commits.filter((commit) => {
            if (seenHashes.has(commit.hash)) return false;
            seenHashes.add(commit.hash);
            return true;
        }).map((commit) => ({
            ...commit,
            graphRefs: this.buildGraphRefs(commit),
        }));
    }

    private buildGraphRefs(commit: Commit): GraphRefInfo[] {
        const branches = this.branchSnapshotsByRoot[commit.repoRoot] ?? [];
        const trackedRemoteNames = new Set(
            branches
                .filter((branch) => !branch.isRemote && Boolean(branch.upstream))
                .map((branch) => branch.upstream as string),
        );

        const graphRefs: GraphRefInfo[] = [];
        for (const ref of commit.refs) {
            if (ref === "HEAD" || ref.startsWith("HEAD -> ")) {
                if (ref.startsWith("HEAD -> ")) {
                    const branchName = ref.slice("HEAD -> ".length).trim();
                    graphRefs.push({ name: branchName, type: "head" });
                    graphRefs.push({ name: branchName, type: "local" });
                    continue;
                }
                graphRefs.push({ name: "HEAD", type: "head" });
                continue;
            }
            if (ref.startsWith("tag:")) {
                graphRefs.push({ name: ref.slice("tag:".length).trim(), type: "tag" });
                continue;
            }

            const branch = branches.find((item) => item.name === ref);
            if (branch) {
                if (branch.isRemote) {
                    graphRefs.push({
                        name: branch.name,
                        type: "remote",
                        tracked: trackedRemoteNames.has(branch.name),
                    });
                    continue;
                }
                graphRefs.push({ name: branch.name, type: "local" });
                continue;
            }

            if (/^[^/]+\/HEAD$/.test(ref)) {
                graphRefs.push({ name: ref, type: "other" });
                continue;
            }
            if (/^[^/]+\/.+/.test(ref)) {
                graphRefs.push({
                    name: ref,
                    type: "remote",
                    tracked: trackedRemoteNames.has(ref),
                });
                continue;
            }
            graphRefs.push({ name: ref, type: "other" });
        }

        const seen = new Set<string>();
        return graphRefs.filter((ref) => {
            const key = `${ref.type}:${ref.name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    private getRepositoryEntry(root: string): RepositoryEntry {
        const repository =
            this.getRepositoryByRoot(root) ??
            this.getRepositories().find((entry) => entry.root === root) ??
            null;
        if (!repository) {
            throw new Error(`No repository found for '${root}'.`);
        }
        return repository;
    }

    private postToWebview(msg: CommitGraphInbound): void {
        this.view?.webview.postMessage(msg);
    }

    private postCommitDetailState(): void {
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        if (this.selectedCommitDetail) {
            this.postToWebview({
                type: "setCommitDetail",
                detail: this.selectedCommitDetail,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName: this.folderIconsByName,
                iconFonts,
            });
            return;
        }
        this.postToWebview({ type: "clearCommitDetail" });
    }

    private async decorateAndStoreCommitDetail(
        detail: CommitDetail,
        requestId: number,
    ): Promise<void> {
        const decorated = await this.iconTheme.decorateCommitDetailWithFolderIcons(detail);
        if (requestId !== this.commitDetailSeq) return;
        this.selectedCommitDetail = decorated.detail;
        this.folderIconsByName = decorated.folderIconsByName;
        this.postCommitDetailState();
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-commitgraph.js",
            title: "Commit Graph",
            backgroundVar: "var(--vscode-editor-background)",
        });
    }

    dispose(): void {
        this.iconTheme.dispose();
        this.disposeThemeChangeDisposables();
        this._onCommitSelected.dispose();
        this._onBranchFilterChanged.dispose();
        this._onBranchAction.dispose();
        this._onBranchPopupAction.dispose();
        this._onChooseWorktreeLocation.dispose();
        this._onCreateWorktree.dispose();
        this._onOpenWorktree.dispose();
        this._onDeleteWorktree.dispose();
        this._onCommitAction.dispose();
        this._onOpenCommitFileDiff.dispose();
    }

    private refreshThemeDataWithErrorHandling(): void {
        this.refreshThemeData().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Commit graph error: ${message}`);
            this.postToWebview({ type: "error", message });
        });
    }

    private async refreshThemeData(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        if (!this.selectedCommitDetail) {
            this.postCommitDetailState();
            return;
        }
        const requestId = ++this.commitDetailSeq;
        await this.decorateAndStoreCommitDetail(this.selectedCommitDetail, requestId);
    }

    private registerThemeChangeListeners(): void {
        this.themeChangeDisposables.push(
            ...registerThemeChangeListeners(() => this.refreshThemeDataWithErrorHandling()),
        );
    }

    private disposeThemeChangeDisposables(): void {
        disposeAll(this.themeChangeDisposables);
    }
}
