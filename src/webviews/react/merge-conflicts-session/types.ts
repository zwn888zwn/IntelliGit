import type { MergeConflictFile } from "../../../types";

export interface MergeConflictSessionFile extends MergeConflictFile {
    resolved: boolean;
    resolvedConflictCount?: number;
    totalConflictCount?: number;
}

export interface MergeConflictSessionData {
    sourceBranch: string;
    targetBranch: string;
    files: MergeConflictSessionFile[];
    selectedPath?: string | null;
    simpleConflictsResolved: boolean;
}

export type OutboundMessage =
    | { type: "ready" }
    | { type: "refresh" }
    | { type: "openMerge"; filePath: string }
    | { type: "acceptYours"; filePath: string }
    | { type: "acceptTheirs"; filePath: string }
    | { type: "resolveAllSimple" }
    | { type: "acceptAndFinish" }
    | { type: "close" };

export type InboundMessage =
    | { type: "setSessionData"; data: MergeConflictSessionData }
    | { type: "loadError"; message: string };
