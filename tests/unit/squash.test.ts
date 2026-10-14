import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySquash, prepareSquash } from "../../src/git/squash";

let root: string;
const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
const executor = { run: async (args: string[]) => git(...args) };
function commit(file: string, content: string, subject: string): string {
    writeFileSync(join(root, file), content);
    git("add", "--", file);
    git("commit", "-qm", `test: ✅ ${subject}`);
    return git("rev-parse", "HEAD");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "intelligit-squash-"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    commit("file.txt", "base\n", "Create base");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("squash selected commits", () => {
    it("combines the selected suffix while preserving staged, unstaged and untracked contents", async () => {
        const base = git("rev-parse", "HEAD");
        const first = commit("file.txt", "one\n", "Add first change");
        const second = commit("file.txt", "two\n", "Add second change");
        const tree = git("rev-parse", "HEAD^{tree}");
        writeFileSync(join(root, "file.txt"), "staged\n");
        git("add", "file.txt");
        writeFileSync(join(root, "file.txt"), "working\n");
        writeFileSync(join(root, "new.txt"), "untracked\n");
        const index = git("write-tree");
        const beforeStatus = git("status", "--porcelain");
        const plan = await prepareSquash(executor, [first, second]);
        const hash = await applySquash(executor, plan, "feat: ✨ Combine changes");
        expect(git("rev-parse", "HEAD")).toBe(hash);
        expect(git("rev-parse", "HEAD^")).toBe(base);
        expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
        expect(git("write-tree")).toBe(index);
        expect(git("status", "--porcelain")).toBe(beforeStatus);
        expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("working\n");
        expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("untracked\n");
        expect(git("reflog", "-1")).toContain("squash 2 commits");
    });

    it("rejects gaps, ranges not ending at HEAD, duplicates and root commits", async () => {
        const base = git("rev-parse", "HEAD");
        const a = commit("a", "a", "Add a"),
            b = commit("b", "b", "Add b"),
            c = commit("c", "c", "Add c");
        for (const hashes of [
            [a, c],
            [a, b],
            [b, b],
            [base, a, b, c],
        ]) {
            await expect(prepareSquash(executor, hashes)).rejects.toThrow();
            expect(git("rev-parse", "HEAD")).toBe(c);
        }
    });

    it("rejects published commits and unfinished Git operations", async () => {
        const a = commit("a", "a", "Add a"),
            b = commit("b", "b", "Add b");
        git("update-ref", "refs/remotes/origin/main", a);
        await expect(prepareSquash(executor, [a, b])).rejects.toThrow("remote-tracking");
        git("update-ref", "-d", "refs/remotes/origin/main");
        writeFileSync(join(root, ".git", "MERGE_HEAD"), a + "\n");
        await expect(prepareSquash(executor, [a, b])).rejects.toThrow("current Git operation");
    });

    it("does not rewrite a moved or switched branch after the message dialog", async () => {
        const a = commit("a", "a", "Add a"),
            b = commit("b", "b", "Add b");
        const plan = await prepareSquash(executor, [a, b]);
        git("checkout", "-qb", "another");
        await expect(applySquash(executor, plan, "test: ✅ Squash")).rejects.toThrow(
            "branch changed",
        );
        expect(git("rev-parse", "main")).toBe(b);
        git("checkout", "-q", "main");
        const c = commit("c", "c", "Add c");
        await expect(applySquash(executor, plan, "test: ✅ Squash")).rejects.toThrow();
        expect(git("rev-parse", "HEAD")).toBe(c);
    });

    it("leaves HEAD and the index intact when creating the commit fails", async () => {
        const a = commit("a", "a", "Add a"),
            b = commit("b", "b", "Add b");
        const plan = await prepareSquash(executor, [a, b]);
        const index = git("write-tree");
        const failing = {
            run: async (args: string[]) => {
                if (args[0] === "commit-tree") throw new Error("signing failed");
                return git(...args);
            },
        };
        await expect(applySquash(failing, plan, "test: ✅ Squash")).rejects.toThrow(
            "signing failed",
        );
        expect(git("rev-parse", "HEAD")).toBe(b);
        expect(git("write-tree")).toBe(index);
    });
});
