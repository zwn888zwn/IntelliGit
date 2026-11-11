import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { setImmediate as yieldToHost } from "node:timers/promises";
import { JsonFormatter } from "./formatter";
import type { JsonNodeKind, JsonTreeCursor, JsonTreeNode } from "./types";

export const JSON_TREE_PAGE_SIZE = 100;
const CHUNK = 64 * 1024;
const SUMMARY_BYTES = 256;
const KEY_BYTES = 4096;
export const JSON_VALUE_PREVIEW_BYTES = 16 * 1024;
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const delimiter = (byte: number) => whitespace(byte) || byte === 44 || byte === 93 || byte === 125;

/** Random access cursors share a file handle but never a mutable seek position. */
class Cursor {
    private buffer = Buffer.alloc(CHUNK);
    private used = 0;
    private length = 0;
    constructor(private readonly input: FileHandle, public position: number,
        private readonly check: () => void, private readonly record: (bytes: number) => void) {}
    async available(): Promise<Buffer> {
        this.check();
        if (this.used === this.length) {
            await yieldToHost();
            this.check();
            this.length = (await this.input.read(this.buffer, 0, CHUNK, this.position)).bytesRead;
            this.record(this.length);
            this.used = 0;
        }
        return this.buffer.subarray(this.used, this.length);
    }
    advance(length: number): void { this.used += length; this.position += length; }
    async peek(): Promise<number | undefined> { return (await this.available())[0]; }
    async spaces(): Promise<void> {
        while (true) {
            const buffer = await this.available();
            let end = 0;
            while (end < buffer.length && whitespace(buffer[end])) end++;
            this.advance(end);
            if (end < buffer.length || !buffer.length) return;
        }
    }
}

/** Reads only the requested container's immediate children; no resident AST. */
export class JsonTreeReader {
    private closed = false;
    private tasks = new Set<Promise<unknown>>();
    private rootOffset = -1;
    public bytesRead = 0;
    private constructor(private readonly input: FileHandle, private readonly filename: string,
        public readonly size: number, private readonly signature: string) {}

    static async open(filename: string): Promise<JsonTreeReader> {
        const input = await fs.open(filename, "r");
        try {
            const stat = await input.stat();
            if (!stat.isFile()) throw new Error("请选择 JSON 文件");
            return new JsonTreeReader(input, filename, stat.size, statKey(stat));
        } catch (error) { await input.close(); throw error; }
    }

