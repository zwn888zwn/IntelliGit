// Typed message protocol for communication between the commit panel webview
// and the extension host. Defines all inbound and outbound message shapes.

import type {
    RepoPathRef,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
    WorkingFile,
    StashEntry,
} from "../../../types";
import type {
    TreeFolder as GenericTreeFolder,
    TreeLeaf as GenericTreeLeaf,
} from "../shared/fileTree";

/** Messages sent FROM the webview TO the extension host. */
export type OutboundMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "stageFiles"; targets: RepoPathRef[] }
    | { type: "unstageFiles"; targets: RepoPathRef[] }
    | { type: "commitSelected"; targets: RepoPathRef[]; message: string; amend: boolean; push: boolean }
    | { type: "commit"; message: string; amend: boolean }
    | { type: "commitAndPush"; message: string; amend: boolean }
    | { type: "getLastCommitMessage" }
    | { type: "rollback"; targets: RepoPathRef[] }
    | { type: "showDiff"; target: RepoPathRef }
    | { type: "shelveSave"; name?: string; targets?: RepoPathRef[] }
    | { type: "shelfPop"; index: number }
    | { type: "shelfApply"; index: number }
    | { type: "shelfDelete"; index: number }
    | { type: "shelfSelect"; index: number }
    | { type: "showShelfDiff"; index: number; path: string }
    | { type: "openFile"; target: RepoPathRef }
    | { type: "deleteFile"; target: RepoPathRef }
    | { type: "showHistory"; target: RepoPathRef }
    | { type: "setCurrentRepository"; repoRoot: string };

/** Messages sent FROM the extension host TO the webview. */
export type InboundMessage =
    | {
          type: "update";
          repositories: RepositoryContextInfo[];
          files: WorkingFile[];
          stashes: StashEntry[];
          shelfFiles: WorkingFile[];
          selectedShelfIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "lastCommitMessage"; message: string }
    | { type: "committed" }
    | { type: "setRepositoryContext"; repository: RepositoryContextInfo | null }
    | { type: "refreshing"; active: boolean }
    | { type: "error"; message: string };

/** Reducer state for the commit panel app. */
export interface CommitPanelState {
    repositories: RepositoryContextInfo[];
    files: WorkingFile[];
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedShelfIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    repository: RepositoryContextInfo | null;
    commitMessage: string;
    isAmend: boolean;
    isRefreshing: boolean;
    error: string | null;
}

/** Actions dispatched by the message handler and UI events. */
export type CommitPanelAction =
    | {
          type: "SET_FILES_AND_STASHES";
          repositories: RepositoryContextInfo[];
          files: WorkingFile[];
          stashes: StashEntry[];
          shelfFiles: WorkingFile[];
          selectedShelfIndex: number | null;
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "SET_LAST_COMMIT_MESSAGE"; message: string }
    | { type: "COMMITTED" }
    | { type: "SET_REPOSITORY_CONTEXT"; repository: RepositoryContextInfo | null }
    | { type: "SET_REFRESHING"; active: boolean }
    | { type: "SET_ERROR"; message: string }
    | { type: "SET_COMMIT_MESSAGE"; message: string }
    | { type: "SET_AMEND"; isAmend: boolean };

/** A node in the directory tree used for grouped file display. */
export interface TreeNode extends Omit<GenericTreeFolder<WorkingFile>, "children"> {
    children: TreeEntry[];
    descendantFiles: WorkingFile[];
}

/** A leaf file node in the directory tree. */
export type TreeFile = GenericTreeLeaf<WorkingFile>;

export type TreeEntry = TreeNode | TreeFile;
