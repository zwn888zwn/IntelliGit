import { describe, expect, it } from "vitest";
import {
    getAdjacentHunkIndex,
    hasAdjacentHunk,
    parseChangedNewFileHunks,
} from "../../src/services/diffNavigation";

describe("diff navigation helpers", () => {
    it("parses changed new-file hunk ranges", () => {
        expect(
            parseChangedNewFileHunks("@@ -1 +10,2 @@\n-a\n+b\n+c\n@@ -7 +30 @@\n-x\n+y"),
        ).toEqual([
            { start: 9, end: 10 },
            { start: 29, end: 29 },
        ]);
    });

    it("keeps the first hunk consumed when a newly opened diff starts above it", () => {
        const ranges = [
            { start: 9, end: 9 },
            { start: 29, end: 29 },
        ];

        expect(hasAdjacentHunk(ranges, 0, "previous")).toBe(false);
        expect(hasAdjacentHunk(ranges, 0, "next")).toBe(true);
        expect(hasAdjacentHunk([{ start: 9, end: 9 }], 0, "next")).toBe(false);
    });

    it("keeps both directions available between two hunks", () => {
        const ranges = [
            { start: 9, end: 9 },
            { start: 29, end: 29 },
        ];

        expect(hasAdjacentHunk(ranges, 20, "previous")).toBe(true);
        expect(hasAdjacentHunk(ranges, 20, "next")).toBe(true);
    });

    it("finds adjacent hunk indexes from a logical hunk cursor", () => {
        const ranges = [
            { start: 9, end: 9 },
            { start: 29, end: 29 },
        ];

        expect(getAdjacentHunkIndex(ranges, 0, "next")).toBe(1);
        expect(getAdjacentHunkIndex(ranges, 1, "next")).toBeNull();
        expect(getAdjacentHunkIndex(ranges, 1, "previous")).toBe(0);
    });
});
