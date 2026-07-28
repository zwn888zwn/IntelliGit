// Tests for the upstream-style merge editor state model.

import { describe, it, expect } from "vitest";
import {
    reducer,
    getResultLines,
    getEffectiveResultLines,
    splitEditedText,
    buildResultContent,
    allResolved,
    trueConflictCount,
    resolvedTrueConflictCount,
    paneChangeCount,
} from "../../src/webviews/react/merge-editor/mergeState";
import type {
    MergeEditorData,
    ConflictSegment,
    MergeSegment,
} from "../../src/webviews/react/merge-editor/types";

function makeConflict(overrides: Partial<ConflictSegment> = {}): ConflictSegment {
    return {
        type: "conflict",
        id: 0,
        baseLines: ["base"],
        oursLines: ["ours"],
        theirsLines: ["theirs"],
        changeKind: "conflict",
        ...overrides,
    };
}

function makeData(segments: MergeSegment[]): MergeEditorData {
    return {
        filePath: "test.ts",
        oursLabel: "HEAD",
        theirsLabel: "feature",
        segments,
        eol: "\n",
        hasTrailingNewline: true,
    };
}

describe("reducer", () => {
    const initial = {
        data: null,
        error: null,
        resolutions: {},
        edits: {},
        dismissals: {},
    };

    it("SET_DATA replaces data and clears local decisions", () => {
        const data = makeData([]);
        const state = reducer(
            {
                ...initial,
                resolutions: { 0: "ours" as const },
                edits: { 0: ["manual"] },
                dismissals: { 0: { ours: true } },
            },
            { type: "SET_DATA", data },
        );
        expect(state.data).toBe(data);
        expect(state.error).toBeNull();
        expect(state.resolutions).toEqual({});
        expect(state.edits).toEqual({});
        expect(state.dismissals).toEqual({});
    });

    it("SET_ERROR sets error message", () => {
        expect(reducer(initial, { type: "SET_ERROR", message: "fail" }).error).toBe("fail");
    });

    it("RESOLVE_HUNK stores the choice and clears stale edits and dismissals", () => {
        const state = reducer(
            {
                ...initial,
                edits: { 1: ["manual"] },
                dismissals: { 1: { theirs: true } },
            },
            { type: "RESOLVE_HUNK", id: 1, resolution: "ours" },
        );
        expect(state.resolutions[1]).toBe("ours");
        expect(state.edits[1]).toBeUndefined();
        expect(state.dismissals[1]).toBeUndefined();
    });

    it("EDIT_HUNK_RESULT stores manual result lines", () => {
        const state = reducer(initial, {
            type: "EDIT_HUNK_RESULT",
            id: 2,
            lines: ["manual"],
        });
        expect(state.edits[2]).toEqual(["manual"]);
    });

    it("CLEAR_HUNK_EDIT resets the hunk to its unresolved state", () => {
        const state = reducer(
            {
                ...initial,
                resolutions: { 2: "both" },
                edits: { 2: ["manual"] },
                dismissals: { 2: { ours: true, theirs: true } },
            },
            { type: "CLEAR_HUNK_EDIT", id: 2 },
        );
        expect(state.resolutions[2]).toBeUndefined();
        expect(state.edits[2]).toBeUndefined();
        expect(state.dismissals[2]).toBeUndefined();
    });

    it("DISMISS_SIDE records only the selected side", () => {
        const state = reducer(initial, { type: "DISMISS_SIDE", id: 2, side: "ours" });
        expect(state.dismissals[2]).toEqual({ ours: true });
    });
});

