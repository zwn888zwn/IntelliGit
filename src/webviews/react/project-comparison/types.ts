import type {
    ProjectComparisonFile,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../../types";

export type ProjectComparisonOutbound =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "openDiff"; path: string }
    | { type: "openAllDiffs" }
    | { type: "viewState"; state: ProjectComparisonViewState };

export interface ProjectComparisonViewState {
    filterText: string;
    activePath: string | null;
    expandedDirs: string[];
    seenDirs: string[];
    scrollTop: number;
}

export type ProjectComparisonInbound =
    | {
          type: "update";
          branchName: string;
          targetLabel: string;
          repository: RepositoryContextInfo;
          files: ProjectComparisonFile[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
          viewState?: ProjectComparisonViewState | null;
      }
    | { type: "refreshing"; active: boolean }
    | { type: "setActiveFile"; path: string | null }
    | { type: "error"; message: string };

export interface ProjectComparisonState {
    branchName: string;
    targetLabel: string;
    repository: RepositoryContextInfo | null;
    files: ProjectComparisonFile[];
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    isRefreshing: boolean;
    error: string | null;
}
