import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

type CommandHandler = (...args: unknown[]) => unknown;

const registeredCommands = new Map<string, CommandHandler>();
const mockDisposables: Array<{ dispose: () => void }> = [];
const executeCommandFallback = vi.fn(async () => undefined);
const showInformationMessage = vi.fn(async () => undefined);
const showErrorMessage = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(
    async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0],
);
const showInputBox = vi.fn(async (opts?: { prompt?: string; value?: string }) => {
    if (!opts?.prompt) return "input";
    if (opts.prompt.includes("New branch")) return "feature/new";
    if (opts.prompt.includes("New tag")) return "v1.0.0";
    if (opts.prompt.includes("Rename")) return "renamed-branch";
    if (opts.prompt.includes("Edit commit message")) return "edited message";
    return "input";
});
const showSaveDialog = vi.fn(async () => ({ fsPath: "/tmp/patch.diff", path: "/tmp/patch.diff" }));
const showOpenDialog = vi.fn(async () => [{ fsPath: "/tmp", path: "/tmp" }]);
const showQuickPick = vi.fn(async (items: Array<Record<string, unknown>>) => items[0]);
const showTextDocument = vi.fn(async () => undefined);
const openTextDocument = vi.fn(async (arg: unknown) => arg);
const writeFile = vi.fn(async () => undefined);
const readFile = vi.fn(async () => Buffer.from(""));
const fsStat = vi.fn(async () => ({ type: 1, ctime: 0, mtime: 0, size: 1 }));
const clipboardWriteText = vi.fn(async () => undefined);
const createOutputChannel = vi.fn(() => ({ appendLine: vi.fn() }));
const createdStatusBarItems: Array<{
    text?: string;
    tooltip?: string;
    command?: string;
    name?: string;
    backgroundColor?: unknown;
    color?: unknown;
    accessibilityInformation?: unknown;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
}> = [];
const createStatusBarItem = vi.fn(() => {
    const item = {
        text: "",
        tooltip: "",
        command: "",
        name: "",
        backgroundColor: undefined,
        color: undefined,
        accessibilityInformation: undefined,
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
    };
    createdStatusBarItems.push(item);
    return item;
});
const withProgress = vi.fn(
    async (
        _options: unknown,
        task: (
            progress: { report: ReturnType<typeof vi.fn> },
            token: {
                isCancellationRequested: boolean;
                onCancellationRequested: ReturnType<typeof vi.fn>;
            },
        ) => Promise<unknown>,
    ) =>
        task(
            { report: vi.fn() },
            { isCancellationRequested: false, onCancellationRequested: vi.fn() },
        ),
);
const registerWebviewViewProvider = vi.fn(() => ({ dispose: vi.fn() }));
const createTerminal = vi.fn(() => ({ show: vi.fn(), sendText: vi.fn() }));
const textDocListeners: Array<() => void> = [];
const closeDocListeners: Array<(document: { uri: { scheme?: string; toString?: () => string } }) => void> = [];
const saveDocListeners: Array<() => void> = [];
const createFileListeners: Array<() => void> = [];
const deleteFileListeners: Array<() => void> = [];
const renameFileListeners: Array<() => void> = [];
const activeEditorListeners: Array<(editor: unknown) => void> = [];
const editorSelectionListeners: Array<(event: { textEditor: unknown }) => void> = [];
const workspaceFolderListeners: Array<() => void> = [];
type FsWatchCallback = (...args: unknown[]) => void;
const fsWatchCallbacks: FsWatchCallback[] = [];
let registeredDefinitionProvider:
    | {
          provideDefinition: (
              document: unknown,
              position: unknown,
          ) => Promise<unknown> | unknown;
      }
    | undefined;
let latestWebviewPanel:
    | {
          webview: { postMessage: ReturnType<typeof vi.fn> };
          emitMessage: (message: unknown) => Promise<void>;
      }
    | undefined;

let workspaceFolders: Array<{ uri: { fsPath: string; path: string } }> | undefined = [
    { uri: { fsPath: "/repo", path: "/repo" } },
];
let activeTextEditor:
    | {
          document: {
              uri: { fsPath: string; path: string; scheme: string };
          };
          selection?: { active: { line: number; character: number } };
      }
    | undefined = undefined;

class MockDisposable {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
        this.fn();
    }
}

class MockPosition {
    constructor(
        public readonly line: number,
        public readonly character: number,
    ) {}
}

class MockRange {
    constructor(
        public readonly start: { line: number; character: number },
        public readonly end: { line: number; character: number },
    ) {}
}

class MockEventEmitter<T> {
    private listeners: Array<(value: T) => unknown> = [];
    readonly event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: vi.fn() };
    };
    fire(value: T): void {
        void this.fireAsync(value);
    }
    async fireAsync(value: T): Promise<void> {
        for (const listener of this.listeners) await listener(value);
    }
    dispose = vi.fn();
}

const defaultExecutorRunImpl = async (args: string[]) => {
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
    if (args[0] === "rev-parse" && args[1] === "--short") return args[2]?.slice(0, 7) ?? "feed123";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return "feed1234";
    if (args[0] === "worktree" && args[1] === "list") {
        return ["worktree /repo-a", "HEAD feed1234", "branch refs/heads/main", ""].join("\n");
    }
    if (args[0] === "format-patch") return "patch-content";
    if (args[0] === "log" && args.includes("--format=%B")) return "current commit body";
    if (args[0] === "rev-list" && args[1] === "--count") return "2";
    if (args[0] === "rev-list" && args[1] === "--parents") {
        const hash = args[args.length - 1];
        if (hash === "deadbee") return `${hash} parent1 parent2`;
        return `${hash} parent1`;
    }
    if (args[0] === "merge-base" && args.includes("feature-unmerged")) {
        throw new Error("not ancestor");
    }
    if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-force") {
        throw new Error("not fully merged");
    }
    return "";
};
const executorRun = vi.fn(defaultExecutorRunImpl);

const gitOpsState = {
    isRepository: vi.fn(async () => true),
    getBranches: vi.fn(async () => [
        { name: "main", hash: "feed1234", isRemote: false, isCurrent: true, ahead: 0, behind: 0 },
        {
            name: "feature-local",
            hash: "a1b2c3d4",
            isRemote: false,
            isCurrent: false,
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/main",
            hash: "feed1234",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/feature-remote",
            hash: "a1b2c3d4",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
        {
            name: "origin/force-fail",
            hash: "abc123",
            isRemote: true,
            isCurrent: false,
            remote: "origin",
            ahead: 0,
            behind: 0,
        },
    ]),
    getCommitDetail: vi.fn(async (hash: string) => ({
        hash,
        shortHash: hash.slice(0, 7),
        message: "msg",
        body: "",
        author: "Mahesh",
        email: "m@example.com",
        date: "2026-02-19T00:00:00Z",
        parentHashes: [],
        refs: [],
        files: [],
    })),
    getUnpushedCommitHashes: vi.fn(async () => ["a1b2c3d4", "feed1234", "deadbee"]),
    getFileContentAtRef: vi.fn(async (_filePath: string, ref: string) => `content:${ref}`),
    getBranchComparisonFiles: vi.fn(async () => [
        {
            repoId: ".",
            repoRoot: "/repo-a",
            path: "src/changed.ts",
            status: "M",
            additions: 1,
            deletions: 1,
        },
        {
            repoId: ".",
            repoRoot: "/repo-a",
            path: "src/next.ts",
            status: "M",
            additions: 2,
            deletions: 0,
        },
    ]),
    rollbackFiles: vi.fn(async () => undefined),
    shelveSave: vi.fn(async () => "saved"),
    getFileHistory: vi.fn(async () => "history"),
    getStatus: vi.fn(async () => []),
    listShelved: vi.fn(async () => []),
    getShelvedFiles: vi.fn(async () => []),
    getConflictedFiles: vi.fn(async () => []),
    getConflictFilesDetailed: vi.fn(async () => []),
    acceptConflictSide: vi.fn(async () => undefined),
    getConflictFileVersions: vi.fn(async () => ({ base: "", ours: "", theirs: "" })),
    stageFile: vi.fn(async () => undefined),
    commit: vi.fn(async () => "committed"),
    commitAndPush: vi.fn(async () => "committed and pushed"),
    isMergeInProgress: vi.fn(async () => false),
    isRebaseInProgress: vi.fn(async () => false),
    continueRebase: vi.fn(async () => "continued"),
    abortMerge: vi.fn(async () => ""),
    getPendingCommitMessage: vi.fn(async () => ""),
    push: vi.fn(async () => ""),
};

const repositoryEntries = [
    {
        root: "/repo-a",
        uri: { fsPath: "/repo-a", path: "/repo-a" },
        info: { name: "repo-a", root: "/repo-a", relativePath: "repo-a" },
        executor: { run: executorRun, runWithStderr: executorRun },
        gitOps: gitOpsState,
    },
    {
        root: "/repo-b",
        uri: { fsPath: "/repo-b", path: "/repo-b" },
        info: { name: "repo-b", root: "/repo-b", relativePath: "repo-b" },
        executor: { run: executorRun, runWithStderr: executorRun },
        gitOps: gitOpsState,
    },
] as const;
let currentRepositoryRoot = repositoryEntries[0].root;

const deleteFileWithFallback = vi.fn(async () => true);
type MockExtensionContext = {
    extensionUri: { fsPath: string; path: string };
    subscriptions: Array<{ dispose: () => void }>;
};

let latestCommitGraphProvider: MockCommitGraphViewProvider | undefined;
let latestCommitPanelProvider: MockCommitPanelViewProvider | undefined;
let latestBlameController: MockEditorBlameController | undefined;

class MockCommitGraphViewProvider {
    static readonly viewType = "intelligit.commitGraph";
    private commitSelectedEmitter = new MockEventEmitter<string>();
    private branchFilterEmitter = new MockEventEmitter<string | null>();
    private branchActionEmitter = new MockEventEmitter<{
        action: string;
        branchName: string;
        repoRoot?: string;
        allRepositories?: boolean;
    }>();
    private branchPopupActionEmitter = new MockEventEmitter<{
        action: string;
        root?: string;
    }>();
    private chooseWorktreeLocationEmitter = new MockEventEmitter<{ currentLocation?: string }>();
    private createWorktreeEmitter = new MockEventEmitter<Record<string, unknown>>();
    private openWorktreeEmitter = new MockEventEmitter<{ repoRoot: string; path: string }>();
    private deleteWorktreeEmitter = new MockEventEmitter<{ repoRoot: string; path: string }>();
    private commitActionEmitter = new MockEventEmitter<{
        action: string;
        hash: string;
    }>();
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();

    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitGraphProvider = this;
    }
    onCommitSelected = this.commitSelectedEmitter.event;
    onBranchFilterChanged = this.branchFilterEmitter.event;
    onBranchAction = this.branchActionEmitter.event;
    onBranchPopupAction = this.branchPopupActionEmitter.event;
    onChooseWorktreeLocation = this.chooseWorktreeLocationEmitter.event;
    onCreateWorktree = this.createWorktreeEmitter.event;
    onOpenWorktree = this.openWorktreeEmitter.event;
    onDeleteWorktree = this.deleteWorktreeEmitter.event;
    onCommitAction = this.commitActionEmitter.event;
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    setBranches = vi.fn();
    setRepositoryContext = vi.fn();
    refresh = vi.fn(async () => undefined);
    filterByBranch = vi.fn(async () => undefined);
    revealCommit = vi.fn(async () => undefined);
    openBranchPopup = vi.fn();
    openWorktreeDialog = vi.fn();
    openWorktreesDialog = vi.fn();
    setWorktreeLocationSelected = vi.fn();
    setWorktreeCreateResult = vi.fn();
    setRepositoryWorktrees = vi.fn();
    setWorktreeDeleteResult = vi.fn();
    setCommitDetail = vi.fn();
    clearCommitDetail = vi.fn();
    dispose = vi.fn();

    emitCommitSelected(hash: string): void {
        this.commitSelectedEmitter.fire(hash);
    }
    emitBranchFilterChanged(value: string | null): void {
        this.branchFilterEmitter.fire(value);
    }
    async emitBranchAction(payload: {
        action: string;
        branchName: string;
        repoRoot?: string;
        allRepositories?: boolean;
    }): Promise<void> {
        await this.branchActionEmitter.fireAsync(payload);
    }
    async emitBranchPopupAction(payload: { action: string; root?: string }): Promise<void> {
        await this.branchPopupActionEmitter.fireAsync(payload);
    }
    async emitChooseWorktreeLocation(payload: { currentLocation?: string }): Promise<void> {
        await this.chooseWorktreeLocationEmitter.fireAsync(payload);
    }
    async emitCreateWorktree(payload: Record<string, unknown>): Promise<void> {
        await this.createWorktreeEmitter.fireAsync(payload);
    }
    async emitOpenWorktree(payload: { repoRoot: string; path: string }): Promise<void> {
        await this.openWorktreeEmitter.fireAsync(payload);
    }
    async emitDeleteWorktree(payload: { repoRoot: string; path: string }): Promise<void> {
        await this.deleteWorktreeEmitter.fireAsync(payload);
    }
    emitCommitAction(payload: { action: string; hash: string }): void {
        this.commitActionEmitter.fire(payload);
    }
    emitOpenCommitFileDiff(payload: { commitHash: string; filePath: string }): void {
        this.openCommitFileDiffEmitter.fire(payload);
    }
}

