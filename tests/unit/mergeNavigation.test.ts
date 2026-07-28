import { describe, expect, it } from "vitest";
import { findUniqueSourceLine } from "../../src/mergeEditor/navigation";

function documentWithLines(lines: string[]) {
    return {
        lineCount: lines.length,
        lineAt: (line: number) => ({ text: lines[line] }),
    };
}

describe("merge definition navigation", () => {
    it("uses the displayed position when the full line still matches", () => {
        const document = documentWithLines(["same", "target", "target"]);
        expect(findUniqueSourceLine(document, 2, "target")).toBe(1);
    });

    it("maps a marker-shifted line only when its full text is unique", () => {
        const document = documentWithLines(["<<<<<<< HEAD", "const target = helper();", "======="]);
        expect(findUniqueSourceLine(document, 1, "const target = helper();")).toBe(1);
    });

    it("refuses ambiguous or missing mappings", () => {
        const document = documentWithLines(["duplicate", "marker", "duplicate"]);
        expect(findUniqueSourceLine(document, 2, "duplicate")).toBeUndefined();
        expect(findUniqueSourceLine(document, 2, "missing")).toBeUndefined();
    });
});
