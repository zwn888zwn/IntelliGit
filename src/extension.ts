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
import { MergeEditorPanel } from "./views/MergeEditorPanel";
import { NoWorkspaceViewProvider } from "./views/NoWorkspaceViewProvider";
import { ProjectBranchComparisonPanel } from "./views/ProjectBranchComparisonPanel";
import type { Branch, CommitDetail, GitWorktree } from "./types";
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
import { showPushSuccessWithRequestLink } from "./utils/pushMergeRequest";
import {
    RepositoryContextService,
    createRepositoryScopedExecutor,
    createRepositoryScopedGitOps,
    type RepositoryEntry,
} from "./services/RepositoryContextService";
import {
    checkoutBranch,
    isValidBranchName,
    resolveRemoteName,
    resolveTrackedRemoteBranch,
} from "./services/gitHelpers";
import {
    buildWorktreeAddArgs,
    buildWorktreeRemoveArgs,
    copyWorktreeLocalFiles,
    findWorktreeForBranch,
    getDefaultWorktreeLocation,
    getDefaultWorktreeProjectName,
    isLocalBranchCheckedOut,
    isCurrentWorktreePath,
    parseWorktreeListPorcelain,
    resolveAndValidateWorktreeTarget,
    resolveRemoteBranchTarget,
} from "./services/worktreeService";
import type { CreateWorktreePayload } from "./webviews/react/commitGraphTypes";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const COMMIT_DIFF_SOURCE_EXISTS_CONTEXT = "intelligit.commitDiffSourceExists";
    const DIFF_NAVIGATION_ACTIVE_CONTEXT = "intelligit.diffNavigation.active";
    const DIFF_NAVIGATION_HAS_PREVIOUS_CONTEXT = "intelligit.diffNavigation.hasPrevious";
    const DIFF_NAVIGATION_HAS_NEXT_CONTEXT = "intelligit.diffNavigation.hasNext";
    type DiffNavigationState = {
        active: boolean;
        hasPrevious: boolean;
        hasNext: boolean;
        currentFile: number;
        totalFiles: number;
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
        currentFile: 0,
        totalFiles: 0,
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
    const diffFileCountStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        98,
    );
    diffFileCountStatusBar.name = "IntelliGit Diff File Position";
    diffFileCountStatusBar.tooltip = "Current file in IntelliGit diff";
    diffFileCountStatusBar.hide();
    context.subscriptions.push(diffFileCountStatusBar);
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
    const getCommitDiffNavigationState = async (
        editor: vscode.TextEditor | null | undefined,
    ): Promise<DiffNavigationState> => {
        const navigation = getCommitDiffNavigationForEditor(editor);
        if (!navigation || !editor) return inactiveDiffNavigationState;
        const filePath = getDiffOriginalFilePathFromUri(editor.document.uri);
        if (!filePath || filePath !== navigation.filePath) {
            return inactiveDiffNavigationState;
        }
        const currentIndex = navigation.files.findIndex((file) => file === navigation.filePath);
        if (currentIndex < 0) return inactiveDiffNavigationState;
        return {
            active: true,
            hasPrevious: currentIndex > 0,
            hasNext: currentIndex < navigation.files.length - 1,
            currentFile: currentIndex + 1,
            totalFiles: navigation.files.length,
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
        if (state.active) {
            diffFileCountStatusBar.text = `${state.currentFile}/${state.totalFiles} files`;
            diffFileCountStatusBar.show();
        } else {
            diffFileCountStatusBar.hide();
        }
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
    const openCommitDiffNavigationFile = async (
        filePath: string,
        navigation: ActiveCommitDiffNavigation,
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
    };
    const navigateCommitFileDiff = async (direction: "next" | "previous"): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        const navigation = getCommitDiffNavigationForEditor(editor);
        const state = await getCommitDiffNavigationState(editor);
        if (!state.active || !navigation) return;
        const target = getAdjacentCommitDiffFile(direction, navigation);
        if (target) await openCommitDiffNavigationFile(target, navigation);
    };
    const navigateIntelliGitDiffFile = async (direction: "next" | "previous"): Promise<void> => {
        const projectPanel = ProjectBranchComparisonPanel.getActivePanel();
        const editor = vscode.window.activeTextEditor ?? null;
        const projectState = await projectPanel?.getDiffNavigationState(editor);
        const commitDiffState = projectState?.active
            ? inactiveDiffNavigationState
            : await getCommitDiffNavigationState(editor);
        if (projectPanel && projectState?.active) {
            await projectPanel.navigateFile(direction);
        } else if (commitDiffState.active) {
            await navigateCommitFileDiff(direction);
        } else {
            await commitPanel.navigateFile(direction);
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
        branchStatusBar.update(repository, currentBranches, {
            mergeInProgress: await repository.gitOps.isMergeInProgress(),
        });
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

    type MergeConflictSessionOptions = {
        sourceBranch?: string;
        targetBranch?: string;
        repository?: RepositoryEntry;
    };

    let openConflictSession: (options?: MergeConflictSessionOptions) => Promise<void> =
        async () => undefined;

    const refreshService = new RefreshService(
        {
            gitOps,
            commitGraph,
            commitPanel,
            mergeConflicts,
            mergeConflictsView,
            onBranchesUpdated: async (branches) => {
                currentBranches = branches;
                branchStatusBar.update(getCurrentRepository(), currentBranches, {
                    mergeInProgress: await gitOps.isMergeInProgress(),
                });
            },
            onMergeConflictsDetected: async (count) => {
                const repository = getCurrentRepository();
                if (repository && MergeConflictSessionPanel.isOpen(repository.root)) return;
                await openConflictSession({
                    repository: repository ?? undefined,
                    targetBranch: currentBranches.find((branch) => branch.isCurrent)?.name,
                });
                vscode.window.showWarningMessage(
                    `Detected ${count} unresolved merge conflict file${count === 1 ? "" : "s"}. Opened Conflicts session.`,
                );
            },
        },
        repositoryService.listRepositories().map((entry) => entry.root),
    );

    // --- Merge conflict helpers ---

    let isFinalizingMerge = false;
    let isContinuingRebase = false;

    const ensureRepositoryContextActive = async (repository: RepositoryEntry): Promise<void> => {
        if (repository.root === getCurrentRepository()?.root) return;
        if (repositoryService.switchRepository(repository.root)) {
            await applyCurrentRepositoryContext({ resetGraph: true });
        }
    };

    const finalizeMergeIfReady = async (
        repository: RepositoryEntry = requireCurrentRepository(),
    ): Promise<boolean> => {
        if (isFinalizingMerge) return false;
        const conflicts = await repository.gitOps.getConflictFilesDetailed();
        if (conflicts.length > 0) return false;
        if (!(await repository.gitOps.isMergeInProgress())) return false;

        isFinalizingMerge = true;
        try {
            await ensureRepositoryContextActive(repository);
            const message = (await repository.gitOps.getPendingCommitMessage()) || "Merge commit";
            await runWithNotificationProgress("Committing merge...", async () => {
                await repository.gitOps.commit(message, false);
            });
            vscode.window.showInformationMessage("Merge committed successfully.");
            await vscode.commands.executeCommand("intelligit.refresh");
            return true;
        } finally {
            isFinalizingMerge = false;
        }
    };

    const continueRebaseIfReady = async (
        repository: RepositoryEntry = requireCurrentRepository(),
    ): Promise<boolean> => {
        if (isContinuingRebase) return false;
        const conflicts = await repository.gitOps.getConflictFilesDetailed();
        if (conflicts.length > 0) return false;
        if (!(await repository.gitOps.isRebaseInProgress())) return false;

        isContinuingRebase = true;
        try {
            await ensureRepositoryContextActive(repository);
            await runWithNotificationProgress("Continuing rebase...", async () => {
                await repository.gitOps.continueRebase();
            });
            vscode.window.showInformationMessage("Rebase continued successfully.");
            await vscode.commands.executeCommand("intelligit.refresh");
            return true;
        } finally {
            isContinuingRebase = false;
        }
    };

    const handleConflictStateChanged = async (
        repository: RepositoryEntry,
        resolvedPath?: string,
        refreshSession: boolean = true,
        finishWhenReady: boolean = true,
    ): Promise<void> => {
        await ensureRepositoryContextActive(repository);
        await refreshService.refreshConflictUi();
        if (resolvedPath && refreshSession) {
            await MergeConflictSessionPanel.refreshIfOpen({
                resolvedPath,
                repoRoot: repository.root,
            });
        }
        if (!finishWhenReady) return;
        if (await continueRebaseIfReady(repository)) return;
        await finalizeMergeIfReady(repository);
    };

    const openBuiltInMergeEditorForFile = async (
        repository: RepositoryEntry,
        filePath: string,
    ): Promise<void> => {
        const fileUri = vscode.Uri.file(
            path.join(repository.root, assertRepoRelativePath(filePath)),
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

    const openMergeConflictForFile = async (
        filePath: string,
        labels?: {
            sourceBranch?: string;
            targetBranch?: string;
        },
        repository: RepositoryEntry = requireCurrentRepository(),
        deferFinish: boolean = false,
        applyNonConflicting: boolean = false,
    ): Promise<void> => {
        const safePath = assertRepoRelativePath(filePath);
        await ensureRepositoryContextActive(repository);
        const preferExternal = getPreferExternalMergeTool();

        if (preferExternal && getJetBrainsMergeToolPath()) {
            const opened = await openJetBrainsMergeToolForFile(
                safePath,
                repository.root,
                repository.gitOps,
                async () => {
                    await ensureRepositoryContextActive(repository);
                    await refreshService.refreshConflictUi();
                },
                (pathToOpen) => openBuiltInMergeEditorForFile(repository, pathToOpen),
            );
            if (opened) return;
        }

        const targetBranch =
            labels?.targetBranch || currentBranches.find((branch) => branch.isCurrent)?.name;
        MergeEditorPanel.open(
            context.extensionUri,
            repository.gitOps,
            repository.uri,
            safePath,
            {
                oursSourceLabel: targetBranch,
                theirsSourceLabel: labels?.sourceBranch,
                applyNonConflicting,
            },
            async () => {
                await handleConflictStateChanged(repository, safePath, true, !deferFinish);
            },
        );
    };

    openConflictSession = async (options: MergeConflictSessionOptions = {}): Promise<void> => {
        const repository = options.repository ?? getCurrentRepository();
        if (!repository) return;
        await ensureRepositoryContextActive(repository);
        const labels = {
            sourceBranch: options.sourceBranch,
            targetBranch: options.targetBranch,
        };
        await MergeConflictSessionPanel.open(
            context.extensionUri,
            repository.gitOps,
            labels,
            {
                onOpenMergeConflict: async (filePath, applyNonConflicting) => {
                    await openMergeConflictForFile(
                        filePath,
                        labels,
                        repository,
                        true,
                        applyNonConflicting,
                    );
                },
                onConflictStateChanged: async (resolvedPath) => {
                    await handleConflictStateChanged(repository, resolvedPath, false, false);
                },
                onFinish: async () => {
                    if (await continueRebaseIfReady(repository)) return true;
                    return finalizeMergeIfReady(repository);
                },
                onMergeAborted: async () => {
                    await vscode.commands.executeCommand("intelligit.refresh");
                },
            },
            { repoRoot: repository.root },
        );
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
        commitGraph.onBranchAction(async ({ action, branchName, repoRoot, allRepositories }) => {
            if (allRepositories) {
                await runBranchActionInAllRepositories(action, branchName);
                return;
            }
            const targetRepository =
                (repoRoot
                    ? repositoryService.listRepositories().find((entry) => entry.root === repoRoot)
                    : null) ?? getCurrentRepository();
            if (!targetRepository) return;
            const branches = await getBranchesForRepository(targetRepository);
            const branch = branches.find((b) => b.name === branchName);
            if (!branch) return;
            if (action === "openWorktree") {
                await openWorktreeForBranch(targetRepository, branch);
                return;
            }
            if (targetRepository.root !== getCurrentRepository()?.root) {
                repositoryService.switchRepository(targetRepository.root);
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
            if (action === "newWorktreeFrom") {
                await openNewWorktreeDialog(targetRepository, branch);
                return;
            }
            const item: { branch: Branch } = { branch };
            await vscode.commands.executeCommand(`intelligit.${action}`, item);
        }),
    );

    context.subscriptions.push(
        commitGraph.onBranchPopupAction(async ({ action, root, refName, allRepositories }) => {
            if (
                action === "worktrees" &&
                !root &&
                repositoryService.listRepositories().length > 1
            ) {
                await openAllWorktreesDialog();
                return;
            }
            const targetRepository =
                (root
                    ? repositoryService.listRepositories().find((entry) => entry.root === root)
                    : null) ?? getCurrentRepository();
            if (targetRepository && targetRepository.root !== getCurrentRepository()?.root) {
                repositoryService.switchRepository(targetRepository.root);
                await applyCurrentRepositoryContext({ resetGraph: true });
            }
            const currentBranch = currentBranches.find(
                (branch) => branch.isCurrent && !branch.isRemote,
            );
            switch (action) {
                case "switchRepository":
                    return;
                case "commit":
                    await vscode.commands.executeCommand("intelligit.commitPanel.focus");
                    return;
                case "checkoutRevision": {
                    if (allRepositories && refName) {
                        await checkoutRefInAllRepositories(refName);
                        return;
                    }
                    const revision =
                        refName ??
                        (await vscode.window.showInputBox({
                            prompt: "Checkout tag, branch, or revision",
                            placeHolder: "tag, branch, or commit hash",
                            ignoreFocusOut: true,
                        }));
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
                    await createBranchFromPopup(targetRepository);
                    return;
                case "newWorktree": {
                    if (!targetRepository) return;
                    const branches = await getBranchesForRepository(targetRepository);
                    const branch =
                        branches.find((item) => item.isCurrent && !item.isRemote) ??
                        branches.find((item) => !item.isRemote) ??
                        branches[0];
                    if (!branch) {
                        vscode.window.showWarningMessage(
                            `No branch was found in ${targetRepository.info.name}.`,
                        );
                        return;
                    }
                    await openNewWorktreeDialog(targetRepository, branch);
                    return;
                }
                case "worktrees":
                    if (targetRepository) {
                        await openWorktreesDialog(targetRepository);
                    }
                    return;
            }
        }),
    );

    context.subscriptions.push(
        commitGraph.onChooseWorktreeLocation(async ({ currentLocation }) => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: "Select",
                defaultUri: currentLocation ? vscode.Uri.file(currentLocation) : undefined,
            });
            const selected = picked?.[0]?.fsPath;
            if (selected) {
                commitGraph.setWorktreeLocationSelected(selected);
            }
        }),
    );

    context.subscriptions.push(commitGraph.onCreateWorktree(handleCreateWorktreeRequest));
    context.subscriptions.push(commitGraph.onOpenWorktree(handleOpenWorktreeRequest));
    context.subscriptions.push(commitGraph.onDeleteWorktree(handleDeleteWorktreeRequest));

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

    async function getBranchesForRepository(repository: RepositoryEntry): Promise<Branch[]> {
        return repository.root === getCurrentRepository()?.root
            ? currentBranches
            : await repository.gitOps.getBranches();
    }

    async function listWorktrees(repository: RepositoryEntry): Promise<GitWorktree[]> {
        return parseWorktreeListPorcelain(
            await repository.executor.run(["worktree", "list", "--porcelain"]),
        );
    }

    async function refreshRepositoryWorktrees(repository: RepositoryEntry): Promise<GitWorktree[]> {
        const worktrees = await listWorktrees(repository);
        commitGraph.setRepositoryWorktrees(repository.root, worktrees);
        return worktrees;
    }

    async function openWorktreesDialog(repository: RepositoryEntry): Promise<void> {
        try {
            await refreshRepositoryWorktrees(repository);
            commitGraph.openWorktreesDialog(repository.root);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to load worktrees: ${message}`);
        }
    }

    async function openAllWorktreesDialog(): Promise<void> {
        try {
            await Promise.all(
                repositoryService
                    .listRepositories()
                    .map((repository) => refreshRepositoryWorktrees(repository)),
            );
            commitGraph.openWorktreesDialog();
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to load worktrees: ${message}`);
        }
    }

    async function openWorktreeForBranch(
        repository: RepositoryEntry,
        branch: Branch,
    ): Promise<void> {
        try {
            const worktrees = await refreshRepositoryWorktrees(repository);
            const worktree = findWorktreeForBranch(branch, worktrees);
            if (!worktree) {
                vscode.window.showWarningMessage(
                    `No worktree is checked out for '${branch.name}'.`,
                );
                return;
            }
            await openWorktreePath(worktree.path);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to open worktree: ${message}`);
        }
    }

    async function handleOpenWorktreeRequest(payload: { repoRoot: string; path: string }): Promise<void> {
        try {
            const repository = repositoryService
                .listRepositories()
                .find((entry) => entry.root === payload.repoRoot);
            if (!repository) throw new Error("Repository was not found for the requested worktree.");

            const worktrees = await refreshRepositoryWorktrees(repository);
            const worktree = findWorktreeByPath(worktrees, payload.path);
            if (!worktree) throw new Error(`Worktree was not found: ${payload.path}`);

            await openWorktreePath(worktree.path);
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to open worktree: ${message}`);
        }
    }

    async function handleDeleteWorktreeRequest(payload: { repoRoot: string; path: string }): Promise<void> {
        try {
            const repository = repositoryService
                .listRepositories()
                .find((entry) => entry.root === payload.repoRoot);
            if (!repository) throw new Error("Repository was not found for the requested worktree.");

            const worktrees = await listWorktrees(repository);
            const worktree = findWorktreeByPath(worktrees, payload.path);
            if (!worktree) throw new Error(`Worktree was not found: ${payload.path}`);
            if (isCurrentWorktreePath(repository.root, worktree.path)) {
                throw new Error("The current worktree cannot be deleted from this window.");
            }

            await runWithNotificationProgress(`Deleting worktree ${path.basename(worktree.path)}...`, async () => {
                await repository.executor.run(buildWorktreeRemoveArgs(worktree.path));
            });
            commitGraph.setWorktreeDeleteResult({ success: true, path: worktree.path });
            await refreshRepositoryWorktrees(repository);
            vscode.window.showInformationMessage(`Deleted worktree at ${worktree.path}.`);
        } catch (error) {
            const message = getErrorMessage(error);
            commitGraph.setWorktreeDeleteResult({ success: false, message });
            vscode.window.showErrorMessage(`Failed to delete worktree: ${message}`);
        }
    }

    async function openWorktreePath(worktreePath: string): Promise<void> {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), true);
    }

    function findWorktreeByPath(worktrees: GitWorktree[], worktreePath: string): GitWorktree | null {
        return worktrees.find((worktree) => sameFsPath(worktree.path, worktreePath)) ?? null;
    }

    function sameFsPath(left: string, right: string): boolean {
        const normalizedLeft = path.resolve(left);
        const normalizedRight = path.resolve(right);
        return process.platform === "win32"
            ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
            : normalizedLeft === normalizedRight;
    }

    async function openNewWorktreeDialog(
        repository: RepositoryEntry,
        branch: Branch,
    ): Promise<void> {
        try {
            const worktrees = await refreshRepositoryWorktrees(repository);
            commitGraph.openWorktreeDialog({
                repository: repository.info,
                branch,
                defaultLocation: getDefaultWorktreeLocation(repository.root),
                defaultProjectName: getDefaultWorktreeProjectName(repository.root, branch.name),
                worktrees,
            });
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to open New Worktree dialog: ${message}`);
        }
    }

    async function handleCreateWorktreeRequest(payload: CreateWorktreePayload): Promise<void> {
        try {
            const repository = repositoryService
                .listRepositories()
                .find((entry) => entry.root === payload.repoRoot);
            if (!repository) {
                throw new Error("Repository was not found for the requested worktree.");
            }

            const branches = await getBranchesForRepository(repository);
            const branch = branches.find((item) => item.name === payload.branchName);
            if (!branch) {
                throw new Error(`Branch '${payload.branchName}' was not found.`);
            }

            const newBranchName = payload.createBranch ? payload.newBranchName?.trim() ?? "" : undefined;
            if (payload.createBranch && (!newBranchName || !isValidBranchName(newBranchName))) {
                throw new Error(`Invalid branch name '${newBranchName}'.`);
            }

            const targetPath = await resolveAndValidateWorktreeTarget(
                payload.location,
                payload.projectName,
            );
            const worktrees = parseWorktreeListPorcelain(
                await repository.executor.run(["worktree", "list", "--porcelain"]),
            );
            if (!payload.createBranch && isLocalBranchCheckedOut(branch, worktrees)) {
                throw new Error(
                    `Local branch '${branch.name}' is already checked out. Enable New branch to create a worktree.`,
                );
            }

            const remoteTarget = resolveRemoteBranchTarget(branch);
            await runWithNotificationProgress(`Creating worktree ${payload.projectName.trim()}...`, async () => {
                if (remoteTarget) {
                    await repository.executor.run([
                        "fetch",
                        remoteTarget.remote,
                        remoteTarget.remoteBranch,
                        "--recurse-submodules=no",
                        "--progress",
                        "--prune",
                    ]);
                }
                await repository.executor.run(
                    buildWorktreeAddArgs({
                        targetPath,
                        fromBranch: branch.name,
                        newBranchName,
                    }),
                );
            });

            try {
                await copyWorktreeLocalFiles(repository.root, targetPath);
            } catch (error) {
                vscode.window.showWarningMessage(
                    `Worktree created, but failed to copy .envrc or .vscode: ${getErrorMessage(error)}`,
                );
            }

            commitGraph.setWorktreeCreateResult({ success: true, path: targetPath });
            await refreshRepositoryWorktrees(repository);
            vscode.window.showInformationMessage(`Created worktree at ${targetPath}.`);
            await openWorktreePath(targetPath);
        } catch (error) {
            const message = getErrorMessage(error);
            commitGraph.setWorktreeCreateResult({ success: false, message });
            vscode.window.showErrorMessage(`Failed to create worktree: ${message}`);
        }
    }

    const checkoutBranchInAllRepositories = async (branchName: string): Promise<void> => {
        const repositories = repositoryService.listRepositories();
        const targets: Array<{ repository: (typeof repositories)[number]; branch: Branch; branches: Branch[] }> = [];
        for (const repository of repositories) {
            const branches =
                repository.root === getCurrentRepository()?.root
                    ? currentBranches
                    : await repository.gitOps.getBranches();
            const branch = branches.find((item) => item.name === branchName);
            if (!branch) {
                vscode.window.showErrorMessage(
                    `Checkout failed: '${branchName}' does not exist in ${repository.info.name}.`,
                );
                return;
            }
            targets.push({ repository, branch, branches });
        }

        try {
            await runWithNotificationProgress(`Checking out ${branchName} in all repositories...`, async () => {
                for (const target of targets) {
                    await checkoutBranch(target.branch, target.branches, target.repository.executor);
                }
            });
            vscode.window.showInformationMessage(
                `Checked out ${branchName} in ${targets.length} repositories.`,
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Checkout failed: ${message}`);
        }
    };

    const runBranchActionInAllRepositories = async (
        action: string,
        branchName: string,
    ): Promise<void> => {
        if (action === "checkout") {
            await checkoutBranchInAllRepositories(branchName);
            return;
        }

        const supportedActions = new Set([
            "checkoutAndRebase",
            "rebaseCurrentOnto",
            "mergeIntoCurrent",
            "updateBranch",
            "pushBranch",
        ]);
        if (!supportedActions.has(action)) return;

        const repositories = repositoryService.listRepositories();
        const targets: Array<{
            repository: (typeof repositories)[number];
            branch: Branch;
            branches: Branch[];
            currentBranchName?: string;
            tracked?: { remote: string; remoteBranch: string };
            pushRemote?: string;
        }> = [];

        for (const repository of repositories) {
            const branches =
                repository.root === getCurrentRepository()?.root
                    ? currentBranches
                    : await repository.gitOps.getBranches();
            const branch = branches.find((item) => item.name === branchName);
            if (!branch) {
                vscode.window.showErrorMessage(
                    `Action failed: '${branchName}' does not exist in ${repository.info.name}.`,
                );
                return;
            }
            if ((action === "updateBranch" || action === "pushBranch") && branch.isRemote) {
                vscode.window.showErrorMessage(
                    `Action failed: '${branchName}' is not a local branch in ${repository.info.name}.`,
                );
                return;
            }
            const tracked =
                (action === "updateBranch" || action === "pushBranch"
                    ? resolveTrackedRemoteBranch(branch, branches)
                    : undefined) ?? undefined;
            let pushRemote: string | undefined;
            if (action === "updateBranch" && !tracked) {
                vscode.window.showErrorMessage(
                    `Update failed: No tracked remote branch configured for '${branch.name}' in ${repository.info.name}.`,
                );
                return;
            }
            if (action === "pushBranch" && !tracked && !branch.isCurrent) {
                const resolved = await resolveRemoteName(branch, repository.executor);
                if (!resolved) {
                    vscode.window.showErrorMessage(
                        `Push failed: No remote configured for branch ${branch.name} in ${repository.info.name}.`,
                    );
                    return;
                }
                pushRemote = resolved;
            }
            targets.push({
                repository,
                branch,
                branches,
                currentBranchName: branches.find((item) => item.isCurrent)?.name,
                tracked,
                pushRemote,
            });
        }

        const actionLabel =
            action === "mergeIntoCurrent"
                ? "Merging"
                : action === "rebaseCurrentOnto"
                  ? "Rebasing"
                  : action === "updateBranch"
                    ? "Updating"
                    : action === "pushBranch"
                      ? "Pushing"
                      : "Checking out and rebasing";
        const successVerb =
            action === "mergeIntoCurrent"
                ? "Merged"
                : action === "rebaseCurrentOnto"
                  ? "Rebased"
                  : action === "updateBranch"
                    ? "Updated"
                    : action === "pushBranch"
                      ? "Pushed"
                      : "Checked out and rebased";
        try {
            const pushOutputs: string[] = [];
            await runWithNotificationProgress(
                `${actionLabel} ${branchName} in all repositories...`,
                async () => {
                    for (const target of targets) {
                        switch (action) {
                            case "mergeIntoCurrent":
                                await target.repository.executor.run(["merge", target.branch.name]);
                                break;
                            case "rebaseCurrentOnto":
                                await target.repository.executor.run(["rebase", target.branch.name]);
                                break;
                            case "checkoutAndRebase": {
                                const onto = target.currentBranchName;
                                if (!onto) {
                                    throw new Error(
                                        `No current branch found in ${target.repository.info.name}.`,
                                    );
                                }
                                const checkedOut = await checkoutBranch(
                                    target.branch,
                                    target.branches,
                                    target.repository.executor,
                                );
                                if (checkedOut !== onto) {
                                    await target.repository.executor.run(["rebase", onto]);
                                }
                                break;
                            }
                            case "updateBranch":
                                if (!target.tracked) {
                                    throw new Error(
                                        `No tracked remote branch configured for '${target.branch.name}' in ${target.repository.info.name}.`,
                                    );
                                }
                                if (target.branch.isCurrent) {
                                    await target.repository.executor.run([
                                        "fetch",
                                        target.tracked.remote,
                                        target.tracked.remoteBranch,
                                        "--recurse-submodules=no",
                                        "--progress",
                                        "--prune",
                                    ]);
                                    try {
                                        await target.repository.executor.run([
                                            "merge",
                                            "--ff-only",
                                            "FETCH_HEAD",
                                        ]);
                                    } catch {
                                        await target.repository.executor.run([
                                            "rebase",
                                            "--autostash",
                                            "FETCH_HEAD",
                                        ]);
                                    }
                                } else {
                                    await target.repository.executor.run([
                                        "fetch",
                                        target.tracked.remote,
                                        `${target.tracked.remoteBranch}:${target.branch.name}`,
                                        "--recurse-submodules=no",
                                        "--progress",
                                        "--prune",
                                    ]);
                                }
                                break;
                            case "pushBranch":
                                let pushOutput = "";
                                if (target.tracked) {
                                    pushOutput = await target.repository.executor.runWithStderr([
                                        "push",
                                        target.tracked.remote,
                                        `${target.branch.name}:${target.tracked.remoteBranch}`,
                                    ]);
                                } else if (target.branch.isCurrent) {
                                    pushOutput = await target.repository.gitOps.push();
                                } else {
                                    pushOutput = await target.repository.executor.runWithStderr([
                                        "push",
                                        "-u",
                                        target.pushRemote!,
                                        target.branch.name,
                                    ]);
                                }
                                pushOutputs.push(pushOutput);
                                break;
                        }
                    }
                },
            );
            const successMessage = `${successVerb} ${branchName} in ${targets.length} repositories.`;
            if (action === "pushBranch") {
                await showPushSuccessWithRequestLink(successMessage, pushOutputs.join("\n"));
            } else {
                vscode.window.showInformationMessage(successMessage);
            }
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Action failed: ${message}`);
        }
    };

    const checkoutRefInAllRepositories = async (refName: string): Promise<void> => {
        const repositories = repositoryService.listRepositories();
        for (const repository of repositories) {
            try {
                await repository.executor.run(["show-ref", "--verify", `refs/tags/${refName}`]);
            } catch {
                vscode.window.showErrorMessage(
                    `Checkout failed: tag '${refName}' does not exist in ${repository.info.name}.`,
                );
                return;
            }
        }
        try {
            await runWithNotificationProgress(`Checking out ${refName} in all repositories...`, async () => {
                for (const repository of repositories) {
                    await repository.executor.run(["checkout", refName]);
                }
            });
            vscode.window.showInformationMessage(
                `Checked out ${refName} in ${repositories.length} repositories.`,
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Checkout failed: ${message}`);
        }
    };

    const createBranchFromPopup = async (
        preferredRepository: ReturnType<typeof getCurrentRepository>,
    ): Promise<void> => {
        const repositories = repositoryService.listRepositories();
        let selectedRoots: string[] | null = preferredRepository ? [preferredRepository.root] : null;
        if (repositories.length > 1) {
            const picked = await vscode.window.showQuickPick(
                [
                    {
                        label: "All",
                        description: "Create and checkout in every repository",
                        roots: repositories.map((repository) => repository.root),
                    },
                    ...repositories.map((repository) => ({
                        label: repository.info.name,
                        description: repository.info.relativePath ?? repository.info.root,
                        roots: [repository.root],
                    })),
                ],
                { placeHolder: "Select repository root", ignoreFocusOut: true },
            );
            if (!picked) return;
            selectedRoots = picked.roots;
        }

        const currentBranchName = currentBranches.find(
            (branch) => branch.isCurrent && !branch.isRemote,
        )?.name;
        const branchName = await vscode.window.showInputBox({
            prompt: "New branch from current branch",
            value: currentBranchName,
            valueSelection: currentBranchName ? [0, currentBranchName.length] : undefined,
            placeHolder: "branch-name",
            ignoreFocusOut: true,
        });
        const trimmed = branchName?.trim();
        if (!trimmed) return;
        if (!isValidBranchName(trimmed)) {
            vscode.window.showErrorMessage(
                `Invalid branch name '${trimmed}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
            );
            return;
        }

        const roots = selectedRoots ?? repositories.map((repository) => repository.root);
        const targets = repositories.filter((repository) => roots.includes(repository.root));
        for (const repository of targets) {
            const branches = await repository.gitOps.getBranches();
            if (branches.some((branch) => !branch.isRemote && branch.name === trimmed)) {
                vscode.window.showErrorMessage(
                    `Failed to create branch: '${trimmed}' already exists in ${repository.info.name}.`,
                );
                return;
            }
        }
        try {
            await runWithNotificationProgress(`Creating ${trimmed}...`, async () => {
                for (const repository of targets) {
                    await repository.executor.run(["checkout", "-b", trimmed]);
                }
            });
            vscode.window.showInformationMessage(
                `Created and checked out ${trimmed} in ${targets.length} repository${targets.length === 1 ? "" : "s"}.`,
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const message = getErrorMessage(error);
            vscode.window.showErrorMessage(`Failed to create branch: ${message}`);
        }
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

        vscode.commands.registerCommand("intelligit.abortMerge", async () => {
            if (!(await gitOps.isMergeInProgress())) {
                vscode.window.showInformationMessage("No merge in progress.");
                await vscode.commands.executeCommand("intelligit.refresh");
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                "Abort the current merge and discard merge conflict resolutions?",
                { modal: true },
                "Abort Merge",
            );
            if (confirm !== "Abort Merge") return;

            try {
                await runWithNotificationProgress("Aborting merge...", async () => {
                    await gitOps.abortMerge();
                });
                vscode.window.showInformationMessage("Merge aborted.");
                await vscode.commands.executeCommand("intelligit.refresh");
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Abort merge failed: ${message}`);
            }
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

    const getUriFromUnknown = (value: unknown): vscode.Uri | null => {
        if (!value || typeof value !== "object") return null;
        const maybe = value as { scheme?: unknown; fsPath?: unknown };
        return typeof maybe.scheme === "string" && typeof maybe.fsPath === "string"
            ? (value as vscode.Uri)
            : null;
    };

    const resolveConflictPath = (ctx: unknown): string | null =>
        isFilePathContext(ctx) ? ctx.filePath : null;

    const resolveConflictRepository = (ctx: unknown): RepositoryEntry | null => {
        if (!ctx || typeof ctx !== "object") return getCurrentRepository();
        const maybe = ctx as { uri?: unknown; repoRoot?: unknown };
        const repoRoot = typeof maybe.repoRoot === "string" ? maybe.repoRoot : undefined;
        if (repoRoot) {
            const repository = repositoryService
                .listRepositories()
                .find((entry) => entry.root === repoRoot);
            if (repository) return repository;
        }
        const uri = getUriFromUnknown(maybe.uri);
        return repositoryService.getRepositoryForUri(uri ?? undefined) ?? getCurrentRepository();
    };

    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openMergeConflict", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            const repository = resolveConflictRepository(ctx);
            if (!repository) return;
            await openMergeConflictForFile(filePath, undefined, repository);
        }),
        vscode.commands.registerCommand("intelligit.compareWithRevision", async (ctx?: unknown) => {
            const repository = resolveRepositoryForEditorContext(ctx);
            if (!repository) {
                vscode.window.showWarningMessage("No git repository found for the selected file.");
                return;
            }
            await compareEditorFileWithRevision(
                ctx,
                repository.root,
                repository.gitOps,
                repository.executor,
            );
        }),
        vscode.commands.registerCommand("intelligit.compareWithBranch", async (ctx?: unknown) => {
            const repository = resolveRepositoryForEditorContext(ctx);
            if (!repository) {
                vscode.window.showWarningMessage("No git repository found for the selected file.");
                return;
            }
            await compareEditorFileWithBranch(
                ctx,
                repository.root,
                repository.gitOps,
                repository.executor,
            );
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
            const repository = getCurrentRepository();
            if (!repository) {
                vscode.window.showInformationMessage("No unresolved merge conflicts found.");
                return;
            }
            const conflicts = await repository.gitOps.getConflictFilesDetailed();
            if (conflicts.length === 0) {
                vscode.window.showInformationMessage("No unresolved merge conflicts found.");
                return;
            }
            await openConflictSession({ repository });
        }),
        vscode.commands.registerCommand("intelligit.detectJetBrainsMergeTool", async () => {
            await detectAndPickJetBrainsMergeToolPath();
        }),
        vscode.commands.registerCommand(
            "intelligit.openMergeConflictInJetBrains",
            async (ctx: unknown) => {
                const filePath = resolveConflictPath(ctx);
                if (!filePath) return;
                const repository = resolveConflictRepository(ctx);
                if (!repository) return;
                await ensureRepositoryContextActive(repository);
                await openJetBrainsMergeToolForFile(
                    filePath,
                    repository.root,
                    repository.gitOps,
                    async () => {
                        await ensureRepositoryContextActive(repository);
                        await refreshService.refreshConflictUi();
                    },
                    (pathToOpen) => openBuiltInMergeEditorForFile(repository, pathToOpen),
                );
            },
        ),
        vscode.commands.registerCommand("intelligit.conflictAcceptYours", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            const repository = resolveConflictRepository(ctx);
            if (!repository) return;
            try {
                await runWithNotificationProgress(
                    `Accepting yours for ${filePath}...`,
                    async () => {
                        await repository.gitOps.acceptConflictSide(filePath, "ours");
                    },
                );
                vscode.window.showInformationMessage(`Accepted yours for ${filePath}`);
                await handleConflictStateChanged(repository, filePath);
            } catch (error) {
                const message = getErrorMessage(error);
                vscode.window.showErrorMessage(`Accept yours failed: ${message}`);
            }
        }),
        vscode.commands.registerCommand("intelligit.conflictAcceptTheirs", async (ctx: unknown) => {
            const filePath = resolveConflictPath(ctx);
            if (!filePath) return;
            const repository = resolveConflictRepository(ctx);
            if (!repository) return;
            try {
                await runWithNotificationProgress(
                    `Accepting theirs for ${filePath}...`,
                    async () => {
                        await repository.gitOps.acceptConflictSide(filePath, "theirs");
                    },
                );
                vscode.window.showInformationMessage(`Accepted theirs for ${filePath}`);
                await handleConflictStateChanged(repository, filePath);
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
        finalizeMergeIfReady,
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
                    repository.executor,
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
            async (ctx: { filePath?: string; filePaths?: string[]; repoRoot?: string }) => {
                const paths =
                    Array.isArray(ctx?.filePaths) && ctx.filePaths.length > 0
                        ? ctx.filePaths
                        : ctx?.filePath
                          ? [ctx.filePath]
                          : [];
                if (paths.length === 0) return;
                const confirm = await vscode.window.showWarningMessage(
                    paths.length === 1 ? `Rollback ${paths[0]}?` : `Rollback ${paths.length} file(s)?`,
                    { modal: true },
                    "Rollback",
                );
                if (confirm !== "Rollback") return;
                try {
                    const repository =
                        (ctx.repoRoot
                            ? repositoryService.listRepositories().find((entry) => entry.root === ctx.repoRoot)
                            : null) ?? requireCurrentRepository();
                    await repository.gitOps.rollbackFiles(paths);
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
        vscode.commands.registerCommand("intelligit.previousDiffFile", async () => {
            await navigateIntelliGitDiffFile("previous");
        }),
        vscode.commands.registerCommand("intelligit.nextDiffFile", async () => {
            await navigateIntelliGitDiffFile("next");
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
