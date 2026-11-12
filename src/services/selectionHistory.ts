import * as vscode from "vscode";
import * as path from "path";
import type { RepositoryEntry } from "./RepositoryContextService";
import { prepareSelectionHistory, type HistoryRange } from "../git/selectionHistory";
import { SelectionHistoryPanel } from "../views/SelectionHistoryPanel";
import { getErrorMessage } from "../utils/errors";

export function selectedLineRange(range: vscode.Range): HistoryRange {
    return { start: range.start.line + 1,
        end: range.end.line > range.start.line && range.end.character === 0
            ? range.end.line : range.end.line + 1 };
}

export async function showSelectionHistory(
    extensionUri: vscode.Uri, repository: RepositoryEntry,
    editor: Pick<vscode.TextEditor, "document" | "selection">, explicitRange?: vscode.Range,
): Promise<void> {
    const document = editor.document;
    const content = document.getText();
    const version = document.version;
    let range: vscode.Range = explicitRange ?? editor.selection;
    try {
        if (!explicitRange && editor.selection.isEmpty) {
            // Prefer the smallest enclosing function; languages without symbols fall back to the caret line.
            const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
                "vscode.executeDocumentSymbolProvider", document.uri,
            ).then((value) => value ?? [], () => []);
            const candidates: vscode.Range[] = [];
            const visit = (items: Array<vscode.DocumentSymbol | vscode.SymbolInformation>) => {
                for (const symbol of items) {
                    const candidate = "range" in symbol ? symbol.range : symbol.location.range;
                    if ([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor].includes(symbol.kind)
                        && candidate.contains(range.start)) candidates.push(candidate);
                    if ("children" in symbol) visit(symbol.children);
                }
            };
            if (document.version === version) visit(symbols);
            candidates.sort((a, b) => (a.end.line - a.start.line) - (b.end.line - b.start.line));
            range = candidates[0] ?? range;
        }
        const lines = selectedLineRange(range);
        const relative = path.relative(repository.root, document.uri.fsPath).split(path.sep).join("/");
        const snapshot = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
            title: "正在定位选中代码的历史…" }, () => prepareSelectionHistory(repository.root, relative, content, lines));
        new SelectionHistoryPanel(extensionUri, repository.root, snapshot, lines.start);
    } catch (error) {
        vscode.window.showWarningMessage(`无法查看代码历史：${getErrorMessage(error)}`);
    }
}