class MockCommitInfoViewProvider {
    static readonly viewType = "intelligit.commitFiles";
    private openCommitFileDiffEmitter = new MockEventEmitter<{
        commitHash: string;
        filePath: string;
    }>();
    setCommitDetail = vi.fn();
    clear = vi.fn();
    onOpenCommitFileDiff = this.openCommitFileDiffEmitter.event;
    dispose = vi.fn();
}

class MockCommitPanelViewProvider {
    static readonly viewType = "intelligit.commitPanel";
    private fileCountEmitter = new MockEventEmitter<number>();
    constructor(_uri: unknown, _gitOps: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestCommitPanelProvider = this;
    }
    onDidChangeFileCount = this.fileCountEmitter.event;
    setRepositoryContext = vi.fn();
    refresh = vi.fn(async () => undefined);
    syncActiveEditor = vi.fn();
    getAdjacentWorkingFileTarget = vi.fn(() => null);
    openWorkingFileDiff = vi.fn(async () => undefined);
    navigateFile = vi.fn(async () => undefined);
    getDiffNavigationState = vi.fn(async () => ({
        active: true,
        hasPrevious: true,
        hasNext: true,
        currentFile: 1,
        totalFiles: 2,
    }));
    dispose = vi.fn();
    emitFileCount(count: number): void {
        this.fileCountEmitter.fire(count);
    }
}

class MockEditorBlameController {
    constructor(
        _repoRoot: string,
        _gitOps: unknown,
        _revealCommitInGraph: (hash: string) => Promise<void>,
    ) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        latestBlameController = this;
    }
    initialize = vi.fn(async () => undefined);
    annotateActiveEditor = vi.fn(async () => undefined);
    clear = vi.fn(async () => undefined);
    dispose = vi.fn();
}

vi.mock("fs", () => ({
    watch: vi.fn((...args: unknown[]) => {
        const callback = args[args.length - 1];
        if (typeof callback === "function") fsWatchCallbacks.push(callback);
        return { close: vi.fn() };
    }),
}));

