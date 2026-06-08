// State management and resolution helpers for the merge editor.
// Contains the reducer, conflict resolution logic, and result builder.

import type { MergeEditorData, MergeSegment, ConflictSegment, HunkResolution } from "./types";

export interface State {
    data: MergeEditorData | null;
    error: string | null;
    resolutions: Record<number, HunkResolution>;
    resultEdits: Record<string, string[]>;
}

export type Action =
    | { type: "SET_DATA"; data: MergeEditorData }
    | { type: "SET_ERROR"; message: string }
    | { type: "RESOLVE_HUNK"; id: number; resolution: HunkResolution }
    | { type: "EDIT_RESULT"; key: string; lines: string[]; conflictId?: number };

export function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "SET_DATA":
            return {
                ...state,
                data: action.data,
                error: null,
                resolutions: {},
                resultEdits: {},
            };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "RESOLVE_HUNK": {
            const resultEdits = { ...state.resultEdits };
            delete resultEdits[getConflictResultKey(action.id)];
            return {
                ...state,
                resolutions: { ...state.resolutions, [action.id]: action.resolution },
                resultEdits,
            };
        }
        case "EDIT_RESULT": {
            const resolutions =
                action.conflictId === undefined
                    ? state.resolutions
                    : { ...state.resolutions, [action.conflictId]: "custom" as HunkResolution };
            return {
                ...state,
                resolutions,
                resultEdits: { ...state.resultEdits, [action.key]: action.lines },
            };
        }
        default:
            return state;
    }
}

export function getConflictResultKey(id: number): string {
    return `conflict:${id}`;
}

export function getCommonResultKey(index: number): string {
    return `common:${index}`;
}

export function getSegmentResultKey(segment: MergeSegment, index: number): string {
    return segment.type === "conflict"
        ? getConflictResultKey(segment.id)
        : getCommonResultKey(index);
}

export function getResultLines(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
    customLines?: string[],
): string[] {
    switch (resolution) {
        case "ours":
            return segment.oursLines;
        case "theirs":
            return segment.theirsLines;
        case "both":
            return [...segment.oursLines, ...segment.theirsLines];
        case "none":
            return [];
        case "custom":
            return customLines ?? segment.baseLines;
        default:
            // Non-conflicting changes auto-resolve to the changed side
            if (segment.changeKind === "ours-only") return segment.oursLines;
            if (segment.changeKind === "theirs-only") return segment.theirsLines;
            return segment.baseLines;
    }
}

export function buildResultContent(
    data: MergeEditorData,
    resolutions: Record<number, HunkResolution>,
    resultEdits: Record<string, string[]> = {},
): string {
    const { segments } = data;
    const lines: string[] = [];
    segments.forEach((seg, index) => {
        const editedLines = resultEdits[getSegmentResultKey(seg, index)];
        if (seg.type === "common") {
            lines.push(...(editedLines ?? seg.lines));
        } else {
            lines.push(...getResultLines(seg, resolutions[seg.id], editedLines));
        }
    });
    if (lines.length === 0) return "";
    const eol = data.eol ?? "\n";
    const joined = lines.join(eol);
    return data.hasTrailingNewline ? joined + eol : joined;
}

export function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): boolean {
    return segments.every(
        (seg) =>
            seg.type === "common" ||
            seg.changeKind !== "conflict" ||
            resolutions[seg.id] !== undefined,
    );
}

export function trueConflictCount(segments: MergeSegment[]): number {
    return segments.filter((seg) => seg.type === "conflict" && seg.changeKind === "conflict")
        .length;
}

export function resolvedTrueConflictCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): number {
    return segments.filter(
        (seg) =>
            seg.type === "conflict" &&
            seg.changeKind === "conflict" &&
            resolutions[seg.id] !== undefined,
    ).length;
}

export function paneChangeCount(segments: MergeSegment[], side: "ours" | "theirs"): number {
    return segments.filter((seg) => {
        if (seg.type !== "conflict") return false;
        if (side === "ours") return seg.changeKind !== "theirs-only";
        return seg.changeKind !== "ours-only";
    }).length;
}
