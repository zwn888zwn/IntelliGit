import { beforeEach, describe, expect, it, vi } from "vitest";

type MessageHandler = (message: unknown) => void | Promise<void>;

class FakeEventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
    };
    fire(value: T): void {
        for (const listener of this.listeners) listener(value);
    }
    dispose = vi.fn();
}

class FakeTreeItem {
    public iconPath?: unknown;
    public contextValue?: string;
    public description?: string;
    public command?: unknown;
    constructor(
        public readonly label: string,
        public readonly collapsibleState: number = 0,
    ) {}
}

class FakeThemeIcon {
    constructor(
        public readonly id: string,
        public readonly color?: unknown,
    ) {}
}

class FakeThemeColor {
    constructor(public readonly id: string) {}
}

class FakeDisposable {
    constructor(private readonly disposeFn?: () => void) {}
    dispose(): void {
        this.disposeFn?.();
    }
}

const showErrorMessage = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(async () => undefined);
const showInformationMessage = vi.fn(async () => undefined);
const showTextDocument = vi.fn(async () => undefined);
const executeCommand = vi.fn(async () => undefined);
const openTextDocument = vi.fn(async (arg) => {
    if (arg && typeof arg === "object" && "scheme" in arg && "path" in arg) {
        return { uri: arg, ...arg };
    }
    return {
        ...arg,
        uri: {
            scheme: "untitled",
            path: "/snapshot",
            fsPath: "/snapshot",
            toString: () => "untitled:/snapshot",
        },
    };
});
const readFile = vi.fn(async () => Buffer.from("working tree content", "utf8"));
const fsStat = vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 1 }));
const writeFile = vi.fn(async () => undefined);
let registeredEditableDiffProvider:
    | {
          writeFile?: (uri: unknown, content: Uint8Array) => Promise<void> | void;
          readFile?: (uri: unknown) => Uint8Array;
      }
    | undefined;
const postMessageSpy = vi.fn();
const withProgress = vi.fn(
    async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() },
        ),
);

const workspaceState: {
    workspaceFolders: Array<{ uri: { fsPath: string; path: string } }> | undefined;
} = {
    workspaceFolders: [{ uri: { fsPath: "/repo", path: "/repo" } }],
};

const vscodeMock = {
    EventEmitter: FakeEventEmitter,
    Disposable: FakeDisposable,
    TreeItem: FakeTreeItem,
    ThemeIcon: FakeThemeIcon,
    ThemeColor: FakeThemeColor,
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1 },
    FileChangeType: { Changed: 0, Created: 1, Deleted: 2 },
    FileSystemError: {
        FileNotFound: (uri: unknown) => new Error(`File not found: ${String(uri)}`),
        NoPermissions: (message: string) => new Error(message),
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
        from: ({
            scheme,
            path,
            query,
        }: {
            scheme: string;
            path: string;
            query?: string;
        }): { scheme: string; path: string; query: string; fsPath: string; toString: () => string } => ({
            scheme,
            path,
            query: query ?? "",
            fsPath: path,
            toString: () => `${scheme}:${path}${query ? `?${query}` : ""}`,
        }),
        file: (value: string): { scheme: string; fsPath: string; path: string } => ({
            scheme: "file",
            fsPath: value,
            path: value,
        }),
        joinPath: (
            base: { fsPath?: string; path?: string },
            ...segments: string[]
        ): { fsPath: string; path: string } => {
            const basePath = base.fsPath ?? base.path;
            if (!basePath) {
                throw new Error("joinPath base must provide fsPath or path");
            }
            for (const segment of segments) {
                if (typeof segment !== "string") {
                    throw new Error("joinPath segments must be strings");
                }
            }
            const joined = [basePath, ...segments].join("/").replace(/\/+/g, "/");
            return { fsPath: joined, path: joined };
        },
    },
    languages: {
        registerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
        showErrorMessage,
        showWarningMessage,
        showInformationMessage,
        showTextDocument,
        withProgress,
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
    },
    commands: {
        executeCommand,
    },
    workspace: {
        get workspaceFolders() {
            return workspaceState.workspaceFolders as
                | Array<{ uri: { fsPath: string; path: string } }>
                | undefined;
        },
        set workspaceFolders(value: Array<{ uri: { fsPath: string; path: string } }> | undefined) {
            workspaceState.workspaceFolders = value;
        },
        openTextDocument,
        fs: { readFile, writeFile, stat: fsStat },
        registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerFileSystemProvider: vi.fn((_scheme, provider) => {
            registeredEditableDiffProvider = provider as typeof registeredEditableDiffProvider;
            return { dispose: vi.fn() };
        }),
        onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
};

const deleteFileWithFallback = vi.fn(async () => true);

