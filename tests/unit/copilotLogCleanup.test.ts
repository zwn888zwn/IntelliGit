import fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupCopilotLogs } from "../../src/services/copilotLogCleanup";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
let directory: string;
let root: string;

async function session(name: string, ageDays: number, sizes = [10]): Promise<string> {
    const target = path.join(root, name);
    await fs.mkdir(target, { recursive: true });
    for (const [index, size] of sizes.entries()) {
        const file = path.join(target, index === 0 ? "main.jsonl" : `system_prompt_${index}.json`);
        await fs.writeFile(file, "x".repeat(size));
        await fs.utimes(file, new Date(now - ageDays * DAY_MS), new Date(now - ageDays * DAY_MS));
    }
    await fs.utimes(target, new Date(now - ageDays * DAY_MS), new Date(now - ageDays * DAY_MS));
    return target;
}

async function exists(target: string): Promise<boolean> {
    return fs.lstat(target).then(() => true, () => false);
}

beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-copilot-cleanup-"));
    root = path.join(directory, "debug-logs");
    await fs.mkdir(root);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
});

describe("cleanupCopilotLogs", () => {
    it("expires whole historical sessions including prompt and tool sidecars", async () => {
        const old = await session("old", 8, [10, 20, 30]);
        const current = await session("current", 0);
        const result = await cleanupCopilotLogs([root], { now });
        expect(result).toEqual({ deletedSessions: 1, freedBytes: 60, remainingBytes: 10, protectedBytes: 10 });
        expect(await exists(old)).toBe(false);
        expect(await exists(current)).toBe(true);
    });

    it("deletes oldest eligible sessions until the total size target is met", async () => {
        const oldest = await session("oldest", 5, [10, 50]);
        const newer = await session("newer", 3, [10, 20]);
        await session("current", 0);
        const result = await cleanupCopilotLogs([root], { now, maxTotalBytes: 40 });
        expect(result).toEqual({ deletedSessions: 1, freedBytes: 60, remainingBytes: 40, protectedBytes: 10 });
        expect(await exists(oldest)).toBe(false);
        expect(await exists(newer)).toBe(true);
    });

    it("protects recent writes and the newest session even when over budget", async () => {
        const recent = await session("recent", 0.1, [30]);
        const newest = await session("newest", 0, [40]);
        const result = await cleanupCopilotLogs([root], { now, maxTotalBytes: 0, clearOld: true });
        expect(result).toEqual({ deletedSessions: 0, freedBytes: 0, remainingBytes: 70, protectedBytes: 70 });
        expect(await exists(recent)).toBe(true);
        expect(await exists(newest)).toBe(true);
        await fs.rm(root, { recursive: true });
        await fs.mkdir(root);
        const oldNewest = await session("only-session", 30);
        expect((await cleanupCopilotLogs([root], { now, clearOld: true })).deletedSessions).toBe(0);
        expect(await exists(oldNewest)).toBe(true);
    });

    it("manual cleanup removes eligible history even below the size target", async () => {
        const old = await session("old", 2);
        await session("current", 0);
        expect((await cleanupCopilotLogs([root], { now })).deletedSessions).toBe(0);
        expect((await cleanupCopilotLogs([root], { now, clearOld: true })).deletedSessions).toBe(1);
        expect(await exists(old)).toBe(false);
    });

    it("protects a session when a sidecar was written recently", async () => {
        const old = await session("old", 20);
        const sidecar = path.join(old, "tools_1.json");
        await fs.writeFile(sidecar, "current tools");
        await fs.utimes(sidecar, new Date(now), new Date(now));
        await session("current", 0);
        expect((await cleanupCopilotLogs([root], { now, maxTotalBytes: 0, clearOld: true })).deletedSessions).toBe(0);
        expect(await exists(old)).toBe(true);
    });

    it("does not follow symlinks, remove other storage, or clear the root itself", async () => {
        const outside = path.join(directory, "outside");
        await fs.mkdir(outside);
        const outsideLog = path.join(outside, "main.jsonl");
        await fs.writeFile(outsideLog, "keep");
        await fs.symlink(outside, path.join(root, "linked-session"));
        const linkedFileSession = await session("linked-file", 20);
        await fs.symlink(outsideLog, path.join(linkedFileSession, "tools.json"));
        const invalid = path.join(root, "chat-history");
        await fs.mkdir(invalid);
        await fs.writeFile(path.join(invalid, "state.json"), "keep");
        const database = path.join(root, "session-store.db");
        await fs.writeFile(database, "keep");
        await session("current", 0);
        expect((await cleanupCopilotLogs([root], { now, clearOld: true, maxTotalBytes: 0 })).deletedSessions).toBe(0);
        for (const entry of [root, outsideLog, linkedFileSession, invalid, database]) {
            expect(await exists(entry)).toBe(true);
        }
    });

    it("handles absent roots and deduplicates storage roots", async () => {
        await session("old", 20);
        await session("current", 0);
        const result = await cleanupCopilotLogs([root, root, path.join(directory, "missing")], { now });
        expect(result).toEqual({ deletedSessions: 1, freedBytes: 10, remainingBytes: 10, protectedBytes: 10 });
    });

    it("uses safe defaults for non-finite cleanup limits", async () => {
        const old = await session("old", 2);
        await session("current", 0);
        const result = await cleanupCopilotLogs([root], { now, retentionDays: NaN, maxTotalBytes: NaN });
        expect(result.deletedSessions).toBe(0);
        expect(await exists(old)).toBe(true);
    });

    it("rechecks a historical session and skips it if writing resumed after discovery", async () => {
        const old = await session("old", 20);
        await session("current", 0);
        const main = path.join(old, "main.jsonl");
        const originalLstat = fs.lstat;
        let inspections = 0;
        vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
            if (args[0] === main && ++inspections === 2) await fs.appendFile(main, "resumed");
            return originalLstat(...args);
        }) as typeof fs.lstat);
        const result = await cleanupCopilotLogs([root], { now, clearOld: true });
        expect(result.deletedSessions).toBe(0);
        expect(result.remainingBytes).toBe(27);
        expect(result.protectedBytes).toBe(27);
        expect(await fs.readFile(main, "utf8")).toContain("resumed");
    });

    it("protects the newest session in every separate root", async () => {
        const first = await session("only-first", 30);
        const secondRoot = path.join(directory, "second-debug-logs");
        await fs.mkdir(secondRoot);
        const savedRoot = root;
        root = secondRoot;
        const second = await session("only-second", 20);
        root = savedRoot;
        expect((await cleanupCopilotLogs([root, secondRoot], { now, clearOld: true, maxTotalBytes: 0 })).deletedSessions).toBe(0);
        expect(await exists(first)).toBe(true);
        expect(await exists(second)).toBe(true);
    });
});
