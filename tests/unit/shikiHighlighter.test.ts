import { describe, expect, it } from "vitest";
import {
    highlightLine,
    initShiki,
    isShikiReady,
    langForPath,
} from "../../src/webviews/react/merge-editor/shikiHighlighter";

describe("merge editor Shiki highlighter", () => {
    it("maps supported file extensions and tokenizes code", () => {
        expect(langForPath("src/config.ts")).toBe("typescript");
        expect(langForPath("cmd/server.go")).toBe("go");
        expect(langForPath("README.unknown")).toBeNull();

        initShiki();
        expect(isShikiReady()).toBe(true);
        const source = 'const mode = "feature";';
        const tokens = highlightLine(source, "typescript", "dark-plus");
        expect(tokens?.map((token) => token.text).join("")).toBe(source);
        expect(tokens?.some((token) => token.color)).toBe(true);
    });
});
