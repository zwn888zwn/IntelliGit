import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { Branch } from "../../src/types";
import {
    buildWorktreeAddArgs,
    buildWorktreeRemoveArgs,
    copyWorktreeLocalFiles,
    findWorktreeForBranch,
    getDefaultWorktreeLocation,
    getDefaultWorktreeProjectName,
    isLocalBranchCheckedOut,
    isCurrentWorktreePath,
    parseWorktreeListPorcelain,
    resolveAndValidateWorktreeTarget,
    resolveRemoteBranchTarget,
    sanitizeWorktreeNamePart,
    validateWorktreeProjectName,
} from "../../src/services/worktreeService";

function branch(overrides: Partial<Branch> = {}): Branch {
    return {
        name: "main",
        hash: "abc1234",
        isRemote: false,
        isCurrent: false,
        ahead: 0,
        behind: 0,
        ...overrides,
    };
}

describe("worktreeService", () => {
    it("builds IDEA-style default location and project names", () => {
        expect(getDefaultWorktreeLocation("/Users/me/project/IntelliGit")).toBe(
            "/Users/me/project",
        );
        expect(getDefaultWorktreeProjectName("/Users/me/project/IntelliGit", "feature/demo")).toBe(
            "IntelliGit-feature-demo",
        );
        expect(sanitizeWorktreeNamePart("../bad/name")).toBe("bad-name");
    });

    it("validates project names and target directories", async () => {
        expect(validateWorktreeProjectName("")).toBeTruthy();
        expect(validateWorktreeProjectName(".")).toBeTruthy();
        expect(validateWorktreeProjectName("bad/name")).toBeTruthy();
        expect(validateWorktreeProjectName("good-name")).toBeNull();

        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-"));
        const target = await resolveAndValidateWorktreeTarget(parent, "new-worktree");
        expect(target).toBe(path.join(parent, "new-worktree"));

        await fs.mkdir(target);
        await expect(resolveAndValidateWorktreeTarget(parent, "new-worktree")).rejects.toThrow(
            "already exists",
        );
    });

    it("copies local worktree files without overwriting checked out files", async () => {
        const parent = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-worktree-copy-"));
        const repoRoot = path.join(parent, "repo");
        const target = path.join(parent, "target");
        await fs.mkdir(path.join(repoRoot, ".vscode"), { recursive: true });
        await fs.mkdir(path.join(target, ".vscode"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".envrc"), "export TOKEN=local\n");
        await fs.writeFile(path.join(repoRoot, ".vscode", "settings.json"), "local settings\n");
        await fs.writeFile(path.join(repoRoot, ".vscode", "extensions.json"), "local extensions\n");
        await fs.writeFile(path.join(target, ".vscode", "extensions.json"), "tracked extensions\n");

        await copyWorktreeLocalFiles(repoRoot, target);

        await expect(fs.readFile(path.join(target, ".envrc"), "utf8")).resolves.toBe(
            "export TOKEN=local\n",
        );
        await expect(
            fs.readFile(path.join(target, ".vscode", "settings.json"), "utf8"),
        ).resolves.toBe("local settings\n");
        await expect(
            fs.readFile(path.join(target, ".vscode", "extensions.json"), "utf8"),
        ).resolves.toBe("tracked extensions\n");
    });

    it("parses worktree porcelain output and detects checked out local branches", () => {
        const worktrees = parseWorktreeListPorcelain(
            [
                "worktree /repo",
                "HEAD abc123",
                "branch refs/heads/main",
                "",
                "worktree /repo-feature",
                "HEAD def456",
                "branch refs/heads/feature/demo",
                "",
                "worktree /detached",
                "HEAD feed00",
                "detached",
            ].join("\n"),
        );

        expect(worktrees).toEqual([
            { path: "/repo", head: "abc123", branch: "main", detached: false },
            { path: "/repo-feature", head: "def456", branch: "feature/demo", detached: false },
            { path: "/detached", head: "feed00", detached: true },
        ]);
        expect(findWorktreeForBranch(branch({ name: "feature/demo" }), worktrees)).toEqual({
            path: "/repo-feature",
            head: "def456",
            branch: "feature/demo",
            detached: false,
        });
        expect(isLocalBranchCheckedOut(branch({ name: "main" }), worktrees)).toBe(true);
        expect(isLocalBranchCheckedOut(branch({ name: "origin/main", isRemote: true }), worktrees)).toBe(
            false,
        );
    });

    it("builds git worktree args and remote fetch targets", () => {
        expect(
            buildWorktreeAddArgs({
                targetPath: "/repo-main",
                fromBranch: "main",
            }),
        ).toEqual(["worktree", "add", "/repo-main", "main"]);
        expect(
            buildWorktreeAddArgs({
                targetPath: "/repo-feature",
                fromBranch: "origin/main",
                newBranchName: "feature/new",
            }),
        ).toEqual(["worktree", "add", "-b", "feature/new", "/repo-feature", "origin/main"]);
        expect(buildWorktreeRemoveArgs("/repo-feature")).toEqual([
            "worktree",
            "remove",
            "/repo-feature",
        ]);
        expect(() => buildWorktreeRemoveArgs("")).toThrow("Worktree path is required");
        expect(() =>
            buildWorktreeAddArgs({
                targetPath: "/repo-feature",
                fromBranch: "main",
                newBranchName: "-bad",
            }),
        ).toThrow("Invalid branch name");
        expect(resolveRemoteBranchTarget(branch({ name: "origin/main", isRemote: true, remote: "origin" }))).toEqual({
            remote: "origin",
            remoteBranch: "main",
        });
    });

    it("detects the current worktree path", () => {
        const root = path.join(os.tmpdir(), "intelligit-current-worktree");
        expect(isCurrentWorktreePath(root, path.join(root, "."))).toBe(true);
        expect(isCurrentWorktreePath(root, path.join(root, "child"))).toBe(false);
    });
});
