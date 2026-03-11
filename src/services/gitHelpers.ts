// Git helper functions extracted from extension.ts.
// Provides branch resolution, hash validation, and commit utilities
// used by multiple command modules.

import { spawnSync } from "child_process";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import { getErrorMessage } from "../utils/errors";
import { EMPTY_TREE_HASH } from "../utils/constants";
import { runWithNotificationProgress } from "../utils/notifications";

export interface MainlineParentPickResult {
    kind: "notMerge" | "cancelled" | "selected";
    parentNumber?: number;
}

export function isValidGitHash(value: string): boolean {
    return /^[0-9a-fA-F]{7,40}$/.test(value);
}

export function isValidBranchName(value: string): boolean {
    if (!value) return false;
    try {
        const result = spawnSync("git", ["check-ref-format", "--branch", value], {
            encoding: "utf8",
            timeout: 5000,
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

export function isValidTagName(value: string): boolean {
    if (!value) return false;
    try {
        const result = spawnSync("git", ["check-ref-format", `refs/tags/${value}`], {
            encoding: "utf8",
            timeout: 5000,
        });
        return result.status === 0;
    } catch {
        return false;
    }
}

export function isHashMatch(a: string, b: string): boolean {
    return a.startsWith(b) || b.startsWith(a);
}

export function getLocalNameFromRemote(remoteBranchName: string): string {
    return remoteBranchName.split("/").slice(1).join("/");
}

export async function getCheckedOutBranchName(
    executor: GitExecutor,
    currentBranches: Branch[],
): Promise<string | null> {
    try {
        const head = (await executor.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
        if (head && head !== "HEAD") return head;
    } catch {
        // Fall back to cached branch metadata.
    }
    return currentBranches.find((b) => b.isCurrent)?.name ?? null;
}

export function resolveTrackedRemoteBranch(
    branch: Branch,
    currentBranches: Branch[],
): { remote: string; remoteBranch: string } | null {
    if (branch.upstream && branch.upstream.includes("/")) {
        const [remote, ...rest] = branch.upstream.split("/");
        const remoteBranch = rest.join("/");
        if (remote && remoteBranch) {
            return { remote, remoteBranch };
        }
    }

    if (branch.remote) {
        const expected = `${branch.remote}/${branch.name}`;
        if (currentBranches.some((b) => b.isRemote && b.name === expected)) {
            return { remote: branch.remote, remoteBranch: branch.name };
        }
    }

    // Fallback: match remote branches whose name ends with the local branch name.
    // Only used when there is exactly one match to avoid ambiguity.
    const suffixMatches = currentBranches.filter(
        (b) => b.isRemote && b.name.endsWith(`/${branch.name}`),
    );
    if (suffixMatches.length === 1) {
        const [remote, ...rest] = suffixMatches[0].name.split("/");
        const remoteBranch = rest.join("/");
        if (remote && remoteBranch) {
            return { remote, remoteBranch };
        }
    }

    return null;
}

export function resolveRemoteDeleteTarget(
    branch: Branch,
): { remote: string; remoteBranch: string } | null {
    if (!branch.isRemote) return null;
    const parts = branch.name.split("/");
    if (parts.length < 2) return null;

    const remote = branch.remote ?? parts[0];
    const remoteBranch = parts.slice(1).join("/");
    if (!remote || !remoteBranch) return null;

    return { remote, remoteBranch };
}

export async function resolveRemoteName(
    branch: Branch,
    executor: GitExecutor,
): Promise<string | null> {
    if (branch.remote) return branch.remote;
    try {
        const raw = await executor.run(["remote"]);
        const remotes = raw
            .split("\n")
            .map((r) => r.trim())
            .filter(Boolean);
        return remotes[0] ?? null;
    } catch {
        return null;
    }
}

export async function getCommitParentHashes(
    hash: string,
    executor: GitExecutor,
): Promise<string[]> {
    const raw = (await executor.run(["rev-list", "--parents", "-n", "1", hash])).trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts.slice(1);
}

export async function isMergeCommitHash(hash: string, executor: GitExecutor): Promise<boolean> {
    return (await getCommitParentHashes(hash, executor)).length > 1;
}

export async function isCommitUnpushed(hash: string, gitOps: GitOps): Promise<boolean> {
    const unpushed = await gitOps.getUnpushedCommitHashes();
    return unpushed.some((h) => isHashMatch(h, hash));
}

export async function getUndoCommitCount(hash: string, executor: GitExecutor): Promise<number> {
    const raw = (await executor.run(["rev-list", "--count", `${hash}^..HEAD`])).trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export async function pickMainlineParent(
    hash: string,
    actionLabel: string,
    executor: GitExecutor,
    knownParents?: string[],
): Promise<MainlineParentPickResult> {
    const parents = knownParents ?? (await getCommitParentHashes(hash, executor));
    if (parents.length <= 1) return { kind: "notMerge" };

    const pick = await vscode.window.showQuickPick(
        parents.map((parent, idx) => ({
            label: `Parent ${idx + 1} (${parent.slice(0, 8)})`,
            detail:
                idx === 0
                    ? "Usually the target branch side of the merge."
                    : "Alternate merge parent.",
            parentNumber: idx + 1,
        })),
        {
            title: `${actionLabel}: select mainline parent`,
            placeHolder: "Pick the parent number to use with -m",
        },
    );

    if (!pick) return { kind: "cancelled" };
    return { kind: "selected", parentNumber: pick.parentNumber };
}

export async function checkoutBranch(
    branch: Branch,
    currentBranches: Branch[],
    executor: GitExecutor,
): Promise<string> {
    if (!branch.isRemote) {
        await executor.run(["checkout", branch.name]);
        return branch.name;
    }

    const localName = getLocalNameFromRemote(branch.name);
    const existingLocal = currentBranches.find((b) => !b.isRemote && b.name === localName);
    if (existingLocal) {
        await executor.run(["checkout", existingLocal.name]);
        return existingLocal.name;
    }

    await executor.run(["checkout", "--track", branch.name]);
    return localName;
}

export async function buildCommitFilePatch(
    commitHash: string,
    filePath: string,
    actionLabel: string,
    executor: GitExecutor,
): Promise<string | null> {
    const parents = await getCommitParentHashes(commitHash, executor);

    let baseRef: string;
    if (parents.length > 1) {
        const result = await pickMainlineParent(commitHash, actionLabel, executor, parents);
        if (result.kind === "cancelled") return null;
        baseRef = `${commitHash}^${result.parentNumber}`;
    } else {
        baseRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
    }

    return executor.run([
        "diff",
        "--binary",
        "--full-index",
        "--no-color",
        baseRef,
        commitHash,
        "--",
        filePath,
    ]);
}

export async function getLocalBranchMergeStatusForDelete(
    branchName: string,
    currentBranchName: string | null,
    executor: GitExecutor,
): Promise<{ merged: boolean; target: string }> {
    const target = currentBranchName?.trim() || "HEAD";
    try {
        await executor.run(["merge-base", "--is-ancestor", branchName, target]);
        return { merged: true, target };
    } catch {
        return { merged: false, target };
    }
}

export async function showDeletedBranchActions(
    branch: Branch,
    currentBranches: Branch[],
    executor: GitExecutor,
): Promise<void> {
    const restoreLabel = "Restore";
    const deleteTrackedLabel = "Delete Tracked Branch";
    const tracked = resolveTrackedRemoteBranch(branch, currentBranches);
    const buttons = tracked ? [restoreLabel, deleteTrackedLabel] : [restoreLabel];
    const action = await vscode.window.showInformationMessage(
        `Deleted: ${branch.name}`,
        ...buttons,
    );

    if (action === restoreLabel) {
        if (!isValidGitHash(branch.hash)) {
            vscode.window.showErrorMessage(
                `Cannot restore '${branch.name}': missing or invalid commit hash.`,
            );
            return;
        }
        try {
            await executor.run(["branch", branch.name, branch.hash]);
            vscode.window.showInformationMessage(`Restored ${branch.name}`);
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const msg = getErrorMessage(error);
            vscode.window.showErrorMessage(`Restore failed: ${msg}`);
        }
        return;
    }

    if (action === deleteTrackedLabel && tracked) {
        const confirm = await vscode.window.showWarningMessage(
            `Delete tracked branch '${tracked.remote}/${tracked.remoteBranch}'?`,
            { modal: true },
            deleteTrackedLabel,
        );
        if (confirm !== deleteTrackedLabel) return;

        try {
            await runWithNotificationProgress(
                `Deleting tracked branch ${tracked.remote}/${tracked.remoteBranch}...`,
                async () => {
                    await executor.run(["push", tracked.remote, "--delete", tracked.remoteBranch]);
                },
            );
            vscode.window.showInformationMessage(
                `Deleted tracked branch ${tracked.remote}/${tracked.remoteBranch}`,
            );
            await vscode.commands.executeCommand("intelligit.refresh");
        } catch (error) {
            const msg = getErrorMessage(error);
            vscode.window.showErrorMessage(`Delete tracked branch failed: ${msg}`);
        }
    }
}
