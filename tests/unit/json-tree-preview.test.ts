import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { JsonTreeReader, JSON_TREE_PAGE_SIZE, JSON_VALUE_PREVIEW_BYTES } from "../../src/services/jsonPreview/treeReader";
import type { JsonTreeNode } from "../../src/services/jsonPreview/types";

async function fixture(json: string, test: (reader: JsonTreeReader, filename: string) => Promise<void>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "json-tree-test-"));
    const filename = path.join(dir, "data.json");
    await fs.writeFile(filename, json);
    const reader = await JsonTreeReader.open(filename);
    try { await test(reader, filename); }
    finally { await reader.dispose(); await fs.rm(dir, { recursive: true, force: true }); }
}
const readChildren = async (reader: JsonTreeReader, parent: number) => {
    const nodes: JsonTreeNode[] = [];
    const next = await reader.children(parent, undefined, new AbortController().signal, batch => nodes.push(...batch));
    return { nodes, next };
};

describe("lazy JSON tree", () => {
    it("loads immediate children and expands nested containers independently", async () => {
        await fixture('{"query":{"q":"中文😀","x":true},"items":[1,null,{"z":"[]{}\\\""}],"$":5,"[name]":6}', async reader => {
            const root = await reader.root();
            const first = await readChildren(reader, root.offset);
            expect(first.nodes.map(node => node.label)).toEqual(["query", "items", "$", "[name]"]);
            expect(first.next).toBeUndefined();
            expect(first.nodes[3].ordinal).toBeUndefined();
            const query = await readChildren(reader, first.nodes[0].offset);
            expect(query.nodes.map(node => node.preview)).toEqual(['"中文😀"', 'true']);
            const array = await readChildren(reader, first.nodes[1].offset);
            expect(array.nodes.map(node => node.ordinal)).toEqual([0, 1, 2]);
            expect(array.nodes.map(node => node.kind)).toEqual(["number", "literal", "object"]);
        });
    });
    it("emits a huge child's header immediately and can cancel before scanning it", async () => {
        await fixture('[{"payload":"' + 'x'.repeat(8 * 1024 * 1024) + '"},{}]', async reader => {
            const root = await reader.root();
            expect(reader.bytesRead).toBeLessThan(70000);
            const controller = new AbortController();
            const nodes: JsonTreeNode[] = [];
            await expect(reader.children(root.offset, undefined, controller.signal, batch => {
                nodes.push(...batch); controller.abort();
            })).rejects.toThrow('取消');
            expect(nodes).toHaveLength(1);
            expect(nodes[0].kind).toBe('object');
            expect(reader.bytesRead).toBeLessThan(150000);
        });
    });
    it("paginates siblings without pre-scanning the final huge value and can revisit pages", async () => {
        const entries = Array.from({length: JSON_TREE_PAGE_SIZE - 1}, (_, i) => String(i));
        entries.push('"' + 'x'.repeat(3 * 1024 * 1024) + '"', '101');
        await fixture('[' + entries.join(',') + ']', async reader => {
            const root = await reader.root();
            const first = await readChildren(reader, root.offset);
            expect(first.nodes).toHaveLength(JSON_TREE_PAGE_SIZE);
            expect(first.nodes[99].truncated).toBe(true);
            expect(reader.bytesRead).toBeLessThan(200000);
            const second: JsonTreeNode[] = [];
            const next = await reader.children(root.offset, first.next, new AbortController().signal, batch => second.push(...batch));
            expect(second.map(node => node.preview)).toEqual(['101']);
            expect(second[0].ordinal).toBe(100);
            expect(next).toBeUndefined();
            expect((await readChildren(reader, root.offset)).nodes).toEqual(first.nodes);
        });
    });
    it("bounds the selected scalar and preserves large integer text", async () => {
        await fixture('{"n":9007199254740993123,"s":"' + 'x'.repeat(100000) + '"}', async reader => {
            const first = await readChildren(reader, (await reader.root()).offset);
            expect(await reader.value(first.nodes[0].offset)).toEqual({ text:'9007199254740993123', truncated:false });
            const selected = await reader.value(first.nodes[1].offset);
            expect(selected.truncated).toBe(true);
            expect(selected.text.length).toBeLessThanOrEqual(JSON_VALUE_PREVIEW_BYTES);
        });
    });
    it("handles UTF-8 and quotes crossing input-buffer boundaries", async () => {
        const source = '{"key":"' + 'x'.repeat(65526) + '😀\\\"\\\\end","tail":true}';
        await fixture(source, async reader => {
            const result = await readChildren(reader, (await reader.root()).offset);
            expect(result.nodes.map(node => node.label)).toEqual(['key','tail']);
            expect(result.nodes[1].preview).toBe('true');
        });
    });
    it.each(['{}','[]','\uFEFF {}'])('supports empty containers: %s', async json => {
        await fixture(json, async reader => expect((await readChildren(reader, (await reader.root()).offset)).nodes).toEqual([]));
    });
    it.each(['[1,]','{"a":1,}','{"a" 1}','[1 2]','[01]','[tru]','[{}] extra','{"x":{"a":}}','["\\x"]'])('reports malformed JSON while traversing: %s', async json => {
        await fixture(json, async reader => {
            const root = await reader.root();
            await expect(readChildren(reader, root.offset)).rejects.toThrow();
        });
    });
    it("detects source changes and closes in-progress work", async () => {
        await fixture('[1]', async (reader, filename) => {
            await reader.root();
            await fs.writeFile(filename, '[12345]');
            await expect(readChildren(reader, 0)).rejects.toThrow('文件已变化');
            await reader.dispose();
            await expect(reader.root()).rejects.toThrow('取消');
        });
    });
});
