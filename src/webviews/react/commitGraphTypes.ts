// Typed message protocol for communication between the commit graph webview
// and the extension host. Defines all inbound and outbound message shapes.

import type {
    Branch,
    Commit,
    CommitDetail,
    GitTag,
    GitWorktree,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";

export const BRANCH_ACTION_VALUES = [
    "checkout",
    "openWorktree",
    "newBranchFrom",
    "newWorktreeFrom",
    "checkoutAndRebase",
    "rebaseCurrentOnto",
    "mergeIntoCurrent",
    "updateBranch",
    "pushBranch",
    "renameBranch",
    "deleteBranch",
] as const;

export const BRANCH_POPUP_ACTION_VALUES = [
    "updateProject",
    "commit",
    "push",
    "newBranch",
    "newWorktree",
    "checkoutRevision",
    "worktrees",
    "switchRepository",
] as const;

export const COMMIT_ACTION_VALUES = [
    "copyRevision",
    "createPatch",
    "cherryPick",
    "checkoutRevision",
    "resetCurrentToHere",
    "revertCommit",
    "pushAllUpToHere",
    "undoCommit",
    "editCommitMessage",
    "dropCommit",
    "interactiveRebaseFromHere",
    "newBranch",
    "newTag",
    "pushTag",
    "deleteTag",
] as const;

export type BranchAction = (typeof BRANCH_ACTION_VALUES)[number];
export type BranchPopupAction = (typeof BRANCH_POPUP_ACTION_VALUES)[number];
export type CommitAction = (typeof COMMIT_ACTION_VALUES)[number];

export interface OpenWorktreeDialogPayload {
    repository: RepositoryContextInfo;
    branch: Branch;
    defaultLocation: string;
    defaultProjectName: string;
    worktrees: GitWorktree[];
}

export interface CreateWorktreePayload {
    repoRoot: string;
    branchName: string;
    createBranch: boolean;
    newBranchName?: string;
    projectName: string;
    location: string;
}

export interface WorktreePathPayload {
    repoRoot: string;
    path: string;
}

export function isBranchAction(value: string): value is BranchAction {
    return BRANCH_ACTION_VALUES.includes(value as BranchAction);
}

export function isCommitAction(value: string): value is CommitAction {
    return COMMIT_ACTION_VALUES.includes(value as CommitAction);
}

/** Messages sent FROM the webview TO the extension host. */
export type CommitGraphOutbound =
    | { type: "ready" }
    | { type: "selectCommit"; hash: string; repoRoot: string }
    | { type: "revealCommit"; hash: string }
    | { type: "filterText"; text: string }
    | { type: "loadMore" }
    | { type: "filterBranch"; branch: string | null }
    | {
          type: "branchAction";
          action: BranchAction;
          branchName: string;
          repoRoot?: string;
          allRepositories?: boolean;
      }
    | { type: "chooseWorktreeLocation"; currentLocation?: string }
    | { type: "createWorktree"; payload: CreateWorktreePayload }
    | { type: "openWorktree"; payload: WorktreePathPayload }
    | { type: "deleteWorktree"; payload: WorktreePathPayload }
    | {
          type: "branchPopupAction";
          action: BranchPopupAction;
          root?: string;
          refName?: string;
          allRepositories?: boolean;
      }
    | { type: "commitAction"; action: CommitAction; hash: string; repoRoot: string }
    | { type: "openCommitFileDiff"; commitHash: string; filePath: string; repoRoot: string };

/** Messages sent FROM the extension host TO the webview. */
export type CommitGraphInbound =
    | {
          type: "loadCommits";
          commits: Commit[];
          hasMore: boolean;
          append: boolean;
          unpushedHashes: string[];
      }
    | {
          type: "setBranches";
          branches: Branch[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "setRepositories"; repositories: RepositoryContextInfo[] }
    | { type: "setRepositoryBranches"; branchesByRoot: Record<string, Branch[]> }
    | { type: "setRepositoryTags"; tagsByRoot: Record<string, GitTag[]> }
    | { type: "setRepositoryWorktrees"; worktreesByRoot: Record<string, GitWorktree[]> }
    | { type: "setRepositoryContext"; repository: RepositoryContextInfo | null }
    | { type: "setSelectedBranch"; branch: string | null }
    | { type: "setFilterText"; text: string }
    | { type: "openBranchPopup" }
    | { type: "openWorktreesDialog"; repoRoot?: string }
    | { type: "openWorktreeDialog"; payload: OpenWorktreeDialogPayload }
    | { type: "worktreeLocationSelected"; location: string }
    | { type: "worktreeCreateResult"; success: true; path: string }
    | { type: "worktreeCreateResult"; success: false; message: string }
    | { type: "worktreeDeleteResult"; success: true; path: string }
    | { type: "worktreeDeleteResult"; success: false; message: string }
    | {
          type: "setCommitDetail";
          detail: CommitDetail;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "revealCommit"; hash: string }
    | { type: "clearCommitDetail" }
    | { type: "loadError"; message: string }
    | { type: "error"; message: string };
