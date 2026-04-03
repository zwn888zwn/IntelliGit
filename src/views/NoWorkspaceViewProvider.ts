import * as vscode from "vscode";
import { SYSTEM_FONT_STACK } from "../utils/constants";

export class NoWorkspaceViewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly title: string,
        private readonly message: string,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        webviewView.webview.options = {
            enableScripts: false,
        };
        webviewView.webview.html = this.getHtml();
    }

    dispose(): void {}

    private getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(this.title)}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 20px;
            font-family: ${SYSTEM_FONT_STACK};
            font-size: 13px;
            line-height: 1.5;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .card {
            max-width: 520px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            padding: 16px;
            background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
        }
        .title {
            margin: 0 0 8px;
            font-size: 15px;
            font-weight: 600;
        }
        .message {
            margin: 0;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="card">
        <h1 class="title">${escapeHtml(this.title)}</h1>
        <p class="message">${escapeHtml(this.message)}</p>
    </div>
</body>
</html>`;
    }
}

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
