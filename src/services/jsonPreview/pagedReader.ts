import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as yieldToHost } from "node:timers/promises";
import { JsonFormatter } from "./formatter";
import { JSON_PAGE_LINES, type JsonLine, type JsonPage } from "./types";

const READ_BYTES = 64 * 1024;

/** Forward-only parsing with disk-backed pages for backwards navigation. */
export class PagedJsonReader {
    private input!: FileHandle;
    private spool!: FileHandle;
    private tempDir = "";
    private signature = "";
    private pages: { offset: number; length: number }[] = [];
    private spoolSize = 0;
    private rows!: AsyncGenerator<JsonLine>;
    private closed = false;
    private ended = false;
    private queue: Promise<unknown> = Promise.resolve();
    public size = 0;
    public bytesRead = 0;
    public formattedLines = 0;

    private constructor(private readonly filename: string) {}

    static async open(filename: string): Promise<PagedJsonReader> {
        const reader = new PagedJsonReader(filename);
        try {
            reader.input = await fs.open(filename, "r");
            const stat = await reader.input.stat();
            if (!stat.isFile()) throw new Error("请选择 JSON 文件");
            reader.size = stat.size;
            reader.signature = reader.statKey(stat);
            reader.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-json-"));
            reader.spool = await fs.open(path.join(reader.tempDir, "pages"), "wx+", 0o600);
            reader.rows = reader.readRows();
            return reader;
        } catch (error) {
            await reader.dispose();
            throw error;
        }
    }

    getPage(index: number): Promise<JsonPage> {
        const work = this.queue.then(() => this.loadPage(index));
        this.queue = work.catch(() => {});
        return work;
    }

    private statKey(stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): string {
        return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    }

    private async assertCurrent(): Promise<void> {
        if (this.closed) throw new Error("预览已关闭");
        if (this.statKey(await fs.stat(this.filename)) !== this.signature) {
            throw new Error("文件已变化，请刷新预览，避免混合显示两个版本的内容");
        }
    }

    private async loadPage(index: number): Promise<JsonPage> {
        await this.assertCurrent();
        if (!Number.isSafeInteger(index) || index < 0 || index > this.pages.length) throw new Error("无效的预览页");
        const cached = this.pages[index];
        if (cached) {
            const buffer = Buffer.alloc(cached.length);
            let read = 0;
            while (read < buffer.length) {
                const result = await this.spool.read(buffer, read, buffer.length - read, cached.offset + read);
                if (!result.bytesRead) throw new Error("预览缓存不完整，请刷新");
                read += result.bytesRead;
            }
            return JSON.parse(buffer.toString("utf8")) as JsonPage;
        }
        if (this.ended) throw new Error("已到文件末尾");
        const page: JsonPage = { index, lines: [], done: false };
        try {
            while (page.lines.length < JSON_PAGE_LINES && !this.closed) {
                const row = await this.rows.next();
                if (row.done) { page.done = true; break; }
                page.lines.push(row.value);
                this.formattedLines = row.value.number;
            }
        } catch (error) {
            page.done = true;
            page.error = error instanceof Error ? error.message : String(error);
        }
        await this.assertCurrent();
        this.ended = page.done;
        const content = Buffer.from(JSON.stringify(page), "utf8");
        let written = 0;
        while (written < content.length) {
            const result = await this.spool.write(content, written, content.length - written, this.spoolSize + written);
            if (!result.bytesWritten) throw new Error("无法写入预览缓存");
            written += result.bytesWritten;
        }
        this.pages.push({ offset: this.spoolSize, length: content.length });
        this.spoolSize += content.length;
        return page;
    }

    private async *readRows(): AsyncGenerator<JsonLine> {
        const buffer = Buffer.alloc(READ_BYTES);
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const formatter = new JsonFormatter();
        while (!this.closed) {
            const { bytesRead } = await this.input.read(buffer, 0, buffer.length, this.bytesRead);
            if (!bytesRead) {
                yield* formatter.feed(decoder.decode());
                yield* formatter.finish();
                return;
            }
            this.bytesRead += bytesRead;
            yield* formatter.feed(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
            // Even whitespace-heavy files must not monopolize the extension host.
            await yieldToHost();
        }
    }

    async dispose(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.queue;
        await this.rows?.return(undefined).catch(() => {});
        await Promise.allSettled([this.input?.close(), this.spool?.close()]);
        if (this.tempDir) await fs.rm(this.tempDir, { recursive: true, force: true });
    }
}
