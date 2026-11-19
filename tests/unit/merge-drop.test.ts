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
