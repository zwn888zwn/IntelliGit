import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { registerJsonPreview, JSON_PREVIEW_EDITOR } from "../../src/views/JsonPreviewPanel";

vi.mock("node:fs/promises", async importOriginal => ({
    ...await importOriginal<typeof import("node:fs/promises")>(),
    open: vi.fn(),
}));

vi.mock("vscode", () => {
    class Uri {
        scheme = "file";
        constructor(public fsPath: string) {}
        static file(path: string) { return new Uri(path); }
        static joinPath(uri: Uri, ...parts: string[]) { return new Uri([uri.fsPath, ...parts].join('/')); }
        toString() { return `file://${this.fsPath}`; }
    }
    return {
        Uri,
        commands: { registerCommand: vi.fn(() => ({ dispose() {} })), executeCommand: vi.fn(async () => {}) },
        window: { registerCustomEditorProvider: vi.fn(() => ({ dispose() {} })), createWebviewPanel: vi.fn(),
            showTextDocument: vi.fn(), showErrorMessage: vi.fn(), showOpenDialog: vi.fn(), activeTextEditor: undefined },
        workspace: { openTextDocument: vi.fn(), textDocuments: [] },
    };
});

describe("JSON default custom editor", () => {
    beforeEach(() => vi.clearAllMocks());
    function setup() {
        const context = { extensionUri: vscode.Uri.file('/ext'), subscriptions: [] } as unknown as vscode.ExtensionContext;
        registerJsonPreview(context);
        const call = vi.mocked(vscode.window.registerCustomEditorProvider).mock.calls[0];
        return { context, provider: call[1] as vscode.CustomReadonlyEditorProvider, options: call[2] };
    }
    it("registers a readonly document model and reuses the supplied editor without reading the file", async () => {
        {
            const { provider, options } = setup();
            const uri = vscode.Uri.file('/Downloads/300MB.json');
            const token = { isCancellationRequested: false } as vscode.CancellationToken;
            const document = await provider.openCustomDocument(uri, {}, token);
            const panel = {
                title: '', webview: { options: {}, html: '', asWebviewUri: (value: vscode.Uri) => value,
                    cspSource: 'https://test', onDidReceiveMessage: vi.fn(), postMessage: vi.fn() },
                onDidDispose: vi.fn(), dispose: vi.fn(),
            } as unknown as vscode.WebviewPanel;
            await provider.resolveCustomEditor(document, panel, token);
            expect(document.uri).toBe(uri);
            expect(panel.webview.options.enableScripts).toBe(true);
            expect(panel.webview.html).toContain('webview-jsonpreview.js');
            expect(options?.supportsMultipleEditorsPerDocument).toBe(true);
            expect(vscode.window.createWebviewPanel).not.toHaveBeenCalled();
            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
            expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
            expect(fs.open).not.toHaveBeenCalled();
            document.dispose();
        }
    });
    it("routes the explicit preview command through the custom editor resolver", async () => {
        setup();
        const command = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([id]) => id === 'intelligit.previewJson')![1];
        const uri = vscode.Uri.file('/Downloads/export.json');
        await command(uri);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openWith', uri, JSON_PREVIEW_EDITOR);
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
    it("does not initialize a canceled editor", async () => {
        const { provider } = setup();
        const panel = { webview: { html: '' } } as vscode.WebviewPanel;
        const document = { uri: vscode.Uri.file('/test.json'), dispose() {} };
        await provider.resolveCustomEditor(document, panel, { isCancellationRequested: true } as vscode.CancellationToken);
        expect(panel.webview.html).toBe('');
    });
});
