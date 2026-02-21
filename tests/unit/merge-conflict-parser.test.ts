import { describe, it, expect } from "vitest";
import { parseConflictVersions } from "../../src/mergeEditor/conflictParser";

describe("merge conflict parser", () => {
    it("handles insertion-only changes without hanging", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "a\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({
            type: "conflict",
            changeKind: "ours-only",
            oursLines: ["x"],
            theirsLines: [],
            baseLines: [],
        });
        expect(segments[1]).toEqual({
            type: "common",
            lines: ["a", "b"],
        });
    });

    it("treats identical insertions as common content", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "x\na\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toEqual([
            {
                type: "common",
                lines: ["x", "a", "b"],
            },
        ]);
    });

    it("creates a conflict when both sides insert different lines", () => {
        const base = "a\nb";
        const ours = "x\na\nb";
        const theirs = "y\na\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            oursLines: ["x"],
            theirsLines: ["y"],
            baseLines: [],
        });
        expect(segments[1]).toEqual({
            type: "common",
            lines: ["a", "b"],
        });
    });

    it("classifies theirs-only change as theirs-only", () => {
        const base = "a\nb";
        const ours = "a\nb";
        const theirs = "a\nz\nb";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "theirs-only",
        });
    });

    it("classifies both-sides-different as a true conflict", () => {
        const base = "a\nb\nc";
        const ours = "a\nX\nc";
        const theirs = "a\nY\nc";

        const segments = parseConflictVersions(base, ours, theirs);

        const conflict = segments.find((s) => s.type === "conflict");
        expect(conflict).toBeDefined();
        expect(conflict).toMatchObject({
            type: "conflict",
            changeKind: "conflict",
            oursLines: ["X"],
            theirsLines: ["Y"],
            baseLines: ["b"],
        });
    });
});
