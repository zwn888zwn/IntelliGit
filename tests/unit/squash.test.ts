import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitExecutor } from "../../src/git/executor";
import { applySquash, prepareSquash, applyReword, prepareReword, undoRewrite } from "../../src/git/squash";

let root: string;
const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
const run = async (args: string[]) => git(...args);
const executor = { run, runWithStderr: run };
function commit(file: string, content: string, subject: string): string {
    writeFileSync(join(root, file), content);
    git("add", "--", file);
    git("commit", "-qm", `test: ✅ ${subject}`);
    return git("rev-parse", "HEAD");
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "intelligit-squash-"));
    git("init", "-q", "-b", "main");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", join(root, ".git", "hooks-disabled"));
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
            ...executor,
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

describe("edit unpublished history", () => {
    it.each(["HEAD", "middle", "root"])("rewords %s and restores exact original history on Undo", async which => {
        const ops = new GitExecutor(root);
        const initial = git("rev-parse", "HEAD");
        const middle = commit("a", "one", "Middle subject");
        git("config", "user.name", "Another author");
        const head = commit("b", "two", "Later subject");
        const target = which === "root" ? initial : which === "middle" ? middle : head;
        writeFileSync(join(root, "a"), "already staged");
        git("add", "a");
        writeFileSync(join(root, "a"), "more local edits");
        writeFileSync(join(root, "new"), "untracked");
        const status = git("status", "--porcelain");
        const index = git("write-tree");
        const snapshots = () => git("log", "--format=%T %an %ae %ai");
        const before = snapshots();
        const plan = await prepareReword(ops, target);
        const receipt = await applyReword(ops, plan, "New subject\n\nDetailed body\n\nSigned-off-by: Test");
        expect(snapshots()).toBe(before);
        expect(git("log", "-1", "--format=%B", receipt.firstRewritten)).toBe("New subject\n\nDetailed body\n\nSigned-off-by: Test");
        if (which !== "HEAD") expect(git("log", "-1", "--format=%B")).toBe(git("log", "-1", "--format=%B", head));
        expect(git("status", "--porcelain")).toBe(status);
        expect(git("write-tree")).toBe(index);
        expect(readFileSync(join(root, "a"), "utf8")).toBe("more local edits");
        await undoRewrite(ops, receipt);
        expect(git("rev-parse", "HEAD")).toBe(head);
        expect(git("write-tree")).toBe(index);
    });

    it("rechecks publication and branch movement before applying or undoing", async () => {
        const ops = new GitExecutor(root);
        const a = commit("a", "a", "First");
        const b = commit("b", "b", "Second");
        const plan = await prepareReword(ops, a);
        git("update-ref", "refs/remotes/origin/main", a);
        await expect(applyReword(ops, plan, "new title")).rejects.toThrow("remote-tracking");
        expect(git("rev-parse", "HEAD")).toBe(b);
        git("update-ref", "-d", "refs/remotes/origin/main");
        git("checkout", "-qb", "other");
        await expect(applyReword(ops, plan, "new title")).rejects.toThrow("branch changed");
        git("checkout", "-q", "main");
        const receipt = await applyReword(ops, plan, "new title");
        git("update-ref", "refs/remotes/origin/main", receipt.firstRewritten);
        await expect(undoRewrite(ops, receipt)).rejects.toThrow("remote-tracking");
        git("update-ref", "-d", "refs/remotes/origin/main");
        const c = commit("c", "c", "Later");
        await expect(undoRewrite(ops, receipt)).rejects.toThrow();
        expect(git("rev-parse", "HEAD")).toBe(c);
    });

    it.each(["", "echo rejected-message >&2\n"])("keeps history intact after a rejecting commit-msg hook (%j)", async output => {
        const ops = new GitExecutor(root);
        const a = commit("a", "a", "First");
        const b = commit("b", "b", "Second");
        const squash = await prepareSquash(ops, a);
        const reword = await prepareReword(ops, a);
        const hooks = join(root, ".git", "hooks-disabled");
        mkdirSync(hooks);
        writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\n${output}exit 1\n`, { mode: 0o755 });
        writeFileSync(join(root, "extra"), "for later");
        git("add", "extra");
        const index = git("write-tree");
        await expect(applySquash(ops, squash, "bad")).rejects.toThrow(output ? "rejected-message" : "exit code 1");
        await expect(applyReword(ops, reword, "bad")).rejects.toThrow(output ? "rejected-message" : "exit code 1");
        expect(git("rev-parse", "HEAD")).toBe(b);
        expect(git("write-tree")).toBe(index);
    });

    it("does not flatten an intervening merge when editing an older commit", async () => {
        const a = commit("a", "a", "Before merge");
        git("checkout", "-qb", "side");
        commit("side-file", "side", "Side");
        git("checkout", "main");
        commit("main-file", "main", "Main");
        git("merge", "-q", "--no-ff", "side", "-m", "Merge side");
        const head = git("rev-parse", "HEAD");
        await expect(prepareReword(new GitExecutor(root), a)).rejects.toThrow("merge");
        await expect(prepareSquash(executor, a)).rejects.toThrow();
        expect(git("rev-parse", "HEAD")).toBe(head);
    });

    it("lists squash subjects oldest first and can undo the combined commit with a dirty index", async () => {
        const a = commit("a", "a", "First");
        const b = commit("b", "b", "Second");
        const plan = await prepareSquash(executor, [b, a]);
        expect((await prepareSquash(executor, a)).hashes).toEqual([b, a]);
        expect(plan.commits.map(c => c.subject)).toEqual(["test: ✅ First", "test: ✅ Second"]);
        const after = await applySquash(executor, plan, "One commit\n\nWith a body");
        writeFileSync(join(root, "extra"), "staged after squash");
        git("add", "extra");
        const index = git("write-tree");
        await undoRewrite(executor, { branch: plan.branch, before: b, after, firstRewritten: after });
        expect(git("rev-parse", "HEAD")).toBe(b);
        expect(git("write-tree")).toBe(index);
    });
});
