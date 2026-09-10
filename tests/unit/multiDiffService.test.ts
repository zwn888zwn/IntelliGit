import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { executeCommand, showInformationMessage, showQuickPick } = vi.hoisted(() => ({
    executeCommand: vi.fn(async () => undefined),
    showInformationMessage: vi.fn(async () => undefined),
    showQuickPick: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => {
    class Uri {
        private constructor(
            public readonly scheme: string,
            public readonly path: string,
            public readonly query: string,
        ) {}
        static file(fsPath: string): Uri {
            return new Uri("file", fsPath, "");
        }
        static from(options: { scheme: string; path: string; query?: string }): Uri {
            return new Uri(options.scheme, options.path, options.query ?? "");
        }
        get fsPath(): string {
            return this.path;
        }
        toString(): string {
            return `${this.scheme}:${this.path}?${this.query}`;
        }
    }
    return {
        Uri,
        commands: { executeCommand },
        window: { showInformationMessage, showQuickPick },
    };
});

import {
    openBranchComparisonChanges,
    openCommitChanges,
    openShelvedChanges,
    openStageChanges,
    openWorkingTreeChanges,
} from "../../src/services/multiDiffService";
import { GitExecutor } from "../../src/git/executor";
import type { ProjectComparisonFile, WorkingFile } from "../../src/types";

type MockUri = { scheme: string; path: string; fsPath: string; query: string };
type TestResource = [MockUri, MockUri | undefined, MockUri | undefined];

const repoRoot = "/repo";
const hash = (char: string): string => char.repeat(40);

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function makeGitFixture(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "intelligit-multi-diff-"));
    git(cwd, "init", "-q");
    git(cwd, "config", "user.email", "intelligit@example.test");
    git(cwd, "config", "user.name", "IntelliGit Tests");
    return cwd;
}
function removeGitFixture(cwd: string): void {
    fs.rmSync(cwd, { recursive: true, force: true });
}
function workingFile(filePath: string, staged = false): WorkingFile {
    return {
        repoId: "repo",
        repoRoot,
        path: filePath,
        status: "M",
        staged,
        additions: 1,
        deletions: 0,
    };
}
function comparisonFile(filePath: string, oldPath?: string): ProjectComparisonFile {
    return {
        repoId: "repo",
        repoRoot,
        path: filePath,
        oldPath,
        status: oldPath ? "R" : "M",
        additions: 1,
        deletions: 0,
    };
}
function makeExecutor(responses: (args: string[]) => string): GitExecutor {
    return { run: vi.fn(async (args: string[]) => responses(args)) } as unknown as GitExecutor;
}
function lastChangesCall(): [string, unknown[]] {
    const call = executeCommand.mock.calls.find(([command]) => command === "vscode.changes");
    expect(call).toBeDefined();
    return call!.slice(1) as unknown as [string, unknown[]];
}
function query(uri: { query: string }): { path: string; ref: string } {
    return JSON.parse(uri.query) as { path: string; ref: string };
}
function getResourceTuples(): TestResource[] {
    const [, resources] = lastChangesCall();
    return resources as TestResource[];
}
function gitContent(cwd: string, uri: MockUri): Buffer {
    const parsed = query(uri);
    const relativePath = path.relative(cwd, parsed.path).split(path.sep).join("/");
    return execFileSync("git", ["show", `${parsed.ref}:${relativePath}`], { cwd });
}

beforeEach(() => {
    executeCommand.mockClear();
    showInformationMessage.mockClear();
    showQuickPick.mockClear();
});

