import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { JsonFormatter } from "../../src/services/jsonPreview/formatter";
import { PagedJsonReader } from "../../src/services/jsonPreview/pagedReader";
import { JSON_LINE_CHARS, JSON_PAGE_LINES, type JsonLine } from "../../src/services/jsonPreview/types";

const raw = (lines: JsonLine[]) => lines.map(line => line.parts.map(part => part.text).join("")).join("");
function formatted(input: string, chunkSize = 1): JsonLine[] {
    const formatter = new JsonFormatter();
    const lines: JsonLine[] = [];
    for (let i = 0; i < input.length; i += chunkSize) lines.push(...formatter.feed(input.slice(i, i + chunkSize)));
    lines.push(...formatter.finish());
    return lines;
}

describe("streaming JSON formatter", () => {
    it("preserves values, escapes, duplicate keys and large numbers across chunk boundaries", () => {
        const json = String.raw`{"中文":"hello\n\u0041\"\\😀","n":9007199254740993123456789,"n":-0.125e+20,"a":[true,false,null,{},[]]}`;
        for (const size of [1, 2, 7, 64]) {
            const lines = formatted(json, size);
            expect(JSON.parse(raw(lines))).toEqual(JSON.parse(json));
            expect(raw(lines)).toContain('9007199254740993123456789');
            expect(raw(lines)).toContain('-0.125e+20');
            expect(lines.some(line => line.parts.some(part => part.kind === "key"))).toBe(true);
        }
    });
    it("segments a huge scalar without losing data or creating an unbounded row", () => {
        const json = JSON.stringify({ payload: 'x'.repeat(100_000) });
        const lines = formatted(json, 16384);
        expect(lines.length).toBeGreaterThan(40);
        expect(lines.some(line => line.continued)).toBe(true);
        expect(Math.max(...lines.map(line => raw([line]).length))).toBeLessThanOrEqual(JSON_LINE_CHARS);
        expect(JSON.parse(raw(lines))).toEqual(JSON.parse(json));
    });
    it.each(['{"a":}', '[1,]', '{"a":1,}', '01', '-', '1.', '1e+', 'true false', 'tru', '"\\x"', '"\\u12xy"', '"abc\n"', '{]', '', '   '])("rejects invalid JSON: %s", json => {
        expect(() => formatted(json)).toThrow();
    });
    it("handles BOM and rejects excessive nesting explicitly", () => {
        expect(JSON.parse(raw(formatted('\uFEFF [1]')))).toEqual([1]);
        expect(() => formatted('['.repeat(513))).toThrow('512');
    });
});

describe("paged JSON disk reader", () => {
    async function fixture(run: (filename: string) => Promise<void>, content: string) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-preview-test-'));
        try {
            const filename = path.join(dir, 'data.json');
            await fs.writeFile(filename, content);
            await run(filename);
        } finally { await fs.rm(dir, { recursive: true, force: true }); }
    }
    it("reads lazily and restores earlier pages from disk without re-reading the input", async () => {
        await fixture(async filename => {
            const reader = await PagedJsonReader.open(filename);
            try {
                const first = await reader.getPage(0);
                expect(first.lines).toHaveLength(JSON_PAGE_LINES);
                expect(first.done).toBe(false);
                expect(reader.bytesRead).toBeLessThan(reader.size / 4);
                const second = await reader.getPage(1);
                expect(second.lines[0].number).toBe(1001);
                const bytes = reader.bytesRead;
                expect(await reader.getPage(0)).toEqual(first);
                expect(reader.bytesRead).toBe(bytes);
                await expect(reader.getPage(100)).rejects.toThrow('无效');
            } finally { await reader.dispose(); }
        }, '[' + Array.from({length:50000}, (_, i) => `{"id":${i},"text":"hello"}`).join(',') + ']');
    });
    it("returns a partial preview with an error instead of claiming invalid JSON is complete", async () => {
        await fixture(async filename => {
            const reader = await PagedJsonReader.open(filename);
            try {
                const page = await reader.getPage(0);
                expect(page.done).toBe(true);
                expect(page.error).toContain('结束符');
                expect(page.lines.length).toBeGreaterThan(0);
            } finally { await reader.dispose(); }
        }, '[1,2,]');
    });
    it("decodes UTF-8 split at read boundaries and keeps long token pages bounded", async () => {
        const json = '{"s":"' + 'x'.repeat(65529) + '😀中文' + 'y'.repeat(2_100_000) + '"}';
        await fixture(async filename => {
            const reader = await PagedJsonReader.open(filename);
            try {
                const first = await reader.getPage(0);
                expect(first.lines).toHaveLength(1000);
                expect(first.done).toBe(false);
                const second = await reader.getPage(1);
                expect(second.done).toBe(true);
                expect(second.error).toBeUndefined();
                expect(JSON.parse(raw([...first.lines,...second.lines]))).toEqual(JSON.parse(json));
            } finally { await reader.dispose(); }
        }, json);
    });
    it("detects replaced files and cleans up handles and temp pages on disposal", async () => {
        await fixture(async filename => {
            const reader = await PagedJsonReader.open(filename);
            const tempDir = (reader as unknown as {tempDir:string}).tempDir;
            await reader.getPage(0);
            await fs.rename(filename, filename + '.old');
            await fs.writeFile(filename, '[3]');
            await expect(reader.getPage(0)).rejects.toThrow('文件已变化');
            await reader.dispose();
            await expect(fs.stat(tempDir)).rejects.toThrow();
            await expect(reader.getPage(0)).rejects.toThrow('已关闭');
        }, '[1,2]');
    });
    it("can cancel a whitespace-heavy read without scanning the rest of the file", async () => {
        await fixture(async filename => {
            const reader = await PagedJsonReader.open(filename);
            const request = reader.getPage(0);
            const rejected = expect(request).rejects.toThrow('已关闭');
            await reader.dispose();
            await rejected;
            expect(reader.bytesRead).toBeLessThan(reader.size);
        }, ' '.repeat(2_000_000) + '[]');
    });
});
