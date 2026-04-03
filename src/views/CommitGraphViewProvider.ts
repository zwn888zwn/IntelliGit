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

    private readonly _onCommitSelected = new vscode.EventEmitter<string>();
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
    }>();
    readonly onCommitAction = this._onCommitAction.event;

    private readonly _onOpenCommitFileDiff = new vscode.EventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    readonly onOpenCommitFileDiff = this._onOpenCommitFileDiff.event;

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
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
                        this._onCommitSelected.fire(msg.hash);
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
                        this._onCommitAction.fire({
                            action: msg.action,
                            hash: msg.hash,
                        });
                        break;
                    case "openCommitFileDiff":
                        this._onOpenCommitFileDiff.fire({
                            commitHash: msg.commitHash,
                            filePath: msg.filePath,
                        });
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

    async refresh(): Promise<void> {
        await this.iconTheme.initIconThemeData();
        await this.sendBranches();
        await this.loadInitial();
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

    async revealCommit(hash: string): Promise<void> {
        this.pendingRevealHash = hash;
        if (!this.webviewReady) return;
        if (!this.repository) return;

        const requestId = ++this.requestSeq;
        this.loadingMore = false;
        this.currentBranch = null;
        this.filterText = "";
        this.postToWebview({ type: "setSelectedBranch", branch: null });
        this.postToWebview({ type: "setFilterText", text: "" });

        try {
            const [loadResult, unpushedHashes] = await Promise.all([
                this.loadCommitsUntilHash(hash, requestId),
                this.gitOps.getUnpushedCommitHashes(),
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
                const detail = await this.gitOps.getCommitDetail(hash);
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

        if (!this.repository) {
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
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    0,
                ),
                this.gitOps.getUnpushedCommitHashes(),
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

    private async loadMore(): Promise<void> {
        if (!this.repository || this.loadingMore) return;
        this.loadingMore = true;
        const requestId = ++this.requestSeq;
        try {
            const [commits, unpushedHashes] = await Promise.all([
                this.gitOps.getLog(
                    this.PAGE_SIZE,
                    this.currentBranch ?? undefined,
                    this.filterText || undefined,
                    this.offset,
                ),
                this.gitOps.getUnpushedCommitHashes(),
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
        const commits: Commit[] = [];
        let skip = 0;

        for (;;) {
            const page = await this.gitOps.getLog(this.PAGE_SIZE, undefined, undefined, skip);
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
