import { beforeEach, describe, expect, it, vi } from "vitest";

type ActiveEditorListener = (editor: MockTextEditor | undefined) => void;
type SelectionListener = (event: {
    textEditor: MockTextEditor;
    selections: Array<{ active: { line: number; character: number } }>;
    kind?: number;
}) => void;
type ThemeListener = () => void;

type MockTextEditor = {
    document: {
        uri: {
            scheme: string;
            fsPath: string;
            toString: () => string;
        };
    };
    setDecorations: ReturnType<typeof vi.fn>;
};

const executeCommand = vi.fn(async () => undefined);
const showWarningMessage = vi.fn(async () => undefined);
const showErrorMessage = vi.fn(async () => undefined);
const createTextEditorDecorationType = vi.fn(() => ({ dispose: vi.fn() }));

let activeEditor: MockTextEditor | undefined;
const activeEditorListeners: ActiveEditorListener[] = [];
const selectionListeners: SelectionListener[] = [];
const themeListeners: ThemeListener[] = [];
let activeThemeKind = 2;

vi.mock("vscode", () => ({
    Range: class {
        constructor(
            public startLine: number,
            public startCharacter: number,
            public endLine: number,
            public endCharacter: number,
        ) {}
    },
    ThemeColor: class {
        constructor(public readonly id: string) {}
    },
    MarkdownString: class {
        value = "";
        constructor(_value?: string, _supportThemeIcons?: boolean) {}
        appendMarkdown(markdown: string) {
            this.value += markdown;
            return this;
        }
    },
    ColorThemeKind: {
        Light: 1,
        Dark: 2,
        HighContrast: 3,
        HighContrastLight: 4,
    },
    TextEditorSelectionChangeKind: {
        Mouse: 1,
        Keyboard: 2,
    },
    window: {
        get activeTextEditor() {
            return activeEditor;
        },
        get activeColorTheme() {
            return { kind: activeThemeKind };
        },
        createTextEditorDecorationType,
        showWarningMessage,
        showErrorMessage,
        onDidChangeActiveTextEditor: vi.fn((listener: ActiveEditorListener) => {
            activeEditorListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidChangeTextEditorSelection: vi.fn((listener: SelectionListener) => {
            selectionListeners.push(listener);
            return { dispose: vi.fn() };
        }),
        onDidChangeActiveColorTheme: vi.fn((listener: ThemeListener) => {
            themeListeners.push(listener);
            return { dispose: vi.fn() };
        }),
    },
    commands: {
        executeCommand,
    },
}));

function makeEditor(fsPath: string, scheme: string = "file"): MockTextEditor {
    return {
        document: {
            uri: {
                scheme,
                fsPath,
                toString: () => `${scheme}:${fsPath}`,
            },
        },
        setDecorations: vi.fn(),
    };
}

async function emitActiveEditorChanged(editor: MockTextEditor | undefined): Promise<void> {
    activeEditor = editor;
    for (const listener of activeEditorListeners) {
        await listener(editor);
    }
}

async function emitSelectionChanged(
    editor: MockTextEditor,
    line: number,
    character: number,
    kind: number,
): Promise<void> {
    for (const listener of selectionListeners) {
        await listener({
            textEditor: editor,
            selections: [{ active: { line, character } }],
            kind,
        });
    }
}

async function emitThemeChanged(kind: number): Promise<void> {
    activeThemeKind = kind;
    for (const listener of themeListeners) {
        await listener();
    }
}

describe("EditorBlameController", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activeEditor = undefined;
        activeThemeKind = 2;
        activeEditorListeners.length = 0;
        selectionListeners.length = 0;
        themeListeners.length = 0;
    });

    it("annotates the active repo file and keeps same-commit colors stable", async () => {
        const { EditorBlameController } = await import("../../src/services/EditorBlameController");
        const gitOps = {
            getBlame: vi.fn(async () => [
                {
                    line: 0,
                    commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    shortHash: "aaaaaaaa",
                    author: "Alice",
                    date: "2026/3/18",
                    summary: "First summary",
                    isUncommitted: false,
                },
                {
                    line: 1,
                    commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    shortHash: "aaaaaaaa",
                    author: "Alice",
                    date: "2026/3/18",
                    summary: "First summary",
                    isUncommitted: false,
                },
                {
                    line: 2,
                    commitHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    shortHash: "bbbbbbbb",
                    author: "Bob",
                    date: "2026/3/23",
                    summary: "Second summary",
                    isUncommitted: false,
                },
            ]),
        };
        const revealCommit = vi.fn(async () => undefined);
        const controller = new EditorBlameController(
            "/repo",
            gitOps as never,
            revealCommit,
        );
        const editor = makeEditor("/repo/src/a.ts");
        activeEditor = editor;

        await controller.annotateActiveEditor();

        expect(gitOps.getBlame).toHaveBeenCalledWith("src/a.ts");
        expect(editor.setDecorations).toHaveBeenCalledTimes(1);
        const decorations = editor.setDecorations.mock.calls[0]?.[1] as Array<{
            renderOptions?: { before?: { backgroundColor?: string } };
        }>;
        expect(decorations).toHaveLength(3);
        expect(decorations[0]?.renderOptions?.before?.backgroundColor).toBe(
            decorations[1]?.renderOptions?.before?.backgroundColor,
        );
        expect(decorations[0]?.renderOptions?.before?.backgroundColor).not.toBe(
            decorations[2]?.renderOptions?.before?.backgroundColor,
        );
        expect(String((decorations[0] as { hoverMessage?: { value?: string } }).hoverMessage?.value)).toContain(
            "First summary",
        );
        expect((decorations[0]?.renderOptions?.before as { color?: { id?: string } } | undefined)?.color?.id).toBe(
            "editor.foreground",
        );
    });

    it("recomputes blame colors when the active theme changes", async () => {
        const vscode = await import("vscode");
        const { EditorBlameController } = await import("../../src/services/EditorBlameController");
        const gitOps = {
            getBlame: vi.fn(async () => [
                {
                    line: 0,
                    commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    shortHash: "aaaaaaaa",
                    author: "Alice",
                    date: "2026/3/18",
                    summary: "First summary",
                    isUncommitted: false,
                },
            ]),
        };
        const controller = new EditorBlameController("/repo", gitOps as never, vi.fn(async () => undefined));
        const editor = makeEditor("/repo/src/a.ts");
        activeEditor = editor;

        await controller.annotateActiveEditor();
        const firstDecorations = editor.setDecorations.mock.calls[0]?.[1] as Array<{
            renderOptions?: { before?: { backgroundColor?: string } };
        }>;

        await emitThemeChanged(vscode.ColorThemeKind.Light);

        expect(editor.setDecorations).toHaveBeenCalledTimes(2);
        const secondDecorations = editor.setDecorations.mock.calls[1]?.[1] as Array<{
            renderOptions?: { before?: { backgroundColor?: string } };
        }>;
        expect(firstDecorations[0]?.renderOptions?.before?.backgroundColor).not.toBe(
            secondDecorations[0]?.renderOptions?.before?.backgroundColor,
        );
    });

    it("reapplies blame when switching back to the same file", async () => {
        const { EditorBlameController } = await import("../../src/services/EditorBlameController");
        const gitOps = {
            getBlame: vi.fn(async () => [
                {
                    line: 0,
                    commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    shortHash: "aaaaaaaa",
                    author: "Alice",
                    date: "2026/3/18",
                    summary: "First summary",
                    isUncommitted: false,
                },
            ]),
        };
        const controller = new EditorBlameController("/repo", gitOps as never, vi.fn(async () => undefined));
        const firstEditor = makeEditor("/repo/src/a.ts");
        const secondEditor = makeEditor("/repo/src/a.ts");
        activeEditor = firstEditor;

        await controller.annotateActiveEditor();
        await emitActiveEditorChanged(undefined);
        await emitActiveEditorChanged(secondEditor);

        expect(secondEditor.setDecorations).toHaveBeenCalledTimes(1);
    });

    it("reveals commit only for mouse clicks at column zero on committed lines", async () => {
        const vscode = await import("vscode");
        const { EditorBlameController } = await import("../../src/services/EditorBlameController");
        const revealCommit = vi.fn(async () => undefined);
        const controller = new EditorBlameController(
            "/repo",
            {
                getBlame: vi.fn(async () => [
                    {
                        line: 0,
                        commitHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        shortHash: "aaaaaaaa",
                        author: "Alice",
                        date: "2026/3/18",
                        summary: "First summary",
                        isUncommitted: false,
                    },
                    {
                        line: 1,
                        commitHash: "0000000000000000000000000000000000000000",
                        shortHash: "00000000",
                        author: "Not Committed Yet",
                        date: "2026/3/23",
                        summary: "",
                        isUncommitted: true,
                    },
                ]),
            } as never,
            revealCommit,
        );
        const editor = makeEditor("/repo/src/a.ts");
        activeEditor = editor;

        await controller.annotateActiveEditor();
        await emitSelectionChanged(editor, 0, 1, vscode.TextEditorSelectionChangeKind.Mouse);
        await emitSelectionChanged(editor, 0, 0, vscode.TextEditorSelectionChangeKind.Keyboard);
        await emitSelectionChanged(editor, 1, 0, vscode.TextEditorSelectionChangeKind.Mouse);
        await emitSelectionChanged(editor, 0, 0, vscode.TextEditorSelectionChangeKind.Mouse);

        expect(revealCommit).toHaveBeenCalledTimes(1);
        expect(revealCommit).toHaveBeenCalledWith(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
    });

    it("clears decorations and warns for unsupported files", async () => {
        const { EditorBlameController } = await import("../../src/services/EditorBlameController");
        const controller = new EditorBlameController(
            "/repo",
            { getBlame: vi.fn(async () => []) } as never,
            vi.fn(async () => undefined),
        );
        activeEditor = makeEditor("/other/outside.ts");

        await controller.annotateActiveEditor();
        await controller.clear();

        expect(showWarningMessage).toHaveBeenCalled();
        expect(createTextEditorDecorationType).not.toHaveBeenCalled();
    });
});
