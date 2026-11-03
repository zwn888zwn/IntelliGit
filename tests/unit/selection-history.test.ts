import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { prepareSelectionHistory, readSelectionHistory, mapSelectionToHead } from "../../src/git/selectionHistory";
import { resolveBranchChanges } from "../../src/services/branchComparison";
import { GitExecutor } from "../../src/git/executor";
import { GitOps } from "../../src/git/operations";

let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const write = (name: string, text: string) => fs.writeFile(path.join(root, name), text);
const commit = (message: string) => { git("add", "."); git("commit", "-qm", `test(history): ✅ ${message}`); return git("rev-parse", "HEAD"); };
const source = (answer: number, other = 1) => `package demo\n\nfunc answer() int {\n    return ${answer}\n}\n\nfunc other() int {\n    return ${other}\n}\n`;
beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-history-test-"));
    git("init", "-q", "-b", "master");
    git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("selected code history", () => {
    it("omits unrelated commits and follows the fragment through file renames", async () => {
        await write("old name.go", source(1)); const initial = commit("initial");
        await write("old name.go", source(2)); const changed = commit("change answer");
        await write("old name.go", source(2, 9)); commit("unrelated function");
        git("mv", "old name.go", "新的 name.go"); commit("rename file");
        const snapshot = await prepareSelectionHistory(root, "新的 name.go", source(2, 9), { start: 3, end: 5 });
        const result = await readSelectionHistory(root, snapshot);
        expect(result.entries.map(e => e.hash)).toEqual([changed, initial]);
        expect(result.entries[0].before).toContain("return 1");
        expect(result.entries[0].after).toContain("return 2");
        expect(result.entries[0].after).not.toContain("other()");
        const paged = await readSelectionHistory(root, snapshot, 1);
        expect(paged.entries).toHaveLength(1); expect(paged.hasMore).toBe(true);
    });

    it("maps saved and unsaved insertions before a function without modifying files or index", async () => {
        await write("code.go", source(1)); commit("initial");
        await write("code.go", source(2)); commit("answer");
        await write("code.go", "// saved insertion\n" + source(2)); git("add", "code.go");
        const beforeStatus = git("status", "--porcelain");
        const beforeIndex = git("write-tree");
        const content = "// unsaved insertion\n// saved insertion\n" + source(2);
        const snapshot = await prepareSelectionHistory(root, "code.go", content, { start: 5, end: 7 });
        expect(snapshot.range).toEqual({ start: 3, end: 5 });
        expect(snapshot.mapped).toBe(true);
        expect((await readSelectionHistory(root, snapshot)).entries[0].subject).toBe("test(history): ✅ answer");
        expect(git("status", "--porcelain")).toBe(beforeStatus);
        expect(git("write-tree")).toBe(beforeIndex);
        expect(await fs.readFile(path.join(root, "code.go"), "utf8")).toBe("// saved insertion\n" + source(2));
    });

    it("includes prior versions of an edited function, but rejects wholly new code", async () => {
        await write("code.go", source(1)); commit("initial");
        const snapshot = await prepareSelectionHistory(root, "code.go", source(42), { start: 3, end: 5 });
        expect(snapshot.range).toEqual({ start: 3, end: 5 });
        expect((await readSelectionHistory(root, snapshot)).entries[0].after).toContain("return 1");
        await expect(prepareSelectionHistory(root, "code.go", source(1) + "\nfunc added() {}\n", { start: 11, end: 11 }))
            .rejects.toThrow("尚未提交");
    });

    it("keeps history anchored when HEAD advances after opening", async () => {
        await write("code.go", source(1)); const initial = commit("initial");
        const snapshot = await prepareSelectionHistory(root, "code.go", source(1), { start: 3, end: 5 });
        await write("code.go", source(2)); commit("later");
        expect((await readSelectionHistory(root, snapshot)).entries.map(e => e.hash)).toEqual([initial]);
    });

    it("refuses ambiguous partial replacement rather than showing another function's history", () => {
        expect(() => mapSelectionToHead({ start: 5, end: 6 }, "@@ -4,5 +4,5 @@\n"))
            .toThrow("部分未提交修改");
        expect(mapSelectionToHead({ start: 5, end: 15 }, "@@ -1,0 +2,10 @@\n"))
            .toEqual({ start: 2, end: 5 });
        expect(mapSelectionToHead({ start: 1, end: 5 }, "@@ -1,0 +2,10 @@\n"))
            .toEqual({ start: 1, end: 1 });
    });
});

describe("changes introduced by this branch", () => {
    it("excludes target-only changes and dirty work, and pins diffs to the listed commits", async () => {
        await write("base.txt", "base\n"); commit("base");
        git("checkout", "-qb", "feature");
        await write("feature.txt", "feature\n"); const feature = commit("feature");
        git("checkout", "-q", "master");
        await write("master-only.txt", "master\n"); commit("master advances");
        git("checkout", "-q", "feature");
        await write("dirty.txt", "untracked\n");
        const executor = new GitExecutor(root);
        const ops = new GitOps(executor);
        const { base, head } = await resolveBranchChanges(executor, "master");
        expect(head).toBe(feature);
        expect((await ops.getBranchComparisonFiles(base, { kind: "working-tree", label: "Working Tree" }))
            .map(f => f.path).sort()).toEqual(["dirty.txt", "feature.txt"]);
        expect((await ops.getBranchComparisonFiles(base, { kind: "current-branch", label: "feature", ref: head }))
            .map(f => f.path)).toEqual(["feature.txt"]);
        expect((await ops.getBranchComparisonFiles("master", { kind: "current-branch", label: "feature" }))
            .map(f => f.path).sort()).toEqual(["feature.txt", "master-only.txt"]);
        await write("feature.txt", "later\n"); commit("advance feature");
        expect(await ops.getFileContentAtRef("feature.txt", head)).toBe("feature\n");
        expect((await ops.getBranchComparisonFiles(base, { kind: "current-branch", label: "snapshot", ref: head }))
            .map(f => f.path)).toEqual(["feature.txt"]);
        git("checkout", "--orphan", "unrelated"); git("rm", "-rf", ".");
        await write("unrelated.txt", "none\n"); commit("unrelated root");
        await expect(resolveBranchChanges(executor, "master")).rejects.toThrow("共同祖先");
    });
});
