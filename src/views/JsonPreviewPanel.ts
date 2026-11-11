import * as vscode from "vscode";
import * as path from "node:path";
import { PagedJsonReader } from "../services/jsonPreview/pagedReader";
import { JsonTreeReader } from "../services/jsonPreview/treeReader";
import type { JsonTreeMessage, JsonTreeCursor, JsonTreeNode } from "../services/jsonPreview/types";
import type { JsonPreviewMessage } from "../services/jsonPreview/types";
import { buildWebviewShellHtml } from "./webviewHtml";

export const JSON_PREVIEW_EDITOR = "intelligit.jsonPreview";

export function registerJsonPreview(context: vscode.ExtensionContext): void {
    const panels = new Set<JsonPreviewPanel>();
    const provider: vscode.CustomReadonlyEditorProvider = {
        // Deliberately do not use CustomTextEditorProvider or openTextDocument:
        // VS Code must not load a large JSON into its text model before previewing.
        openCustomDocument(uri) {
            if (uri.scheme !== "file") throw new Error("此来源不支持分块读取，请使用“重新打开方式 → 文本编辑器”。");
            return { uri, dispose() {} };
        },
        resolveCustomEditor(document, panel, token) {
            if (token.isCancellationRequested) return;
            const preview = new JsonPreviewPanel(context.extensionUri, document.uri, panel, () => panels.delete(preview));
            panels.add(preview);
        },
    };
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(JSON_PREVIEW_EDITOR, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
    }));
    context.subscriptions.push(vscode.commands.registerCommand("intelligit.previewJson", async (resource?: vscode.Uri) => {
        let uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
            uri = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] } }))?.[0];
        }
        if (!uri) return;
        if (uri.scheme !== "file") {
            void vscode.window.showErrorMessage("JSON 大文件预览需要磁盘文件，请先将内容保存为本地 JSON 文件。");
            return;
        }
        await vscode.commands.executeCommand("vscode.openWith", uri, JSON_PREVIEW_EDITOR);
    }));
    context.subscriptions.push({ dispose: () => {
        for (const panel of panels) panel.dispose();
        panels.clear();
    } });
}

class JsonPreviewPanel {
    private reader: PagedJsonReader | undefined;
    private tree: JsonTreeReader | undefined;
    private mode: "tree" | "code" = "tree";
    private treeRequests = new Map<number, { request: number; controller: AbortController }>();
    private generation = 0;
    private closed = false;
    private busy = false;

