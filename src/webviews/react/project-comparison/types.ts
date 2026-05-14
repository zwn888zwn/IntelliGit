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
    | { type: "openDiff"; path: string };

export type ProjectComparisonInbound =
    | {
          type: "update";
          branchName: string;
          repository: RepositoryContextInfo;
          files: ProjectComparisonFile[];
          folderIcon?: ThemeTreeIcon;
          folderExpandedIcon?: ThemeTreeIcon;
          folderIconsByName?: ThemeFolderIconMap;
          iconFonts?: ThemeIconFont[];
      }
    | { type: "refreshing"; active: boolean }
    | { type: "error"; message: string };

export interface ProjectComparisonState {
    branchName: string;
    repository: RepositoryContextInfo | null;
    files: ProjectComparisonFile[];
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    iconFonts: ThemeIconFont[];
    isRefreshing: boolean;
    error: string | null;
}
