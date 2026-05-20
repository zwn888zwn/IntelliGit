// Extension entry point. Registers coordinated IntelliGit webviews:
// commit graph (with integrated branch column/details) and commit panel.
// The extension host is the sole data coordinator -- views never talk directly.

import * as path from "path";
import * as vscode from "vscode";
import { CommitGraphViewProvider } from "./views/CommitGraphViewProvider";
import { CommitInfoViewProvider } from "./views/CommitInfoViewProvider";
import { CommitPanelViewProvider } from "./views/CommitPanelViewProvider";
import { MergeConflictSessionPanel } from "./views/MergeConflictSessionPanel";
import { MergeConflictsTreeProvider } from "./views/MergeConflictsTreeProvider";
import { NoWorkspaceViewProvider } from "./views/NoWorkspaceViewProvider";
import { ProjectBranchComparisonPanel } from "./views/ProjectBranchComparisonPanel";
import type { Branch, CommitDetail } from "./types";
import { getErrorMessage } from "./utils/errors";
import { assertRepoRelativePath, deleteFileWithFallback } from "./utils/fileOps";
import { handleCommitContextAction } from "./commands/commitCommands";
import { createBranchCommands } from "./commands/branchCommands";
import { BranchStatusBarController } from "./commands/branchPopup";
import { RefreshService } from "./services/refreshService";
import {
    openJetBrainsMergeToolForFile,
    getJetBrainsMergeToolPath,
    getPreferExternalMergeTool,
    detectAndPickJetBrainsMergeToolPath,
} from "./services/jetbrainsMergeService";
import {
    compareEditorFileWithBranch,
    compareEditorFileWithRevision,
    compareCommitInfoFileWithLocal,
    applySelectedCommitFileChange,
    commitDiffSourceFileExists,
    getCommitDiffEditorUri,
    openCommitFileDiff,
    openCommitDiffSourceFile,
    registerDiffContentProvider,
    getEditorContextFileUri,
    getCommitInfoFileContext,
    getDiffOriginalFilePathFromUri,
} from "./services/diffService";
import { EditorBlameController } from "./services/EditorBlameController";
import { runWithNotificationProgress } from "./utils/notifications";
import {
    RepositoryContextService,
    createRepositoryScopedExecutor,
    createRepositoryScopedGitOps,
} from "./services/RepositoryContextService";
import {
    hasAdjacentHunk,
    parseChangedNewFileHunks,
    type DiffHunkRange,
} from "./services/diffNavigation";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const COMMIT_DIFF_SOURCE_EXISTS_CONTEXT = "intelligit.commitDiffSourceExists";
    const DIFF_NAVIGATION_ACTIVE_CONTEXT = "intelligit.diffNavigation.active";
    const DIFF_NAVIGATION_HAS_PREVIOUS_CONTEXT = "intelligit.diffNavigation.hasPrevious";
    const DIFF_NAVIGATION_HAS_NEXT_CONTEXT = "intelligit.diffNavigation.hasNext";
    type DiffNavigationState = {
        active: boolean;
        hasPrevious: boolean;
        hasNext: boolean;
    };
    type ActiveCommitDiffNavigation = {
        commitHash: string;
        parentRef: string;
        parentDisplayHash: string;
        repoRoot: string;
        filePath: string;
        files: string[];
    };
    const inactiveDiffNavigationState: DiffNavigationState = {
        active: false,
        hasPrevious: false,
        hasNext: false,
    };
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        const noWorkspaceMessage =
            "Open a folder or workspace that contains a Git repository to use IntelliGit. Loose files opened without a workspace are not enough for repository-backed views.";
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(
                CommitGraphViewProvider.viewType,
                new NoWorkspaceViewProvider("IntelliGit unavailable", noWorkspaceMessage),
            ),
            vscode.window.registerWebviewViewProvider(
                CommitPanelViewProvider.viewType,
                new NoWorkspaceViewProvider("IntelliGit unavailable", noWorkspaceMessage),
            ),
        );
        return;
    }

    const repositoryService = new RepositoryContextService(workspaceFolder.uri);
    await repositoryService.initialize();
    const executor = createRepositoryScopedExecutor(repositoryService);
    const gitOps = createRepositoryScopedGitOps(repositoryService);
    registerDiffContentProvider(context.subscriptions);

    // Cached branch list for webview context menu lookups
    let currentBranches: Branch[] = [];
    let currentCommitDetail: CommitDetail | null = null;
    const commitDiffNavigationsByUri = new Map<string, ActiveCommitDiffNavigation>();
    let commitDetailRequestSeq = 0;

    // --- Providers ---

    const commitGraph = new CommitGraphViewProvider(
        context.extensionUri,
        gitOps,
        () => repositoryService.listRepositories(),
        (root) => repositoryService.listRepositories().find((entry) => entry.root === root) ?? null,
    );
    const commitInfo = new CommitInfoViewProvider(context.extensionUri);
    const branchStatusBar = new BranchStatusBarController();
    const commitPanel = new CommitPanelViewProvider(
        context.extensionUri,
        gitOps,
        () => repositoryService.getCurrentRepository()?.uri,
        () => repositoryService.listRepositories(),
        (root) => repositoryService.listRepositories().find((entry) => entry.root === root) ?? null,
        async (root) => {
            if (repositoryService.switchRepository(root)) {
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
        },
        () => {
            void updateIntelliGitDiffNavigationContext();
        },
    );
    const mergeConflicts = new MergeConflictsTreeProvider(
        gitOps,
        () => repositoryService.getCurrentRepository()?.uri,
    );
    const blameController = new EditorBlameController(
        workspaceFolder.uri.fsPath,
        gitOps,
        async (hash) => {
            await vscode.commands.executeCommand("intelligit.revealCommitInGraph", hash);
        },
        () => repositoryService.getCurrentRepository()?.root ?? null,
        () => repositoryService.requireCurrentRepository().gitOps,
    );

    const getCurrentRepository = () => repositoryService.getCurrentRepository();
    const requireCurrentRepository = () => repositoryService.requireCurrentRepository();
    const resolveRepositoryForEditorContext = (ctx?: unknown) => {
        const fileUri = getEditorContextFileUri(ctx);
        return repositoryService.getRepositoryForUri(fileUri ?? undefined) ?? getCurrentRepository();
    };
    const getCommitDiffNavigationForEditor = (
        editor: vscode.TextEditor | null | undefined,
    ): ActiveCommitDiffNavigation | null => {
        const uri = editor?.document.uri;
        return uri ? commitDiffNavigationsByUri.get(uri.toString()) ?? null : null;
    };
    const registerCommitDiffNavigation = (
        navigation: ActiveCommitDiffNavigation,
        uris: vscode.Uri[],
    ): void => {
        for (const uri of uris) {
            commitDiffNavigationsByUri.set(uri.toString(), navigation);
        }
    };
    const getAdjacentCommitDiffFile = (
        direction: "next" | "previous",
        active: ActiveCommitDiffNavigation,
    ): string | null => {
        const index = active.files.findIndex((file) => file === active.filePath);
        if (index < 0) return null;
        const nextIndex = direction === "next" ? index + 1 : index - 1;
        return active.files[nextIndex] ?? null;
    };
    const getCommitDiffChangeRanges = async (
        active: ActiveCommitDiffNavigation,
    ): Promise<DiffHunkRange[]> => {
        const repository = repositoryService
            .listRepositories()
            .find((entry) => entry.root === active.repoRoot);
        if (!repository) return [];
        const safePath = assertRepoRelativePath(active.filePath);
        const diff = await repository.executor
            .run(["diff", "--unified=0", active.parentRef, active.commitHash, "--", safePath])
            .catch(() => "");
        return parseChangedNewFileHunks(diff);
    };
    const getCommitDiffNavigationState = async (
        editor: vscode.TextEditor | null | undefined,
    ): Promise<DiffNavigationState> => {
        const navigation = getCommitDiffNavigationForEditor(editor);
        if (!navigation || !editor) return inactiveDiffNavigationState;
        const filePath = getDiffOriginalFilePathFromUri(editor.document.uri);
        if (!filePath || filePath !== navigation.filePath) {
            return inactiveDiffNavigationState;
        }
        const currentLine = editor.selection?.active?.line ?? null;
        const changeRanges = await getCommitDiffChangeRanges(navigation);
        const hasPreviousChange =
            currentLine !== null && hasAdjacentHunk(changeRanges, currentLine, "previous");
        const hasNextChange =
            currentLine !== null && hasAdjacentHunk(changeRanges, currentLine, "next");
        return {
            active: true,
            hasPrevious:
                hasPreviousChange || Boolean(getAdjacentCommitDiffFile("previous", navigation)),
            hasNext: hasNextChange || Boolean(getAdjacentCommitDiffFile("next", navigation)),
        };
    };
    let diffNavigationContextSeq = 0;
    async function updateIntelliGitDiffNavigationContext(): Promise<void> {
        const requestId = ++diffNavigationContextSeq;
        const editor = vscode.window.activeTextEditor ?? null;
        const projectState =
            await ProjectBranchComparisonPanel.getActivePanel()?.getDiffNavigationState(editor);
        const commitDiffState = projectState?.active
            ? inactiveDiffNavigationState
            : await getCommitDiffNavigationState(editor);
        const state = projectState?.active
            ? projectState
            : commitDiffState.active
              ? commitDiffState
              : await commitPanel.getDiffNavigationState(editor);
        if (requestId !== diffNavigationContextSeq) return;
        await Promise.all([
            vscode.commands.executeCommand(
                "setContext",
                DIFF_NAVIGATION_ACTIVE_CONTEXT,
                state.active,
            ),
            vscode.commands.executeCommand(
                "setContext",
                DIFF_NAVIGATION_HAS_PREVIOUS_CONTEXT,
                state.hasPrevious,
            ),
            vscode.commands.executeCommand(
                "setContext",
                DIFF_NAVIGATION_HAS_NEXT_CONTEXT,
                state.hasNext,
            ),
        ]);
    }
    const getFileUriFromCommandContext = (ctx?: unknown): vscode.Uri | null => {
        if (!ctx || typeof ctx !== "object") return null;
        const maybe = ctx as { scheme?: unknown; fsPath?: unknown; path?: unknown };
        if (typeof maybe.scheme === "string" && typeof maybe.fsPath === "string") {
            return ctx as vscode.Uri;
        }
        return null;
    };
    const resolveRepositoryForResourceContext = (ctx?: unknown) => {
        const fileUri = getFileUriFromCommandContext(ctx);
        if (fileUri) {
            return repositoryService.getRepositoryForUri(fileUri) ?? getCurrentRepository();
        }
        return getCurrentRepository();
    };
    let commitDiffSourceContextSeq = 0;
    const updateCommitDiffSourceContext = async (
        editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
    ): Promise<void> => {
        const requestId = ++commitDiffSourceContextSeq;
        const repository = getCurrentRepository();
        const enabled = await commitDiffSourceFileExists(
            getCommitDiffEditorUri(editor?.document.uri),
            repository?.uri,
        );
        if (requestId !== commitDiffSourceContextSeq) return;
        await vscode.commands.executeCommand(
            "setContext",
            COMMIT_DIFF_SOURCE_EXISTS_CONTEXT,
            enabled,
        );
    };
    const getEditorNavigationState = (): { uri: string; line: number; character: number } | null => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return null;
        const active = editor.selection.active;
        return {
            uri: editor.document.uri.toString(),
            line: active.line,
            character: active.character,
        };
    };
    const waitForEditorCommand = () => new Promise((resolve) => setTimeout(resolve, 80));
    const isSameEditorPosition = (
        before: { uri: string; line: number; character: number } | null,
        after: { uri: string; line: number; character: number } | null,
    ): boolean =>
        before?.uri === after?.uri &&
        before?.line === after?.line &&
        before?.character === after?.character;
    const didNativeDiffNavigationWrap = (
        direction: "next" | "previous",
        before: { uri: string; line: number; character: number } | null,
        after: { uri: string; line: number; character: number } | null,
    ): boolean => {
        if (!before || !after || before.uri !== after.uri) return false;
        return direction === "next" ? after.line < before.line : after.line > before.line;
    };
    const restoreEditorNavigationState = (
        state: { uri: string; line: number; character: number } | null,
    ): void => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !state || editor.document.uri.toString() !== state.uri) return;
        const position = new vscode.Position(state.line, state.character);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
    };
    const navigateWorkingTreeDiff = async (direction: "next" | "previous"): Promise<void> => {
        if (!(await commitPanel.canNavigateWorkingFileChange(direction))) return;
        const command =
            direction === "next"
                ? "workbench.action.compareEditor.nextChange"
                : "workbench.action.compareEditor.previousChange";
        const before = getEditorNavigationState();
        await vscode.commands.executeCommand(command);
        await waitForEditorCommand();
        commitPanel.syncActiveEditor(vscode.window.activeTextEditor);
        const after = getEditorNavigationState();
        if (
            !isSameEditorPosition(before, after) &&
            !didNativeDiffNavigationWrap(direction, before, after)
        ) {
            return;
        }

        const target = commitPanel.getAdjacentWorkingFileTarget(direction);
        if (!target) {
            restoreEditorNavigationState(before);
            commitPanel.syncActiveEditor(vscode.window.activeTextEditor);
            return;
        }
        await commitPanel.openWorkingFileDiff(target);
        if (direction === "previous") {
            await waitForEditorCommand();
            await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
            await waitForEditorCommand();
            commitPanel.syncActiveEditor(vscode.window.activeTextEditor);
        } else {
            await waitForEditorCommand();
            await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
            await waitForEditorCommand();
            commitPanel.syncActiveEditor(vscode.window.activeTextEditor);
        }
    };
    const openCommitDiffNavigationFile = async (
        filePath: string,
        navigation: ActiveCommitDiffNavigation,
        initialHunk: "first" | "last" = "first",
    ): Promise<void> => {
        const repository =
            repositoryService.listRepositories().find((entry) => entry.root === navigation.repoRoot) ??
            requireCurrentRepository();
        const result = await openCommitFileDiff(
            navigation.commitHash,
            filePath,
            repository.root,
            repository.gitOps,
            repository.executor,
            {
                parentRef: navigation.parentRef,
                parentDisplayHash: navigation.parentDisplayHash,
            },
        );
        if (!result) return;
        const nextNavigation = {
            ...navigation,
            repoRoot: repository.root,
            filePath: assertRepoRelativePath(filePath),
            parentRef: result.parentRef,
            parentDisplayHash: result.parentDisplayHash,
        };
        registerCommitDiffNavigation(nextNavigation, [result.leftUri, result.rightUri]);
        if (initialHunk === "last") {
            await waitForEditorCommand();
            await vscode.commands.executeCommand("workbench.action.compareEditor.previousChange");
            await waitForEditorCommand();
        } else {
            await waitForEditorCommand();
            await vscode.commands.executeCommand("workbench.action.compareEditor.nextChange");
            await waitForEditorCommand();
        }
    };
    const navigateCommitFileDiff = async (direction: "next" | "previous"): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        const navigation = getCommitDiffNavigationForEditor(editor);
        const state = await getCommitDiffNavigationState(editor);
        if (!state.active || !navigation) return;
        const command =
            direction === "next"
                ? "workbench.action.compareEditor.nextChange"
                : "workbench.action.compareEditor.previousChange";
        const before = getEditorNavigationState();
        await vscode.commands.executeCommand(command);
        await waitForEditorCommand();
        const after = getEditorNavigationState();
        if (
            !isSameEditorPosition(before, after) &&
            !didNativeDiffNavigationWrap(direction, before, after)
        ) {
            return;
        }

        const target = getAdjacentCommitDiffFile(direction, navigation);
        if (!target) {
            restoreEditorNavigationState(before);
            return;
        }
        await openCommitDiffNavigationFile(
            target,
            navigation,
            direction === "previous" ? "last" : "first",
        );
    };
    const navigateIntelliGitDiff = async (direction: "next" | "previous"): Promise<void> => {
        const projectPanel = ProjectBranchComparisonPanel.getActivePanel();
        const editor = vscode.window.activeTextEditor ?? null;
        const projectState = await projectPanel?.getDiffNavigationState(editor);
        const commitDiffState = projectState?.active
            ? inactiveDiffNavigationState
            : await getCommitDiffNavigationState(editor);
        if (projectPanel && projectState?.active) {
            await projectPanel.navigateChange(direction);
        } else if (commitDiffState.active) {
            await navigateCommitFileDiff(direction);
        } else {
            await navigateWorkingTreeDiff(direction);
        }
        await updateIntelliGitDiffNavigationContext();
    };

    const applyCurrentRepositoryContext = async (
        options: { resetGraph?: boolean } = {},
    ): Promise<void> => {
        const repository = getCurrentRepository();
        const repositoryInfo = repository?.info ?? null;
        commitGraph.setRepositoryContext(repositoryInfo);
        commitPanel.setRepositoryContext(repositoryInfo);
        mergeConflicts.setRepositoryRoot(repository?.uri);
        refreshService.updateRepositoryRoots(
            repositoryService.listRepositories().map((entry) => entry.root),
        );

        if (!repository) {
            currentBranches = [];
            currentCommitDetail = null;
            branchStatusBar.update(null, currentBranches);
            commitDiffNavigationsByUri.clear();
            commitGraph.setBranches([]);
            await commitGraph.refresh({ reset: true });
            await commitPanel.refresh();
            await refreshService.refreshMergeConflicts();
            clearSelection();
            await updateCommitDiffSourceContext();
            return;
        }

        currentBranches = await repository.gitOps.getBranches();
        branchStatusBar.update(repository, currentBranches);
        commitGraph.setBranches(currentBranches);
        await commitGraph.refresh({ reset: options.resetGraph ?? true });
        await commitPanel.refresh();
        await refreshService.refreshMergeConflicts();
        clearSelection();
        await updateCommitDiffSourceContext();
    };

    // --- Register views ---

    const emptyTreeProvider: vscode.TreeDataProvider<never> = {
        getTreeItem: () => {
            throw new Error("unreachable");
        },
        getChildren: () => [],
    };
    const badgeView = vscode.window.createTreeView("intelligit.fileCountBadge", {
        treeDataProvider: emptyTreeProvider,
    });
    const mergeConflictsView = vscode.window.createTreeView("intelligit.mergeConflicts", {
        treeDataProvider: mergeConflicts,
    });

    const updateBadge = (count: number) => {
        badgeView.badge =
            count > 0
                ? { tooltip: `${count} changed file${count !== 1 ? "s" : ""}`, value: count }
                : undefined;
    };

    // --- Refresh service ---

    const refreshService = new RefreshService(
        {
            gitOps,
            commitGraph,
            commitPanel,
            mergeConflicts,
            mergeConflictsView,
            onBranchesUpdated: (branches) => {
                currentBranches = branches;
                branchStatusBar.update(getCurrentRepository(), currentBranches);
            },
        },
        repositoryService.listRepositories().map((entry) => entry.root),
    );

    // --- Merge conflict helpers ---

    const openBuiltInMergeEditorForFile = async (filePath: string): Promise<void> => {
        const fileUri = vscode.Uri.file(
            path.join(requireCurrentRepository().root, assertRepoRelativePath(filePath)),
        );
        try {
            await vscode.commands.executeCommand("git.openMergeEditor", fileUri);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showWarningMessage(
                `VS Code merge editor command failed (${message}). Opening the file instead.`,
            );
            await vscode.commands.executeCommand("vscode.open", fileUri);
        }
    };

    const openMergeConflictForFile = async (filePath: string): Promise<void> => {
        const preferExternal = getPreferExternalMergeTool();

        if (preferExternal && getJetBrainsMergeToolPath()) {
            const opened = await openJetBrainsMergeToolForFile(
                filePath,
                requireCurrentRepository().root,
                gitOps,
                () => refreshService.refreshConflictUi(),
                openBuiltInMergeEditorForFile,
            );
            if (opened) return;
        }
        await openBuiltInMergeEditorForFile(filePath);
    };

    const openConflictSession = async (labels?: {
        sourceBranch?: string;
        targetBranch?: string;
    }): Promise<void> => {
        await MergeConflictSessionPanel.open(context.extensionUri, gitOps, labels ?? {}, {
            onOpenMergeConflict: async (filePath) => {
                await openMergeConflictForFile(filePath);
            },
            onConflictStateChanged: async () => {
                await refreshService.refreshConflictUi();
            },
        });
    };

    // --- Register view providers ---

    context.subscriptions.push(
        badgeView,
        mergeConflictsView,
        commitPanel.onDidChangeFileCount(updateBadge),
        vscode.window.registerWebviewViewProvider(CommitGraphViewProvider.viewType, commitGraph),
        vscode.window.registerWebviewViewProvider(CommitInfoViewProvider.viewType, commitInfo),
        vscode.window.registerWebviewViewProvider(CommitPanelViewProvider.viewType, commitPanel),
    );

    // --- Wire data flow ---

    context.subscriptions.push(
        commitGraph.onCommitSelected(async (selection) => {
            const hash = typeof selection === "string" ? selection : selection.hash;
            const repoRoot =
                typeof selection === "string" ? requireCurrentRepository().root : selection.repoRoot;
            const requestId = ++commitDetailRequestSeq;
            try {
                const repository = repositoryService.listRepositories().find((entry) => entry.root === repoRoot);
                if (!repository) return;
                const detail = await repository.gitOps.getCommitDetail(hash);
                if (requestId !== commitDetailRequestSeq) return;
                currentCommitDetail = detail;
                commitGraph.setCommitDetail(detail);
                commitInfo.setCommitDetail(detail);
            } catch (err) {
                const msg = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to load commit: ${msg}`);
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchFilterChanged(() => {
            commitGraph.clearCommitDetail();
            commitInfo.clear();
            currentCommitDetail = null;
        }),
    );

    // Forward branch actions from webview context menu to VS Code commands
    context.subscriptions.push(
        commitGraph.onBranchAction(async ({ action, branchName, repoRoot }) => {
            const targetRepository =
                (repoRoot
                    ? repositoryService.listRepositories().find((entry) => entry.root === repoRoot)
                    : null) ?? getCurrentRepository();
            if (!targetRepository) return;
            const branches =
                targetRepository.root === getCurrentRepository()?.root
                    ? currentBranches
                    : await targetRepository.gitOps.getBranches();
            const branch = branches.find((b) => b.name === branchName);
            if (!branch) return;
            if (targetRepository.root !== getCurrentRepository()?.root) {
                repositoryService.switchRepository(targetRepository.root);
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
            const item: { branch: Branch } = { branch };
            await vscode.commands.executeCommand(`intelligit.${action}`, item);
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchPopupAction(async ({ action, root }) => {
            const targetRepository =
                (root
                    ? repositoryService.listRepositories().find((entry) => entry.root === root)
                    : null) ?? getCurrentRepository();
            if (targetRepository && targetRepository.root !== getCurrentRepository()?.root) {
                repositoryService.switchRepository(targetRepository.root);
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
            const currentBranch = currentBranches.find((branch) => branch.isCurrent && !branch.isRemote);
            switch (action) {
                case "switchRepository":
                    return;
                case "commit":
                    await vscode.commands.executeCommand("intelligit.commitPanel.focus");
                    return;
                case "checkoutRevision": {
                    const revision = await vscode.window.showInputBox({
                        prompt: "Checkout tag, branch, or revision",
                        placeHolder: "tag, branch, or commit hash",
                        ignoreFocusOut: true,
                    });
                    const trimmed = revision?.trim();
                    if (!trimmed) return;
                    try {
                        await executor.run(["checkout", trimmed]);
                        vscode.window.showInformationMessage(`Checked out ${trimmed}`);
                        await vscode.commands.executeCommand("intelligit.refresh");
                    } catch (error) {
                        const message = getErrorMessage(error);
                        vscode.window.showErrorMessage(`Checkout failed: ${message}`);
                    }
                    return;
                }
                case "updateProject":
                    if (currentBranch) {
                        await vscode.commands.executeCommand("intelligit.updateBranch", {
                            branch: currentBranch,
                        });
                    }
                    return;
                case "push":
                    if (currentBranch) {
                        await vscode.commands.executeCommand("intelligit.pushBranch", {
                            branch: currentBranch,
                        });
                    }
                    return;
                case "newBranch":
                    if (currentBranch) {
                        await vscode.commands.executeCommand("intelligit.newBranchFrom", {
                            branch: currentBranch,
                        });
                    }
                    return;
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onCommitAction(async (payload) => {
            const action = payload.action;
            const hash = payload.hash;
            const repoRoot = "repoRoot" in payload ? payload.repoRoot : requireCurrentRepository().root;
            try {
                const repository =
                    repositoryService.listRepositories().find((entry) => entry.root === repoRoot) ??
                    requireCurrentRepository();
                await handleCommitContextAction({
                    action,
                    hash,
                    executor: repository.executor,
                    gitOps: repository.gitOps,
                    repoRoot: repository.root,
                    currentBranches,
                    refreshAll: () => refreshService.refreshAll(),
                });
            } catch (error) {
                const message = getErrorMessage(error);
                console.error(`Commit action '${action}' failed:`, error);
                vscode.window.showErrorMessage(`Commit action failed: ${message}`);
            }
        }),
    );

    const handleOpenCommitFileDiff = async (params: {
        commitHash: string;
        filePath: string;
        repoRoot: string;
    }): Promise<void> => {
        try {
            const repository =
                repositoryService.listRepositories().find((entry) => entry.root === params.repoRoot) ??
                requireCurrentRepository();
            const detail =
                currentCommitDetail?.hash === params.commitHash &&
                currentCommitDetail.repoRoot === repository.root
                    ? currentCommitDetail
                    : await repository.gitOps.getCommitDetail(params.commitHash);
            currentCommitDetail = detail;
            const result = await openCommitFileDiff(
                params.commitHash,
                params.filePath,
                repository.root,
                repository.gitOps,
                repository.executor,
            );
            if (!result) return;
            const navigation = {
                commitHash: params.commitHash,
                parentRef: result.parentRef,
                parentDisplayHash: result.parentDisplayHash,
                repoRoot: repository.root,
                filePath: assertRepoRelativePath(params.filePath),
                files: detail.files.map((file) => assertRepoRelativePath(file.path)),
            };
            registerCommitDiffNavigation(navigation, [result.leftUri, result.rightUri]);
            await updateIntelliGitDiffNavigationContext();
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to open commit diff: ${message}`);
        }
    };

    context.subscriptions.push(
        commitGraph.onOpenCommitFileDiff(handleOpenCommitFileDiff),
        commitInfo.onOpenCommitFileDiff(handleOpenCommitFileDiff),
    );

    // --- Helper ---

    const clearSelection = () => {
        commitGraph.clearCommitDetail();
        commitInfo.clear();
        currentCommitDetail = null;
    };

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.refresh", async () => {
            const previousRoot = repositoryService.getCurrentRepository()?.root ?? null;
            await repositoryService.refreshRepositories();
            const nextRoot = repositoryService.getCurrentRepository()?.root ?? null;
            await applyCurrentRepositoryContext({ resetGraph: previousRoot !== nextRoot });
        }),

        vscode.commands.registerCommand(
            "intelligit.filterByBranch",
            async (branchName?: string) => {
                await commitGraph.filterByBranch(branchName ?? null);
                await clearSelection();
            },
        ),

        vscode.commands.registerCommand("intelligit.showGitLog", async () => {
                await vscode.commands.executeCommand("intelligit.commitGraph.focus");
            }),

        vscode.commands.registerCommand("intelligit.revealCommitInGraph", async (hash: unknown) => {
            if (typeof hash !== "string" || !hash.trim()) return;
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
            await commitGraph.revealCommit(hash.trim());
        }),

        vscode.commands.registerCommand("intelligit.switchRepository", async () => {
            const repositories = repositoryService.listRepositories();
            if (repositories.length === 0) {
                vscode.window.showWarningMessage("No git repositories found in the current workspace.");
                return;
            }
            const picked = await vscode.window.showQuickPick(
                repositories.map((repository) => ({
                    label: repository.info.name,
                    description: repository.info.relativePath ?? repository.info.root,
                    root: repository.root,
                })),
                { placeHolder: "Select IntelliGit repository" },
            );
            if (!picked) return;
            if (repositoryService.switchRepository(picked.root)) {
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
        }),

        vscode.commands.registerCommand("intelligit.refreshRepositories", async () => {
            const previousRoot = repositoryService.getCurrentRepository()?.root ?? null;
            await repositoryService.refreshRepositories();
            const nextRoot = repositoryService.getCurrentRepository()?.root ?? null;
            await applyCurrentRepositoryContext({ resetGraph: previousRoot !== nextRoot });
        }),

        vscode.commands.registerCommand("intelligit.showBranchPopup", async () => {
            await vscode.commands.executeCommand("intelligit.commitGraph.focus");
            commitGraph.openBranchPopup();
        }),

        vscode.commands.registerCommand("intelligit.annotateWithGitBlame", async () => {
            await blameController.annotateActiveEditor();
        }),

        vscode.commands.registerCommand("intelligit.clearGitBlame", async () => {
            await blameController.clear();
        }),

        vscode.commands.registerCommand("intelligit.mergeConflictsRefresh", async () => {
            await refreshService.refreshMergeConflicts();
        }),
    );

    const isFilePathContext = (value: unknown): value is { filePath: string } => {
        return (
            !!value &&
            typeof value === "object" &&
            "filePath" in value &&
            typeof value.filePath === "string"
        );
    };

    const resolveConflictPath = (ctx: unknown): string | null =>
        isFilePathContext(ctx) ? ctx.filePath : null;

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            await openMergeConflictForFile(filePath);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            const repository = resolveRepositoryForEditorContext(ctx);
            if (!repository) {
                vscode.window.showWarningMessage("No git repository found for the selected file.");
                return;
            }
            await compareEditorFileWithRevision(ctx, repository.root, repository.gitOps);
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            const repository = resolveRepositoryForEditorContext(ctx);
            if (!repository) {
                vscode.window.showWarningMessage("No git repository found for the selected file.");
                return;
            }
            await compareEditorFileWithBranch(ctx, repository.root, repository.gitOps);
        }),
        vscode.commands.registerCommand(
            "intelligit.compareProjectWithBranch",
            async (ctx?: unknown) => {
                const repository = resolveRepositoryForResourceContext(ctx);
                if (!repository) {
                    vscode.window.showWarningMessage("No git repository found for the selected resource.");
                    return;
                }

                try {
                    const branches = await repository.gitOps.getBranches();
                    const picks = branches
                        .slice()
                        .sort((a, b) => {
                            if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
                            if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
                            return a.name.localeCompare(b.name);
                        })
                        .map((branch) => ({
                            label: branch.isCurrent ? `${branch.name} (current)` : branch.name,
                            description: branch.isRemote ? "remote branch" : "local branch",
                            detail: branch.hash,
                            refName: branch.name,
                        }));

                    const picked = await vscode.window.showQuickPick(picks, {
                        title: "Compare Project with Branch",
                        placeHolder: `Select a branch for ${repository.info.relativePath ?? repository.info.name}`,
                        ignoreFocusOut: true,
                        matchOnDescription: true,
                        matchOnDetail: true,
                    });
                    if (!picked) return;

                    ProjectBranchComparisonPanel.open(
                        context.extensionUri,
                        repository,
                        picked.refName,
                        () => {
                            void updateIntelliGitDiffNavigationContext();
                        },
                    );
                } catch (error) {
                    const message = getErrorMessage(error);
                    vscode.window.showErrorMessage(`Compare project with branch failed: ${message}`);
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.openConflictSession", async () => {
            const conflicts = await gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                vscode.window.showInformationMessage("No unresolved merge conflicts found.");
                return;
            }
            await openConflictSession();
        }),
        vscode.commands.registerCommand("intelligit.detectJetBrainsMergeTool", async () => {
            await detectAndPickJetBrainsMergeToolPath();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInJetBrains",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                await openJetBrainsMergeToolForFile(
                    filePath,
                    requireCurrentRepository().root,
                    gitOps,
                    () => refreshService.refreshConflictUi(),
                    openBuiltInMergeEditorForFile,
                );
            },
        ),
        vscode.commands.registerCommand("intelligit.conflictAcceptYours", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                vscode.window.showInformationMessage(`Accepted yours for ${filePath}`);
                await refreshService.refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept yours failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand("intelligit.conflictAcceptTheirs", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            try {
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                vscode.window.showInformationMessage(`Accepted theirs for ${filePath}`);
                await refreshService.refreshConflictUi();
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept theirs failed: ${message}`);
            }
        }),
    );

    // --- Branch action commands ---

    const branchCommands = createBranchCommands({
        executor,
        gitOps,
        getCurrentBranchName: () => currentBranches.find((b) => b.isCurrent)?.name,
        getCurrentBranches: () => currentBranches,
        openConflictSession,
        refreshConflictUi: () => refreshService.refreshConflictUi(),
    });

    for (const cmd of branchCommands) {
        context.subscriptions.push(
            vscode.commands.registerCommand(cmd.id, (item: unknown) => {
                const validated =
                    item && typeof item === "object" && "branch" in item
                        ? (item as { branch?: Branch })
                        : { branch: undefined };
                return cmd.handler(validated);
            }),
        );
    }

    // --- Commit panel file context menu commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "intelligit.commitFileCompareWithLocal",
            async (ctx: unknown) => {
                const fileCtx = getCommitInfoFileContext(ctx);
                const repository =
                    (fileCtx?.repoRoot
                        ? repositoryService.listRepositories().find((entry) => entry.root === fileCtx.repoRoot)
                        : null) ?? requireCurrentRepository();
                await compareCommitInfoFileWithLocal(
                    ctx,
                    repository.root,
                    repository.gitOps,
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileCherryPickChange",
            async (ctx: unknown) => {
                const fileCtx = getCommitInfoFileContext(ctx);
                const repository =
                    (fileCtx?.repoRoot
                        ? repositoryService.listRepositories().find((entry) => entry.root === fileCtx.repoRoot)
                        : null) ?? requireCurrentRepository();
                await applySelectedCommitFileChange(ctx, "cherry-pick", repository.executor, () =>
                    refreshService.refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.commitFileRevertChange",
            async (ctx: unknown) => {
                const fileCtx = getCommitInfoFileContext(ctx);
                const repository =
                    (fileCtx?.repoRoot
                        ? repositoryService.listRepositories().find((entry) => entry.root === fileCtx.repoRoot)
                        : null) ?? requireCurrentRepository();
                await applySelectedCommitFileChange(ctx, "revert", repository.executor, () =>
                    refreshService.refreshConflictUi(),
                );
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileRollback",
            async (ctx: { filePath?: string; repoRoot?: string }) => {
                if (!ctx?.filePath) return;
                const confirm = await vscode.window.showWarningMessage(
                    `Rollback ${ctx.filePath}?`,
                    { modal: true },
                    "Rollback",
                );
                if (confirm !== "Rollback") return;
                try {
                    const repository =
                        (ctx.repoRoot
                            ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                            : null) ?? requireCurrentRepository();
                    await repository.gitOps.rollbackFiles([ctx.filePath]);
                    vscode.window.showInformationMessage("Changes rolled back.");
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to rollback file:", error);
                    vscode.window.showErrorMessage(`Rollback failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileJumpToSource",
            async (ctx: { filePath?: string; repoRoot?: string }) => {
                if (!ctx?.filePath) return;
                const repository =
                    (ctx.repoRoot
                        ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                        : null) ?? requireCurrentRepository();
                const uri = vscode.Uri.joinPath(
                    repository.uri,
                    assertRepoRelativePath(ctx.filePath),
                );
                await vscode.window.showTextDocument(uri);
            },
        ),
        vscode.commands.registerCommand("intelligit.openCommitDiffSource", async (ctx: unknown) => {
            const repository = getCurrentRepository();
            if (!repository) return;
            await openCommitDiffSourceFile(ctx, repository.uri);
            await updateCommitDiffSourceContext();
        }),
        vscode.commands.registerCommand(
            "intelligit.fileDelete",
            async (ctx: { filePath?: string; repoRoot?: string }) => {
                if (!ctx?.filePath) return;
                const safePath = assertRepoRelativePath(ctx.filePath);
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${safePath}?`,
                    { modal: true },
                    "Delete",
                );
                if (confirm !== "Delete") return;

                const repository =
                    (ctx.repoRoot
                        ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                        : null) ?? requireCurrentRepository();
                const deleted = await deleteFileWithFallback(
                    repository.gitOps,
                    repository.uri,
                    safePath,
                );
                if (!deleted) return;

                vscode.window.showInformationMessage(`Deleted ${safePath}`);
                await commitPanel.refresh();
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShelve",
            async (ctx: { filePath?: string; repoRoot?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const repository =
                        (ctx.repoRoot
                            ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                            : null) ?? requireCurrentRepository();
                    await repository.gitOps.shelveSave([ctx.filePath]);
                    vscode.window.showInformationMessage(`Shelved ${ctx.filePath}.`);
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to shelve file:", error);
                    vscode.window.showErrorMessage(`Shelve failed: ${message}`);
                } finally {
                    await commitPanel.refresh();
                }
            },
        ),
        vscode.commands.registerCommand(
            "intelligit.fileShowHistory",
            async (ctx: { filePath?: string; repoRoot?: string }) => {
                if (!ctx?.filePath) return;
                try {
                    const repository =
                        (ctx.repoRoot
                            ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                            : null) ?? requireCurrentRepository();
                    const history = await repository.gitOps.getFileHistory(ctx.filePath);
                    const doc = await vscode.workspace.openTextDocument({
                        content: history || "No history found.",
                        language: "git-commit",
                    });
                    await vscode.window.showTextDocument(doc, { preview: true });
                } catch (error) {
                    const message = getErrorMessage(error);
                    console.error("Failed to load file history:", error);
                    vscode.window.showErrorMessage(`Show history failed: ${message}`);
                }
            },
        ),
        vscode.commands.registerCommand("intelligit.fileRefresh", async () => {
            await commitPanel.refresh();
        }),
        vscode.commands.registerCommand("intelligit.fileRefreshing", () => {
            // No-op: visual-only command shown while refreshing (disabled via enablement).
        }),
        vscode.commands.registerCommand("intelligit.previousDiffChange", async () => {
            await navigateIntelliGitDiff("previous");
        }),
        vscode.commands.registerCommand("intelligit.previousDiffChangeUnavailable", () => {
            // Visible no-op placeholder. VS Code hides commands disabled via enablement in editor/title.
        }),
        vscode.commands.registerCommand("intelligit.nextDiffChange", async () => {
            await navigateIntelliGitDiff("next");
        }),
        vscode.commands.registerCommand("intelligit.nextDiffChangeUnavailable", () => {
            // Visible no-op placeholder. VS Code hides commands disabled via enablement in editor/title.
        }),
    );

    // --- Initial load ---

    await applyCurrentRepositoryContext({ resetGraph: true });
    commitPanel.syncActiveEditor(vscode.window.activeTextEditor);
    ProjectBranchComparisonPanel.getActivePanel()?.syncActiveEditor(vscode.window.activeTextEditor);
    await updateIntelliGitDiffNavigationContext();
    await blameController.initialize();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(async (editor) => {
            if (await repositoryService.followActiveEditor(editor)) {
                await applyCurrentRepositoryContext({ resetGraph: true });
                commitPanel.syncActiveEditor(editor);
                ProjectBranchComparisonPanel.getActivePanel()?.syncActiveEditor(editor);
                await updateIntelliGitDiffNavigationContext();
                return;
            }
            commitPanel.syncActiveEditor(editor);
            ProjectBranchComparisonPanel.getActivePanel()?.syncActiveEditor(editor);
            await updateCommitDiffSourceContext(editor);
            await updateIntelliGitDiffNavigationContext();
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            commitPanel.syncActiveEditor(event.textEditor);
            ProjectBranchComparisonPanel.getActivePanel()?.syncActiveEditor(event.textEditor);
            void updateIntelliGitDiffNavigationContext();
        }),
        vscode.workspace.onDidCloseTextDocument((document) => {
            commitDiffNavigationsByUri.delete(document.uri.toString());
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await repositoryService.refreshRepositories();
            await applyCurrentRepositoryContext({ resetGraph: true });
        }),
        vscode.workspace.onDidCreateFiles(async () => {
            await updateCommitDiffSourceContext();
        }),
        vscode.workspace.onDidDeleteFiles(async () => {
            await updateCommitDiffSourceContext();
        }),
        vscode.workspace.onDidRenameFiles(async () => {
            await updateCommitDiffSourceContext();
        }),
    );

    // Eagerly fetch file count so the activity bar badge shows immediately.
    commitPanel.refresh().catch((err) => {
        console.error("Initial commit panel refresh failed:", err);
    });
    refreshService.refreshMergeConflicts().catch((err) => {
        console.error("Initial merge conflicts refresh failed:", err);
    });

    // --- Auto-refresh on file changes ---

    refreshService.registerFileWatchers();

    // --- Disposables ---

    context.subscriptions.push(
        refreshService,
        branchStatusBar,
        blameController,
        commitGraph,
        commitInfo,
        commitPanel,
        mergeConflicts,
    );
}

export function deactivate(): void {}