    constructor(extensionUri: vscode.Uri, private readonly uri: vscode.Uri,
        private readonly panel: vscode.WebviewPanel, onClose: () => void) {
        panel.title = `JSON 预览 · ${path.basename(uri.fsPath)}`;
        panel.webview.options = { ...panel.webview.options, enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")] };
        this.panel.webview.html = buildWebviewShellHtml({ extensionUri, webview: this.panel.webview,
            title: "JSON 格式化预览", scriptFile: "webview-jsonpreview.js" });
        this.panel.webview.onDidReceiveMessage((message: unknown) => {
            if (!message || typeof message !== "object") return;
            const data = message as Record<string, unknown>;
            if (data.type === "ready" || data.type === "refresh") {
                if (data.mode === "code" || data.mode === "tree") this.mode = data.mode;
                void this.reset();
            }
            if (data.type === "children" && data.generation === this.generation &&
                Number.isSafeInteger(data.parent) && Number.isSafeInteger(data.request)) {
                void this.children(data.parent as number, data.request as number,
                    data.cursor && typeof data.cursor === "object" ? data.cursor as JsonTreeCursor : undefined);
            }
            if (data.type === "cancelChildren" && data.generation === this.generation && Number.isSafeInteger(data.parent)) {
                this.treeRequests.get(data.parent as number)?.controller.abort();
                this.treeRequests.delete(data.parent as number);
            }
            if (data.type === "value" && data.generation === this.generation && Number.isSafeInteger(data.offset)) {
                void this.value(data.offset as number);
            }
            if (data.type === "page" && data.generation === this.generation && Number.isSafeInteger(data.index)) {
                void this.page(data.index as number);
            }
        });
        this.panel.onDidDispose(() => {
            this.closed = true;
            this.generation++;
            for (const entry of this.treeRequests.values()) entry.controller.abort();
            this.treeRequests.clear();
            void this.tree?.dispose().catch(console.error);
            this.tree = undefined;
            void this.reader?.dispose().catch(console.error);
            this.reader = undefined;
            onClose();
        });
    }

    dispose(): void { this.panel.dispose(); }

    private send(message: JsonPreviewMessage | JsonTreeMessage): void {
        if (!this.closed) void this.panel.webview.postMessage(message);
    }

    private async reset(): Promise<void> {
        const generation = ++this.generation;
        this.busy = true;
        const previous = this.reader;
        const previousTree = this.tree;
        for (const entry of this.treeRequests.values()) entry.controller.abort();
        this.treeRequests.clear();
        this.reader = undefined;
        this.tree = undefined;
        this.send({ type: "reset", generation, name: this.uri.fsPath, size: 0 });
        try {
            await Promise.all([previous?.dispose(), previousTree?.dispose()]);
            if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === this.uri.toString() && doc.isDirty)) {
                throw new Error("文件有未保存的修改，请先保存，再刷新预览。预览只读取磁盘内容。");
            }
            if (this.mode === "tree") {
                const tree = await JsonTreeReader.open(this.uri.fsPath);
                if (this.closed || generation !== this.generation) { await tree.dispose(); return; }
                this.tree = tree;
                this.send({ type: "reset", generation, name: this.uri.fsPath, size: tree.size });
                const node = await tree.root();
                if (generation === this.generation) {
                    this.send({ type: "root", generation, node });
                    this.busy = false;
                }
                return;
            }
            const reader = await PagedJsonReader.open(this.uri.fsPath);
            if (this.closed || generation !== this.generation) { await reader.dispose(); return; }
            this.reader = reader;
            this.send({ type: "reset", generation, name: this.uri.fsPath, size: reader.size });
            this.busy = false;
            await this.page(0);
        } catch (error) {
            if (generation === this.generation) {
                this.busy = false;
                this.send({ type: "error", generation, message: error instanceof Error ? error.message : String(error) });
            }
        }
    }

    private async children(parent: number, request: number, cursor?: JsonTreeCursor): Promise<void> {
        const tree = this.tree;
        if (!tree || this.closed) return;
        if (!this.treeRequests.has(parent) && this.treeRequests.size >= 4) {
            this.send({ type: "children", generation: this.generation, parent, request, nodes: [], complete: true,
                error: "其他节点正在读取，请稍后收起并重新展开此处。" });
            return;
        }
        this.treeRequests.get(parent)?.controller.abort();
        const controller = new AbortController();
        this.treeRequests.set(parent, { request, controller });
        const generation = this.generation;
        const current = () => !controller.signal.aborted && generation === this.generation && !this.closed;
        let pending: JsonTreeNode[] = [];
        let first = true;
        let timer: NodeJS.Timeout | undefined;
        const flush = () => {
            clearTimeout(timer);
            timer = undefined;
            if (current() && pending.length) this.send({ type: "children", generation, parent, request, nodes: pending, complete: false });
            pending = [];
        };
        try {
            const next = await tree.children(parent, cursor, controller.signal, nodes => {
                pending.push(...nodes);
                if (first) { first = false; flush(); }
                else if (!timer) timer = setTimeout(flush, 16);
            });
            flush();
            if (current()) this.send({ type: "children", generation, parent, request, nodes: [], complete: true, next });
        } catch (error) {
            flush();
            if (current()) this.send({ type: "children", generation, parent, request, nodes: [], complete: true,
                error: error instanceof Error ? error.message : String(error) });
        } finally {
            clearTimeout(timer);
            if (this.treeRequests.get(parent)?.controller === controller) this.treeRequests.delete(parent);
        }
    }

    private async value(offset: number): Promise<void> {
        const tree = this.tree;
        const generation = this.generation;
        if (!tree || this.closed) return;
        try {
            const preview = await tree.value(offset);
            if (generation === this.generation) this.send({ type: "value", generation, offset, ...preview });
        } catch (error) {
            if (generation === this.generation) this.send({ type: "error", generation,
                message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async page(index: number): Promise<void> {
        if (!this.reader || this.busy || this.closed) return;
        this.busy = true;
        const generation = this.generation;
        const reader = this.reader;
        try {
            const page = await reader.getPage(index);
            if (generation === this.generation) this.send({ type: "page", generation, page,
                bytesRead: reader.bytesRead, formattedLines: reader.formattedLines });
        } catch (error) {
            if (generation === this.generation) this.send({ type: "error", generation,
                message: error instanceof Error ? error.message : String(error) });
        } finally {
            if (generation === this.generation) this.busy = false;
        }
    }
}
