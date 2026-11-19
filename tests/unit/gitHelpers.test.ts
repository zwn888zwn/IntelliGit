// Tests for pure utility functions in src/services/gitHelpers.ts.

import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => ({
    window: {
        showQuickPick: vi.fn(),
        showWarningMessage: vi.fn(),
        showInformationMessage: vi.fn(),
    },
}));

import {
    isValidGitHash,
    isValidBranchName,
    isHashMatch,
    getLocalNameFromRemote,
    resolveTrackedRemoteBranch,
    resolveRemoteDeleteTarget,
} from "../../src/services/gitHelpers";
import type { Branch } from "../../src/types";

function makeBranch(overrides: Partial<Branch> = {}): Branch {
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

describe("isValidGitHash", () => {
    it("accepts 7-char hex hash", () => {
        expect(isValidGitHash("abc1234")).toBe(true);
    });

    it("accepts 40-char full hash", () => {
        expect(isValidGitHash("a".repeat(40))).toBe(true);
    });

    it("rejects shorter than 7 chars", () => {
        expect(isValidGitHash("abc12")).toBe(false);
    });

    it("rejects non-hex characters", () => {
        expect(isValidGitHash("ghijklm")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(isValidGitHash("")).toBe(false);
    });

    it("rejects hash longer than 40 chars", () => {
        expect(isValidGitHash("a".repeat(41))).toBe(false);
    });
});

describe("isValidBranchName", () => {
    it("accepts standard branch names", () => {
        expect(isValidBranchName("feature/my-branch")).toBe(true);
        expect(isValidBranchName("main")).toBe(true);
        expect(isValidBranchName("v1.0.0")).toBe(true);
    });

    it("rejects names starting with dash", () => {
        expect(isValidBranchName("-bad")).toBe(false);
    });

    it("rejects empty string", () => {
        expect(isValidBranchName("")).toBe(false);
    });

    it("rejects names with spaces", () => {
        expect(isValidBranchName("my branch")).toBe(false);
    });

    it("allows underscores and dots", () => {
        expect(isValidBranchName("my_branch.test")).toBe(true);
    });
});

describe("isHashMatch", () => {
    it("matches when a is prefix of b", () => {
        expect(isHashMatch("abc1234", "abc1234567890")).toBe(true);
    });

    it("matches when b is prefix of a", () => {
        expect(isHashMatch("abc1234567890", "abc1234")).toBe(true);
    });

    it("matches identical hashes", () => {
        expect(isHashMatch("abc1234", "abc1234")).toBe(true);
    });

    it("does not match different hashes", () => {
        expect(isHashMatch("abc1234", "def5678")).toBe(false);
    });
});

describe("getLocalNameFromRemote", () => {
    it("strips single remote prefix", () => {
        expect(getLocalNameFromRemote("origin/main")).toBe("main");
    });

    it("preserves slashes in branch name", () => {
        expect(getLocalNameFromRemote("origin/feature/my-branch")).toBe("feature/my-branch");
    });
});

describe("resolveTrackedRemoteBranch", () => {
    it("resolves from upstream field", () => {
        const branch = makeBranch({ upstream: "origin/main" });
        const result = resolveTrackedRemoteBranch(branch);
        expect(result).toEqual({ remote: "origin", remoteBranch: "main" });
    });

    it("does not treat a remote name as a configured upstream", () => {
        expect(resolveTrackedRemoteBranch(makeBranch({ name: "fix", remote: "origin" }))).toBeNull();
    });

    it("returns null when no match found", () => {
        const branch = makeBranch({ name: "feature" });
        const result = resolveTrackedRemoteBranch(branch);
        expect(result).toBeNull();
    });
});

describe("resolveRemoteDeleteTarget", () => {
    it("resolves remote branch from remote branch object", () => {
        const branch = makeBranch({
            name: "origin/feature",
            isRemote: true,
            remote: "origin",
        });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toEqual({ remote: "origin", remoteBranch: "feature" });
    });

    it("falls back to parsing name when remote not set", () => {
        const branch = makeBranch({
            name: "upstream/release/v2",
            isRemote: true,
        });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toEqual({ remote: "upstream", remoteBranch: "release/v2" });
    });

    it("returns null for local branches", () => {
        const branch = makeBranch({ isRemote: false });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toBeNull();
    });

    it("returns null for single-part name", () => {
        const branch = makeBranch({ name: "main", isRemote: true });
        const result = resolveRemoteDeleteTarget(branch);
        expect(result).toBeNull();
    });
});
