// Commit context menu action handlers extracted from extension.ts.
// Each action handles a right-click operation on a commit in the
// commit graph: cherry-pick, revert, reset, rebase, tag, etc.

import * as path from "path";
import * as vscode from "vscode";
import { firstPushRemote, readBranchTracking } from "../git/branchTracking";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import { prepareSquash, applySquash, prepareReword, applyReword, undoRewrite, type RewriteReceipt } from "../git/squash";
import type { CommitAction, EditHistoryPrompt } from "../webviews/react/commitGraphTypes";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import { showPushSuccessWithRequestLink } from "../utils/pushMergeRequest";
import {
    isValidGitHash,
    isValidBranchName,
    isValidTagName,
    isCommitUnpushed,
    isMergeCommitHash,
    getCommitParentHashes,
    getUndoCommitCount,
    getCheckedOutBranchName,
    pickMainlineParent,
} from "../services/gitHelpers";
import type { Branch } from "../types";

function assertNever(value: never): never {
    throw new Error(`Unhandled commit action: ${String(value)}`);
}

export async function handleCommitContextAction(params: {
    action: CommitAction;
    hash: string;
    hashes?: string[];
    executor: GitExecutor;
    gitOps: GitOps;
    repoRoot: string;
    currentBranches: Branch[];
    refreshAll: () => Promise<void>;
    editHistoryMessage: (prompt: EditHistoryPrompt) => Promise<string | undefined>;
}): Promise<void> {
    const { action, hash, executor, gitOps, repoRoot, currentBranches, refreshAll } = params;
    const validatedHash = hash.trim();
    if (!isValidGitHash(validatedHash)) {
        console.error("Blocked commit action due to invalid hash:", { action, hash });
        vscode.window.showErrorMessage("Invalid commit hash received for commit action.");
        return;
    }
    const short = validatedHash.slice(0, 8);

    async function finishRewrite(receipt: RewriteReceipt, status: string): Promise<void> {
        await refreshAll();
        const undo = await vscode.window.showInformationMessage(status, "Undo");
        if (undo !== "Undo") return;
        await runWithNotificationProgress("Restoring original commits...", () => undoRewrite(executor, receipt));
        await refreshAll();
        void vscode.window.showInformationMessage("Restored the original commits.");
    }

    switch (action) {
        case "squashCommits": {
            const plan = await prepareSquash(executor, params.hashes ?? validatedHash);
            const message = await params.editHistoryMessage({
                operation: "squash", repository: path.basename(repoRoot), branch: plan.branch,
                commits: plan.commits, message: plan.message,
            });
            if (!message?.trim()) return;
            const after = await runWithNotificationProgress("Squashing commits...", () => applySquash(executor, plan, message));
            await finishRewrite({ branch: plan.branch, before: plan.head, after, firstRewritten: after },
                `Squashed ${plan.hashes.length} commits into ${after.slice(0, 8)}.`);
            return;
        }
        case "copyRevision": {
            const copiedRevision = (
                await executor.run(["rev-parse", "--short", validatedHash])
            ).trim() || short;
            await vscode.env.clipboard.writeText(copiedRevision);
            vscode.window.showInformationMessage(`Copied revision ${copiedRevision}.`);
            return;
        }
        case "createPatch": {
            const defaultUri = vscode.Uri.file(path.join(repoRoot, `${short}.patch`));
            const targetUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { Patch: ["patch", "diff"] },
            });
            if (!targetUri) return;
            try {
                const patchText = await executor.run([
                    "format-patch",
                    "-1",
                    "--stdout",
                    validatedHash,
                ]);
                await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patchText, "utf8"));
                vscode.window.showInformationMessage(
                    `Patch created: ${path.basename(targetUri.fsPath)}`,
                );
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create patch: ${message}`);
            }
            return;
        }
        case "cherryPick": {
            const confirm = await vscode.window.showWarningMessage(
                `Cherry-pick commit ${short}?`,
                { modal: true },
                "Cherry-pick",
            );
            if (confirm !== "Cherry-pick") return;

            const mainlineParent = await pickMainlineParent(validatedHash, "Cherry-pick", executor);
            if (mainlineParent.kind === "cancelled") return;
            const args =
                mainlineParent.kind === "notMerge"
                    ? ["cherry-pick", validatedHash]
                    : ["cherry-pick", "-m", String(mainlineParent.parentNumber), validatedHash];
            try {
                await executor.run(args);
                vscode.window.showInformationMessage(`Cherry-picked ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Cherry-pick failed: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "checkoutRevision": {
            const confirm = await vscode.window.showWarningMessage(
                `Checkout commit ${short}? This creates a detached HEAD state.`,
                { modal: true },
                "Checkout",
            );
            if (confirm !== "Checkout") return;
            try {
                await executor.run(["checkout", validatedHash]);
                vscode.window.showInformationMessage(`Checked out revision ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Checkout failed: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "resetCurrentToHere": {
            const mode = await vscode.window.showQuickPick([
                { label: "Keep working files (Mixed)", description: "Move the branch here and leave changes unstaged.", flag: "--mixed" },
                { label: "Discard working changes (Hard)", description: "Restore tracked files and the index to this commit.", flag: "--hard" },
            ], { title: `Reset current branch to ${short}`, placeHolder: "Choose what happens to your files" });
            if (!mode) return;
            if (mode.flag === "--hard") {
                const confirm = await vscode.window.showWarningMessage(
                    `Hard reset to ${short}? Uncommitted changes to tracked files will be lost.`,
                    { modal: true }, "Discard Changes and Reset",
                );
                if (confirm !== "Discard Changes and Reset") return;
            }
            try {
                await executor.run(["reset", mode.flag, validatedHash]);
                const result = mode.flag === "--mixed" ? "Working files were kept." : "Tracked files were restored.";
                vscode.window.showInformationMessage(`Reset current branch to ${short}. ${result}`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Reset failed: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "revertCommit": {
            const confirm = await vscode.window.showWarningMessage(
                `Revert commit ${short}?`,
                { modal: true },
                "Revert",
            );
            if (confirm !== "Revert") return;
            const mainlineParent = await pickMainlineParent(validatedHash, "Revert", executor);
            if (mainlineParent.kind === "cancelled") return;
            const args =
                mainlineParent.kind === "notMerge"
                    ? ["revert", "--no-edit", validatedHash]
                    : [
                          "revert",
                          "-m",
                          String(mainlineParent.parentNumber),
                          "--no-edit",
                          validatedHash,
                      ];
            try {
                await executor.run(args);
                vscode.window.showInformationMessage(`Reverted ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Revert failed: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "pushAllUpToHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Push All up to Here is available only for unpushed commits.",
                );
                return;
            }

            const checkedOutBranchName = await getCheckedOutBranchName(executor, currentBranches);
            if (!checkedOutBranchName) {
                vscode.window.showErrorMessage(
                    "Push All up to Here is only available when a local branch is checked out.",
                );
                return;
            }

            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }

            const { upstream, pushRemote } = await readBranchTracking(executor, checkedOutBranchName);
            const remote = upstream?.remote ?? await firstPushRemote(executor, checkedOutBranchName, pushRemote);
            const destination = upstream?.remoteBranch ?? checkedOutBranchName;
            const target = `${remote}/${destination}`;
            const label = upstream ? "Push" : "Set Upstream and Push";
            const question = upstream
                ? `Push all commits up to ${short} to ${target}?`
                : `Set upstream for '${checkedOutBranchName}' to '${target}' and push commits up to ${short}?`;
            const confirm = await vscode.window.showWarningMessage(question, { modal: true }, label);
            if (confirm !== label) return;

            const pushOutput = await runWithNotificationProgress(`Pushing commits up to ${short}...`, () =>
                executor.runWithStderr(["push", remote, `${validatedHash}:refs/heads/${destination}`]),
            );
            // Git cannot infer a local tracking branch when the pushed source is a SHA.
            if (!upstream) {
                try {
                    await executor.run(["branch", "--set-upstream-to", target, checkedOutBranchName]);
                } catch (error) {
                    vscode.window.showWarningMessage(`Pushed to ${target}, but could not set the upstream: ${getErrorMessage(error)}`);
                }
            }

            await showPushSuccessWithRequestLink(`Pushed commits up to ${short}.`, pushOutput);
            await refreshAll();
            return;
        }
        case "newBranch": {
            const branchName = await vscode.window.showInputBox({
                prompt: `New branch from ${short}`,
                placeHolder: "branch-name",
            });
            if (!branchName) return;
            if (!isValidBranchName(branchName)) {
                vscode.window.showErrorMessage(
                    `Invalid branch name '${branchName}'. Names must contain only alphanumeric characters, dots, dashes, underscores, or slashes, and must not start with a dash.`,
                );
                return;
            }
            try {
                await executor.run(["branch", branchName, validatedHash]);
                vscode.window.showInformationMessage(`Created branch ${branchName} at ${short}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create branch: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "newTag": {
            const tagName = await vscode.window.showInputBox({
                prompt: `New tag at ${short}`,
                placeHolder: "v1.0.0",
            });
            if (!tagName) return;
            if (!isValidTagName(tagName)) {
                vscode.window.showErrorMessage(
                    `Invalid tag name '${tagName}'. Tag names must be valid git ref names.`,
                );
                return;
            }
            try {
                await executor.run(["tag", tagName, validatedHash]);
                vscode.window.showInformationMessage(`Created tag ${tagName}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to create tag: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "pushTag": {
            const tags = (await executor.run(["tag", "--points-at", validatedHash]))
                .split("\n")
                .map((tag) => tag.trim())
                .filter(Boolean);
            if (tags.length === 0) {
                vscode.window.showErrorMessage(`No tag found at commit ${short}.`);
                return;
            }

            const tag =
                tags.length === 1
                    ? tags[0]
                    : await vscode.window.showQuickPick(tags, {
                          placeHolder: "Select a tag to push",
                      });
            if (!tag) return;

            const remotes = (await executor.run(["remote"]))
                .split("\n")
                .map((remote) => remote.trim())
                .filter(Boolean);
            if (remotes.length === 0) {
                vscode.window.showErrorMessage("No Git remote configured for this repository.");
                return;
            }

            const remote =
                remotes.length === 1
                    ? remotes[0]
                    : await vscode.window.showQuickPick(remotes, {
                          placeHolder: `Select a remote for tag ${tag}`,
                      });
            if (!remote) return;

            try {
                await runWithNotificationProgress(`Pushing tag ${tag}...`, async () => {
                    await executor.runWithStderr(["push", remote, `refs/tags/${tag}`]);
                });
                vscode.window.showInformationMessage(`Pushed tag ${tag} to ${remote}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                vscode.window.showErrorMessage(`Failed to push tag ${tag}: ${message}`);
            }
            await refreshAll();
            return;
        }
        case "deleteTag": {
            const tags = (await executor.run(["tag", "--points-at", validatedHash]))
                .split("\n")
                .map((tag) => tag.trim())
                .filter(Boolean);
            if (tags.length === 0) {
                vscode.window.showErrorMessage(`No tag found at commit ${short}.`);
                return;
            }

            const tag =
                tags.length === 1
                    ? tags[0]
                    : await vscode.window.showQuickPick(tags, {
                          placeHolder: "Select a tag to delete",
                      });
            if (!tag) return;

            const target = await vscode.window.showQuickPick(
                [
                    {
                        label: "Delete Local Tag",
                        description: `Keep ${tag} on remotes`,
                        mode: "local" as const,
                    },
                    {
                        label: "Delete Remote Tag",
                        description: `Keep the local ${tag} tag`,
                        mode: "remote" as const,
                    },
                    {
                        label: "Delete Local and Remote Tag",
                        description: `Delete ${tag} locally and from a remote`,
                        mode: "both" as const,
                    },
                ],
                { placeHolder: `Choose where to delete tag ${tag}` },
            );
            if (!target) return;

            let remote: string | undefined;
            if (target.mode !== "local") {
                const remotes = (await executor.run(["remote"]))
                    .split("\n")
                    .map((name) => name.trim())
                    .filter(Boolean);
                if (remotes.length === 0) {
                    vscode.window.showErrorMessage("No Git remote configured for this repository.");
                    return;
                }
                remote =
                    remotes.length === 1
                        ? remotes[0]
                        : await vscode.window.showQuickPick(remotes, {
                              placeHolder: `Select a remote for tag ${tag}`,
                          });
                if (!remote) return;
            }

            const location =
                target.mode === "local"
                    ? "locally"
                    : target.mode === "remote"
                      ? `from ${remote}`
                      : `locally and from ${remote}`;
            const confirm = await vscode.window.showWarningMessage(
                `Delete tag '${tag}' ${location}?`,
                { modal: true },
                "Delete Tag",
            );
            if (confirm !== "Delete Tag") return;

            let remoteDeleted = false;
            try {
                await runWithNotificationProgress(`Deleting tag ${tag}...`, async () => {
                    if (remote) {
                        await executor.runWithStderr(["push", remote, `:refs/tags/${tag}`]);
                        remoteDeleted = true;
                    }
                    if (target.mode !== "remote") {
                        await executor.run(["tag", "-d", tag]);
                    }
                });
                vscode.window.showInformationMessage(`Deleted tag ${tag} ${location}.`);
            } catch (err) {
                const message = getErrorMessage(err);
                const partial = remoteDeleted
                    ? `Tag ${tag} was deleted from ${remote}, but local deletion failed: `
                    : `Failed to delete tag ${tag}: `;
                vscode.window.showErrorMessage(`${partial}${message}`);
            }
            await refreshAll();
            return;
        }
        case "undoCommit": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Undo Commit is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage("Undo Commit is not available for merge commits.");
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const undoParents = await getCommitParentHashes(validatedHash, executor);
            if (undoParents.length === 0) {
                vscode.window.showErrorMessage("Cannot undo the initial commit of the repository.");
                return;
            }
            const undoCount = await getUndoCommitCount(validatedHash, executor);
            const confirm = await vscode.window.showWarningMessage(
                `Undo ${undoCount} commit(s) up to ${short} (soft reset)?`,
                { modal: true },
                "Undo",
            );
            if (confirm !== "Undo") return;
            await executor.run(["reset", "--soft", `${validatedHash}^`]);
            vscode.window.showInformationMessage(`Undid ${undoCount} commit(s) up to ${short}.`);
            await refreshAll();
            return;
        }
        case "editCommitMessage": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Edit Commit Message is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    "Edit Commit Message is not available for merge commits.",
                );
                return;
            }

            const plan = await prepareReword(executor, validatedHash);
            const message = await params.editHistoryMessage({
                operation: "reword", repository: path.basename(repoRoot), branch: plan.branch,
                commits: plan.commits.map(({ hash, subject }) => ({ hash, subject })), message: plan.message,
            });
            if (!message?.trim() || message === plan.message) return;
            const receipt = await runWithNotificationProgress("Editing commit message...", () => applyReword(executor, plan, message));
            await finishRewrite(receipt, `Updated commit message (${receipt.firstRewritten.slice(0, 8)}).`);
            return;
        }
        case "dropCommit": {
            const branch = (await executor.run(["branch", "--show-current"])).trim();
            if (!branch) {
                vscode.window.showErrorMessage("Check out a local branch before dropping a commit.");
                return;
            }
            const head = (await executor.run(["rev-parse", "HEAD"])).trim();
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Drop Commit is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage("Drop Commit is not available for merge commits.");
                return;
            }
            try {
                await executor.runWithStderr(["merge-base", "--is-ancestor", validatedHash, head]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const dropParents = await getCommitParentHashes(validatedHash, executor);
            if (dropParents.length === 0) {
                vscode.window.showErrorMessage("Cannot drop the initial commit of the repository.");
                return;
            }
            const confirm = await vscode.window.showWarningMessage(
                `Drop commit ${short} from ${branch}?`,
                { modal: true },
                "Drop",
            );
            if (confirm !== "Drop") return;
            try {
                if ((await executor.run(["branch", "--show-current"])).trim() !== branch ||
                    (await executor.run(["rev-parse", "HEAD"])).trim() !== head) {
                    throw new Error("The branch or commit changed. Select the commit again.");
                }
                if (!(await isCommitUnpushed(validatedHash, gitOps))) throw new Error("This commit has already been pushed.");
                // Omitting the branch argument keeps the rebase attached to the current branch.
                await executor.runWithStderr(["rebase", "--onto", `${validatedHash}^`, validatedHash]);
                vscode.window.showInformationMessage(`Dropped ${short} from history.`);
            } catch (err) {
                const recovery = await gitOps.isRebaseInProgress() ? " Run 'git rebase --abort' to recover." : "";
                vscode.window.showErrorMessage(`Failed to drop commit: ${getErrorMessage(err)}${recovery}`);
            }
            await refreshAll();
            return;
        }
        case "interactiveRebaseFromHere": {
            if (!(await isCommitUnpushed(validatedHash, gitOps))) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is available only for unpushed commits.",
                );
                return;
            }
            if (await isMergeCommitHash(validatedHash, executor)) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is not available for merge commits.",
                );
                return;
            }
            try {
                await executor.run(["merge-base", "--is-ancestor", validatedHash, "HEAD"]);
            } catch {
                vscode.window.showErrorMessage(
                    `Commit ${short} is not in the current branch history.`,
                );
                return;
            }
            const rebaseParents = await getCommitParentHashes(validatedHash, executor);
            if (rebaseParents.length === 0) {
                vscode.window.showErrorMessage(
                    "Interactive Rebase from Here is not available for the initial commit.",
                );
                return;
            }
            const terminal = vscode.window.createTerminal({
                name: "IntelliGit Interactive Rebase",
                cwd: repoRoot,
            });
            terminal.show();
            terminal.sendText(`git rebase -i "${validatedHash}^"`, true);
            vscode.window.showInformationMessage(`Opened interactive rebase from ${short}.`);
            return;
        }
        default:
            return assertNever(action);
    }
}
