import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotLogReader } from "../../src/services/copilotLogReader";

let directory: string;
let file: string;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: "llm_request", ts: 1000, dur: 29900, status: "ok",
        attrs: { model: "gpt-test", outputTokens: 1240, ttft: 2300 },
        ...overrides,
    };
}

function lines(...events: unknown[]): string {
    return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-copilot-reader-"));
    file = path.join(directory, "main.jsonl");
});

afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
});

describe("CopilotLogReader", () => {
    it("detects completed provider turns without LLM metrics and clears the diagnostic when metrics arrive", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines(
            { type: "user_message", ts: 100 },
            { type: "turn_start", ts: 200 },
            { type: "tool_call", ts: 300, dur: 50 },
        ));
        expect(await reader.readLatest([file])).toBeUndefined();
        expect(reader.hasCompletedTurnsWithoutMetrics).toBe(false);
        await fs.appendFile(file, lines({ type: "turn_end", ts: 400 }));
        expect(await reader.readLatest([file])).toBeUndefined();
        expect(reader.hasCompletedTurnsWithoutMetrics).toBe(true);
        await fs.appendFile(file, lines(request()));
        expect(await reader.readLatest([file])).toBeDefined();
        expect(reader.hasCompletedTurnsWithoutMetrics).toBe(false);
        await reader.readLatest([]);
        expect(reader.hasCompletedTurnsWithoutMetrics).toBe(false);
    });

    it("reads millisecond request metrics and counts user turns across tool iterations", async () => {
        await fs.writeFile(file, lines(
            { type: "session_start", ts: 100 },
            { type: "user_message", ts: 500, attrs: { content: "private prompt" } },
            { type: "turn_start", ts: 700 },
            request(),
            { type: "turn_end", ts: 700 },
            { type: "turn_start", ts: 31000 },
            request({ ts: "32000", dur: "2000", attrs: { model: "other", ttft: "250", outputTokens: "300" } }),
        ));
        const result = await new CopilotLogReader().readLatest([file]);
        expect(result).toEqual({
            request: { startedAt: 32000, durationMs: 2000, ttftMs: 250, outputTokens: 300, model: "other" },
            turn: { requestCount: 2, outputTokens: 1540, durationMs: 31900 },
        });
        expect(JSON.stringify(result)).not.toContain("private prompt");
    });

    it("waits for a complete newline and reads appended UTF-8 without double counting", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines({ type: "user_message", ts: 100 }));
        const content = Buffer.from(JSON.stringify(request({ attrs: { model: "模型", ttft: 2300, outputTokens: 1240 } })) + "\n");
        const split = content.indexOf(Buffer.from("模型")) + 1;
        await fs.appendFile(file, content.subarray(0, split));
        expect(await reader.readLatest([file])).toBeUndefined();
        await fs.appendFile(file, content.subarray(split));
        const result = await reader.readLatest([file]);
        expect(result?.request.model).toBe("模型");
        expect(result?.turn?.requestCount).toBe(1);
        expect(await reader.readLatest([file])).toEqual(result);
    });

    it("keeps the previous request and its turn until a new request completes", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines({ type: "user_message", ts: 500 }, request()));
        const previous = await reader.readLatest([file]);
        await fs.appendFile(file, lines(
            { type: "user_message", ts: 40000 },
            { type: "turn_start", ts: 41000 },
            request({ ts: 42000, dur: undefined }),
        ));
        expect(await reader.readLatest([file])).toEqual(previous);
        await fs.appendFile(file, lines(request({ ts: 43000, dur: 1000 })));
        expect((await reader.readLatest([file]))?.turn).toEqual({ requestCount: 1, outputTokens: 1240, durationMs: 1000 });
    });

    it("chooses the latest completion across files and ignores event write order", async () => {
        const other = path.join(directory, "other.jsonl");
        await fs.writeFile(file, lines(request({ ts: 1000, dur: 50000 }), request({ ts: 5000, dur: 1000 })));
        await fs.writeFile(other, lines(request({ ts: 40000, dur: 1000 })));
        const result = await new CopilotLogReader().readLatest([file, other]);
        expect(result?.request).toMatchObject({ startedAt: 1000, durationMs: 50000 });
        expect(result?.turn).toBeUndefined();
    });

    it("ignores malformed, failed and unfinished requests", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines(request()) + "{broken}\nnull\n[]\n" + lines(
            request({ ts: 40000, status: "error" }),
            request({ ts: 40000, dur: 0 }),
            request({ ts: 40000, dur: -1 }),
            request({ ts: 40000, dur: "NaN" }),
            request({ ts: "Infinity" }),
            request({ ts: 40000, dur: undefined }),
        ));
        expect((await reader.readLatest([file]))?.request.startedAt).toBe(1000);
    });

    it("leaves unavailable metrics undefined instead of inventing zeros", async () => {
        await fs.writeFile(file, lines(
            { type: "user_message", ts: 100 },
            request({ attrs: { ttft: -1, outputTokens: "", model: 42 } }),
        ));
        expect(await new CopilotLogReader().readLatest([file])).toEqual({
            request: { startedAt: 1000, durationMs: 29900, ttftMs: undefined, outputTokens: undefined, model: "" },
            turn: undefined,
        });
        await fs.writeFile(file, lines(request({ attrs: { ttft: "Infinity", outputTokens: -1 } })));
        expect((await new CopilotLogReader().readLatest([file]))?.request).toMatchObject({ ttftMs: undefined, outputTokens: undefined });
    });

    it("preserves zero tokens and zero TTFT", async () => {
        await fs.writeFile(file, lines(request({ attrs: { ttft: 0, outputTokens: 0 } })));
        expect((await new CopilotLogReader().readLatest([file]))?.request).toMatchObject({ ttftMs: 0, outputTokens: 0 });
    });

    it("resets metrics after a file is truncated or replaced", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines(request()) + " ".repeat(1000));
        await reader.readLatest([file]);
        await fs.writeFile(file, lines(request({ ts: 100, dur: 1, attrs: {} })));
        expect((await reader.readLatest([file]))?.request.startedAt).toBe(100);
        const replacement = path.join(directory, "replacement.jsonl");
        await fs.writeFile(replacement, lines(request({ ts: 10, dur: 1 })));
        await fs.rename(replacement, file);
        expect((await reader.readLatest([file]))?.request.startedAt).toBe(10);
    });

    it("drops disappeared and unlisted files and can load them again", async () => {
        const reader = new CopilotLogReader();
        await fs.writeFile(file, lines(request()));
        expect(await reader.readLatest([file])).toBeDefined();
        expect(await reader.readLatest([])).toBeUndefined();
        expect(await reader.readLatest([file])).toBeDefined();
        await fs.unlink(file);
        expect(await reader.readLatest([file])).toBeUndefined();
    });

    it("streams large lines without losing requests on either side of chunk boundaries", async () => {
        await fs.writeFile(file, lines(
            { type: "user_message", ts: 500, attrs: { content: "x".repeat(150000) } },
            request(),
            { type: "tool_call", ts: 50000, attrs: { output: "y".repeat(80000) } },
            request({ ts: 60000 }),
        ));
        expect((await new CopilotLogReader().readLatest([file]))?.turn?.requestCount).toBe(2);
    });
});