describe("multi diff resources", () => {
    it("opens HEAD to working tree changes with rename paths and file RHS", async () => {
        const head = hash("a");
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") return `${head}\n`;
            if (args[0] === "diff") return `R100\0old.txt\0new.txt\0`;
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openWorkingTreeChanges([workingFile("new.txt")], repoRoot, executor);
        const [title, rawResources] = lastChangesCall();
        expect(title).toBe("Working Tree Changes");
        const resources = rawResources as TestResource[];
        expect(resources).toHaveLength(1);
        expect(resources[0][0].fsPath).toBe("/repo/new.txt");
        expect(query(resources[0][1]!)).toMatchObject({ path: "/repo/old.txt", ref: head });
        expect(resources[0][2]!.scheme).toBe("file");
    });

    it("uses an empty ref for the index in staged and unstaged native tuples", async () => {
        const head = hash("b");
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") return `${head}\n`;
            if (args[0] === "diff" && args.includes("--cached")) return "M\0staged.txt\0";
            if (args[0] === "diff") return "M\0unstaged.txt\0";
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openStageChanges([workingFile("staged.txt", true)], repoRoot, executor, true);
        let [, rawResources] = lastChangesCall();
        let resources = rawResources as TestResource[];
        expect(query(resources[0][1]!).ref).toBe(head);
        expect(query(resources[0][2]!).ref).toBe("");
        executeCommand.mockClear();
        await openStageChanges([workingFile("unstaged.txt")], repoRoot, executor, false);
        [, rawResources] = lastChangesCall();
        resources = rawResources as TestResource[];
        expect(query(resources[0][1]!).ref).toBe("");
        expect(resources[0][2]!.scheme).toBe("file");
    });

    it("pins stash and untracked files to immutable hashes in one open", async () => {
        const stash = hash("c");
        const base = hash("d");
        const untracked = hash("e");
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") return `${stash}\n`;
            if (args[0] === "rev-list") return `${stash} ${base} ${hash("f")} ${untracked}\n`;
            if (args[0] === "diff" && args.includes(stash)) return `M\0tracked.txt\0`;
            if (args[0] === "diff") return `A\0untracked.txt\0`;
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openShelvedChanges(2, repoRoot, executor);
        const [title, rawResources] = lastChangesCall();
        expect(title).toBe("Stash 2 Changes");
        const resources = rawResources as TestResource[];
        expect(resources).toHaveLength(2);
        const untrackedTuple = resources.find((tuple) => tuple[0].fsPath.endsWith("untracked.txt"));
        expect(untrackedTuple).toBeDefined();
        expect(untrackedTuple?.[1]).toBeUndefined();
        expect(query(untrackedTuple![2]!)).toMatchObject({ ref: untracked });
        expect(executeCommand).toHaveBeenCalledTimes(1);
    });

    it("asks for one merge parent and compares the selected parent directly", async () => {
        const commit = hash("1");
        const first = hash("2");
        const second = hash("3");
        showQuickPick.mockResolvedValueOnce({ parentNumber: 2 });
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") return `${commit}\n`;
            if (args[0] === "rev-list") return `${commit} ${first} ${second}\n`;
            if (args[0] === "diff") return `M\0merge.txt\0`;
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openCommitChanges(commit, repoRoot, executor);
        const [title, rawResources] = lastChangesCall();
        expect(title).toBe(`Commit ${commit.slice(0, 8)} Changes`);
        const resources = rawResources as TestResource[];
        expect(query(resources[0][1]!).ref).toBe(second);
        expect(query(resources[0][2]!).ref).toBe(commit);
        expect(showQuickPick).toHaveBeenCalledTimes(1);
    });

    it("does not invoke changes for a canceled parent or an empty scope", async () => {
        const head = hash("4");
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") return `${head}\n`;
            if (args[0] === "diff") return "";
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openWorkingTreeChanges([workingFile("missing.txt")], repoRoot, executor);
        expect(executeCommand).not.toHaveBeenCalled();
        expect(showInformationMessage).toHaveBeenCalledWith("No working tree changes to show.");
    });

    it("handles an unborn HEAD without turning a staged add into a deletion", async () => {
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse") throw new Error("unborn HEAD");
            if (args[0] === "diff" && args.includes("--cached")) return "A\0new.txt\0";
            if (args[0] === "diff") return "M\0new.txt\0";
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openWorkingTreeChanges([workingFile("new.txt")], repoRoot, executor);
        const [, rawResources] = lastChangesCall();
        const resources = rawResources as TestResource[];
        expect(resources[0][1]).toBeUndefined();
        expect(resources[0][2]!.scheme).toBe("file");
        executeCommand.mockClear();
        const canceled = makeExecutor((args) => {
            if (args[0] === "rev-parse") throw new Error("unborn HEAD");
            if (args[0] === "diff" && args.includes("--cached")) return "A\0gone.txt\0";
            if (args[0] === "diff") return "D\0gone.txt\0";
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openWorkingTreeChanges([workingFile("gone.txt")], repoRoot, canceled);
        expect(executeCommand).not.toHaveBeenCalled();
    });

    it("filters branch comparison changes by selected path", async () => {
        const source = hash("5");
        const head = hash("6");
        const executor = makeExecutor((args) => {
            if (args[0] === "rev-parse" && args[2]?.startsWith("HEAD")) return `${head}\n`;
            if (args[0] === "rev-parse") return `${source}\n`;
            if (args[0] === "diff") return `M\0selected.txt\0M\0other.txt\0`;
            if (args[0] === "ls-files") return "";
            throw new Error(`unexpected git args: ${args.join(" ")}`);
        });
        await openBranchComparisonChanges(
            [comparisonFile("selected.txt")],
            "feature",
            { kind: "current-branch", label: "Current Branch" },
            repoRoot,
            executor,
        );
        const [title, rawResources] = lastChangesCall();
        expect(title).toBe("feature ↔ Current Branch");
        expect(rawResources as TestResource[]).toHaveLength(1);
    });
});

describe("multi diff against real Git repositories", () => {
    it("keeps HEAD, index, and working tree bytes distinct for a partial staged edit", async () => {
        const cwd = makeGitFixture();
        try {
            fs.writeFileSync(path.join(cwd, "partial.txt"), "head\n");
            git(cwd, "add", "partial.txt");
            git(cwd, "commit", "--no-verify", "-qm", "initial");
            const head = git(cwd, "rev-parse", "HEAD").trim();
            fs.writeFileSync(path.join(cwd, "partial.txt"), "index\n");
            git(cwd, "add", "partial.txt");
            fs.writeFileSync(path.join(cwd, "partial.txt"), "working\n");
            const executor = new GitExecutor(cwd);
            await openStageChanges([workingFile("partial.txt", true)], cwd, executor, true);
            let [original, modified] = getResourceTuples()[0].slice(1) as [MockUri, MockUri];
            expect(query(original).ref).toBe(head);
            expect(gitContent(cwd, original).toString()).toBe("head\n");
            expect(query(modified).ref).toBe("");
            expect(gitContent(cwd, modified).toString()).toBe("index\n");
            executeCommand.mockClear();
            await openStageChanges([workingFile("partial.txt")], cwd, executor, false);
            [original, modified] = getResourceTuples()[0].slice(1) as [MockUri, MockUri];
            expect(query(original).ref).toBe("");
            expect(gitContent(cwd, original).toString()).toBe("index\n");
            expect(modified.scheme).toBe("file");
            expect(fs.readFileSync(modified.fsPath).toString()).toBe("working\n");
        } finally {
            removeGitFixture(cwd);
        }
    });

    it("keeps native binary URIs for rename, deletion, and untracked addition", async () => {
        const cwd = makeGitFixture();
        try {
            fs.writeFileSync(path.join(cwd, "old.bin"), Buffer.from([0, 1, 2, 3]));
            fs.writeFileSync(path.join(cwd, "gone.bin"), Buffer.from([4, 5, 6]));
            git(cwd, "add", ".");
            git(cwd, "commit", "--no-verify", "-qm", "initial");
            git(cwd, "mv", "old.bin", "renamed.bin");
            fs.unlinkSync(path.join(cwd, "gone.bin"));
            fs.writeFileSync(path.join(cwd, "new.bin"), Buffer.from([7, 8, 9, 10]));
            await openWorkingTreeChanges(
                [workingFile("renamed.bin"), workingFile("gone.bin"), workingFile("new.bin")],
                cwd,
                new GitExecutor(cwd),
            );
            const tuples = getResourceTuples();
            const rename = tuples.find((tuple) => tuple[0].fsPath.endsWith("renamed.bin"));
            const deleted = tuples.find((tuple) => tuple[0].fsPath.endsWith("gone.bin"));
            const added = tuples.find((tuple) => tuple[0].fsPath.endsWith("new.bin"));
            expect(rename?.[1] && query(rename[1])).toMatchObject({
                path: path.join(cwd, "old.bin"),
                ref: expect.any(String),
            });
            expect(rename?.[2]?.scheme).toBe("file");
            expect(fs.readFileSync(rename![2]!.fsPath)).toEqual(Buffer.from([0, 1, 2, 3]));
            expect(deleted?.[1] && query(deleted[1])).toMatchObject({
                path: path.join(cwd, "gone.bin"),
                ref: expect.any(String),
            });
            expect(deleted?.[2]).toBeUndefined();
            expect(added?.[1]).toBeUndefined();
            expect(fs.readFileSync(added![2]!.fsPath)).toEqual(Buffer.from([7, 8, 9, 10]));
        } finally {
            removeGitFixture(cwd);
        }
    });

    it("pins stash untracked bytes to its third parent and handles unborn/root commits", async () => {
        const cwd = makeGitFixture();
        try {
            fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
            git(cwd, "add", "tracked.txt");
            git(cwd, "commit", "--no-verify", "-qm", "initial");
            fs.writeFileSync(path.join(cwd, "tracked.txt"), "shelved\n");
            fs.writeFileSync(path.join(cwd, "shelved.bin"), Buffer.from([11, 12, 13]));
            git(cwd, "stash", "push", "--include-untracked", "-m", "stash fixture");
            const stashHash = git(cwd, "rev-parse", "stash@{0}").trim();
            const parents = git(cwd, "rev-list", "--parents", "-n", "1", stashHash)
                .trim()
                .split(/\s+/);
            const untrackedHash = parents[3];
            const executor = new GitExecutor(cwd);
            await openShelvedChanges(0, cwd, executor, stashHash);
            const tuples = getResourceTuples();
            const tracked = tuples.find((tuple) => tuple[0].fsPath.endsWith("tracked.txt"));
            const shelved = tuples.find((tuple) => tuple[0].fsPath.endsWith("shelved.bin"));
            expect(tracked && query(tracked[2]!)).toMatchObject({ ref: stashHash });
            expect(gitContent(cwd, tracked![1]!).toString()).toBe("base\n");
            expect(gitContent(cwd, tracked![2]!).toString()).toBe("shelved\n");
            expect(shelved?.[1]).toBeUndefined();
            expect(query(shelved![2]!)).toMatchObject({ ref: untrackedHash });
            expect(gitContent(cwd, shelved![2]!).equals(Buffer.from([11, 12, 13]))).toBe(true);

            executeCommand.mockClear();
            const unborn = makeGitFixture();
            try {
                fs.writeFileSync(path.join(unborn, "first.txt"), "first\n");
                git(unborn, "add", "first.txt");
                fs.writeFileSync(path.join(unborn, "first.txt"), "working\n");
                await openWorkingTreeChanges(
                    [workingFile("first.txt")],
                    unborn,
                    new GitExecutor(unborn),
                );
                const first = getResourceTuples()[0];
                expect(first[1]).toBeUndefined();
                expect(fs.readFileSync(first[2]!.fsPath).toString()).toBe("working\n");
                executeCommand.mockClear();
                fs.unlinkSync(path.join(unborn, "first.txt"));
                await openWorkingTreeChanges(
                    [workingFile("first.txt")],
                    unborn,
                    new GitExecutor(unborn),
                );
                expect(executeCommand).not.toHaveBeenCalled();
                fs.writeFileSync(path.join(unborn, "root.txt"), "root\n");
                git(unborn, "add", "root.txt");
                git(unborn, "commit", "--no-verify", "-qm", "root");
                const rootHash = git(unborn, "rev-parse", "HEAD").trim();
                await openCommitChanges(rootHash, unborn, new GitExecutor(unborn));
                const rootTuple = getResourceTuples()[0];
                expect(rootTuple[1]).toBeUndefined();
                expect(query(rootTuple[2]!)).toMatchObject({ ref: rootHash });
            } finally {
                removeGitFixture(unborn);
            }
        } finally {
            removeGitFixture(cwd);
        }
    });
});
