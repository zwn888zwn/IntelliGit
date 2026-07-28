// WebviewPanel for the 3-way merge conflict editor. Opens as an editor tab
// and shows ours/theirs/result columns with per-hunk accept/discard controls.

import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import { buildWebviewShellHtml } from "./webviewHtml";
import { getErrorMessage } from "../utils/errors";
import { parseConflictVersions } from "../mergeEditor/conflictParser";
import type { MergeDiffOptions, MergeEditorData } from "../mergeEditor/conflictParser";
import { findUniqueSourceLine } from "../mergeEditor/navigation";

export class MergeEditorPanel {
    private static panels = new Map<string, MergeEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private disposed = false;
    private diffOptions: MergeDiffOptions = { ignoreWhitespace: false };
    private currentLoadId = 0;
    private workingFileSnapshot: Uint8Array | undefined;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly gitOps: GitOps,
        private readonly workspaceRoot: vscode.Uri,
        private readonly filePath: string,
        private readonly oursSourceLabel: string,
        private readonly theirsSourceLabel: string,
        private readonly onResolved: () => Promise<void> | void,
    ) {
        this.panel = panel;

        panel.webview.html = this.getHtml(panel.webview);

        panel.webview.onDidReceiveMessage(async (msg) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(message);
            }
        });

        panel.onDidDispose(() => {
            this.disposed = true;
            MergeEditorPanel.panels.delete(this.getPanelKey());
        });
    }

    static open(
        extensionUri: vscode.Uri,
        gitOps: GitOps,
        workspaceRoot: vscode.Uri,
        filePath: string,
        labels: { oursSourceLabel?: string; theirsSourceLabel?: string } | undefined,
        onResolved: () => Promise<void> | void,
    ): void {
        const panelKey = MergeEditorPanel.getPanelKey(workspaceRoot, filePath);
        const existing = MergeEditorPanel.panels.get(panelKey);
        if (existing && !existing.disposed) {
            existing.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "intelligit.mergeEditor",
            `Merge: ${filePath}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );

        const instance = new MergeEditorPanel(
            panel,
            extensionUri,
            gitOps,
            workspaceRoot,
            filePath,
            labels?.oursSourceLabel?.trim() || "current branch",
            labels?.theirsSourceLabel?.trim() || "incoming branch",
            onResolved,
        );
        MergeEditorPanel.panels.set(panelKey, instance);
    }

    private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
        switch (msg.type) {
            case "ready":
                await this.loadConflictData();
                break;

            case "setIgnoreMode": {
                const mode = msg.mode === "whitespace" ? "whitespace" : "none";
                this.diffOptions = { ignoreWhitespace: mode === "whitespace" };
                await this.loadConflictData();
                break;
            }

            case "confirm": {
                if (
                    typeof msg.requestId !== "number" ||
                    typeof msg.message !== "string" ||
                    typeof msg.confirmLabel !== "string"
                ) {
                    return;
                }
                const selection = await vscode.window.showWarningMessage(
                    msg.message,
                    { modal: true },
                    msg.confirmLabel,
                );
                await this.panel.webview.postMessage({
                    type: "confirmResult",
                    requestId: msg.requestId,
                    confirmed: selection === msg.confirmLabel,
                });
                break;
            }

            case "applyResolution": {
                if (typeof msg.content !== "string") {
                    vscode.window.showErrorMessage(
                        `Invalid merge resolution content for ${this.filePath}.`,
                    );
                    return;
                }
                if (!(await this.ensureWorkingFileUnchanged())) return;
                const content = msg.content;
                const fileUri = vscode.Uri.joinPath(this.workspaceRoot, this.filePath);
                await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, "utf8"));
                await this.gitOps.stageFile(this.filePath);
                vscode.window.showInformationMessage(`Resolved: ${this.filePath}`);
                try {
                    await this.onResolved();
                } finally {
                    this.panel.dispose();
                }
                break;
            }

            case "acceptYours": {
                if (!(await this.ensureWorkingFileUnchanged())) return;
                await this.gitOps.acceptConflictSide(this.filePath, "ours");
                vscode.window.showInformationMessage(`Accepted yours: ${this.filePath}`);
                try {
                    await this.onResolved();
                } finally {
                    this.panel.dispose();
                }
                break;
            }

            case "acceptTheirs": {
                if (!(await this.ensureWorkingFileUnchanged())) return;
                await this.gitOps.acceptConflictSide(this.filePath, "theirs");
                vscode.window.showInformationMessage(`Accepted theirs: ${this.filePath}`);
                try {
                    await this.onResolved();
                } finally {
                    this.panel.dispose();
                }
                break;
            }

            case "goToDefinition": {
                if (
                    (msg.pane !== "left" &&
                        msg.pane !== "middle" &&
                        msg.pane !== "right") ||
                    typeof msg.lineNumber !== "number" ||
                    !Number.isInteger(msg.lineNumber) ||
                    msg.lineNumber < 1 ||
                    typeof msg.character !== "number" ||
                    !Number.isInteger(msg.character) ||
                    msg.character < 0 ||
                    typeof msg.lineText !== "string" ||
                    msg.lineText.length > 100_000
                ) {
                    return;
                }
                await this.goToDefinition(msg.lineNumber, msg.character, msg.lineText);
                break;
            }

            case "close":
                this.panel.dispose();
                break;
        }
    }

    private async loadConflictData(): Promise<void> {
        const loadId = ++this.currentLoadId;
        try {
            const versions = await this.gitOps.getConflictFileVersions(this.filePath);
            if (this.disposed || loadId !== this.currentLoadId) return;
            const workingFileSnapshot = await this.readWorkingFile().catch(() => undefined);
            const textFormat = workingFileSnapshot
                ? detectTextFormatFromText(Buffer.from(workingFileSnapshot).toString("utf8"))
                : detectTextFormatFromText(versions.ours);
            if (this.disposed || loadId !== this.currentLoadId) return;
            const segments = parseConflictVersions(
                versions.base,
                versions.ours,
                versions.theirs,
                this.diffOptions,
            );

            const data: MergeEditorData = {
                filePath: this.filePath,
                segments,
                oursLabel: this.oursSourceLabel,
                theirsLabel: this.theirsSourceLabel,
                eol: textFormat.eol,
                hasTrailingNewline: textFormat.hasTrailingNewline,
                diffOptions: this.diffOptions,
            };

            if (this.disposed || loadId !== this.currentLoadId) return;
            this.workingFileSnapshot = workingFileSnapshot;
            await this.panel.webview.postMessage({ type: "setConflictData", data });
        } catch (err) {
            if (this.disposed || loadId !== this.currentLoadId) return;
            const message = getErrorMessage(err);
            if (this.disposed || loadId !== this.currentLoadId) return;
            await this.panel.webview.postMessage({ type: "loadError", message });
        }
    }

    private getHtml(webview: vscode.Webview): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview,
            scriptFile: "webview-mergeeditor.js",
            styleFiles: ["webview-mergeeditor.css"],
            title: "Merge Editor",
        });
    }

    private static getPanelKey(workspaceRoot: vscode.Uri, filePath: string): string {
        return `${workspaceRoot.fsPath}::${filePath}`;
    }

    private getPanelKey(): string {
        return MergeEditorPanel.getPanelKey(this.workspaceRoot, this.filePath);
    }

    private async readWorkingFile(): Promise<Uint8Array> {
        const fileUri = vscode.Uri.joinPath(this.workspaceRoot, this.filePath);
        return vscode.workspace.fs.readFile(fileUri);
    }

    private async ensureWorkingFileUnchanged(): Promise<boolean> {
        if (!this.workingFileSnapshot) {
            vscode.window.showWarningMessage(
                `Cannot verify ${this.filePath}; reopen the merge editor before applying.`,
            );
            return false;
        }
        const current = await this.readWorkingFile();
        if (Buffer.from(current).equals(Buffer.from(this.workingFileSnapshot))) return true;
        vscode.window.showWarningMessage(
            `${this.filePath} changed on disk after the merge editor opened. Reopen it to avoid overwriting those changes.`,
        );
        return false;
    }

    private async goToDefinition(
        displayedLineNumber: number,
        displayedCharacter: number,
        displayedLineText: string,
    ): Promise<void> {
        const fileUri = vscode.Uri.joinPath(this.workspaceRoot, this.filePath);
        const document = await vscode.workspace.openTextDocument(fileUri);
        const sourceLine = findUniqueSourceLine(
            document,
            displayedLineNumber,
            displayedLineText,
        );
        if (sourceLine === undefined) {
            vscode.window.showInformationMessage(
                `Cannot reliably map this merge line in ${this.filePath}.`,
            );
            return;
        }

        const sourceText = document.lineAt(sourceLine).text;
        const character = Math.min(displayedCharacter, sourceText.length);
        const position = new vscode.Position(
            sourceLine,
            character === sourceText.length && character > 0 ? character - 1 : character,
        );
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) return;

        const definitions = await vscode.commands.executeCommand<
            Array<vscode.Location | vscode.LocationLink> | undefined
        >("vscode.executeDefinitionProvider", fileUri, wordRange.start);
        const target = definitions?.[0];
        if (!target) return;

        if ("targetUri" in target) {
            await vscode.window.showTextDocument(target.targetUri, {
                preview: true,
                selection: target.targetSelectionRange ?? target.targetRange,
            });
            return;
        }
        await vscode.window.showTextDocument(target.uri, {
            preview: true,
            selection: target.range,
        });
    }
}

function detectTextFormatFromText(text: string): {
    eol: "\n" | "\r\n";
    hasTrailingNewline: boolean;
} {
    const newlineIdx = text.indexOf("\n");
    const eol: "\n" | "\r\n" =
        newlineIdx > 0 && text.charAt(newlineIdx - 1) === "\r" ? "\r\n" : "\n";
    const hasTrailingNewline = text.endsWith("\r\n") || text.endsWith("\n");
    return { eol, hasTrailingNewline };
}
