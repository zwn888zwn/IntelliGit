import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { createBranchCommands } from "../../src/commands/branchCommands";
import { handleCommitContextAction } from "../../src/commands/commitCommands";
import { GitExecutor } from "../../src/git/executor";
import { GitOps } from "../../src/git/operations";

vi.mock("vscode", () => ({
    window: { showWarningMessage: vi.fn(), showInformationMessage: vi.fn(), showErrorMessage: vi.fn() },
    commands: { executeCommand: vi.fn() },
}));

let root: string;
let executor: GitExecutor;
let gitOps: GitOps;
function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(file: string, subject: string) {
    writeFileSync(join(root, file), subject + "\n");
    git("add", "--", file);
    git("commit", "-qm", subject);
    return git("rev-parse", "HEAD");
}
beforeEach(() => {
    vi.resetAllMocks();
    root = mkdtempSync(join(tmpdir(), "intelligit-merge-drop-"));
    git("init", "-qb", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.hooksPath", join(root, ".git", "empty-hooks"));
    git("config", "commit.gpgsign", "false");
    git("config", "rerere.enabled", "false");
    commit("base", "A");
    executor = new GitExecutor(root);
    gitOps = new GitOps(executor, undefined, { repoId: ".", repoRoot: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([false, true])("reports the actual Merge outcome (conflicting: %s)", async conflicting => {
    git("switch", "-qc", "topic");
    commit(conflicting ? "base" : "feature", "incoming");
    git("switch", "-q", "main");
    const local = commit("base", "local");
    const repository = { root, executor, gitOps, uri: { fsPath: root } as vscode.Uri, info: { root, name: "fixture", repoId: ".", color: "#888" } };
    const openConflictSession = vi.fn();
    const merge = createBranchCommands({
        executor, gitOps, requireCurrentRepository: () => repository, getCurrentBranches: () => [],
        getCurrentBranchName: () => "main", openConflictSession, refreshConflictUi: vi.fn(), finalizeMergeIfReady: vi.fn(),
    }).find(command => command.id === "intelligit.mergeIntoCurrent")!;
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Merge" as never);
    await merge.handler({ branch: { name: "topic", hash: git("rev-parse", "topic"), isRemote: false, isCurrent: false, ahead: 0, behind: 0 } });
    if (!conflicting) {
        expect(openConflictSession).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Merged topic");
        expect(git("rev-parse", "HEAD^1")).toBe(local);
        expect(git("rev-parse", "HEAD^2")).toBe(git("rev-parse", "topic"));
        return;
    }
    expect(openConflictSession).toHaveBeenCalledWith({ repository, sourceBranch: "topic", targetBranch: "main" });
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(git("rev-parse", "HEAD")).toBe(local);
    expect(git("status", "--porcelain")).toBe("UU base");
});

function drop(hash: string) {
    return handleCommitContextAction({ action: "dropCommit", hash, executor, gitOps, repoRoot: root,
        currentBranches: [], refreshAll: vi.fn(), editHistoryMessage: vi.fn() });
}

it.each([false, true])("drops a commit from the checked-out branch (tip: %s)", async atTip => {
    const removed = commit("remove.txt", "B");
    if (!atTip) commit("keep.txt", "C");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Drop" as never);
    await drop(removed);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("log", "--format=%s", "main")).toBe(atTip ? "A" : "C\nA");
    expect(git("ls-files")).toBe(atTip ? "base" : "base\nkeep.txt");
});

it("keeps both branches intact when checkout changes during confirmation", async () => {
    const head = commit("b", "B");
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
        git("switch", "-qc", "other");
        return "Drop" as never;
    });
    await drop(head);
    expect(git("branch", "--show-current")).toBe("other");
    expect(git("rev-parse", "main", "other")).toBe(head + "\n" + head);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
});

function undo(hash: string) {
    return handleCommitContextAction({ action: "undoCommit", hash, executor, gitOps, repoRoot: root,
        currentBranches: [], refreshAll: vi.fn(), editHistoryMessage: vi.fn() });
}

it("undoes a local suffix without modifying the index or the worktree", async () => {
    const base = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", base);
    const target = commit("b", "B");
    const head = commit("c", "C");
    const index = git("write-tree");
    writeFileSync(join(root, "b"), "unstaged edits");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Undo" as never);

    await undo(target);
    expect(git("rev-parse", "HEAD", "ORIG_HEAD")).toBe(base + "\n" + head);
    expect(git("write-tree")).toBe(index);
    expect(git("status", "--porcelain")).toBe("AM b\nA  c");
});

it.each([
    ["Undo", "other branch"], ["Undo", "across a merge"], ["Undo", "already published"],
    ["Drop", "across a merge"],
])("rejects %s Commit %s before prompting", async (action, scenario) => {
    git("switch", "-qc", "topic");
    const topic = commit("topic", "topic");
    git("switch", "-q", "main");
    const main = commit("main", "main");
    const target = scenario === "other branch" ? topic : main;
    if (scenario === "across a merge") git("merge", "--no-ff", "--no-edit", "topic");
    if (scenario === "already published") git("update-ref", "refs/remotes/origin/main", main);
    const head = git("rev-parse", "HEAD");

    if (action === "Undo") await undo(target);
    else await drop(target);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(git("rev-parse", "HEAD", "topic")).toBe(head + "\n" + topic);
    expect(git("status", "--porcelain")).toBe("");
});

it("keeps a second branch unchanged on Drop Commit when Git rebase.updateRefs is enabled", async () => {
    const removed = commit("b", "B");
    const other = commit("c", "C");
    git("branch", "other");
    commit("d", "D");
    git("config", "rebase.updateRefs", "true");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Drop" as never);

    await drop(removed);
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("log", "--format=%s", "main")).toBe("D\nC\nA");
    expect(git("rev-parse", "other")).toBe(other);
});

it.each(["branch", "HEAD", "remote tracking ref"])("rechecks %s after Undo Commit confirmation", async changed => {
    const target = commit("b", "B");
    let expected = target;
    vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
        if (changed === "branch") git("switch", "-qc", "other");
        if (changed === "HEAD") expected = commit("c", "C");
        if (changed === "remote tracking ref") git("update-ref", "refs/remotes/origin/main", target);
        return "Undo" as never;
    });

    await undo(target);
    expect(git("rev-parse", "HEAD", "main")).toBe(expected + "\n" + expected);
    expect(git("branch", "--show-current")).toBe(changed === "branch" ? "other" : "main");
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
});

it.each(["continue", "abort"])("protects a rebase resolution from rollback until %s", async action => {
    git("switch", "-qc", "topic");
    commit("base", "incoming");
    git("switch", "-q", "main");
    commit("base", "local");
    expect(() => git("rebase", "topic")).toThrow();
    writeFileSync(join(root, "base"), "resolved");
    git("add", "base");
    writeFileSync(join(root, "notes"), "untracked");
    const status = git("status", "--porcelain");
    const index = git("write-tree");

    expect(await gitOps.getConflictOperation()).toBe("rebase");
    await expect(gitOps.rollbackFiles(["base", "notes"])).rejects.toThrow("A rebase is in progress");
    await expect(gitOps.rollbackAll()).rejects.toThrow("A rebase is in progress");
    expect(git("status", "--porcelain")).toBe(status);
    expect(git("write-tree")).toBe(index);

    if (action === "continue") await gitOps.continueRebase();
    else await gitOps.abortRebase();
    expect(git("branch", "--show-current")).toBe("main");
    expect(git("show", "HEAD:base")).toBe(action === "continue" ? "resolved" : "local");
    expect(await gitOps.getConflictOperation()).toBeNull();
});