    private check(signal?: AbortSignal): void {
        if (this.closed || signal?.aborted) throw new Error("读取已取消");
    }
    private async current(signal?: AbortSignal): Promise<void> {
        this.check(signal);
        if (statKey(await fs.stat(this.filename)) !== this.signature) throw new Error("文件已变化，请刷新预览");
    }
    private cursor(offset: number, signal?: AbortSignal): Cursor {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > this.size) throw new Error("无效的文件位置");
        return new Cursor(this.input, offset, () => this.check(signal), bytes => { this.bytesRead += bytes; });
    }
    private task<T>(run: () => Promise<T>): Promise<T> {
        const task = run();
        this.tasks.add(task);
        void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
        return task;
    }

    root(): Promise<JsonTreeNode> {
        return this.task(async () => {
            await this.current();
            const cursor = this.cursor(0);
            const buffer = await cursor.available();
            if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) cursor.advance(3);
            await cursor.spaces();
            if (await cursor.peek() === undefined) throw new Error("JSON 文件为空");
            this.rootOffset = cursor.position;
            return this.describe(cursor.position, "$", SUMMARY_BYTES);
        });
    }

    children(parent: number, previous: JsonTreeCursor | undefined, signal: AbortSignal,
        emit: (nodes: JsonTreeNode[]) => void): Promise<JsonTreeCursor | undefined> {
        return this.task(async () => {
            await this.current(signal);
            const parentCursor = this.cursor(parent, signal);
            const opening = await parentCursor.peek();
            if (opening !== 123 && opening !== 91) throw new Error("该节点不是对象或数组");
            const closing = opening === 123 ? 125 : 93;
            let ordinal = previous ? previous.ordinal + 1 : 0;
            const cursor = previous ? this.cursor(previous.offset, signal) : parentCursor;
            let afterComma = false;
            if (previous) {
                if (previous.offset <= parent || !Number.isSafeInteger(previous.ordinal) || previous.ordinal < 0) throw new Error("无效的分页位置");
                await this.skip(cursor);
                afterComma = await this.separator(cursor, closing);
                if (!afterComma) { await this.finishContainer(parent, cursor, signal); return undefined; }
            } else cursor.advance(1);
            for (let count = 0; count < JSON_TREE_PAGE_SIZE; count++, ordinal++) {
                await cursor.spaces();
                const first = await cursor.peek();
                if (first === closing && !afterComma) {
                    cursor.advance(1);
                    await this.finishContainer(parent, cursor, signal);
                    return undefined;
                }
                if (first === undefined || first === closing) throw new Error("JSON 内容不完整或存在多余逗号");
                let label = `[${ordinal}]`;
                if (opening === 123) {
                    if (first !== 34) throw new Error(`对象字段名需要双引号（字节 ${cursor.position}）`);
                    const key = await this.skip(cursor, KEY_BYTES);
                    label = key.truncated ? key.text + "…" : JSON.parse(key.text) as string;
                    await cursor.spaces();
                    if (await cursor.peek() !== 58) throw new Error(`字段名之后缺少冒号（字节 ${cursor.position}）`);
                    cursor.advance(1);
                    await cursor.spaces();
                }
                const offset = cursor.position;
                const node = await this.describe(offset, label, SUMMARY_BYTES);
                if (opening === 91) node.ordinal = ordinal;
                this.check(signal);
                // Publish before skipping: a 300 MB child must not delay its header.
                emit([node]);
                if (count + 1 === JSON_TREE_PAGE_SIZE) return { offset, ordinal };
                await this.skip(cursor);
                afterComma = await this.separator(cursor, closing);
                if (!afterComma) { await this.finishContainer(parent, cursor, signal); return undefined; }
            }
            return undefined;
        });
    }

    private async finishContainer(parent: number, cursor: Cursor, signal: AbortSignal): Promise<void> {
        if (parent === this.rootOffset) {
            await cursor.spaces();
            if (await cursor.peek() !== undefined) throw new Error("JSON 根值之后存在额外内容");
        }
        await this.current(signal);
    }

    private async separator(cursor: Cursor, closing: number): Promise<boolean> {
        await cursor.spaces();
        const byte = await cursor.peek();
        if (byte === closing) { cursor.advance(1); return false; }
        if (byte !== 44) throw new Error(`缺少逗号或结束符（字节 ${cursor.position}）`);
        cursor.advance(1);
        return true;
    }

    value(offset: number): Promise<{ text: string; truncated: boolean }> {
        return this.task(async () => {
            await this.current();
            const node = await this.describe(offset, "", JSON_VALUE_PREVIEW_BYTES);
            return { text: node.preview, truncated: node.truncated };
        });
    }

    private async describe(offset: number, label: string, limit: number): Promise<JsonTreeNode> {
        this.check();
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.size) throw new Error("无效的文件位置");
        const content = Buffer.alloc(limit);
        const { bytesRead } = await this.input.read(content, 0, limit, offset);
        this.bytesRead += bytesRead;
        const buffer = content.subarray(0, bytesRead);
        const byte = buffer[0];
        let kind: JsonNodeKind;
        if (byte === 123 || byte === 91) return { offset, label, kind: byte === 123 ? "object" : "array", preview: byte === 123 ? "{ … }" : "[ … ]", truncated: false };
        if (byte === 34) kind = "string";
        else if (byte === 45 || (byte >= 48 && byte <= 57)) kind = "number";
        else if (byte === 116 || byte === 102 || byte === 110) kind = "literal";
        else throw new Error(`无效的 JSON 值（字节 ${offset}）`);
        let end = buffer.length;
        let complete = false;
        if (kind === "string") {
            let escaped = false;
            for (let i = 1; i < buffer.length; i++) {
                if (!escaped && buffer[i] === 34) { end = i + 1; complete = true; break; }
                escaped = !escaped && buffer[i] === 92;
            }
        } else {
            for (let i = 0; i < buffer.length; i++) {
                if (delimiter(buffer[i])) { end = i; complete = true; break; }
            }
            complete ||= offset + end === this.size;
        }
        // A partial UTF-8 character at the preview boundary stays in the next slice.
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end), { stream: !complete });
        if (complete) {
            const validator = new JsonFormatter(false);
            validator.feed(text).next();
            validator.finish().next();
        }
        return { offset, label, kind, preview: text, truncated: !complete };
    }

    /** Skip a value in fixed buffers, validating its grammar without rendering it. */
    private async skip(cursor: Cursor, capture = 0): Promise<{ text: string; truncated: boolean }> {
        const first = await cursor.peek();
        const container = first === 123 || first === 91;
        const rootString = first === 34;
        const validator = new JsonFormatter(false);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let depth = 0, inString = false, escaped = false, started = false, done = false, captured = 0, total = 0;
        const snippets: Buffer[] = [];
        while (!done) {
            const buffer = await cursor.available();
            if (!buffer.length) break;
            let end = 0;
            for (; end < buffer.length; end++) {
                const byte = buffer[end];
                if (!container && !rootString && delimiter(byte)) { done = true; break; }
                if (inString) {
                    if (!escaped && byte === 34) {
                        inString = false;
                        if (rootString) { end++; done = true; break; }
                    }
                    escaped = !escaped && byte === 92;
                } else if (byte === 34) inString = true;
                else if (byte === 123 || byte === 91) depth++;
                else if (byte === 125 || byte === 93) {
                    depth--;
                    if (container && depth === 0) { end++; done = true; break; }
                }
                started = true;
            }
            if (!started && end === 0) throw new Error(`缺少 JSON 值（字节 ${cursor.position}）`);
            const slice = buffer.subarray(0, end);
            if (captured < capture) {
                const part = Buffer.from(slice.subarray(0, capture - captured));
                snippets.push(part); captured += part.length;
            }
            validator.feed(decoder.decode(slice, { stream: true })).next();
            total += end;
            cursor.advance(end);
        }
        validator.feed(decoder.decode()).next();
        validator.finish().next();
        return { text: new TextDecoder().decode(Buffer.concat(snippets), { stream: total > capture }), truncated: total > capture };
    }

    async dispose(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await Promise.allSettled([...this.tasks]);
        await this.input.close();
    }
}

function statKey(stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): string {
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}
