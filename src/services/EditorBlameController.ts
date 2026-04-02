import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { GitBlameLine } from "../types";
import { getRepoRelativeFilePathFromUri } from "./diffService";
import { getErrorMessage } from "../utils/errors";

const BLAME_ACTIVE_CONTEXT = "intelligit.blameActive";
const BLAME_SUPPORTED_CONTEXT = "intelligit.blameSupportedFile";

type BlameStyle = {
    borderColor: string;
    backgroundColor: string;
};

type BlameSession = {
    uri: string;
    filePath: string;
    decorationType: vscode.TextEditorDecorationType;
    decorations: vscode.DecorationOptions[];
    linesByNumber: Map<number, GitBlameLine>;
};

const UNCOMMITTED_STYLE: BlameStyle = {
    borderColor: "rgba(126, 132, 146, 0.9)",
    backgroundColor: "rgba(126, 132, 146, 0.16)",
};

export class EditorBlameController implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private session: BlameSession | null = null;

    constructor(
        private readonly repoRoot: string,
        private readonly gitOps: GitOps,
        private readonly revealCommitInGraph: (hash: string) => Promise<void>,
    ) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                void this.handleActiveEditorChanged(editor);
            }),
            vscode.window.onDidChangeTextEditorSelection((event) => {
                void this.handleSelectionChanged(event);
            }),
        );
    }

    async initialize(): Promise<void> {
        await this.updateContextKeys(vscode.window.activeTextEditor);
    }

    async annotateActiveEditor(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        const filePath = this.getRepoRelativeFilePath(editor);
        if (!editor || !filePath) {
            vscode.window.showWarningMessage(
                "Git blame is only available for files inside the current IntelliGit repository.",
            );
            await this.updateContextKeys(editor);
            return;
        }

        if (this.session?.uri === editor.document.uri.toString()) {
            this.applySessionToEditor(editor);
            await this.updateContextKeys(editor);
            return;
        }

        this.disposeSession();

        try {
            const blameLines = await this.gitOps.getBlame(filePath);
            const decorationType = vscode.window.createTextEditorDecorationType({});
            const decorations = buildBlameDecorations(blameLines);
            this.session = {
                uri: editor.document.uri.toString(),
                filePath,
                decorationType,
                decorations,
                linesByNumber: new Map(blameLines.map((line) => [line.line, line])),
            };
            this.applySessionToEditor(editor);
        } catch (err) {
            vscode.window.showErrorMessage(`Git blame failed: ${getErrorMessage(err)}`);
            this.disposeSession();
        }

        await this.updateContextKeys(editor);
    }

    async clear(): Promise<void> {
        this.disposeSession();
        await this.updateContextKeys(vscode.window.activeTextEditor);
    }

    dispose(): void {
        this.disposeSession();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        void vscode.commands.executeCommand("setContext", BLAME_ACTIVE_CONTEXT, false);
        void vscode.commands.executeCommand("setContext", BLAME_SUPPORTED_CONTEXT, false);
    }

    private async handleActiveEditorChanged(
        editor: vscode.TextEditor | undefined,
    ): Promise<void> {
        if (
            editor &&
            this.session &&
            editor.document.uri.toString() === this.session.uri
        ) {
            this.applySessionToEditor(editor);
        }
        await this.updateContextKeys(editor);
    }

    private async handleSelectionChanged(
        event: vscode.TextEditorSelectionChangeEvent,
    ): Promise<void> {
        if (!this.session) return;
        if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
        if (event.textEditor.document.uri.toString() !== this.session.uri) return;

        const selection = event.selections[0];
        if (!selection || selection.active.character !== 0) return;

        const blameLine = this.session.linesByNumber.get(selection.active.line);
        if (!blameLine || blameLine.isUncommitted) return;

        await this.revealCommitInGraph(blameLine.commitHash);
    }

    private applySessionToEditor(editor: vscode.TextEditor): void {
        if (!this.session) return;
        editor.setDecorations(this.session.decorationType, this.session.decorations);
    }

    private disposeSession(): void {
        if (!this.session) return;
        this.session.decorationType.dispose();
        this.session = null;
    }

    private getRepoRelativeFilePath(editor: vscode.TextEditor | undefined): string | null {
        if (!editor || editor.document.uri.scheme !== "file") return null;
        return getRepoRelativeFilePathFromUri(editor.document.uri, this.repoRoot);
    }

    private async updateContextKeys(editor: vscode.TextEditor | undefined): Promise<void> {
        const supported = !!this.getRepoRelativeFilePath(editor);
        const active = !!editor && !!this.session && editor.document.uri.toString() === this.session.uri;
        await Promise.all([
            vscode.commands.executeCommand("setContext", BLAME_SUPPORTED_CONTEXT, supported),
            vscode.commands.executeCommand("setContext", BLAME_ACTIVE_CONTEXT, active),
        ]);
    }
}

function buildBlameDecorations(lines: GitBlameLine[]): vscode.DecorationOptions[] {
    const labels = lines.map((line) => formatBlameLabel(line));
    const maxLabelLength = labels.reduce((max, label) => Math.max(max, label.length), 0);

    return lines.map((line, index) => {
        const label = labels[index].padEnd(maxLabelLength, " ");
        const style = line.isUncommitted ? UNCOMMITTED_STYLE : resolveCommitStyle(line.commitHash);
        return {
            range: new vscode.Range(line.line, 0, line.line, 0),
            hoverMessage: buildHoverMessage(line),
            renderOptions: {
                before: {
                    contentText: ` ${label} `,
                    color: "rgba(188, 194, 205, 0.94)",
                    backgroundColor: style.backgroundColor,
                    margin: "0 1.2em 0 0",
                    borderRadius: "3px 0 0 3px",
                    borderColor: style.borderColor,
                    borderStyle: "solid",
                    borderWidth: "0 0 0 3px",
                    padding: "0 6px",
                    width: `${maxLabelLength + 2}ch`,
                    fontStyle: "normal",
                    fontWeight: "400",
                    textDecoration: "none; display: inline-block;",
                },
            },
        };
    });
}

function formatBlameLabel(line: GitBlameLine): string {
    const date = line.date.trim();
    const author = line.author.trim();
    if (!date) return author;
    if (!author) return date;
    return `${date} ${author}`;
}

function buildHoverMessage(line: GitBlameLine): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    if (line.isUncommitted) {
        md.appendMarkdown("**Not Committed Yet**");
        return md;
    }
    md.appendMarkdown(`**${line.shortHash}**`);
    if (line.summary) {
        md.appendMarkdown(`  \n${escapeMarkdown(line.summary)}`);
    }
    const meta: string[] = [];
    if (line.author) meta.push(escapeMarkdown(line.author));
    if (line.date) meta.push(escapeMarkdown(line.date));
    if (meta.length > 0) {
        md.appendMarkdown(`  \n${meta.join(" • ")}`);
    }
    md.appendMarkdown(`  \n\`${line.commitHash}\``);
    return md;
}

function escapeMarkdown(value: string): string {
    return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function resolveCommitStyle(commitHash: string): BlameStyle {
    let hash = 0;
    for (let i = 0; i < commitHash.length; i += 1) {
        hash = (hash * 33 + commitHash.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    const saturation = 52 + (hash % 14);
    const lightness = 56 + (hash % 8);
    return {
        borderColor: `hsla(${hue}, ${saturation}%, ${lightness}%, 0.95)`,
        backgroundColor: `hsla(${hue}, ${Math.max(38, saturation - 8)}%, ${Math.min(
            78,
            lightness + 10,
        )}%, 0.14)`,
    };
}
