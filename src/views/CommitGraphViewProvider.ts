// WebviewViewProvider for the bottom panel commit graph.
// Loads the CommitGraphApp React app, handles pagination, branch filtering,
// and posts selected commit hashes back to the extension host.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type {
    Branch,
    Commit,
    CommitDetail,
    RepositoryContextInfo,
    ThemeFolderIconMap,
} from "../types";
import type {
    BranchAction,
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
} from "../webviews/react/commitGraphTypes";
import { getErrorMessage } from "../utils/errors";
import { IconThemeService } from "./shared";
import { registerThemeChangeListeners, disposeAll } from "./shared/themeListeners";
import { buildWebviewShellHtml } from "./webviewHtml";
import type { RepositoryEntry } from "../services/RepositoryContextService";

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
    private requestSeq = 0;
    private readonly PAGE_SIZE = 500;
    private repository: RepositoryContextInfo | null = null;

    private branches: Branch[] = [];
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
    }>();
    readonly onBranchAction = this._onBranchAction.event;

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
                        break;
                    case "selectCommit":
                        if (msg.repoRoot) {
                            this._onCommitSelected.fire({ hash: msg.hash, repoRoot: msg.repoRoot });
                        } else {
                            this._onCommitSelected.fire(msg.hash as never);
                        }
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
                        });
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
        this.sendBranches().catch((err) => {
            const message = getErrorMessage(err);
            vscode.window.showErrorMessage(`Branch update error: ${message}`);
        });
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
            const foundCommit = commits.find((commit) => commit.hash === hash) ?? null;
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

            this.postToWebview({ type: "revealCommit", hash });
            if (this.pendingRevealHash === hash) {
                this.pendingRevealHash = null;
            }

            try {
                const detail = foundCommit.repoRoot
                    ? await this.getRepositoryEntry(foundCommit.repoRoot).gitOps.getCommitDetail(hash)
                    : await this.gitOps.getCommitDetail(hash);
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
        this.branchFolderIconsByName = await this.iconTheme.getFolderIconsByBranches(this.branches);
        const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
        this.postToWebview({
            type: "setRepositories",
            repositories: this.getRepositories().map((entry) => entry.info),
        });
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
            if (page.some((commit) => commit.hash === hash)) {
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

        const merged = pages.flat().sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
        return {
            commits: merged.slice(0, limit),
            hasMore: merged.length > limit,
        };
    }

    private async loadPage(skip: number): Promise<Commit[]> {
        if (this.currentBranch) {
            if (!this.repository) return [];
            return this.gitOps.getLog(
                this.PAGE_SIZE,
                this.currentBranch ?? undefined,
                this.filterText || undefined,
                skip,
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

        return pages
            .flat()
            .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
            .slice(skip, skip + this.PAGE_SIZE);
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