describe("getResultLines", () => {
    const segment = makeConflict();

    it("returns ours for an ours resolution", () => {
        expect(getResultLines(segment, "ours")).toEqual(["ours"]);
    });

    it("returns theirs for a theirs resolution", () => {
        expect(getResultLines(segment, "theirs")).toEqual(["theirs"]);
    });

    it("stacks ours then theirs", () => {
        expect(getResultLines(segment, "both")).toEqual(["ours", "theirs"]);
    });

    it("stacks theirs then ours when accepted in reverse order", () => {
        expect(getResultLines(segment, "both-reversed")).toEqual(["theirs", "ours"]);
    });

    it("restores base lines when both sides are dropped", () => {
        expect(getResultLines(segment, "none")).toEqual(["base"]);
    });

    it("returns empty lines when both inserted sides are dropped", () => {
        expect(getResultLines(makeConflict({ baseLines: [] }), "none")).toEqual([]);
    });

    it("returns base lines for an unresolved true conflict", () => {
        expect(getResultLines(segment, undefined)).toEqual(["base"]);
    });

    it("auto-includes ours-only changes", () => {
        expect(getResultLines(makeConflict({ changeKind: "ours-only" }), undefined)).toEqual([
            "ours",
        ]);
    });

    it("auto-includes theirs-only changes", () => {
        expect(getResultLines(makeConflict({ changeKind: "theirs-only" }), undefined)).toEqual([
            "theirs",
        ]);
    });

    it("uses token-level auto-merged lines when supplied", () => {
        expect(
            getResultLines(makeConflict({ autoResolvedLines: ["auto"] }), undefined),
        ).toEqual(["auto"]);
    });
});

describe("manual edits", () => {
    it("splits edited text and treats empty text as deletion", () => {
        expect(splitEditedText("one\ntwo")).toEqual(["one", "two"]);
        expect(splitEditedText("")).toEqual([]);
    });

    it("manual lines take priority over a side resolution", () => {
        expect(getEffectiveResultLines(makeConflict(), "ours", ["manual"])).toEqual(["manual"]);
    });
});

describe("buildResultContent", () => {
    it("joins common and resolved conflict lines", () => {
        const data = makeData([
            { type: "common", lines: ["line1"] },
            makeConflict({ id: 0 }),
            { type: "common", lines: ["line3"] },
        ]);
        expect(buildResultContent(data, { 0: "ours" })).toBe("line1\nours\nline3\n");
    });

    it("includes manual conflict edits", () => {
        const data = makeData([
            { type: "common", lines: ["line1"] },
            makeConflict({ id: 0 }),
        ]);
        expect(buildResultContent(data, {}, { 0: ["manual", "result"] })).toBe(
            "line1\nmanual\nresult\n",
        );
    });

    it("preserves the source trailing-newline contract", () => {
        const data = makeData([{ type: "common", lines: ["only"] }]);
        data.hasTrailingNewline = false;
        expect(buildResultContent(data, {})).toBe("only");
    });
});

describe("resolution status", () => {
    it("requires only true conflicts to be resolved", () => {
        const segments: MergeSegment[] = [
            makeConflict({ id: 0 }),
            makeConflict({ id: 1, changeKind: "ours-only" }),
        ];
        expect(allResolved(segments, { 0: "ours" })).toBe(true);
        expect(allResolved(segments, {})).toBe(false);
    });

    it("treats a manual edit as a resolution", () => {
        expect(allResolved([makeConflict()], {}, { 0: ["manual"] })).toBe(true);
    });

    it("does not count auto-merged hunks as true conflicts", () => {
        const segments: MergeSegment[] = [makeConflict({ autoResolvedLines: ["auto"] })];
        expect(trueConflictCount(segments)).toBe(0);
        expect(allResolved(segments, {})).toBe(true);
    });

    it("counts resolved true conflicts", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 }), makeConflict({ id: 1 })];
        expect(resolvedTrueConflictCount(segments, { 0: "ours" })).toBe(1);
        expect(resolvedTrueConflictCount(segments, {}, { 1: ["manual"] })).toBe(1);
    });
});

describe("paneChangeCount", () => {
    const segments: MergeSegment[] = [
        makeConflict({ id: 0, changeKind: "conflict" }),
        makeConflict({ id: 1, changeKind: "ours-only" }),
        makeConflict({ id: 2, changeKind: "theirs-only" }),
    ];

    it("excludes theirs-only hunks from the ours count", () => {
        expect(paneChangeCount(segments, "ours")).toBe(2);
    });

    it("excludes ours-only hunks from the theirs count", () => {
        expect(paneChangeCount(segments, "theirs")).toBe(2);
    });
});
