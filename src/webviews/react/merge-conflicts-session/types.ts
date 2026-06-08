import type { MergeConflictFile } from "../../../types";

export interface MergeConflictSessionData {
    sourceBranch: string;
    targetBranch: string;
    files: MergeConflictFile[];
    selectedPath?: string | null;
}

export type OutboundMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "openMerge"; filePath: string }
    | { type: "acceptYours"; filePath: string }
    | { type: "acceptTheirs"; filePath: string }
    | { type: "close" };

export type InboundMessage =
    | { type: "setSessionData"; data: MergeConflictSessionData }
    | { type: "loadError"; message: string };
