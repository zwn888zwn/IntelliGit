import { EditorState, type Transaction } from "@codemirror/state";
import { history, undo, redo } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
    acceptChoice,
    buildMergeDocument,
    mergeDocumentHistory,
    mergeRanges,
    resolveMergeRanges,
} from "../../src/webviews/react/merge-editor/mergeDocumentState";
import { parseConflictVersions } from "../../src/mergeEditor/conflictParser";
import type { MergeEditorData } from "../../src/webviews/react/merge-editor/types";

function fixture(base: string, ours: string, theirs: string, trailing = true) {
    const data: MergeEditorData = {
        filePath: "file.ts",
        oursLabel: "ours",
        theirsLabel: "theirs",
        hasTrailingNewline: trailing,
        segments: parseConflictVersions(base, ours, theirs),
    };
    const document = buildMergeDocument(data);
    let state = EditorState.create({
        doc: document.result,
        extensions: [mergeRanges.init(() => document.ranges), history(), mergeDocumentHistory],
    });
    return {
        data,
        get state() {
            return state;
        },
        dispatch: (transaction: Transaction) => {
            state = transaction.state;
        },
        edit: (spec: Parameters<EditorState["update"]>[0]) => {
            state = state.update(spec).state;
        },
    };
}

describe("full-document merge editing", () => {
    it("allows edits outside conflicts and maps later side acceptance to its new position", () => {
        const editor = fixture(
            "header\nbase\nfooter\n",
            "header\nours\nfooter\n",
            "header\ntheirs\nfooter\n",
        );
        editor.edit({ changes: { from: 0, insert: "import helper;\n" } });
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "theirs"]]), editor.data));
        expect(editor.state.doc.toString()).toBe("import helper;\nheader\ntheirs\nfooter\n");
    });

    it("undoes and redoes decisions and text as one history, including range locations", () => {
        const editor = fixture("header\nbase\n", "header\nours\n", "header\ntheirs\n");
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "both"]]), editor.data));
        const stacked = editor.state.doc.toString();
        editor.edit({ changes: { from: 0, insert: "prefix\n" } });
        expect(undo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe(stacked);
        expect(undo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe("header\nbase\n");
        expect(editor.state.field(mergeRanges)[0].resolved).toBe(false);
        expect(redo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe(stacked);
        expect(editor.state.field(mergeRanges)[0].resolved).toBe(true);
    });

    it("keeps intentionally repeated lines and permits removing just the duplicate manually", () => {
        const editor = fixture(
            "start\nend\n",
            "start\nlog();\nours();\nend\n",
            "start\nlog();\ntheirs();\nend\n",
        );
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "ours"]]), editor.data));
        expect(acceptChoice(editor.state.field(mergeRanges)[0], "theirs")).toBe("both");
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "both"]]), editor.data));
        const second = editor.state.doc.toString().lastIndexOf("log();\n");
        editor.edit({ changes: { from: second, to: second + "log();\n".length } });
        expect(editor.state.doc.toString()).toBe("start\nlog();\nours();\ntheirs();\nend\n");
        expect(editor.state.field(mergeRanges)[0].edited).toBe(true);
        expect(editor.state.field(mergeRanges)[0].resolved).toBe(false);
        expect(acceptChoice(editor.state.field(mergeRanges)[0], "theirs")).toBe("theirs");
    });

    it("restores decision metadata when undoing a group of adjacent typing edits", () => {
        const editor = fixture("base\n", "ours\n", "theirs\n");
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "ours"]]), editor.data));
        editor.edit({ changes: { from: 1, insert: "X" }, userEvent: "input.type" });
        editor.edit({ changes: { from: 2, insert: "Y" }, userEvent: "input.type" });
        expect(undo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe("ours\n");
        expect(editor.state.field(mergeRanges)[0]).toMatchObject({
            choice: "ours",
            edited: false,
            resolved: true,
        });
        expect(redo(editor)).toBe(true);
        expect(editor.state.doc.toString()).toBe("oXYurs\n");
    });

    it("handles appended conflicts when the original file has no trailing newline", () => {
        const editor = fixture("start", "start\nours", "start\ntheirs", false);
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "ours"]]), editor.data));
        expect(editor.state.doc.toString()).toBe("start\nours");
        editor.edit(resolveMergeRanges(editor.state, new Map([[0, "theirs"]]), editor.data));
        expect(editor.state.doc.toString()).toBe("start\ntheirs");
    });

    it("keeps ranges valid after deleting across multiple conflicts", () => {
        const editor = fixture(
            "a\nbase\nmiddle\nold\nz\n",
            "a\nours\nmiddle\nleft\nz\n",
            "a\ntheirs\nmiddle\nright\nz\n",
        );
        const ranges = editor.state.field(mergeRanges);
        editor.edit({ changes: { from: ranges[0].from, to: ranges[1].to } });
        for (const range of editor.state.field(mergeRanges)) {
            expect(range.from).toBeLessThanOrEqual(range.to);
            expect(range.to).toBeLessThanOrEqual(editor.state.doc.length);
            expect(range.resolved).toBe(false);
        }
        editor.edit(resolveMergeRanges(editor.state, new Map([[1, "theirs"]]), editor.data));
        expect(editor.state.doc.toString()).toContain("right");
    });
});
