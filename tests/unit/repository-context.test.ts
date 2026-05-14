import { describe, expect, it, vi } from "vitest";
import { isPathInsideRepository } from "../../src/services/RepositoryContextService";

vi.mock("vscode", () => ({
    EventEmitter: class {
        event = vi.fn();
        fire = vi.fn();
    },
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
});