vi.mock("vscode", () => ({
    Disposable: MockDisposable,
    EventEmitter: MockEventEmitter,
    ThemeIcon: class {
        constructor(_id: string, _color?: unknown) {}
    },
    ThemeColor: class {
        constructor(_id: string) {}
    },
    TreeItem: class {
        constructor(_label: string, _state?: unknown) {}
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    QuickPickItemKind: { Separator: -1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ViewColumn: { Active: -1, One: 1, Two: 2, Three: 3 },
    ProgressLocation: { Notification: 15 },
    FileType: { File: 1 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileSystemError: {
        FileNotFound: (uri: unknown) => new Error(`File not found: ${String(uri)}`),
        NoPermissions: (message: string) => new Error(message),
    },
    Uri: {
        file: (value: string) => ({ scheme: "file", fsPath: value, path: value }),
        from: ({
            scheme,
            path,
            query,
        }: {
            scheme: string;
            path: string;
            query?: string;
        }) => ({
            scheme,
            path,
            query,
            fsPath: path,
            toString: () => `${scheme}:${path}${query ? `?${query}` : ""}`,
        }),
        joinPath: (base: { fsPath?: string; path?: string }, ...parts: string[]) => {
            const prefix = base.fsPath ?? base.path ?? "";
            const joined = [prefix, ...parts].join("/").replace(/\/+/g, "/");
            return { fsPath: joined, path: joined };
        },
    },
    Position: MockPosition,
    Range: MockRange,
    languages: {
        registerDefinitionProvider: vi.fn((_selector, provider) => {
            registeredDefinitionProvider = provider as typeof registeredDefinitionProvider;
            return { dispose: vi.fn() };
        }),
    },
    commands: {
        registerCommand: vi.fn((id: string, handler: CommandHandler) => {
            registeredCommands.set(id, handler);
            return { dispose: vi.fn() };
        }),
        executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
            if (id === "vscode.diff" && args[1] && typeof args[1] === "object") {
                activeTextEditor = {
                    document: {
                        uri: args[1] as { fsPath: string; path: string; scheme: string },
                    },
                    selection: { active: { line: 0, character: 0 } },
                };
            }
            const handler = registeredCommands.get(id);
            if (handler) return handler(...args);
            return executeCommandFallback(id, ...args);
        }),
    },
    window: {
        get activeTextEditor() {
            return activeTextEditor;
        },
        onDidChangeActiveTextEditor: vi.fn((listener: (editor: unknown) => void) => {
            activeEditorListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidChangeTextEditorSelection: vi.fn((listener: (event: { textEditor: unknown }) => void) => {
            editorSelectionListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidChangeActiveColorTheme: vi.fn(() => ({ dispose: vi.fn() })),
        registerWebviewViewProvider,
        createTreeView: vi.fn(() => ({
            badge: undefined,
            dispose: vi.fn(),
        })),
        createWebviewPanel: vi.fn(() => {
            const msgListeners: Array<(msg: unknown) => void> = [];
            const disposeListeners: Array<() => void> = [];
            const panel = {
                webview: {
                    options: {},
                    html: "",
                    onDidReceiveMessage: vi.fn((listener: (msg: unknown) => void) => {
                        msgListeners.push(listener);
                        return { dispose: vi.fn() };
                    }),
                    postMessage: vi.fn(async () => true),
                    asWebviewUri: vi.fn((uri: { path?: string }) => uri),
                    cspSource: "https://test.csp",
                },
                onDidDispose: vi.fn((listener: () => void) => {
                    disposeListeners.push(listener);
                    return { dispose: vi.fn() };
                }),
                reveal: vi.fn(),
                dispose: vi.fn(() => {
                    for (const listener of disposeListeners) listener();
                }),
                async emitMessage(message: unknown): Promise<void> {
                    for (const listener of msgListeners) await listener(message);
                },
            };
            latestWebviewPanel = panel;
            return panel;
        }),
        showInformationMessage,
        showErrorMessage,
        showWarningMessage,
        showInputBox,
        showSaveDialog,
        showOpenDialog,
        showQuickPick,
        showTextDocument,
        createStatusBarItem,
        createTerminal,
        createOutputChannel,
        withProgress,
    },
    workspace: {
        get workspaceFolders() {
            return workspaceFolders;
        },
        onDidChangeWorkspaceFolders: vi.fn((listener: () => void) => {
            workspaceFolderListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        fs: { readFile, writeFile, stat: fsStat },
        openTextDocument,
        registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
        registerFileSystemProvider: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeTextDocument: vi.fn((listener: () => void) => {
            textDocListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidCloseTextDocument: vi.fn((listener: (document: { uri: { scheme?: string; toString?: () => string } }) => void) => {
            closeDocListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidSaveTextDocument: vi.fn((listener: () => void) => {
            saveDocListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidCreateFiles: vi.fn((listener: () => void) => {
            createFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidDeleteFiles: vi.fn((listener: () => void) => {
            deleteFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidRenameFiles: vi.fn((listener: () => void) => {
            renameFileListeners.push(listener);
            return { dispose: vi.fn() };
        }),
    },
    env: {
        clipboard: { writeText: clipboardWriteText },
    },
}));

vi.mock("../../src/git/executor", () => ({
    GitExecutor: class {
        run = executorRun;
        runWithStderr = executorRun;
    },
}));

vi.mock("../../src/git/operations", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/git/operations")>();
    return {
        UpstreamPushDeclinedError: actual.UpstreamPushDeclinedError,
        GitOps: class {
            isRepository = gitOpsState.isRepository;
            getBranches = gitOpsState.getBranches;
            getCommitDetail = gitOpsState.getCommitDetail;
            getUnpushedCommitHashes = gitOpsState.getUnpushedCommitHashes;
            getFileContentAtRef = gitOpsState.getFileContentAtRef;
            getBranchComparisonFiles = gitOpsState.getBranchComparisonFiles;
            rollbackFiles = gitOpsState.rollbackFiles;
            shelveSave = gitOpsState.shelveSave;
            getFileHistory = gitOpsState.getFileHistory;
            getStatus = gitOpsState.getStatus;
            listShelved = gitOpsState.listShelved;
            getShelvedFiles = gitOpsState.getShelvedFiles;
            getConflictedFiles = gitOpsState.getConflictedFiles;
            getConflictFilesDetailed = gitOpsState.getConflictFilesDetailed;
            acceptConflictSide = gitOpsState.acceptConflictSide;
            getConflictFileVersions = gitOpsState.getConflictFileVersions;
            stageFile = gitOpsState.stageFile;
            commit = gitOpsState.commit;
            commitAndPush = gitOpsState.commitAndPush;
            isMergeInProgress = gitOpsState.isMergeInProgress;
            abortMerge = gitOpsState.abortMerge;
            getPendingCommitMessage = gitOpsState.getPendingCommitMessage;
            push = gitOpsState.push;
        },
    };
});

vi.mock("../../src/views/CommitGraphViewProvider", () => ({
    CommitGraphViewProvider: MockCommitGraphViewProvider,
}));

vi.mock("../../src/views/CommitInfoViewProvider", () => ({
    CommitInfoViewProvider: MockCommitInfoViewProvider,
}));

vi.mock("../../src/views/CommitPanelViewProvider", () => ({
    CommitPanelViewProvider: MockCommitPanelViewProvider,
}));

vi.mock("../../src/services/EditorBlameController", () => ({
    EditorBlameController: MockEditorBlameController,
}));

vi.mock("../../src/services/RepositoryContextService", () => ({
    RepositoryContextService: class {
        async initialize() {}
        async refreshRepositories() {
            return repositoryEntries.find((entry) => entry.root === currentRepositoryRoot) ?? null;
        }
        async followActiveEditor(
            editor:
                | {
                      document?: { uri?: { fsPath?: string } };
                  }
                | undefined,
        ) {
            const fsPath = editor?.document?.uri?.fsPath;
            if (!fsPath) return false;
            const next =
                repositoryEntries.find((entry) => fsPath.startsWith(`${entry.root}/`)) ?? null;
            if (!next || next.root === currentRepositoryRoot) return false;
            currentRepositoryRoot = next.root;
            return true;
        }
        switchRepository(root: string) {
            if (!repositoryEntries.some((entry) => entry.root === root)) return false;
            if (root === currentRepositoryRoot) return false;
            currentRepositoryRoot = root;
            return true;
        }
        listRepositories() {
            return [...repositoryEntries];
        }
        getCurrentRepository() {
            return repositoryEntries.find((entry) => entry.root === currentRepositoryRoot) ?? null;
        }
        getCurrentRepositoryInfo() {
            return (
                repositoryEntries.find((entry) => entry.root === currentRepositoryRoot)?.info ??
                null
            );
        }
        getRepositoryForUri(uri?: { fsPath?: string }) {
            const fsPath = uri?.fsPath;
            if (!fsPath) return null;
            return (
                repositoryEntries.find(
                    (entry) => fsPath === entry.root || fsPath.startsWith(`${entry.root}/`),
                ) ?? null
            );
        }
        requireCurrentRepository() {
            const repository = repositoryEntries.find(
                (entry) => entry.root === currentRepositoryRoot,
            );
            if (!repository) throw new Error("No git repository found in the current workspace.");
            return repository;
        }
    },
    createRepositoryScopedExecutor: vi.fn(() => ({
        run: executorRun,
        runWithStderr: executorRun,
    })),
    createRepositoryScopedGitOps: vi.fn(() => ({
        isRepository: gitOpsState.isRepository,
        getBranches: gitOpsState.getBranches,
        getCommitDetail: gitOpsState.getCommitDetail,
        getUnpushedCommitHashes: gitOpsState.getUnpushedCommitHashes,
            getFileContentAtRef: gitOpsState.getFileContentAtRef,
            getBranchComparisonFiles: gitOpsState.getBranchComparisonFiles,
            rollbackFiles: gitOpsState.rollbackFiles,
        shelveSave: gitOpsState.shelveSave,
        getFileHistory: gitOpsState.getFileHistory,
        getStatus: gitOpsState.getStatus,
        listShelved: gitOpsState.listShelved,
        getShelvedFiles: gitOpsState.getShelvedFiles,
        getConflictedFiles: gitOpsState.getConflictedFiles,
        getConflictFilesDetailed: gitOpsState.getConflictFilesDetailed,
        acceptConflictSide: gitOpsState.acceptConflictSide,
        getConflictFileVersions: gitOpsState.getConflictFileVersions,
        stageFile: gitOpsState.stageFile,
        commit: gitOpsState.commit,
        commitAndPush: gitOpsState.commitAndPush,
        isMergeInProgress: gitOpsState.isMergeInProgress,
        abortMerge: gitOpsState.abortMerge,
        getPendingCommitMessage: gitOpsState.getPendingCommitMessage,
        push: gitOpsState.push,
    })),
}));

vi.mock("../../src/utils/fileOps", async () => {
    const actual = await vi.importActual("../../src/utils/fileOps");
    return {
        ...actual,
        deleteFileWithFallback,
    };
});

async function waitForAsync(): Promise<void> {
    const maxPasses = 8;
    for (let i = 0; i < maxPasses; i++) {
        await Promise.resolve();
        try {
            await vi.runAllTimersAsync();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isExpectedTimerError =
                message.includes("Timers are not mocked") ||
                message.includes("Cannot call") ||
                message.includes("runAllTimers");
            if (!isExpectedTimerError) throw error;
        }
    }
    await Promise.resolve();
}

describe("extension integration", () => {
    afterEach(() => {
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        [
            showInformationMessage,
            showErrorMessage,
            showWarningMessage,
            showInputBox,
            showSaveDialog,
            showOpenDialog,
            showQuickPick,
            showTextDocument,
            openTextDocument,
            readFile,
            writeFile,
            fsStat,
            executorRun,
            deleteFileWithFallback,
        ].forEach((mock) => mock.mockReset());
        Object.values(gitOpsState).forEach((mock) => mock.mockReset());
        registeredCommands.clear();
        mockDisposables.length = 0;
        textDocListeners.length = 0;
        closeDocListeners.length = 0;
        saveDocListeners.length = 0;
        createFileListeners.length = 0;
        deleteFileListeners.length = 0;
        renameFileListeners.length = 0;
        activeEditorListeners.length = 0;
        workspaceFolderListeners.length = 0;
        fsWatchCallbacks.length = 0;
        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        activeTextEditor = undefined;
        currentRepositoryRoot = repositoryEntries[0].root;
        latestCommitGraphProvider = undefined;
        latestCommitPanelProvider = undefined;
        latestBlameController = undefined;
        latestWebviewPanel = undefined;
        createdStatusBarItems.length = 0;
        openTextDocument.mockImplementation(async (arg: unknown) => ({
            uri: arg,
            languageId: "typescript",
        }));
        readFile.mockResolvedValue(Buffer.from(""));
        writeFile.mockResolvedValue(undefined);
        fsStat.mockResolvedValue({ type: 1, ctime: 0, mtime: 0, size: 1 });

        executorRun.mockImplementation(defaultExecutorRunImpl);
        gitOpsState.isRepository.mockResolvedValue(true);
        gitOpsState.getBranches.mockResolvedValue([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/feature-remote",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/force-fail",
                hash: "abc123",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        gitOpsState.getCommitDetail.mockImplementation(async (hash: string) => ({
            hash,
            shortHash: hash.slice(0, 7),
            message: "msg",
            body: "",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
            files: [],
        }));
        gitOpsState.getUnpushedCommitHashes.mockResolvedValue(["a1b2c3d4", "feed1234", "deadbee"]);
        gitOpsState.getFileContentAtRef.mockImplementation(
            async (_filePath: string, ref: string) => `content:${ref}`,
        );
        gitOpsState.getBranchComparisonFiles.mockResolvedValue([
            {
                repoId: ".",
                repoRoot: "/repo-a",
                path: "src/changed.ts",
                status: "M",
                additions: 1,
                deletions: 1,
            },
            {
                repoId: ".",
                repoRoot: "/repo-a",
                path: "src/next.ts",
                status: "M",
                additions: 2,
                deletions: 0,
            },
        ]);
        gitOpsState.rollbackFiles.mockResolvedValue(undefined);
        gitOpsState.shelveSave.mockResolvedValue("saved");
        gitOpsState.getFileHistory.mockResolvedValue("history");
        gitOpsState.getConflictedFiles.mockResolvedValue([]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.acceptConflictSide.mockResolvedValue(undefined);
        gitOpsState.commit.mockResolvedValue("committed");
        gitOpsState.commitAndPush.mockResolvedValue("committed and pushed");
        gitOpsState.isMergeInProgress.mockResolvedValue(false);
        gitOpsState.isRebaseInProgress.mockResolvedValue(false);
        gitOpsState.continueRebase.mockResolvedValue("continued");
        gitOpsState.abortMerge.mockResolvedValue("");
        gitOpsState.getPendingCommitMessage.mockResolvedValue("");
        deleteFileWithFallback.mockResolvedValue(true);

        showWarningMessage.mockImplementation(
            async (_msg?: string, _opts?: unknown, ...items: string[]) => items[0],
        );
        showInputBox.mockImplementation(async (opts?: { prompt?: string; value?: string }) => {
            if (!opts?.prompt) return "input";
            if (opts.prompt.includes("New branch")) return "feature/new";
            if (opts.prompt.includes("New tag")) return "v1.0.0";
            if (opts.prompt.includes("Rename")) return "renamed-branch";
            if (opts.prompt.includes("Edit commit message")) return "edited message";
            return "input";
        });
        showSaveDialog.mockResolvedValue({
            fsPath: "/tmp/patch.diff",
            path: "/tmp/patch.diff",
        } as unknown as { fsPath: string; path: string });
        showOpenDialog.mockResolvedValue([{ fsPath: "/tmp", path: "/tmp" }]);
        showQuickPick.mockImplementation(async (items: Array<Record<string, unknown>>) => items[0]);
    });

    it("activates and executes branch/file command handlers", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;

        await activate(context);

        expect(registeredCommands.has("intelligit.refresh")).toBe(true);
        expect(registeredCommands.has("intelligit.checkout")).toBe(true);
        expect(registeredCommands.has("intelligit.fileDelete")).toBe(true);
        expect(registeredCommands.has("intelligit.openMergeConflict")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptYours")).toBe(true);
        expect(registeredCommands.has("intelligit.conflictAcceptTheirs")).toBe(true);
        expect(registeredCommands.has("intelligit.openConflictSession")).toBe(true);
        expect(registeredCommands.has("intelligit.annotateWithGitBlame")).toBe(true);
        expect(registeredCommands.has("intelligit.clearGitBlame")).toBe(true);
        expect(registeredCommands.has("intelligit.revealCommitInGraph")).toBe(true);
        expect(registeredCommands.has("intelligit.openCommitDiffSource")).toBe(true);
        expect(registeredCommands.has("intelligit.compareProjectWithBranch")).toBe(true);
        expect(registeredCommands.has("intelligit.showBranchPopup")).toBe(true);
        expect(registeredCommands.has("intelligit.abortMerge")).toBe(true);
        expect(registeredCommands.has("intelligit.previousDiffFile")).toBe(true);
        expect(registeredCommands.has("intelligit.nextDiffFile")).toBe(true);
        expect(registeredCommands.has("intelligit.previousDiffChange")).toBe(false);
        expect(registeredCommands.has("intelligit.nextDiffChange")).toBe(false);
        expect(registeredCommands.has("intelligit.previousWorkingFileChange")).toBe(false);
        expect(registeredCommands.has("intelligit.nextWorkingFileChange")).toBe(false);
        expect(registeredCommands.has("intelligit.previousProjectComparisonChange")).toBe(false);
        expect(registeredCommands.has("intelligit.nextProjectComparisonChange")).toBe(false);

        function getCommand(id: string): CommandHandler {
            const cmd = registeredCommands.get(id);
            if (!cmd) throw new Error(`Missing command registration: ${id}`);
            return cmd;
        }

        expect(createStatusBarItem).toHaveBeenCalledWith(1, 100);
        expect(createStatusBarItem).toHaveBeenCalledWith(1, 99);
        expect(createStatusBarItem).toHaveBeenCalledWith(1, 98);
        expect(createdStatusBarItems[0]?.command).toBe("intelligit.showBranchPopup");
        expect(createdStatusBarItems[0]?.text).toContain("main");
        expect(createdStatusBarItems[0]?.text).not.toContain("chevron-down");
        expect(createdStatusBarItems[0]?.text).not.toContain("↗");
        expect(createdStatusBarItems[0]?.text).not.toContain("↙");
        expect(createdStatusBarItems[0]?.show).toHaveBeenCalled();
        expect(createdStatusBarItems[1]?.command).toBe("intelligit.abortMerge");
        expect(createdStatusBarItems[1]?.hide).toHaveBeenCalled();
        expect(createdStatusBarItems[2]?.text).toBe("1/2 files");
        expect(createdStatusBarItems[2]?.show).toHaveBeenCalled();

        await getCommand("intelligit.showBranchPopup")();
        expect(executeCommandFallback).toHaveBeenCalledWith("intelligit.commitGraph.focus");
        expect(latestCommitGraphProvider!.openBranchPopup).toHaveBeenCalled();

        await getCommand("intelligit.refresh")();
        await getCommand("intelligit.filterByBranch")("main");
        await getCommand("intelligit.showGitLog")();
        await getCommand("intelligit.annotateWithGitBlame")();
        await getCommand("intelligit.clearGitBlame")();
        await getCommand("intelligit.revealCommitInGraph")("deadbee");

        await getCommand("intelligit.checkout")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.newBranchFrom")({
            branch: { name: "feature-local", isRemote: false },
        });
        expect(showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: "New branch from feature-local",
                value: "feature-local",
                valueSelection: [0, "feature-local".length],
            }),
        );
        await getCommand("intelligit.checkoutAndRebase")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.rebaseCurrentOnto")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.mergeIntoCurrent")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.updateBranch")({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });
        await getCommand("intelligit.pushBranch")({
            branch: { name: "main", isRemote: false, isCurrent: true, remote: "origin" },
        });
        await getCommand("intelligit.renameBranch")({
            branch: { name: "feature-local", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "feature-unmerged", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "feature-force", isRemote: false },
        });
        await getCommand("intelligit.deleteBranch")({
            branch: { name: "origin/feature-remote", isRemote: true, remote: "origin" },
        });

        await getCommand("intelligit.fileRollback")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileJumpToSource")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileDelete")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileShelve")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileShowHistory")({ filePath: "src/a.ts" });
        await getCommand("intelligit.fileRefresh")();
        await getCommand("intelligit.openMergeConflict")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.conflictAcceptYours")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.conflictAcceptTheirs")({
            filePath: "src/conflicted.ts",
        });
        await getCommand("intelligit.mergeConflictsRefresh")();
        await getCommand("intelligit.openConflictSession")();

        expect(executorRun).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalled();
        expect(showWarningMessage).toHaveBeenCalled();
        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/conflicted.ts", "ours");
        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/conflicted.ts", "theirs");
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting remote branch origin/feature-remote"),
            }),
            expect.any(Function),
        );
        expect(deleteFileWithFallback).toHaveBeenCalled();
        expect(latestBlameController!.initialize).toHaveBeenCalled();
        expect(latestBlameController!.annotateActiveEditor).toHaveBeenCalled();
        expect(latestBlameController!.clear).toHaveBeenCalled();
        expect(latestCommitGraphProvider!.revealCommit).toHaveBeenCalledWith("deadbee");
    });

    it("shows merge state in the status bar and aborts the current merge", async () => {
        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        expect(createdStatusBarItems[0]?.text).toBe("$(warning) Merging main");
        expect(createdStatusBarItems[0]?.command).toBe("intelligit.openConflictSession");
        expect(createdStatusBarItems[1]?.text).toBe("$(close)");
        expect(createdStatusBarItems[1]?.command).toBe("intelligit.abortMerge");
        expect(createdStatusBarItems[1]?.show).toHaveBeenCalled();

        await registeredCommands.get("intelligit.abortMerge")?.();

        expect(showWarningMessage).toHaveBeenCalledWith(
            "Abort the current merge and discard merge conflict resolutions?",
            { modal: true },
            "Abort Merge",
        );
        expect(gitOpsState.abortMerge).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalledWith("Merge aborted.");
    });

    it("opens the previous working file without custom hunk navigation", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        activeTextEditor = {
            document: {
                uri: {
                    scheme: "intelligit-diff-editable",
                    fsPath: "/__intelligit_text_diff__/1/current.ts",
                    path: "/__intelligit_text_diff__/1/current.ts",
                    query: "ref=working-tree&path=src/current.ts",
                    toString: () =>
                        "intelligit-diff-editable:/__intelligit_text_diff__/1/current.ts?ref=working-tree&path=src/current.ts",
                },
            },
            selection: { active: { line: 10, character: 0 } },
        } as unknown as typeof activeTextEditor;
        executeCommandFallback.mockClear();

        await registeredCommands.get("intelligit.previousDiffFile")?.();

        expect(latestCommitPanelProvider!.navigateFile).toHaveBeenCalledWith("previous");
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "workbench.action.compareEditor.previousChange",
        );
    });

    it("updates non-current local branch via fetch refspec without checkout", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: false, remote: "origin" },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "main:main",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).not.toHaveBeenCalledWith(["checkout", "main"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Updating main"),
            }),
            expect.any(Function),
        );
    });

    it("updates current local branch by fetching and fast-forwarding FETCH_HEAD", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "main",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).toHaveBeenCalledWith(["merge", "--ff-only", "FETCH_HEAD"]);
        expect(executorRun).not.toHaveBeenCalledWith(["rebase", "--autostash", "FETCH_HEAD"]);
        expect(executorRun).not.toHaveBeenCalledWith(["pull", "--ff-only"]);
    });

    it("falls back to rebase when current branch update cannot fast-forward", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === "FETCH_HEAD") {
                throw new Error("not possible to fast-forward");
            }
            return defaultExecutorRunImpl(args);
        });

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });

        expect(executorRun).toHaveBeenCalledWith(["merge", "--ff-only", "FETCH_HEAD"]);
        expect(executorRun).toHaveBeenCalledWith(["rebase", "--autostash", "FETCH_HEAD"]);
        expect(showInformationMessage).toHaveBeenCalledWith("Updated main");
    });

    it("opens conflict session when current branch update rebase has conflicts", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "merge" && args[1] === "--ff-only" && args[2] === "FETCH_HEAD") {
                throw new Error("not possible to fast-forward");
            }
            if (args[0] === "rebase" && args[1] === "--autostash" && args[2] === "FETCH_HEAD") {
                throw new Error("rebase conflict");
            }
            return defaultExecutorRunImpl(args);
        });
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(
            "Update produced 1 unresolved conflict file. Opened Conflicts session.",
        );
        expect(showInformationMessage).not.toHaveBeenCalledWith("Updated main");
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("opens the new worktree dialog from a branch action", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await latestCommitGraphProvider!.emitBranchAction({
            action: "newWorktreeFrom",
            branchName: "main",
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith(["worktree", "list", "--porcelain"]);
        expect(latestCommitGraphProvider!.openWorktreeDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                branch: expect.objectContaining({ name: "main" }),
                defaultLocation: "/",
                defaultProjectName: "repo-a-main",
                worktrees: [{ path: "/repo-a", head: "feed1234", branch: "main", detached: false }],
            }),
        );
        expect(executorRun).not.toHaveBeenCalledWith(
            expect.arrayContaining(["worktree", "add"]),
        );
    });

    it("opens the checked-out worktree for a branch action", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "worktree" && args[1] === "list") {
                return [
                    "worktree /repo-a",
                    "HEAD feed1234",
                    "branch refs/heads/main",
                    "",
                    "worktree /repo-a-feature",
                    "HEAD a1b2c3d4",
                    "branch refs/heads/feature-local",
                    "",
                ].join("\n");
            }
            return defaultExecutorRunImpl(args);
        });
        await activate(context);
        executeCommandFallback.mockClear();

        await latestCommitGraphProvider!.emitBranchAction({
            action: "openWorktree",
            branchName: "feature-local",
        });
        await waitForAsync();

        expect(latestCommitGraphProvider!.setRepositoryWorktrees).toHaveBeenCalledWith(
            "/repo-a",
            expect.arrayContaining([
                expect.objectContaining({ path: "/repo-a-feature", branch: "feature-local" }),
            ]),
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.openFolder",
            expect.objectContaining({ fsPath: "/repo-a-feature" }),
            true,
        );
    });

    it("updates and pushes common local branches in all repositories", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockClear();
        showInformationMessage.mockClear();
        showErrorMessage.mockClear();
        await latestCommitGraphProvider!.emitBranchAction({
            action: "updateBranch",
            branchName: "main",
            allRepositories: true,
        });

        expect(
            executorRun.mock.calls.filter(
                ([args]) =>
                    args[0] === "fetch" &&
                    args[1] === "origin" &&
                    args[2] === "main" &&
                    args.includes("--recurse-submodules=no"),
            ),
        ).toHaveLength(2);
        expect(
            executorRun.mock.calls.filter(
                ([args]) =>
                    args[0] === "merge" && args[1] === "--ff-only" && args[2] === "FETCH_HEAD",
            ),
        ).toHaveLength(2);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Updated main in 2 repositories.",
        );
        expect(showErrorMessage).not.toHaveBeenCalled();

        executorRun.mockClear();
        showInformationMessage.mockClear();
        showErrorMessage.mockClear();
        await latestCommitGraphProvider!.emitBranchAction({
            action: "pushBranch",
            branchName: "main",
            allRepositories: true,
        });

        expect(
            executorRun.mock.calls.filter(
                ([args]) => args[0] === "push" && args[1] === "origin" && args[2] === "main:main",
            ),
        ).toHaveLength(2);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Pushed main in 2 repositories.",
        );
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("prefills and selects the current branch when creating from the branch popup", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInputBox.mockClear();
        await latestCommitGraphProvider!.emitBranchPopupAction({
            action: "newBranch",
            root: "/repo-a",
        });
        await waitForAsync();

        expect(showInputBox).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: "New branch from current branch",
                value: "main",
                valueSelection: [0, "main".length],
            }),
        );
    });

    it("opens the worktrees dialog from the branch popup action", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await latestCommitGraphProvider!.emitBranchPopupAction({
            action: "worktrees",
            root: "/repo-a",
        });
        await waitForAsync();

        expect(latestCommitGraphProvider!.setRepositoryWorktrees).toHaveBeenCalledWith(
            "/repo-a",
            [{ path: "/repo-a", head: "feed1234", branch: "main", detached: false }],
        );
        expect(latestCommitGraphProvider!.openWorktreesDialog).toHaveBeenCalledWith("/repo-a");
    });

    it("opens the new worktree dialog from the worktrees dialog create action", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await latestCommitGraphProvider!.emitBranchPopupAction({
            action: "newWorktree",
            root: "/repo-b",
        });
        await waitForAsync();

        expect(latestCommitGraphProvider!.openWorktreeDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({ root: "/repo-b" }),
                branch: expect.objectContaining({ name: "main" }),
                defaultProjectName: "repo-b-main",
            }),
        );
    });

    it("opens all repository worktrees from the top-level branch popup action", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        let worktreeListCall = 0;
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "worktree" && args[1] === "list") {
                worktreeListCall += 1;
                const root = worktreeListCall === 1 ? "/repo-a" : "/repo-b";
                return ["worktree " + root, "HEAD feed1234", "branch refs/heads/main", ""].join(
                    "\n",
                );
            }
            return defaultExecutorRunImpl(args);
        });
        await activate(context);

        await latestCommitGraphProvider!.emitBranchPopupAction({
            action: "worktrees",
        });
        await waitForAsync();

        expect(latestCommitGraphProvider!.setRepositoryWorktrees).toHaveBeenCalledWith(
            "/repo-a",
            [{ path: "/repo-a", head: "feed1234", branch: "main", detached: false }],
        );
        expect(latestCommitGraphProvider!.setRepositoryWorktrees).toHaveBeenCalledWith(
            "/repo-b",
            [{ path: "/repo-b", head: "feed1234", branch: "main", detached: false }],
        );
        expect(latestCommitGraphProvider!.openWorktreesDialog).toHaveBeenCalledWith();
    });

    it("deletes a linked worktree with git worktree remove", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "worktree" && args[1] === "list") {
                return [
                    "worktree /repo-a",
                    "HEAD feed1234",
                    "branch refs/heads/main",
                    "",
                    "worktree /repo-a-feature",
                    "HEAD a1b2c3d4",
                    "branch refs/heads/feature-local",
                    "",
                ].join("\n");
            }
            return defaultExecutorRunImpl(args);
        });
        await activate(context);

        await latestCommitGraphProvider!.emitDeleteWorktree({
            repoRoot: "/repo-a",
            path: "/repo-a-feature",
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "worktree",
            "remove",
            "/repo-a-feature",
        ]);
        expect(latestCommitGraphProvider!.setWorktreeDeleteResult).toHaveBeenCalledWith({
            success: true,
            path: "/repo-a-feature",
        });
    });

    it("blocks deleting the current worktree", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await latestCommitGraphProvider!.emitDeleteWorktree({
            repoRoot: "/repo-a",
            path: "/repo-a",
        });
        await waitForAsync();

        expect(executorRun).not.toHaveBeenCalledWith(["worktree", "remove", "/repo-a"]);
        expect(latestCommitGraphProvider!.setWorktreeDeleteResult).toHaveBeenCalledWith({
            success: false,
            message: "The current worktree cannot be deleted from this window.",
        });
    });

    it("selects a worktree location through the VS Code folder picker", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await latestCommitGraphProvider!.emitChooseWorktreeLocation({ currentLocation: "/repos" });
        await waitForAsync();

        expect(showOpenDialog).toHaveBeenCalledWith(
            expect.objectContaining({
                canSelectFolders: true,
                defaultUri: expect.objectContaining({ fsPath: "/repos" }),
            }),
        );
        expect(latestCommitGraphProvider!.setWorktreeLocationSelected).toHaveBeenCalledWith("/tmp");
    });

    it("creates a new-branch worktree and opens it in a new VS Code window", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        executeCommandFallback.mockClear();

        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        const target = path.join(parent, "repo-a-feature-worktree");
        await latestCommitGraphProvider!.emitCreateWorktree({
            repoRoot: "/repo-a",
            branchName: "main",
            createBranch: true,
            newBranchName: "feature/worktree",
            projectName: "repo-a-feature-worktree",
            location: parent,
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "worktree",
            "add",
            "-b",
            "feature/worktree",
            target,
            "main",
        ]);
        expect(latestCommitGraphProvider!.setWorktreeCreateResult).toHaveBeenCalledWith({
            success: true,
            path: target,
        });
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.openFolder",
            expect.objectContaining({ fsPath: target }),
            true,
        );
    });

    it("creates a worktree from an unchecked-out local branch without -b", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        const target = path.join(parent, "repo-a-feature-local");
        await latestCommitGraphProvider!.emitCreateWorktree({
            repoRoot: "/repo-a",
            branchName: "feature-local",
            createBranch: false,
            projectName: "repo-a-feature-local",
            location: parent,
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "worktree",
            "add",
            target,
            "feature-local",
        ]);
    });

    it("fetches a selected remote branch before creating its worktree", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        const target = path.join(parent, "repo-a-remote-main");
        await latestCommitGraphProvider!.emitCreateWorktree({
            repoRoot: "/repo-a",
            branchName: "origin/main",
            createBranch: true,
            newBranchName: "remote/main-worktree",
            projectName: "repo-a-remote-main",
            location: parent,
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "fetch",
            "origin",
            "main",
            "--recurse-submodules=no",
            "--progress",
            "--prune",
        ]);
        expect(executorRun).toHaveBeenCalledWith([
            "worktree",
            "add",
            "-b",
            "remote/main-worktree",
            target,
            "origin/main",
        ]);
    });

    it("keeps the worktree dialog open when creation fails", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "worktree" && args[1] === "add") {
                throw new Error("worktree failed");
            }
            return defaultExecutorRunImpl(args);
        });
        executeCommandFallback.mockClear();

        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        await latestCommitGraphProvider!.emitCreateWorktree({
            repoRoot: "/repo-a",
            branchName: "feature-local",
            createBranch: false,
            projectName: "repo-a-fail",
            location: parent,
        });
        await waitForAsync();

        expect(latestCommitGraphProvider!.setWorktreeCreateResult).toHaveBeenCalledWith({
            success: false,
            message: "worktree failed",
        });
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "vscode.openFolder",
            expect.anything(),
            true,
        );
    });

    it("opens the built-in merge editor by default for conflict files", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/default-conflicted.ts",
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeEditor",
            "Merge: src/default-conflicted.ts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "git.openMergeEditor",
            expect.anything(),
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("uses a native modal confirmation for destructive merge-editor actions", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        showWarningMessage.mockResolvedValueOnce("Discard and Close");

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/confirm-conflicted.ts",
        });
        await latestWebviewPanel?.emitMessage({
            type: "confirm",
            requestId: 7,
            message: "Discard local merge edits?",
            confirmLabel: "Discard and Close",
        });

        expect(showWarningMessage).toHaveBeenCalledWith(
            "Discard local merge edits?",
            { modal: true },
            "Discard and Close",
        );
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenCalledWith({
            type: "confirmResult",
            requestId: 7,
            confirmed: true,
        });
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("does not overwrite a conflicted file that changed after the editor loaded", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        gitOpsState.getConflictFileVersions.mockResolvedValue({
            base: "base\n",
            ours: "ours\n",
            theirs: "theirs\n",
        });
        readFile
            .mockResolvedValueOnce(Buffer.from("original\n"))
            .mockResolvedValueOnce(Buffer.from("changed externally\n"));

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/stale-conflicted.ts",
        });
        await latestWebviewPanel?.emitMessage({ type: "ready" });
        await latestWebviewPanel?.emitMessage({
            type: "applyResolution",
            content: "resolved\n",
        });

        expect(writeFile).not.toHaveBeenCalled();
        expect(gitOpsState.stageFile).not.toHaveBeenCalled();
        expect(showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining("changed on disk"),
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("opens conflict files in the repository from the command context uri", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/repo-b-conflicted.ts",
            uri: {
                scheme: "file",
                fsPath: "/repo-b/src/repo-b-conflicted.ts",
                path: "/repo-b/src/repo-b-conflicted.ts",
            },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(currentRepositoryRoot).toBe("/repo-b");
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeEditor",
            "Merge: src/repo-b-conflicted.ts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(latestCommitGraphProvider!.setRepositoryContext).toHaveBeenCalledWith(
            expect.objectContaining({ root: "/repo-b" }),
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("opens conflict session when refresh detects new unresolved conflicts", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();

        gitOpsState.getConflictedFiles.mockResolvedValue(["src/conflicted.ts"]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.mergeConflictsRefresh")?.();

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(
            "Detected 1 unresolved merge conflict file. Opened Conflicts session.",
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("restores a conflict session when a rebase awaits completion after activation", async () => {
        gitOpsState.isRebaseInProgress.mockResolvedValue(true);
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );

        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
        await registeredCommands.get("intelligit.openConflictSession")?.();
        expect(createWebviewPanelMock).toHaveBeenCalledTimes(2);

        await latestWebviewPanel?.emitMessage({ type: "acceptAndFinish" });
        expect(gitOpsState.continueRebase).toHaveBeenCalled();
    });

    it("auto commits the merge after the final conflict is resolved", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        gitOpsState.getPendingCommitMessage.mockResolvedValue(
            "Merge branch 'master' into alpha",
        );
        gitOpsState.getConflictFileVersions.mockResolvedValue({
            base: "",
            ours: "",
            theirs: "",
        });

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/final-conflict.ts",
        });
        await latestWebviewPanel?.emitMessage({ type: "ready" });
        await latestWebviewPanel?.emitMessage({
            type: "applyResolution",
            content: "resolved\n",
        });

        expect(gitOpsState.stageFile).toHaveBeenCalledWith("src/final-conflict.ts");
        expect(gitOpsState.commit).toHaveBeenCalledWith(
            "Merge branch 'master' into alpha",
            false,
        );
        expect(showInformationMessage).toHaveBeenCalledWith("Merge committed successfully.");
    });

    it("continues the rebase after the final conflict is resolved", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.isRebaseInProgress.mockResolvedValue(true);
        gitOpsState.getConflictFileVersions.mockResolvedValue({
            base: "",
            ours: "",
            theirs: "",
        });

        await registeredCommands.get("intelligit.openMergeConflict")?.({
            filePath: "src/final-rebase-conflict.ts",
        });
        await latestWebviewPanel?.emitMessage({ type: "ready" });
        await latestWebviewPanel?.emitMessage({
            type: "applyResolution",
            content: "resolved\n",
        });

        expect(gitOpsState.stageFile).toHaveBeenCalledWith("src/final-rebase-conflict.ts");
        expect(gitOpsState.continueRebase).toHaveBeenCalled();
        expect(gitOpsState.commit).not.toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalledWith("Rebase continued successfully.");
    });

    it("opens existing merge conflicts instead of starting another merge", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "feature-local", isRemote: false },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(executorRun).not.toHaveBeenCalledWith(["merge", "feature-local"]);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(showWarningMessage).toHaveBeenCalledWith(
            "Merge is already in progress with 1 unresolved conflict file. Opened Conflicts session.",
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("commits an existing merge instead of starting another merge when conflicts are resolved", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.getPendingCommitMessage.mockResolvedValue(
            "Merge branch 'master' into alpha",
        );

        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "feature-local", isRemote: false },
        });

        expect(executorRun).not.toHaveBeenCalledWith(["merge", "feature-local"]);
        expect(gitOpsState.commit).toHaveBeenCalledWith(
            "Merge branch 'master' into alpha",
            false,
        );
        expect(showInformationMessage).toHaveBeenCalledWith("Merge committed successfully.");
    });

    it("opens conflict session when merge fails with unresolved conflicts", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "merge" && args[1] === "feature-local") {
                throw new Error("merge conflict");
            }
            return defaultExecutorRunImpl(args);
        });
        gitOpsState.getConflictedFiles.mockResolvedValue(["src/conflicted.ts"]);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "feature-local", isRemote: false },
        });

        const vscode = await import("vscode");
        const createWebviewPanelMock = vi.mocked(vscode.window.createWebviewPanel);
        expect(createWebviewPanelMock).toHaveBeenCalledWith(
            "intelligit.mergeConflictSession",
            "Conflicts",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("retains resolved files and selects the next unresolved session conflict", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();

        const a = { path: "src/a.ts", code: "UU", ours: "Modified", theirs: "Modified" } as const;
        const b = { path: "src/b.ts", code: "UU", ours: "Modified", theirs: "Modified" } as const;
        const c = { path: "src/c.ts", code: "UU", ours: "Modified", theirs: "Modified" } as const;
        gitOpsState.getConflictFilesDetailed
            .mockResolvedValueOnce([a, b, c])
            .mockResolvedValueOnce([a, b, c])
            .mockResolvedValueOnce([a, c])
            .mockResolvedValueOnce([a, c])
            .mockResolvedValueOnce([a, c]);

        await registeredCommands.get("intelligit.openConflictSession")?.();
        await latestWebviewPanel?.emitMessage({ type: "acceptYours", filePath: "src/b.ts" });

        expect(gitOpsState.acceptConflictSide).toHaveBeenCalledWith("src/b.ts", "ours");
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenLastCalledWith({
            type: "setSessionData",
            data: expect.objectContaining({
                selectedPath: "src/c.ts",
                files: [
                    expect.objectContaining({ ...a, resolved: false }),
                    expect.objectContaining({ ...b, resolved: true }),
                    expect.objectContaining({ ...c, resolved: false }),
                ],
            }),
        });
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("resolves and stages session files that need no manual conflict choice", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();

        const file = {
            path: "src/simple.ts",
            code: "UU",
            ours: "Modified",
            theirs: "Modified",
        } as const;
        gitOpsState.getConflictFilesDetailed
            .mockResolvedValueOnce([file])
            .mockResolvedValueOnce([file])
            .mockResolvedValueOnce([file])
            .mockResolvedValue([]);
        gitOpsState.getConflictFileVersions.mockResolvedValue({
            base: "base\n",
            ours: "base\nlocal\n",
            theirs: "base\n",
        });
        readFile.mockResolvedValue(
            Buffer.from("<<<<<<< ours\nbase\n=======\nbase\n>>>>>>> theirs\n"),
        );

        await registeredCommands.get("intelligit.openConflictSession")?.();
        expect(latestWebviewPanel).toBeDefined();
        expect(gitOpsState.getConflictFilesDetailed).toHaveBeenCalled();
        await latestWebviewPanel?.emitMessage({ type: "resolveAllSimple" });

        expect(gitOpsState.getConflictFileVersions).toHaveBeenCalledWith("src/simple.ts");
        expect(writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ fsPath: "/repo-a/src/simple.ts" }),
            Buffer.from("base\nlocal\n"),
        );
        expect(gitOpsState.stageFile).toHaveBeenCalledWith("src/simple.ts");
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenLastCalledWith({
            type: "setSessionData",
            data: expect.objectContaining({
                simpleConflictsResolved: true,
                files: [
                    expect.objectContaining({
                        path: "src/simple.ts",
                        resolved: true,
                        resolvedConflictCount: 1,
                        totalConflictCount: 1,
                    }),
                ],
            }),
        });
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("opens only the remaining manual hunks after resolving simple conflicts", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const file = {
            path: "src/mixed.ts",
            code: "UU",
            ours: "Modified",
            theirs: "Modified",
        } as const;
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([file]);
        gitOpsState.getConflictFileVersions.mockResolvedValue({
            base: "start\nbase-only\nmiddle\nbase-conflict\nend\n",
            ours: "start\nours-only\nmiddle\nours-conflict\nend\n",
            theirs: "start\nbase-only\nmiddle\ntheirs-conflict\nend\n",
        });
        readFile.mockResolvedValue(Buffer.from("conflict markers\n"));

        await registeredCommands.get("intelligit.openConflictSession")?.();
        const sessionPanel = latestWebviewPanel;
        await latestWebviewPanel?.emitMessage({ type: "resolveAllSimple" });
        await latestWebviewPanel?.emitMessage({ type: "openMerge", filePath: file.path });
        await latestWebviewPanel?.emitMessage({ type: "ready" });

        const conflictDataMessage = latestWebviewPanel?.webview.postMessage.mock.calls
            .map(([message]) => message)
            .find((message) => message?.type === "setConflictData");
        const segments = conflictDataMessage?.data?.segments ?? [];
        expect(segments.filter((segment: { type: string }) => segment.type === "conflict"))
            .toHaveLength(1);
        expect(
            segments
                .filter((segment: { type: string }) => segment.type === "common")
                .flatMap((segment: { lines: string[] }) => segment.lines),
        ).toContain("ours-only");
        expect(gitOpsState.stageFile).not.toHaveBeenCalled();
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
        (sessionPanel as { dispose?: () => void } | undefined)?.dispose?.();
    });

    it("aborts an active merge when the conflict session is closed", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        (latestWebviewPanel as { dispose?: () => void } | undefined)?.dispose?.();
        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([
            {
                path: "src/conflicted.ts",
                code: "UU",
                ours: "Modified",
                theirs: "Modified",
            },
        ]);

        await registeredCommands.get("intelligit.openConflictSession")?.();
        await latestWebviewPanel?.emitMessage({ type: "close" });

        expect(showWarningMessage).toHaveBeenCalledWith(
            "Abort merge?",
            { modal: true },
            "Abort",
        );
        expect(gitOpsState.abortMerge).toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalledWith("Merge aborted.");
    });

    it("finishes the merge only after the conflict session accepts it", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const file = {
            path: "src/final.ts",
            code: "UU",
            ours: "Modified",
            theirs: "Modified",
        } as const;
        gitOpsState.getConflictFilesDetailed.mockResolvedValue([file]);
        await registeredCommands.get("intelligit.openConflictSession")?.();

        gitOpsState.getConflictFilesDetailed.mockResolvedValue([]);
        gitOpsState.isMergeInProgress.mockResolvedValue(true);
        gitOpsState.getPendingCommitMessage.mockResolvedValue("Merge feature into main");
        await latestWebviewPanel?.emitMessage({ type: "acceptAndFinish" });

        expect(gitOpsState.commit).toHaveBeenCalledWith("Merge feature into main", false);
        expect(showInformationMessage).toHaveBeenCalledWith("Merge committed successfully.");
    });

    it("offers restore action after deleting local branch", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInformationMessage.mockImplementation(async (message?: string) => {
            if (typeof message === "string" && message.startsWith("Deleted: feature-local")) {
                return "Restore";
            }
            return undefined;
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                upstream: "origin/feature-local",
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith(["branch", "-d", "feature-local"]);
        expect(executorRun).toHaveBeenCalledWith(["branch", "feature-local", "a1b2c3d4"]);
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Deleted: feature-local",
            "Restore",
            "Delete Tracked Branch",
        );
    });

    it("supports delete tracked branch action after deleting local branch", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        showInformationMessage.mockImplementation(async (message?: string) => {
            if (typeof message === "string" && message.startsWith("Deleted: feature-local")) {
                return "Delete Tracked Branch";
            }
            return undefined;
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "feature-local",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                upstream: "origin/feature-local",
                remote: "origin",
            },
        });

        expect(executorRun).toHaveBeenCalledWith(["branch", "-d", "feature-local"]);
        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "--delete", "feature-local"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting tracked branch origin/feature-local"),
            }),
            expect.any(Function),
        );
        expect(showInformationMessage).toHaveBeenCalledWith(
            "Deleted: feature-local",
            "Restore",
            "Delete Tracked Branch",
        );
    });

    it("deletes remote branch even when remote field is missing", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: {
                name: "origin/feature-fallback",
                isRemote: true,
            },
        });

        expect(executorRun).toHaveBeenCalledWith([
            "push",
            "origin",
            "--delete",
            "feature-fallback",
        ]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Deleting remote branch origin/feature-fallback"),
            }),
            expect.any(Function),
        );
    });

    it("handles commit context actions forwarded from commit graph", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        const emitCommitAction = async (payload: { action: string; hash: string }) => {
            latestCommitGraphProvider!.emitCommitAction(payload);
            await waitForAsync();
        };
        await emitCommitAction({ action: "copyRevision", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "createPatch", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "cherryPick", hash: "deadbee" });
        await emitCommitAction({ action: "checkoutRevision", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "resetCurrentToHere", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "revertCommit", hash: "deadbee" });
        await emitCommitAction({ action: "newBranch", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "newTag", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "undoCommit", hash: "a1b2c3d4" });
        await emitCommitAction({ action: "editCommitMessage", hash: "feed1234" });
        await emitCommitAction({ action: "dropCommit", hash: "a1b2c3d4" });
        await emitCommitAction({
            action: "interactiveRebaseFromHere",
            hash: "a1b2c3d4",
        });
        await latestCommitGraphProvider!.emitBranchAction({
            action: "checkout",
            branchName: "main",
        });
        await waitForAsync();
        latestCommitGraphProvider!.emitCommitSelected("a1b2c3d4");
        await waitForAsync();
        latestCommitGraphProvider!.emitBranchFilterChanged("main");
        await waitForAsync();

        expect(clipboardWriteText).toHaveBeenCalledWith("a1b2c3d");
        expect(showSaveDialog).toHaveBeenCalled();
        expect(executorRun).toHaveBeenCalledWith(
            expect.arrayContaining(["format-patch", "-1", "--stdout", "a1b2c3d4"]),
        );
        expect(showErrorMessage).not.toHaveBeenCalledWith(
            "Invalid commit hash received for commit action.",
        );
    });

    it("opens project branch comparison from an Explorer resource", async () => {
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "diff" && args.includes("src/changed.ts")) {
                return [
                    "@@ -1 +1 @@",
                    "-old",
                    "+new",
                    "@@ -10 +10 @@",
                    "-old",
                    "+new",
                ].join("\n");
            }
            if (args[0] === "diff" && args.includes("src/next.ts")) {
                return "@@ -1 +1 @@\n-old\n+new";
            }
            return defaultExecutorRunImpl(args);
        });
        const { activate } = await import("../../src/extension");
        const vscode = await import("vscode");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;
        await activate(context);

        showQuickPick.mockImplementationOnce(async (items: Array<Record<string, unknown>>) => {
            return items.find((item) => item.refName === "feature-local");
        });

        await registeredCommands.get("intelligit.compareProjectWithBranch")?.({
            scheme: "file",
            fsPath: "/repo-a",
            path: "/repo-a",
        });
        await waitForAsync();

        expect(showQuickPick).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({ title: "Compare Project with Branch" }),
        );
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            "intelligit.projectBranchComparison",
            "Difference Between feature-local and Current",
            expect.any(Number),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(gitOpsState.getBranchComparisonFiles).toHaveBeenCalledWith("feature-local");

        await latestWebviewPanel?.emitMessage({ type: "openDiff", path: "src/changed.ts" });
        await waitForAsync();

        expect(gitOpsState.getFileContentAtRef).toHaveBeenCalledWith(
            "src/changed.ts",
            "feature-local",
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.diff",
            expect.anything(),
            expect.objectContaining({ fsPath: "/repo-a/src/changed.ts" }),
            expect.stringContaining("feature-local"),
        );
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenCalledWith({
            type: "setActiveFile",
            path: "src/changed.ts",
        });
        await waitForAsync();
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasNext",
            true,
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasPrevious",
            false,
        );
        expect(createdStatusBarItems[2]?.text).toBe("1/2 files");
        executeCommandFallback.mockClear();
        gitOpsState.getFileContentAtRef.mockClear();

        await registeredCommands.get("intelligit.nextDiffFile")?.();
        await waitForAsync();

        expect(gitOpsState.getFileContentAtRef).toHaveBeenCalledWith(
            "src/next.ts",
            "feature-local",
        );
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "workbench.action.compareEditor.nextChange",
        );
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenCalledWith({
            type: "setActiveFile",
            path: "src/next.ts",
        });
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasNext",
            false,
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasPrevious",
            true,
        );
        expect(createdStatusBarItems[2]?.text).toBe("2/2 files");
        executeCommandFallback.mockClear();

        await registeredCommands.get("intelligit.previousDiffFile")?.();
        await waitForAsync();

        expect(gitOpsState.getFileContentAtRef).toHaveBeenCalledWith(
            "src/changed.ts",
            "feature-local",
        );
        expect(latestWebviewPanel?.webview.postMessage).toHaveBeenCalledWith({
            type: "setActiveFile",
            path: "src/changed.ts",
        });
        expect(executeCommandFallback).not.toHaveBeenCalledWith(
            "workbench.action.compareEditor.previousChange",
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasPrevious",
            false,
        );
        executeCommandFallback.mockClear();

    });

    it("opens renamed project comparison files against the old path on the compared branch", async () => {
        gitOpsState.getBranchComparisonFiles.mockResolvedValueOnce([
            {
                repoId: ".",
                repoRoot: "/repo-a",
                path: "src/new.ts",
                oldPath: "src/old.ts",
                status: "R",
                additions: 2,
                deletions: 1,
            },
        ]);
        const { activate } = await import("../../src/extension");
        const vscode = await import("vscode");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: mockDisposables,
        } as unknown as MockExtensionContext;
        await activate(context);

        showQuickPick.mockImplementationOnce(async (items: Array<Record<string, unknown>>) => {
            return items.find((item) => item.refName === "feature-local");
        });

        await registeredCommands.get("intelligit.compareProjectWithBranch")?.({
            scheme: "file",
            fsPath: "/repo-a",
            path: "/repo-a",
        });
        await waitForAsync();

        await latestWebviewPanel?.emitMessage({ type: "openDiff", path: "src/new.ts" });
        await waitForAsync();

        expect(gitOpsState.getFileContentAtRef).toHaveBeenCalledWith(
            "src/old.ts",
            "feature-local",
        );
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                scheme: "intelligit-diff",
                query: expect.stringContaining("path=src%2Fold.ts"),
            }),
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "vscode.diff",
            expect.anything(),
            expect.objectContaining({ fsPath: "/repo-a/src/new.ts" }),
            expect.stringContaining("feature-local"),
        );
    });

    it("pushes commits up to selected revision from commit context action", async () => {
        const { activate } = await import("../../src/extension");
        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                upstream: "origin/main",
                remote: "origin",
                ahead: 2,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        latestCommitGraphProvider!.emitCommitAction({
            action: "pushAllUpToHere",
            hash: "a1b2c3d4",
        });
        await waitForAsync();

        expect(executorRun).toHaveBeenCalledWith([
            "merge-base",
            "--is-ancestor",
            "a1b2c3d4",
            "HEAD",
        ]);
        expect(executorRun).toHaveBeenCalledWith(["push", "origin", "a1b2c3d4:refs/heads/main"]);
        expect(withProgress).toHaveBeenCalledWith(
            expect.objectContaining({
                location: 15,
                title: expect.stringContaining("Pushing commits up to a1b2c3d4"),
            }),
            expect.any(Function),
        );
        expect(showInformationMessage).toHaveBeenCalledWith("Pushed commits up to a1b2c3d4.");
    });

    it("opens commit diff when commit graph requests file diff", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        executeCommandFallback.mockClear();
        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "a1b2c3d4",
            filePath: "src/feature.ts",
        });
        await waitForAsync();
        await waitForAsync();

        const diffCall = executeCommandFallback.mock.calls.find(
            (call) => call[0] === "vscode.diff",
        );
        expect(diffCall).toBeDefined();
        expect(diffCall?.[1]).toMatchObject({ scheme: "intelligit-diff" });
        expect(diffCall?.[2]).toMatchObject({ scheme: "intelligit-diff" });
        expect(diffCall?.[3]).toBe("src/feature.ts (parent1 ↔ a1b2c3d4)");
    });

    it("keeps commit diff navigation available when switching back to an older diff tab", async () => {
        gitOpsState.getCommitDetail.mockImplementation(async (hash: string) => ({
            repoId: ".",
            repoRoot: "/repo-a",
            hash,
            shortHash: hash.slice(0, 7),
            message: "msg",
            body: "",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["parent1"],
            refs: [],
            files:
                hash === "a1b2c3d4"
                    ? [
                          { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
                          { path: "src/b.ts", status: "M", additions: 1, deletions: 1 },
                      ]
                    : [
                          { path: "src/c.ts", status: "M", additions: 1, deletions: 1 },
                          { path: "src/d.ts", status: "M", additions: 1, deletions: 1 },
                      ],
        }));
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "a1b2c3d4",
            filePath: "src/a.ts",
            repoRoot: "/repo-a",
        });
        await waitForAsync();
        const firstDiffEditor = activeTextEditor;
        expect(firstDiffEditor?.document.uri.query).toContain("originalPath=src%2Fa.ts");

        latestCommitGraphProvider!.emitCommitSelected("feed1234");
        await waitForAsync();

        activeTextEditor = firstDiffEditor;
        executeCommandFallback.mockClear();
        await activeEditorListeners[0]?.(activeTextEditor);
        await waitForAsync();

        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.active",
            true,
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasNext",
            true,
        );

        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "feed1234",
            filePath: "src/c.ts",
            repoRoot: "/repo-a",
        });
        await waitForAsync();
        expect(activeTextEditor?.document.uri.query).toContain("originalPath=src%2Fc.ts");

        activeTextEditor = firstDiffEditor;
        executeCommandFallback.mockClear();
        await activeEditorListeners[0]?.(activeTextEditor);
        await waitForAsync();

        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.active",
            true,
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasNext",
            true,
        );
    });

    it("marks next unavailable for the final commit diff file opened at the top", async () => {
        gitOpsState.getCommitDetail.mockResolvedValue({
            repoId: ".",
            repoRoot: "/repo-a",
            hash: "a1b2c3d4",
            shortHash: "a1b2c3d",
            message: "msg",
            body: "",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["parent1"],
            refs: [],
            files: [
                { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
                { path: "src/b.ts", status: "M", additions: 1, deletions: 1 },
            ],
        });
        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "diff" && args.includes("src/b.ts")) {
                return "@@ -10 +10 @@\n-old\n+new";
            }
            return defaultExecutorRunImpl(args);
        });
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);
        executeCommandFallback.mockClear();

        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "a1b2c3d4",
            filePath: "src/b.ts",
            repoRoot: "/repo-a",
        });
        await waitForAsync();
        await new Promise((resolve) => setTimeout(resolve, 90));
        await waitForAsync();

        expect(activeTextEditor?.selection.active.line).toBe(0);
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasPrevious",
            true,
        );
        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.diffNavigation.hasNext",
            false,
        );
    });

    it("opens the working tree file from an IntelliGit commit diff editor", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        activeTextEditor = {
            document: {
                uri: {
                    scheme: "intelligit-diff",
                    path: "/__intelligit_text_diff__/1/feature.ts",
                    fsPath: "/__intelligit_text_diff__/1/feature.ts",
                    query: "ref=a1b2c3d4&id=1&path=src%2Ffeature.ts&intelligitCommitDiff=1&originalPath=src%2Ffeature.ts&sourceFsPath=%2Frepo-a%2Fsrc%2Ffeature.ts",
                },
            },
        };

        await registeredCommands.get("intelligit.openCommitDiffSource")?.();

        expect(fsStat).toHaveBeenCalledWith({
            fsPath: "/repo-a/src/feature.ts",
            path: "/repo-a/src/feature.ts",
        });
        expect(showTextDocument).toHaveBeenCalledWith(
            {
                fsPath: "/repo-a/src/feature.ts",
                path: "/repo-a/src/feature.ts",
            },
        );
    });

    it("updates commit diff toolbar context when the source file is missing", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        fsStat.mockRejectedValueOnce(new Error("missing"));
        activeTextEditor = {
            document: {
                uri: {
                    scheme: "intelligit-diff",
                    path: "/__intelligit_text_diff__/2/deleted.ts",
                    fsPath: "/__intelligit_text_diff__/2/deleted.ts",
                    query: "ref=a1b2c3d4&id=2&path=src%2Fdeleted.ts&intelligitCommitDiff=1&originalPath=src%2Fdeleted.ts&sourceFsPath=%2Frepo-a%2Fsrc%2Fdeleted.ts",
                },
            },
        };

        executeCommandFallback.mockClear();
        await activeEditorListeners[0]?.(activeTextEditor);
        await waitForAsync();

        expect(executeCommandFallback).toHaveBeenCalledWith(
            "setContext",
            "intelligit.commitDiffSourceExists",
            false,
        );
    });

    it("opens source directly for function declarations in IntelliGit commit git diff editors", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        await activate(context);

        openTextDocument.mockClear();
        executeCommandFallback.mockClear();

        const sourceUri = {
            scheme: "file",
            path: "/repo-a/src/feature.ts",
            fsPath: "/repo-a/src/feature.ts",
        };
        openTextDocument.mockResolvedValueOnce({
            uri: sourceUri,
            lineCount: 1,
            lineAt: () => ({
                text: "func productMetricNoAdsTransactionIDs(list []productMetricNoAdsRecord) {",
            }),
        });

        await registeredDefinitionProvider?.provideDefinition(
            {
                uri: {
                    scheme: "intelligit-diff",
                    path: "/__intelligit_text_diff__/1/feature.ts",
                    fsPath: "/__intelligit_text_diff__/1/feature.ts",
                    query: "ref=93af1295&id=1&path=src%2Ffeature.ts&intelligitCommitDiff=1&originalPath=src%2Ffeature.ts&sourceFsPath=%2Frepo-a%2Fsrc%2Ffeature.ts",
                },
                getWordRangeAtPosition: () => ({
                    start: { line: 0, character: 5 },
                    end: { line: 0, character: 38 },
                }),
                getText: () => "productMetricNoAdsTransactionIDs",
            },
            new MockPosition(0, 5),
        );

        expect(openTextDocument).toHaveBeenCalledWith(sourceUri);
    });

    it("prompts merge parent selection before opening commit file diff", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        showQuickPick.mockResolvedValueOnce({ parentNumber: 2 });
        await activate(context);

        executeCommandFallback.mockClear();
        latestCommitGraphProvider!.emitOpenCommitFileDiff({
            commitHash: "deadbee",
            filePath: "src/feature.ts",
        });
        await waitForAsync();
        await waitForAsync();

        expect(showQuickPick).toHaveBeenCalled();
        const diffCall = executeCommandFallback.mock.calls.find(
            (call) => call[0] === "vscode.diff",
        );
        expect(diffCall).toBeDefined();
        expect(diffCall?.[1]).toMatchObject({ scheme: "intelligit-diff" });
        expect(diffCall?.[2]).toMatchObject({ scheme: "intelligit-diff" });
        expect(diffCall?.[3]).toBe("src/feature.ts (parent2 ↔ deadbee)");
    });

    it("covers activation guards and debounced refresh sources", async () => {
        const { activate, deactivate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;

        workspaceFolders = undefined;
        await activate(context);
        expect(registeredCommands.size).toBe(0);
        expect(registerWebviewViewProvider).toHaveBeenCalledTimes(2);
        expect(registerWebviewViewProvider).toHaveBeenNthCalledWith(
            1,
            "intelligit.commitGraph",
            expect.anything(),
        );
        expect(registerWebviewViewProvider).toHaveBeenNthCalledWith(
            2,
            "intelligit.commitPanel",
            expect.anything(),
        );
        registerWebviewViewProvider.mockClear();

        workspaceFolders = [{ uri: { fsPath: "/repo", path: "/repo" } }];
        gitOpsState.isRepository.mockResolvedValueOnce(false);
        await activate(context);
        expect(registeredCommands.size).toBeGreaterThan(0);

        vi.useFakeTimers();
        try {
            await activate(context);

            gitOpsState.getCommitDetail.mockRejectedValueOnce(new Error("detail failed"));
            latestCommitGraphProvider!.emitCommitSelected("a1b2c3d4");
            await waitForAsync();
            expect(showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("Failed to load commit: detail failed"),
            );

            executorRun.mockImplementation(async (args: string[]) => {
                if (args[0] === "reset" && args[1] === "--hard") throw new Error("reset failed");
                return defaultExecutorRunImpl(args);
            });
            const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            try {
                latestCommitGraphProvider!.emitCommitAction({
                    action: "resetCurrentToHere",
                    hash: "a1b2c3d4",
                });
                await waitForAsync();
            } finally {
                consoleErrorSpy.mockRestore();
            }
            expect(showErrorMessage).toHaveBeenCalledWith(
                expect.stringContaining("Reset failed: reset failed"),
            );

            await latestCommitGraphProvider!.emitBranchAction({
                action: "checkout",
                branchName: "missing-branch",
            });

            textDocListeners.forEach((listener) => listener());
            saveDocListeners.forEach((listener) => listener());
            createFileListeners.forEach((listener) => listener());
            deleteFileListeners.forEach((listener) => listener());
            renameFileListeners.forEach((listener) => listener());
            fsWatchCallbacks[0]?.("change", "HEAD");
            fsWatchCallbacks[0]?.("change", "FETCH_HEAD");
            fsWatchCallbacks[1]?.();

            vi.advanceTimersByTime(1200);
            await waitForAsync();

            expect(latestCommitPanelProvider!.refresh).toHaveBeenCalled();
            expect(latestCommitGraphProvider!.refresh).toHaveBeenCalled();
            deactivate();
        } finally {
            vi.useRealTimers();
        }
    });

    it("covers commit-context guarded/error branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        const emitCommitAction = async (payload: { action: string; hash: string }) => {
            latestCommitGraphProvider!.emitCommitAction(payload);
            await waitForAsync();
        };

        await emitCommitAction({ action: "copyRevision", hash: "not-a-hash" });

        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();

        showWarningMessage.mockResolvedValueOnce("Cherry-pick");
        showQuickPick.mockResolvedValueOnce(undefined);
        await emitCommitAction({ action: "cherryPick", hash: "deadbee" });

        showInputBox.mockResolvedValueOnce("-bad-branch-name");
        await emitCommitAction({ action: "newBranch", hash: "a1b2c3d4" });
        showInputBox.mockResolvedValueOnce("bad..tag");
        await emitCommitAction({ action: "newTag", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "pushAllUpToHere", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "undoCommit", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "undoCommit", hash: "deadbee" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "editCommitMessage", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "editCommitMessage", hash: "deadbee" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["a1b2c3d4"]);
        await emitCommitAction({ action: "editCommitMessage", hash: "a1b2c3d4" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "dropCommit", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "dropCommit", hash: "deadbee" });

        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce([]);
        await emitCommitAction({ action: "interactiveRebaseFromHere", hash: "a1b2c3d4" });
        gitOpsState.getUnpushedCommitHashes.mockResolvedValueOnce(["deadbee"]);
        await emitCommitAction({ action: "interactiveRebaseFromHere", hash: "deadbee" });

        expect(showErrorMessage).toHaveBeenCalledWith(
            "Invalid commit hash received for commit action.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Invalid branch name '-bad-branch-name'"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Invalid tag name 'bad..tag'"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Push All up to Here is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Undo Commit is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Undo Commit is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Edit Commit Message is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Edit Commit Message is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Drop Commit is available only for unpushed commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Drop Commit is not available for merge commits.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Interactive Rebase from Here is available only for unpushed commits.",
        );
        expect(createTerminal).toHaveBeenCalled();
    });

    it("covers branch/file command failure and fallback branches", async () => {
        const { activate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);

        executorRun.mockImplementation(async (args: string[]) => {
            if (args[0] === "checkout" && args[1] === "broken-branch")
                throw new Error("checkout boom");
            if (args[0] === "rebase" && args[1] === "fail-rebase") throw new Error("rebase boom");
            if (args[0] === "merge" && args[1] === "fail-merge") throw new Error("merge boom");
            if (args[0] === "fetch") throw new Error("fetch boom");
            if (args[0] === "push" && args[2]?.startsWith("force-fail"))
                throw new Error("push boom");
            if (args[0] === "branch" && args[1] === "-m" && args[2] === "fail-rename") {
                throw new Error("rename boom");
            }
            if (args[0] === "branch" && args[1] === "-d" && args[2] === "feature-force-fail") {
                throw new Error("branch is not fully merged");
            }
            if (args[0] === "branch" && args[1] === "-D" && args[2] === "feature-force-fail") {
                throw new Error("force delete failed");
            }
            if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
                throw new Error("rev-parse failed");
            }
            return defaultExecutorRunImpl(args);
        });

        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "origin/feature-local", isRemote: true },
        });
        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "origin/topic/new", isRemote: true },
        });
        await registeredCommands.get("intelligit.checkout")?.({
            branch: { name: "broken-branch", isRemote: false },
        });

        gitOpsState.getBranches.mockResolvedValueOnce([
            { name: "topic", hash: "a1", isRemote: false, isCurrent: false, ahead: 0, behind: 0 },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands.get("intelligit.checkoutAndRebase")?.({
            branch: { name: "topic", isRemote: false },
        });

        gitOpsState.getBranches.mockResolvedValueOnce([
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "feed1234",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/force-fail",
                hash: "abc123",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ]);
        await registeredCommands.get("intelligit.refresh")?.();
        await registeredCommands.get("intelligit.checkoutAndRebase")?.({
            branch: { name: "main", isRemote: false },
        });

        await registeredCommands.get("intelligit.rebaseCurrentOnto")?.({
            branch: { name: "fail-rebase", isRemote: false },
        });
        await registeredCommands.get("intelligit.mergeIntoCurrent")?.({
            branch: { name: "fail-merge", isRemote: false },
        });
        await registeredCommands.get("intelligit.updateBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: false, remote: "origin" },
        });

        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "main", isRemote: false, isCurrent: true },
        });
        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "topic", isRemote: false, isCurrent: false },
        });
        await registeredCommands.get("intelligit.pushBranch")?.({
            branch: { name: "force-fail", isRemote: false, isCurrent: true, remote: "origin" },
        });

        showInputBox.mockResolvedValueOnce("renamed-branch");
        await registeredCommands.get("intelligit.renameBranch")?.({
            branch: { name: "fail-rename", isRemote: false },
        });

        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: { name: "main", isRemote: false },
        });
        await registeredCommands.get("intelligit.deleteBranch")?.({
            branch: { name: "feature-force-fail", isRemote: false },
        });

        gitOpsState.rollbackFiles.mockRejectedValueOnce(new Error("rollback failed"));
        await registeredCommands.get("intelligit.fileRollback")?.({ filePath: "src/a.ts" });
        gitOpsState.shelveSave.mockRejectedValueOnce(new Error("shelve failed"));
        await registeredCommands.get("intelligit.fileShelve")?.({ filePath: "src/a.ts" });
        gitOpsState.getFileHistory.mockRejectedValueOnce(new Error("history failed"));
        await registeredCommands.get("intelligit.fileShowHistory")?.({ filePath: "src/a.ts" });
        deleteFileWithFallback.mockResolvedValueOnce(false);
        await registeredCommands.get("intelligit.fileDelete")?.({ filePath: "src/a.ts" });

        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Checkout failed: checkout boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith("No current branch found.");
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Merge failed: merge boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Update failed: fetch boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            "Push failed: No remote configured for branch topic.",
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Push failed: push boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rename failed: rename boom"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Delete failed: force delete failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Rollback failed: rollback failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Shelve failed: shelve failed"),
        );
        expect(showErrorMessage).toHaveBeenCalledWith(
            expect.stringContaining("Show history failed: history failed"),
        );
    });

    it("handles fs.watch setup failures and exposes deactivate", async () => {
        const fs = await import("fs");
        const watchMock = vi.mocked(fs.watch as unknown as (...args: unknown[]) => unknown);
        watchMock
            .mockImplementationOnce(() => {
                throw new Error("watch .git failed");
            })
            .mockImplementationOnce(() => {
                throw new Error("watch refs failed");
            });

        const { activate, deactivate } = await import("../../src/extension");
        const context = {
            extensionUri: { fsPath: "/ext", path: "/ext" },
            subscriptions: [],
        } as unknown as MockExtensionContext;
        await activate(context);
        deactivate();
        expect(watchMock).toHaveBeenCalled();
    });
});
