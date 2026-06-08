// Typed message protocol for the 3-way merge editor webview.

import type { MergeEditorData, MergeSegment } from "../../../mergeEditor/conflictParser";

export type { MergeEditorData, MergeSegment };
export type {
    CommonSegment,
    ConflictSegment,
    ConflictChangeKind,
} from "../../../mergeEditor/conflictParser";

export type OutboundMessage =
    | { type: "ready" }
    | { type: "setIgnoreMode"; mode: "none" | "whitespace" }
    | { type: "applyResolution"; content: string; mode?: "apply" | "applyNext" }
    | { type: "acceptYours" }
    | { type: "acceptTheirs" }
    | { type: "close" };

export type InboundMessage =
    | { type: "setConflictData"; data: MergeEditorData }
    | { type: "loadError"; message: string };

/** Resolution choice for a single conflict hunk. */
export type HunkResolution = "ours" | "theirs" | "both" | "none" | "custom";

export interface MergeEditorState {
    data: MergeEditorData | null;
    resolutions: Record<number, HunkResolution>;
    resultEdits: Record<string, string[]>;
}
