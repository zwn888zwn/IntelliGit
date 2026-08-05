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
        completedEdits: {},
        past: [],
        future: [],
    };

    it("SET_DATA replaces data and clears local decisions", () => {
        const data = makeData([]);
        const state = reducer(
            {
                ...initial,
                resolutions: { 0: "ours" as const },
                edits: { 0: ["manual"] },
                dismissals: { 0: { ours: true } },
                completedEdits: { 0: true as const },
            },
            { type: "SET_DATA", data },
        );
        expect(state.data).toBe(data);
        expect(state.error).toBeNull();
        expect(state.resolutions).toEqual({});
        expect(state.edits).toEqual({});
        expect(state.dismissals).toEqual({});
        expect(state.completedEdits).toEqual({});
        expect(state.past).toEqual([]);
        expect(state.future).toEqual([]);
    });

    it("SET_ERROR sets error message", () => {
        expect(reducer(initial, { type: "SET_ERROR", message: "fail" }).error).toBe("fail");
    });

    it("RESOLVE_HUNK preserves a discarded opposite side and clears the accepted side", () => {
        const state = reducer(
            {
                ...initial,
                edits: { 1: ["manual"] },
                dismissals: { 1: { ours: true, theirs: true } },
                completedEdits: { 1: true as const },
            },
            { type: "RESOLVE_HUNK", id: 1, resolution: "ours" },
        );
        expect(state.resolutions[1]).toBe("ours");
        expect(state.edits[1]).toBeUndefined();
        expect(state.dismissals[1]).toEqual({ theirs: true });
        expect(state.completedEdits[1]).toBeUndefined();
    });

    it("settles delete/modify conflicts when the non-empty side is accepted", () => {
        const conflict = makeConflict({ oursLines: [], theirsLines: ["modified"] });
        const state = reducer(
            { ...initial, data: makeData([conflict]) },
            { type: "RESOLVE_HUNK", id: conflict.id, resolution: "theirs" },
        );

        expect(state.dismissals[conflict.id]).toEqual({ ours: true });
        expect(
            allResolved(
                [conflict],
                state.resolutions,
                state.edits,
                state.dismissals,
                state.completedEdits,
            ),
        ).toBe(true);
    });

    it("settles modify/delete conflicts when the non-empty side is accepted", () => {
        const conflict = makeConflict({ oursLines: ["modified"], theirsLines: [] });
        const state = reducer(
            { ...initial, data: makeData([conflict]) },
            { type: "RESOLVE_HUNK", id: conflict.id, resolution: "ours" },
        );

        expect(state.dismissals[conflict.id]).toEqual({ theirs: true });
        expect(
            allResolved(
                [conflict],
                state.resolutions,
                state.edits,
                state.dismissals,
                state.completedEdits,
            ),
        ).toBe(true);
    });

    it("EDIT_HUNK_RESULT stores manual result lines", () => {
        const state = reducer(initial, {
            type: "EDIT_HUNK_RESULT",
            id: 2,
            lines: ["manual"],
        });
        expect(state.edits[2]).toEqual(["manual"]);
    });

    it("RESET_HUNK resets every local decision for the hunk", () => {
        const state = reducer(
            {
                ...initial,
                resolutions: { 2: "both" },
                edits: { 2: ["manual"] },
                dismissals: { 2: { ours: true, theirs: true } },
                completedEdits: { 2: true as const },
            },
            { type: "RESET_HUNK", id: 2 },
        );
        expect(state.resolutions[2]).toBeUndefined();
        expect(state.edits[2]).toBeUndefined();
        expect(state.dismissals[2]).toBeUndefined();
        expect(state.completedEdits[2]).toBeUndefined();
    });

    it("DISMISS_SIDE records only the selected side", () => {
        const state = reducer(initial, { type: "DISMISS_SIDE", id: 2, side: "ours" });
        expect(state.dismissals[2]).toEqual({ ours: true });
    });

    it("marks manual edits resolved explicitly and supports undo/redo", () => {
        const edited = reducer(initial, {
            type: "EDIT_HUNK_RESULT",
            id: 2,
            lines: ["manual"],
        });
        const completed = reducer(edited, { type: "MARK_HUNK_RESOLVED", id: 2 });
        expect(completed.completedEdits[2]).toBe(true);

        const undone = reducer(completed, { type: "UNDO" });
        expect(undone.completedEdits[2]).toBeUndefined();
        expect(undone.edits[2]).toEqual(["manual"]);

        const redone = reducer(undone, { type: "REDO" });
        expect(redone.completedEdits[2]).toBe(true);
    });

    it("applies a bulk side choice as one undo step", () => {
        const resolved = reducer(initial, {
            type: "RESOLVE_HUNKS",
            resolutions: [
                { id: 0, resolution: "ours" },
                { id: 1, resolution: "ours" },
            ],
            settleOpposite: true,
        });
        expect(resolved.dismissals).toEqual({
            0: { theirs: true },
            1: { theirs: true },
        });
        expect(resolved.past).toHaveLength(1);
        expect(reducer(resolved, { type: "UNDO" }).resolutions).toEqual({});
    });

    it("settles a conflict regardless of whether discard or accept happens first", () => {
        const discardThenAccept = reducer(
            reducer(initial, { type: "DISMISS_SIDE", id: 0, side: "ours" }),
            { type: "RESOLVE_HUNK", id: 0, resolution: "theirs" },
        );
        expect(
            allResolved(
                [makeConflict()],
                discardThenAccept.resolutions,
                discardThenAccept.edits,
                discardThenAccept.dismissals,
                discardThenAccept.completedEdits,
            ),
        ).toBe(true);

        const acceptThenDiscard = reducer(
            reducer(initial, { type: "RESOLVE_HUNK", id: 0, resolution: "ours" }),
            { type: "DISMISS_SIDE", id: 0, side: "theirs" },
        );
        expect(
            allResolved(
                [makeConflict()],
                acceptThenDiscard.resolutions,
                acceptThenDiscard.edits,
                acceptThenDiscard.dismissals,
                acceptThenDiscard.completedEdits,
            ),
        ).toBe(true);
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
        expect(allResolved(segments, { 0: "ours" }, {}, { 0: { theirs: true } })).toBe(true);
        expect(allResolved(segments, { 0: "ours" })).toBe(false);
        expect(allResolved(segments, {})).toBe(false);
    });

    it("requires an explicit completion after a manual edit", () => {
        expect(allResolved([makeConflict()], {}, { 0: ["manual"] })).toBe(false);
        expect(allResolved([makeConflict()], {}, { 0: ["manual"] }, {}, { 0: true })).toBe(
            true,
        );
    });

    it("does not count auto-merged hunks as true conflicts", () => {
        const segments: MergeSegment[] = [makeConflict({ autoResolvedLines: ["auto"] })];
        expect(trueConflictCount(segments)).toBe(0);
        expect(allResolved(segments, {})).toBe(true);
    });

    it("counts resolved true conflicts", () => {
        const segments: MergeSegment[] = [makeConflict({ id: 0 }), makeConflict({ id: 1 })];
        expect(resolvedTrueConflictCount(segments, { 0: "ours" })).toBe(0);
        expect(
            resolvedTrueConflictCount(segments, { 0: "ours" }, {}, { 0: { theirs: true } }),
        ).toBe(1);
        expect(resolvedTrueConflictCount(segments, {}, { 1: ["manual"] })).toBe(0);
        expect(
            resolvedTrueConflictCount(segments, {}, { 1: ["manual"] }, {}, { 1: true }),
        ).toBe(1);
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
