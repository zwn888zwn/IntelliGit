// Parses three file versions (base, ours, theirs) into aligned segments
// for display in a 3-way merge editor. Uses a simple line-based diff to
// identify common regions and conflict hunks.

export interface CommonSegment {
    type: "common";
    lines: string[];
}

export type ConflictChangeKind = "conflict" | "ours-only" | "theirs-only";

export interface ConflictSegment {
    type: "conflict";
    id: number;
    changeKind: ConflictChangeKind;
    oursLines: string[];
    theirsLines: string[];
    baseLines: string[];
}

export type MergeSegment = CommonSegment | ConflictSegment;

export interface MergeEditorData {
    filePath: string;
    segments: MergeSegment[];
    oursLabel: string;
    theirsLabel: string;
}

/**
 * Parse three file versions into merge segments by comparing each side
 * against the base version. Regions where both sides match the base (or
 * each other) are "common"; regions where either side diverges are
 * "conflict".
 */
export function parseConflictVersions(base: string, ours: string, theirs: string): MergeSegment[] {
    const baseLines = splitLines(base);
    const oursLines = splitLines(ours);
    const theirsLines = splitLines(theirs);

    const oursEdits = diffLines(baseLines, oursLines);
    const theirsEdits = diffLines(baseLines, theirsLines);

    return buildSegments(baseLines, oursLines, theirsLines, oursEdits, theirsEdits);
}

function splitLines(text: string): string[] {
    if (text === "") return [];
    return text.split("\n");
}

// --- Simple LCS-based diff ---

interface EditRange {
    baseStart: number;
    baseEnd: number;
    modStart: number;
    modEnd: number;
}

function diffLines(base: string[], modified: string[]): EditRange[] {
    const lcs = computeLCS(base, modified);
    const edits: EditRange[] = [];
    let bi = 0;
    let mi = 0;

    for (const [lb, lm] of lcs) {
        if (bi < lb || mi < lm) {
            edits.push({ baseStart: bi, baseEnd: lb, modStart: mi, modEnd: lm });
        }
        bi = lb + 1;
        mi = lm + 1;
    }

    if (bi < base.length || mi < modified.length) {
        edits.push({ baseStart: bi, baseEnd: base.length, modStart: mi, modEnd: modified.length });
    }

    return edits;
}

function computeLCS(a: string[], b: string[]): Array<[number, number]> {
    const m = a.length;
    const n = b.length;

    // For very large files, fall back to a simpler approach
    if (m * n > 10_000_000) {
        return greedyLCS(a, b);
    }

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const result: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (a[i] === b[j]) {
            result.push([i, j]);
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return result;
}

function greedyLCS(a: string[], b: string[]): Array<[number, number]> {
    const bIndex = new Map<string, number[]>();
    for (let j = 0; j < b.length; j++) {
        const list = bIndex.get(b[j]);
        if (list) list.push(j);
        else bIndex.set(b[j], [j]);
    }

    const result: Array<[number, number]> = [];
    let lastJ = -1;
    for (let i = 0; i < a.length; i++) {
        const candidates = bIndex.get(a[i]);
        if (!candidates) continue;
        const idx = binarySearchFirstGT(candidates, lastJ);
        if (idx < candidates.length) {
            lastJ = candidates[idx];
            result.push([i, lastJ]);
        }
    }
    return result;
}

function binarySearchFirstGT(arr: number[], target: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// --- Segment builder ---

function buildSegments(
    baseLines: string[],
    oursLines: string[],
    theirsLines: string[],
    oursEdits: EditRange[],
    theirsEdits: EditRange[],
): MergeSegment[] {
    // Build a per-base-line edit map for each side
    const baseLen = baseLines.length;
    const oursMap = buildBaseEditMap(baseLen, oursEdits);
    const theirsMap = buildBaseEditMap(baseLen, theirsEdits);

    const segments: MergeSegment[] = [];
    let conflictId = 0;
    let bi = 0;

    while (bi <= baseLen) {
        const cursor = bi;
        const oursEdit = oursMap.get(bi);
        const theirsEdit = theirsMap.get(bi);

        if (!oursEdit && !theirsEdit) {
            // Both sides match base at this line
            if (bi < baseLen) {
                const commonStart = bi;
                while (bi < baseLen && !oursMap.has(bi) && !theirsMap.has(bi)) {
                    bi++;
                }
                segments.push({ type: "common", lines: baseLines.slice(commonStart, bi) });
            } else {
                bi++;
            }
            continue;
        }

        // At least one side has an edit starting here
        const oe = oursEdit ?? { baseStart: bi, baseEnd: bi, modStart: 0, modEnd: 0 };
        const te = theirsEdit ?? { baseStart: bi, baseEnd: bi, modStart: 0, modEnd: 0 };

        const endBase = Math.max(oe.baseEnd, te.baseEnd);

        const oLines = oursEdit
            ? oursLines.slice(oe.modStart, oe.modEnd)
            : baseLines.slice(bi, endBase);
        const tLines = theirsEdit
            ? theirsLines.slice(te.modStart, te.modEnd)
            : baseLines.slice(bi, endBase);

        // If both sides made the same change, it's not a conflict
        if (arraysEqual(oLines, tLines)) {
            if (oLines.length > 0) {
                segments.push({ type: "common", lines: oLines });
            }
        } else {
            const changeKind: ConflictChangeKind =
                oursEdit && theirsEdit ? "conflict" : oursEdit ? "ours-only" : "theirs-only";
            segments.push({
                type: "conflict",
                id: conflictId++,
                changeKind,
                oursLines: oLines,
                theirsLines: tLines,
                baseLines: baseLines.slice(bi, endBase),
            });
        }

        if (endBase === cursor) {
            // Pure insertion hunks do not consume base lines. Mark this position as
            // processed so the loop can continue with the same base cursor.
            oursMap.delete(cursor);
            theirsMap.delete(cursor);
        } else {
            bi = endBase;
        }
    }

    return mergeAdjacentCommon(segments);
}

function buildBaseEditMap(baseLen: number, edits: EditRange[]): Map<number, EditRange> {
    const map = new Map<number, EditRange>();
    for (const edit of edits) {
        // Map the edit to the base line where it starts.
        // Insertions (baseStart === baseEnd) are mapped to the insertion point.
        map.set(edit.baseStart, edit);
    }
    return map;
}

function arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function mergeAdjacentCommon(segments: MergeSegment[]): MergeSegment[] {
    const result: MergeSegment[] = [];
    for (const seg of segments) {
        if (
            seg.type === "common" &&
            result.length > 0 &&
            result[result.length - 1].type === "common"
        ) {
            (result[result.length - 1] as CommonSegment).lines.push(...seg.lines);
        } else {
            result.push(seg);
        }
    }
    return result;
}