vi.mock("vscode", () => vscodeMock);
vi.mock("../../src/views/webviewHtml", () => ({
    buildWebviewShellHtml: vi.fn(() => "<html></html>"),
}));
vi.mock("../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});

function createWebviewView() {
    let messageHandler: MessageHandler | undefined;
    let disposeHandler: (() => void) | undefined;

    const webview = {
        options: {},
        html: "",
        cspSource: "vscode-resource:",
        asWebviewUri: (uri: { fsPath?: string; path?: string }) => ({
            fsPath: `webview:${uri.fsPath ?? uri.path ?? ""}`,
            path: `webview:${uri.path ?? uri.fsPath ?? ""}`,
        }),
        postMessage: postMessageSpy,
        onDidReceiveMessage: vi.fn((cb: MessageHandler) => {
            messageHandler = cb;
            return { dispose: vi.fn() };
        }),
    };

    const view: Record<string, unknown> = {
        webview,
        badge: undefined as { tooltip: string; value: number } | undefined,
        description: undefined as string | undefined,
        onDidDispose: vi.fn((cb: () => void) => {
            disposeHandler = cb;
            return { dispose: vi.fn() };
        }),
    };

    return {
        view,
        send: async (msg: unknown) => {
            if (messageHandler) {
                await messageHandler(msg);
            }
        },
        dispose: () => disposeHandler?.(),
    };
}

function makeGitOpsMock() {
    return {
        getLog: vi.fn(async () => [
            {
                hash: "abc1234",
                shortHash: "abc1234",
                message: "feat: test",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: [],
                refs: [],
            },
        ]),
        findCommitsByHashPrefix: vi.fn(async (hashPrefix: string) => [
            {
                hash: `${hashPrefix}full`,
                shortHash: hashPrefix.slice(0, 7),
                message: "hash match",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: [],
                refs: [],
            },
        ]),
        getUnpushedCommitHashes: vi.fn(async () => ["abc1234"]),
        getCommitDetail: vi.fn(async (hash: string) => ({
            hash,
            shortHash: hash.slice(0, 7),
            message: `detail:${hash}`,
            body: "",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
            files: [],
        })),
        getStatus: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 1, deletions: 0 },
        ]),
        getFileContentAtRef: vi.fn(async (filePath: string, ref: string) => `${ref}:${filePath}`),
        listShelved: vi.fn(async () => [
            { index: 0, message: "On main: save", date: "2026-02-19T00:00:00Z", hash: "stashhash" },
        ]),
        getShelvedFiles: vi.fn(async () => [
            { path: "src/a.ts", status: "M", staged: false, additions: 2, deletions: 1 },
        ]),
        stageFiles: vi.fn(async () => undefined),
        unstageFiles: vi.fn(async () => undefined),
        commit: vi.fn(async () => "ok"),
        commitAndPush: vi.fn(async () => "ok"),
        getPendingCommitMessage: vi.fn(async () => ""),
        getLastCommitMessage: vi.fn(async () => "last message"),
        rollbackAll: vi.fn(async () => undefined),
        rollbackFiles: vi.fn(async () => undefined),
        shelveSave: vi.fn(async () => "saved"),
        shelvePop: vi.fn(async () => "popped"),
        shelveApply: vi.fn(async () => "applied"),
        shelveDelete: vi.fn(async () => "deleted"),
        getShelvedFilePatch: vi.fn(async () => "diff --git a b"),
        getFileHistory: vi.fn(async () => "history line"),
    };
}

const testRepository = {
    name: "repo",
    root: "/repo",
} as const;

