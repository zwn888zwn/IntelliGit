import * as fs from "fs/promises";
import { describe, expect, it, vi } from "vitest";
import { isPathInsideRepository, RepositoryContextService } from "../../src/services/RepositoryContextService";

vi.mock("fs/promises", () => ({ readdir: vi.fn() }));
vi.mock("../../src/git/executor", () => ({ GitExecutor: class {} }));
vi.mock("../../src/git/operations", () => ({
    GitOps: class {
        async isRepository() { return true; }
    },
}));

vi.mock("vscode", () => ({
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
    },
    window: {},
    Uri: { file: (value: string) => ({ fsPath: value, path: value }) },
}));

describe("RepositoryContextService path matching", () => {
    it("matches the repository root itself", () => {
        expect(isPathInsideRepository("/workspace/repo", "/workspace/repo")).toBe(true);
    });

    it("matches files inside a repository", () => {
        expect(isPathInsideRepository("/workspace/repo/src/index.ts", "/workspace/repo")).toBe(true);
    });

    it("does not match sibling repositories", () => {
        expect(isPathInsideRepository("/workspace/repo-a/src/index.ts", "/workspace/repo")).toBe(false);
    });

    it("bounds concurrent discovery while preserving nested repositories and worktrees", async () => {
        const directory = (name: string) => ({ name, isDirectory: () => true });
        const file = (name: string) => ({ name, isDirectory: () => false });
        const repoNames = Array.from({ length: 40 }, (_, index) => `repo-${index}`);
        const tree = new Map([
            ["/workspace", [
                ...repoNames.map(directory),
                directory("node_modules"),
                directory(".hg"),
                directory(".svn"),
                directory("unreadable"),
                file("symlink"),
            ]],
            ...repoNames.map((name, index) => [
                `/workspace/${name}`,
                index === 0
                    ? [directory(".git"), directory("nested")]
                    : [file(".git")],
            ] as const),
            ["/workspace/repo-0/nested", [directory(".git")]],
        ]);
        let activeReads = 0;
        let maxActiveReads = 0;
        vi.mocked(fs.readdir).mockImplementation(async (dir) => {
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeReads -= 1;
            const entries = tree.get(String(dir));
            if (!entries) throw new Error("Cannot read directory");
            return entries as never;
        });

        const service = new RepositoryContextService({ fsPath: "/workspace" } as never);
        await service.initialize();

        expect(service.listRepositories().map((entry) => entry.root)).toEqual(
            [...repoNames.map((name) => `/workspace/${name}`), "/workspace/repo-0/nested"]
                .sort((left, right) => left.localeCompare(right)),
        );
        expect(maxActiveReads).toBeGreaterThan(1);
        expect(maxActiveReads).toBeLessThanOrEqual(32);
        const visited = vi.mocked(fs.readdir).mock.calls.map(([dir]) => String(dir));
        expect(visited).toContain("/workspace/unreadable");
        expect(visited).not.toContain("/workspace/node_modules");
        expect(visited).not.toContain("/workspace/.hg");
        expect(visited).not.toContain("/workspace/.svn");
        expect(visited).not.toContain("/workspace/repo-0/.git");
        expect(visited).not.toContain("/workspace/symlink");
    });
});