async function setupCommitPanelProvider() {
    const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
    const gitOps = makeGitOpsMock();
    const provider = new CommitPanelViewProvider(
        { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
        gitOps as unknown as object,
    );
    provider.setRepositoryContext(testRepository);
    const webview = createWebviewView();
    provider.resolveWebviewView(
        webview.view as unknown as object,
        {} as unknown as object,
        {} as unknown as object,
    );
    await webview.send({ type: "ready" });
    return { provider, gitOps, webview };
}

describe("view providers integration", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        workspaceState.workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        readFile.mockResolvedValue(Buffer.from("working tree content", "utf8"));
        showWarningMessage.mockResolvedValue(undefined);
        const { registerDiffContentProvider } = await import("../../src/services/diffService");
        registerDiffContentProvider([]);
    });

    it("CommitInfoViewProvider handles ready/set/clear lifecycle", async () => {
        const { CommitInfoViewProvider } = await import("../../src/views/CommitInfoViewProvider");
        const provider = new CommitInfoViewProvider({ fsPath: "/ext", path: "/ext" } as unknown as {
            fsPath: string;
            path: string;
        });
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        provider.setCommitDetail({
            hash: "abc",
            shortHash: "abc",
            message: "msg",
            body: "",
            author: "a",
            email: "e",
            date: "d",
            parentHashes: [],
            refs: [],
            files: [],
        });
        expect(postMessageSpy).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "setCommitDetail" }),
        );

        await webview.send({ type: "ready" });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "setCommitDetail" }),
        );

        provider.clear();
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "clear" });

        webview.dispose();
        provider.dispose();
    });

    it("CommitGraphViewProvider reveals a commit by resetting filters and posting a reveal message", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getLog
            .mockResolvedValueOnce([
                {
                    hash: "old1111",
                    shortHash: "old1111",
                    message: "older",
                    author: "Mahesh",
                    email: "m@example.com",
                    date: "2026-02-18T00:00:00Z",
                    parentHashes: [],
                    refs: [],
                },
            ])
            .mockResolvedValueOnce([
                {
                    hash: "target123",
                    shortHash: "target12",
                    message: "target",
                    author: "Mahesh",
                    email: "m@example.com",
                    date: "2026-02-19T00:00:00Z",
                    parentHashes: [],
                    refs: [],
                },
            ]);
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });
        postMessageSpy.mockClear();

        await provider.revealCommit("target123");

        expect(postMessageSpy).toHaveBeenCalledWith({ type: "setSelectedBranch", branch: null });
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "setFilterText", text: "" });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "loadCommits",
                append: false,
                commits: expect.arrayContaining([expect.objectContaining({ hash: "target123" })]),
            }),
        );
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "revealCommit", hash: "target123" });
        expect(gitOps.getCommitDetail).toHaveBeenCalledWith("target123");
        provider.dispose();
    });

    it("CommitGraphViewProvider reveals the commit even if detail loading fails", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getLog.mockResolvedValue([
            {
                hash: "target123",
                shortHash: "target12",
                message: "target",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: [],
                refs: [],
            },
        ]);
        gitOps.getCommitDetail.mockRejectedValueOnce(new Error("detail failed"));
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });
        postMessageSpy.mockClear();
        showErrorMessage.mockClear();

        await provider.revealCommit("target123");

        expect(postMessageSpy).toHaveBeenCalledWith({ type: "revealCommit", hash: "target123" });
        expect(showErrorMessage).toHaveBeenCalledWith("Commit graph error: detail failed");
        provider.dispose();
    });

    it("CommitGraphViewProvider handles webview events and refresh/load flows", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();

        const selected = vi.fn();
        const branchFilter = vi.fn();
        const branchAction = vi.fn();
        const chooseWorktreeLocation = vi.fn();
        const createWorktree = vi.fn();
        const openWorktree = vi.fn();
        const deleteWorktree = vi.fn();
        const commitAction = vi.fn();
        const openCommitFileDiff = vi.fn();

        provider.onCommitSelected(selected);
        provider.onBranchFilterChanged(branchFilter);
        provider.onBranchAction(branchAction);
        provider.onChooseWorktreeLocation(chooseWorktreeLocation);
        provider.onCreateWorktree(createWorktree);
        provider.onOpenWorktree(openWorktree);
        provider.onDeleteWorktree(deleteWorktree);
        provider.onCommitAction(commitAction);
        provider.onOpenCommitFileDiff(openCommitFileDiff);

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });
        expect(gitOps.getLog).toHaveBeenCalled();

        provider.setBranches([
            {
                name: "main",
                hash: "abc",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ]);
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "setBranches" }),
        );

        await webview.send({ type: "selectCommit", hash: "abc1234" });
        expect(selected).toHaveBeenCalledWith("abc1234");

        await webview.send({ type: "filterBranch", branch: "main" });
        expect(branchFilter).toHaveBeenCalledWith("main");

        await webview.send({ type: "branchAction", action: "checkout", branchName: "main" });
        expect(branchAction).toHaveBeenCalledWith({ action: "checkout", branchName: "main" });

        await webview.send({ type: "chooseWorktreeLocation", currentLocation: "/repos" });
        expect(chooseWorktreeLocation).toHaveBeenCalledWith({ currentLocation: "/repos" });

        await webview.send({
            type: "createWorktree",
            payload: {
                repoRoot: "/repo",
                branchName: "main",
                createBranch: true,
                newBranchName: "feature/worktree",
                projectName: "repo-feature-worktree",
                location: "/repos",
            },
        });
        expect(createWorktree).toHaveBeenCalledWith({
            repoRoot: "/repo",
            branchName: "main",
            createBranch: true,
            newBranchName: "feature/worktree",
            projectName: "repo-feature-worktree",
            location: "/repos",
        });

        await webview.send({
            type: "openWorktree",
            payload: { repoRoot: "/repo", path: "/repo-feature" },
        });
        expect(openWorktree).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "/repo-feature",
        });

        await webview.send({
            type: "deleteWorktree",
            payload: { repoRoot: "/repo", path: "/repo-feature" },
        });
        expect(deleteWorktree).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "/repo-feature",
        });

        provider.openWorktreeDialog({
            repository: { repoId: ".", name: "repo", root: "/repo", color: "#4CAF50" },
            branch: {
                name: "main",
                hash: "abc",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            defaultLocation: "/repos",
            defaultProjectName: "repo-main",
            worktrees: [{ path: "/repo", branch: "main", detached: false }],
        });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: "openWorktreeDialog" }),
        );
        provider.setWorktreeLocationSelected("/next");
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "worktreeLocationSelected",
            location: "/next",
        });
        provider.setWorktreeCreateResult({ success: false, message: "failed" });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "worktreeCreateResult",
            success: false,
            message: "failed",
        });
        provider.setRepositoryWorktrees("/repo", [
            { path: "/repo", branch: "main", detached: false },
            { path: "/repo-feature", branch: "feature/demo", detached: false },
        ]);
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "setRepositoryWorktrees",
            worktreesByRoot: {
                "/repo": [
                    { path: "/repo", branch: "main", detached: false },
                    { path: "/repo-feature", branch: "feature/demo", detached: false },
                ],
            },
        });
        provider.openWorktreesDialog("/repo");
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "openWorktreesDialog",
            repoRoot: "/repo",
        });
        provider.openWorktreesDialog();
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "openWorktreesDialog",
        });
        provider.setWorktreeDeleteResult({ success: false, message: "dirty worktree" });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "worktreeDeleteResult",
            success: false,
            message: "dirty worktree",
        });

        await webview.send({ type: "commitAction", action: "copyRevision", hash: "abc1234" });
        expect(commitAction).toHaveBeenCalledWith({
            action: "copyRevision",
            hash: "abc1234",
        });

        await webview.send({
            type: "openCommitFileDiff",
            commitHash: "abc1234",
            filePath: "src/file.ts",
        });
        expect(openCommitFileDiff).toHaveBeenCalledWith({
            commitHash: "abc1234",
            filePath: "src/file.ts",
        });

        const logCallsBeforePagedFetch = gitOps.getLog.mock.calls.length;
        await webview.send({ type: "filterText", text: "feat" });
        await webview.send({ type: "loadMore" });
        expect(gitOps.getLog.mock.calls.length - logCallsBeforePagedFetch).toBe(2);

        const hashSearchCallsBefore = gitOps.findCommitsByHashPrefix.mock.calls.length;
        await webview.send({ type: "filterText", text: "55d744b" });
        expect(gitOps.findCommitsByHashPrefix.mock.calls.length - hashSearchCallsBefore).toBe(1);

        await webview.send({ type: "filterText", text: "feat" });
        gitOps.getLog.mockRejectedValueOnce(new Error("git failed"));
        await provider.refresh();
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Git log error"));

        provider.dispose();
    });

    it("CommitGraphViewProvider preserves single-repo git log order for all-branches graphs", async () => {
        const { CommitGraphViewProvider } = await import("../../src/views/CommitGraphViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getLog.mockResolvedValueOnce([
            {
                hash: "head",
                shortHash: "head",
                message: "head",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-06-03T15:31:17+08:00",
                parentHashes: ["mid"],
                refs: ["HEAD -> feature/test"],
            },
            {
                hash: "mid",
                shortHash: "mid",
                message: "mid",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-06-03T13:20:27+08:00",
                parentHashes: ["base"],
                refs: [],
            },
            {
                hash: "base",
                shortHash: "base",
                message: "base",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-06-03T14:40:33+08:00",
                parentHashes: [],
                refs: [],
            },
        ]);

        const repositoryEntry = {
            root: "/repo",
            name: "repo",
            gitOps,
        };
        const provider = new CommitGraphViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            () => [repositoryEntry] as never,
            (root: string) => (root === "/repo" ? (repositoryEntry as never) : null),
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        const loadCommitsMessage = postMessageSpy.mock.calls
            .map((call) => call[0])
            .find((message) => message?.type === "loadCommits");
        expect(loadCommitsMessage).toBeTruthy();
        expect(loadCommitsMessage.commits.map((commit: { hash: string }) => commit.hash)).toEqual([
            "head",
            "mid",
            "base",
        ]);

        provider.dispose();
    });

    it("CommitPanelViewProvider handles staging and unstaging", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        expect(gitOps.getStatus).toHaveBeenCalled();
        expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));

        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        await webview.send({ type: "unstageFiles", paths: ["src/a.ts"] });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.unstageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider handles commit flows", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "commit", message: "", amend: false });
        expect(showWarningMessage).toHaveBeenCalledWith("Enter a commit message.");

        await webview.send({
            type: "commitSelected",
            message: "feat: selected",
            amend: false,
            push: false,
            paths: [],
        });
        expect(showWarningMessage).toHaveBeenCalledWith("Select files to commit.");
        expect(gitOps.stageFiles).not.toHaveBeenCalled();

        await webview.send({ type: "commit", message: "feat: ok", amend: false });
        await webview.send({
            type: "commitSelected",
            message: "feat: selected",
            amend: false,
            push: true,
            paths: ["src/a.ts"],
        });
        await webview.send({ type: "commitAndPush", message: "feat: push", amend: false });
        expect(gitOps.commit).toHaveBeenCalled();
        expect(gitOps.commitAndPush).toHaveBeenCalled();
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commitAndPush).toHaveBeenCalledWith("feat: selected", false, ["src/a.ts"]);
        expect(withProgress).toHaveBeenCalled();

        await webview.send({ type: "getLastCommitMessage" });
        expect(postMessageSpy).toHaveBeenCalledWith({
            type: "lastCommitMessage",
            message: "last message",
        });
        provider.dispose();
    });

    it("CommitPanelViewProvider commits only checked paths even when other files are already staged", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        await webview.send({
            type: "commitSelected",
            message: "feat: selected only",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });

        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
        expect(gitOps.commit).toHaveBeenCalledWith("feat: selected only", false, ["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider warns for partially staged files and opens stage-specific diffs", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.getStatus.mockResolvedValue([
            {
                repoId: ".",
                repoRoot: "/repo",
                path: "src/a.ts",
                status: "M",
                staged: true,
                additions: 1,
                deletions: 0,
            },
            {
                repoId: ".",
                repoRoot: "/repo",
                path: "src/a.ts",
                status: "M",
                staged: false,
                additions: 1,
                deletions: 1,
            },
        ]);
        await webview.send({ type: "refresh" });
        gitOps.stageFiles.mockClear();

        await webview.send({
            type: "commitSelected",
            message: "feat: partial",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        expect(showWarningMessage).toHaveBeenCalledWith(
            "该文件还有未暂存的新修改，继续提交会将最新工作区版本一并暂存和提交。",
            { modal: true },
            "继续提交",
        );
        expect(gitOps.stageFiles).not.toHaveBeenCalled();

        showWarningMessage.mockResolvedValueOnce("继续提交");
        await webview.send({
            type: "commitSelected",
            message: "feat: partial",
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        expect(gitOps.stageFiles).toHaveBeenCalledWith(["src/a.ts"]);

        await webview.send({
            type: "showStageDiff",
            target: { repoRoot: "/repo", path: "src/a.ts" },
            staged: true,
        });
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.anything(),
            expect.anything(),
            "src/a.ts (HEAD ↔ Index)",
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider validates malformed commit payloads defensively", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();

        // Each payload exercises a single validation guard independently:
        // 1. Non-string message with valid paths → message guard
        await webview.send({
            type: "commitSelected",
            message: undefined,
            amend: false,
            push: false,
            paths: ["src/a.ts"],
        });
        // 2. Valid message with empty paths → paths guard
        await webview.send({
            type: "commitSelected",
            message: "valid msg",
            amend: false,
            push: false,
            paths: [],
        });
        // 3. Null message on commitAndPush → message guard
        await webview.send({ type: "commitAndPush", message: null, amend: false });

        expect(showWarningMessage).toHaveBeenCalledTimes(3);
        expect(showWarningMessage).toHaveBeenNthCalledWith(1, "Enter a commit message.");
        expect(showWarningMessage).toHaveBeenNthCalledWith(2, "Select files to commit.");
        expect(showWarningMessage).toHaveBeenNthCalledWith(3, "Enter a commit message.");
        expect(gitOps.stageFiles).not.toHaveBeenCalled();
        expect(gitOps.commit).not.toHaveBeenCalled();
        expect(gitOps.commitAndPush).not.toHaveBeenCalled();

        provider.dispose();
    });

    it("CommitPanelViewProvider updates description and fires file count after commit", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();

        // Register event listener BEFORE resolving the view (which triggers refreshData)
        const counts: number[] = [];
        provider.onDidChangeFileCount((n: number) => counts.push(n));

        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        const view = (provider as unknown as { view: Record<string, unknown> }).view;

        // Initial state: getStatus returns 1 file → description set, event fired
        expect(view.description).toBe("1");
        expect(counts).toContain(1);

        // After commit, getStatus returns 0 files → description cleared, event fired with 0
        gitOps.getStatus.mockResolvedValueOnce([]);
        await webview.send({ type: "commit", message: "feat: clear", amend: false });
        expect(view.description).toBe("");
        expect(counts).toContain(0);

        provider.dispose();
    });

    it("CommitPanelViewProvider handles rollback actions", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: [] });
        showWarningMessage.mockResolvedValueOnce("Rollback");
        await webview.send({ type: "rollback", paths: ["src/a.ts"] });
        expect(gitOps.rollbackAll).toHaveBeenCalled();
        expect(gitOps.rollbackFiles).toHaveBeenCalledWith(["src/a.ts"]);
        provider.dispose();
    });

    it("CommitPanelViewProvider handles diff/open/history actions", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        const diffCall = executeCommand.mock.calls.find((call) => call[0] === "vscode.diff");
        expect(diffCall).toEqual([
            "vscode.diff",
            expect.any(Object),
            expect.objectContaining({
                scheme: "file",
                fsPath: "/repo/src/a.ts",
                path: "/repo/src/a.ts",
            }),
            expect.stringContaining("src/a.ts"),
        ]);
        expect(diffCall?.[1]).toEqual(
            expect.objectContaining({
                path: expect.stringMatching(/\/a\.ts$/),
                query: expect.stringContaining("path=src%2Fa.ts"),
            }),
        );
        expect(readFile).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "file",
                fsPath: "/repo/src/a.ts",
            }),
        );
        expect(openTextDocument).not.toHaveBeenCalledWith(
            expect.objectContaining({
                content: expect.any(String),
            }),
        );
        await webview.send({ type: "openFile", path: "src/a.ts" });
        await webview.send({ type: "showHistory", path: "src/a.ts" });
        expect(openTextDocument).toHaveBeenCalled();
        expect(showTextDocument).toHaveBeenCalled();
        provider.dispose();
    });

    it("openCommitFileDiff decodes git-quoted file paths before reading diff content", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) => `content:${ref}`),
        };
        const executor = {
            run: vi.fn(async () => "a1b2c3d4 parent1234"),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            '"docs/\\346\\226\\260\\346\\226\\207\\344\\273\\266.txt"',
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result).not.toBeNull();
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(
            1,
            "docs/新文件.txt",
            "parent1234",
        );
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(
            2,
            "docs/新文件.txt",
            "a1b2c3d4",
        );
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("originalPath=docs%2F%E6%96%B0%E6%96%87%E4%BB%B6.txt"),
            }),
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("intelligitCommitDiff=1"),
            }),
            "docs/新文件.txt (parent12 ↔ a1b2c3d4)",
        );
    });

    it("openCommitFileDiff replaces binary commit content with text placeholders", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) =>
                ref === "parent1234" ? "parent\0binary" : "\u0001\u0002commit-binary",
            ),
        };
        const executor = {
            run: vi.fn(async () => "a1b2c3d4 parent1234"),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            "profiles/cpu-hotspot.pprof",
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result?.leftUri.path).toMatch(/\.txt$/);
        expect(result?.rightUri.path).toMatch(/\.txt$/);
        expect(openTextDocument).toHaveBeenCalledTimes(2);
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "intelligit-diff",
                path: expect.stringMatching(/\.txt$/),
            }),
            expect.objectContaining({
                scheme: "intelligit-diff",
                path: expect.stringMatching(/\.txt$/),
            }),
            "profiles/cpu-hotspot.pprof (parent12 ↔ a1b2c3d4)",
        );
    });

    it("openCommitFileDiff uses native git diff resources for previewable images", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async () => {
                throw new Error("text fallback should not run for previewable images");
            }),
        };
        const executor = {
            run: vi.fn(async () => "a1b2c3d4 parent1234"),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            "assets/logo.png",
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result).not.toBeNull();
        expect(gitOps.getFileContentAtRef).not.toHaveBeenCalled();
        expect(openTextDocument).not.toHaveBeenCalled();
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "git",
                path: "/repo/assets/logo.png",
                query: expect.stringContaining("\"ref\":\"parent1234\""),
            }),
            expect.objectContaining({
                scheme: "git",
                path: "/repo/assets/logo.png",
                query: expect.stringContaining("\"ref\":\"a1b2c3d4\""),
            }),
            "assets/logo.png (parent12 ↔ a1b2c3d4)",
        );
    });

    it("openCommitFileDiff uses an image placeholder for added previewable images", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async () => {
                throw new Error("text fallback should not run for added previewable images");
            }),
        };
        const executor = {
            run: vi.fn(async (args: string[]) => {
                if (args[0] === "rev-list" && args[1] === "--parents") {
                    return "a1b2c3d4 parent1234";
                }
                if (args[0] === "cat-file" && args[1] === "-e") {
                    return args[2] === "a1b2c3d4:assets/new-logo.png"
                        ? ""
                        : Promise.reject(new Error("missing"));
                }
                return "";
            }),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            "assets/new-logo.png",
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result).not.toBeNull();
        expect(gitOps.getFileContentAtRef).not.toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "file",
                fsPath: expect.stringContaining("intelligit-image-placeholders"),
            }),
            expect.any(Uint8Array),
        );
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "file",
                fsPath: expect.stringContaining("intelligit-image-placeholders"),
            }),
            expect.objectContaining({
                scheme: "git",
                path: "/repo/assets/new-logo.png",
                query: expect.stringContaining("\"ref\":\"a1b2c3d4\""),
            }),
            "assets/new-logo.png (parent12 ↔ a1b2c3d4)",
        );
    });

    it("openCommitFileDiff uses an image placeholder for deleted previewable images", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async () => {
                throw new Error("text fallback should not run for deleted previewable images");
            }),
        };
        const executor = {
            run: vi.fn(async (args: string[]) => {
                if (args[0] === "rev-list" && args[1] === "--parents") {
                    return "a1b2c3d4 parent1234";
                }
                if (args[0] === "cat-file" && args[1] === "-e") {
                    return args[2] === "parent1234:assets/removed-logo.png"
                        ? ""
                        : Promise.reject(new Error("missing"));
                }
                return "";
            }),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            "assets/removed-logo.png",
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result).not.toBeNull();
        expect(gitOps.getFileContentAtRef).not.toHaveBeenCalled();
        expect(writeFile).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "file",
                fsPath: expect.stringContaining("intelligit-image-placeholders"),
            }),
            expect.any(Uint8Array),
        );
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "git",
                path: "/repo/assets/removed-logo.png",
                query: expect.stringContaining("\"ref\":\"parent1234\""),
            }),
            expect.objectContaining({
                scheme: "file",
                fsPath: expect.stringContaining("intelligit-image-placeholders"),
            }),
            "assets/removed-logo.png (parent12 ↔ a1b2c3d4)",
        );
    });

    it("openCommitFileDiff keeps added files eligible for Open in Editor", async () => {
        const { openCommitFileDiff } = await import("../../src/services/diffService");
        const gitOps = {
            getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) =>
                ref === "parent1234" ? "" : "package main\n",
            ),
        };
        const executor = {
            run: vi.fn(async (args: string[]) => {
                if (args[0] === "rev-list" && args[1] === "--parents") {
                    return "a1b2c3d4 parent1234";
                }
                if (args[0] === "cat-file" && args[1] === "-e") {
                    return args[2] === "a1b2c3d4:src/new-file.go" ? "" : Promise.reject(new Error("missing"));
                }
                return "";
            }),
        };

        const result = await openCommitFileDiff(
            "a1b2c3d4",
            "src/new-file.go",
            "/repo",
            gitOps as unknown as never,
            executor as unknown as never,
        );

        expect(result).not.toBeNull();
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("intelligitCommitDiff=1"),
            }),
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("intelligitCommitDiff=1"),
            }),
            "src/new-file.go (parent12 ↔ a1b2c3d4)",
        );
    });

    it("CommitPanelViewProvider opens binary working files as placeholder diffs", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getStatus.mockResolvedValueOnce([
            {
                repoRoot: "/repo",
                path: "profiles/cpu.pb.gz",
                status: "?",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ]);
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            () => ({ fsPath: "/repo", path: "/repo" }) as unknown as { fsPath: string; path: string },
            () => [
                {
                    root: "/repo",
                    uri: { fsPath: "/repo", path: "/repo" },
                    info: testRepository,
                    gitOps,
                    executor: { run: vi.fn(async () => "") },
                } as unknown as never,
            ],
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        await provider.openWorkingFileDiff({ repoRoot: "/repo", path: "profiles/cpu.pb.gz" });

        expect(openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("working-tree"),
            }),
        );
        expect(readFile).not.toHaveBeenCalled();
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(Object),
            expect.any(Object),
            expect.stringContaining("profiles/cpu.pb.gz"),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider opens previewable images with native git/file diff", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getStatus.mockResolvedValueOnce([
            {
                repoRoot: "/repo",
                path: "assets/logo.png",
                status: "M",
                staged: false,
                additions: 0,
                deletions: 0,
            },
        ]);
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            () => ({ fsPath: "/repo", path: "/repo" }) as unknown as { fsPath: string; path: string },
            () => [
                {
                    root: "/repo",
                    uri: { fsPath: "/repo", path: "/repo" },
                    info: testRepository,
                    gitOps,
                    executor: { run: vi.fn(async () => "") },
                } as unknown as never,
            ],
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        await provider.openWorkingFileDiff({ repoRoot: "/repo", path: "assets/logo.png" });

        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "git",
                path: "/repo/assets/logo.png",
                query: expect.stringContaining("\"ref\":\"HEAD\""),
            }),
            expect.objectContaining({
                scheme: "file",
                fsPath: "/repo/assets/logo.png",
                path: "/repo/assets/logo.png",
            }),
            expect.stringContaining("assets/logo.png"),
        );
        expect(openTextDocument).not.toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider avoids editable diffs for binary working tree content", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getStatus.mockResolvedValueOnce([
            {
                repoRoot: "/repo",
                path: "profiles/cpu.sample",
                status: "M",
                staged: false,
                additions: 1,
                deletions: 1,
            },
        ]);
        readFile.mockResolvedValue(Buffer.from([0, 1, 2, 3, 4]));
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            () => ({ fsPath: "/repo", path: "/repo" }) as unknown as { fsPath: string; path: string },
            () => [
                {
                    root: "/repo",
                    uri: { fsPath: "/repo", path: "/repo" },
                    info: testRepository,
                    gitOps,
                    executor: { run: vi.fn(async () => "") },
                } as unknown as never,
            ],
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });

        await provider.openWorkingFileDiff({ repoRoot: "/repo", path: "profiles/cpu.sample" });

        expect(readFile).toHaveBeenCalled();
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.any(Object),
            expect.objectContaining({
                scheme: "intelligit-diff",
                path: expect.stringMatching(/\.txt$/),
            }),
            expect.stringContaining("profiles/cpu.sample"),
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider keeps diff navigation active for virtual diff editors", async () => {
        const { CommitPanelViewProvider } = await import("../../src/views/CommitPanelViewProvider");
        const gitOps = makeGitOpsMock();
        gitOps.getStatus.mockResolvedValueOnce([
            {
                repoRoot: "/repo",
                path: "todo.md",
                status: "M",
                staged: false,
                additions: 16,
                deletions: 16,
            },
            {
                repoRoot: "/repo",
                path: "go.sum",
                status: "M",
                staged: false,
                additions: 1,
                deletions: 0,
            },
        ]);
        const executor = {
            run: vi.fn(async () => "@@ -1 +1 @@\n-old\n+new"),
        };
        const provider = new CommitPanelViewProvider(
            { fsPath: "/ext", path: "/ext" } as unknown as { fsPath: string; path: string },
            gitOps as unknown as object,
            () => ({ fsPath: "/repo", path: "/repo" }) as unknown as { fsPath: string; path: string },
            () => [
                {
                    root: "/repo",
                    uri: { fsPath: "/repo", path: "/repo" },
                    info: testRepository,
                    gitOps,
                    executor,
                } as unknown as never,
            ],
        );
        provider.setRepositoryContext(testRepository);
        const webview = createWebviewView();
        provider.resolveWebviewView(
            webview.view as unknown as object,
            {} as unknown as object,
            {} as unknown as object,
        );
        await webview.send({ type: "ready" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        await provider.openWorkingFileDiff({ repoRoot: "/repo", path: "todo.md" });
        await new Promise((resolve) => setTimeout(resolve, 0));
        const markdownDiffCall = executeCommand.mock.calls.find((call) => call[0] === "vscode.diff");
        expect(markdownDiffCall?.[1]).toEqual(
            expect.objectContaining({
                path: expect.stringMatching(/\.txt$/),
                query: expect.stringContaining("path=todo.md"),
            }),
        );
        expect(markdownDiffCall?.[2]).toEqual(
            expect.objectContaining({
                path: expect.stringMatching(/\.txt$/),
                query: expect.stringContaining("path=todo.md"),
            }),
        );
        executeCommand.mockClear();

        provider.syncActiveEditor({
            document: {
                uri: {
                    scheme: "intelligit-diff-editable",
                    path: "/__intelligit_text_diff__/1.txt",
                    query: "ref=working-tree&path=todo.md",
                    fsPath: "/__intelligit_text_diff__/1.txt",
                },
            },
            selection: { active: { line: 1, character: 0 } },
        } as unknown as Parameters<typeof provider.syncActiveEditor>[0]);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(provider.getDiffNavigationState()).resolves.toMatchObject({ active: true });
        executeCommand.mockClear();

        provider.syncActiveEditor(undefined);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(provider.getDiffNavigationState()).resolves.toMatchObject({ active: true });
        provider.dispose();
    });

    it("CommitPanelViewProvider handles shelf operations", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        await webview.send({
            type: "shelveSave",
            name: "work",
            keepIndex: true,
            paths: ["src/a.ts"],
        });
        await webview.send({ type: "shelfPop", index: 0 });
        await webview.send({ type: "shelfApply", index: 0 });
        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "shelfDelete", index: 0 });
        expect(gitOps.shelveSave).toHaveBeenCalledWith(["src/a.ts"], "work", {
            keepIndex: true,
        });
        gitOps.shelveSave.mockClear();
        await webview.send({
            type: "shelveSave",
            name: "all",
            repoRoot: "/repo",
            keepIndex: false,
        });
        expect(gitOps.shelveSave).toHaveBeenCalledWith(undefined, "all", {
            keepIndex: false,
        });
        expect(gitOps.shelvePop).toHaveBeenCalledWith(0);
        expect(gitOps.shelveApply).toHaveBeenCalledWith(0);
        expect(gitOps.shelveDelete).toHaveBeenCalledWith(0);

        await webview.send({ type: "shelfSelect", index: Number.NaN });
        expect(postMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "error",
                message: expect.stringContaining("Expected number"),
            }),
        );

        openTextDocument.mockClear();
        executeCommand.mockClear();
        await webview.send({ type: "showShelfDiff", index: 0, path: "src/a.ts" });
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(1, "src/a.ts", "stash@{0}^");
        expect(gitOps.getFileContentAtRef).toHaveBeenNthCalledWith(2, "src/a.ts", "stash@{0}");
        expect(gitOps.getShelvedFilePatch).not.toHaveBeenCalled();
        expect(openTextDocument).toHaveBeenCalledTimes(2);
        expect(openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("path=src%2Fa.ts"),
            }),
        );
        expect(executeCommand).toHaveBeenCalledWith(
            "vscode.diff",
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("ref=stash%40%7B0%7D%5E"),
            }),
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("ref=stash%40%7B0%7D"),
            }),
            "src/a.ts (Stash 0)",
        );
        provider.dispose();
    });

    it("CommitPanelViewProvider handles file delete with confirmation", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        showWarningMessage.mockResolvedValueOnce("Delete");
        await webview.send({ type: "deleteFile", path: "src/a.ts" });
        expect(deleteFileWithFallback).toHaveBeenCalled();
        provider.dispose();
    });

    it("CommitPanelViewProvider rejects malformed array payloads strictly", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        // Mixed array with non-string elements should fail, not silently filter
        await webview.send({ type: "stageFiles", paths: ["src/a.ts", 42] });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("all elements"));
        // Non-array should also fail
        await webview.send({ type: "unstageFiles", paths: "not-an-array" });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Expected string[]"));
        provider.dispose();
    });

    it("CommitPanelViewProvider rejects path traversal in file operations", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        await webview.send({ type: "showDiff", path: "../etc/passwd" });
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("escaping repo root"),
        );
        await webview.send({ type: "openFile", path: "/etc/passwd" });
        expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("non-relative"));
        provider.dispose();
    });

    it("CommitPanelViewProvider surfaces operation errors", async () => {
        const { provider, gitOps, webview } = await setupCommitPanelProvider();
        gitOps.stageFiles.mockRejectedValueOnce(new Error("stage failed"));
        await webview.send({ type: "stageFiles", paths: ["src/a.ts"] });
        expect(showErrorMessage).toHaveBeenCalledWith("stage failed");
        expect(postMessageSpy).toHaveBeenCalledWith({ type: "error", message: "stage failed" });
        provider.dispose();
    });

    it("CommitPanelViewProvider guards workspace-dependent actions", async () => {
        const { provider, webview } = await setupCommitPanelProvider();
        workspaceState.workspaceFolders = undefined;
        await webview.send({ type: "showDiff", path: "src/a.ts" });
        expect(showErrorMessage).toHaveBeenCalledWith("No IntelliGit repository is selected.");

        provider.dispose();
    });
});
