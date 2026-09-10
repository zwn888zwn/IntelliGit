import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import type {
    ProjectComparisonFile,
    ProjectComparisonTarget,
    WorkingFile,
} from "../types";
import { assertRepoRelativePath } from "../utils/fileOps";
import { EMPTY_TREE_HASH } from "../utils/constants";
import { getCommitParentHashes, pickMainlineParent } from "./gitHelpers";

type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

interface DiffEntry {
    path: string;
    oldPath?: string;
    status: ChangeStatus;
}

type ResourceTuple = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

// VS Code's Git file-system provider treats an empty ref as the index. A
// literal ":" would be interpolated as `::path` by the provider.
const INDEX_REF = "";

function workingTreeUri(repoRoot: string, filePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(repoRoot, filePath));
}

function gitResourceUri(repoRoot: string, filePath: string, ref: string): vscode.Uri {
    const fileUri = workingTreeUri(repoRoot, filePath);
    return vscode.Uri.from({
        scheme: "git",
        path: fileUri.path,
        query: JSON.stringify({ path: fileUri.fsPath, ref }),
    });
}

function assertRef(value: string, label: string): string {
    const trimmed = value.trim();
    if (!trimmed || trimmed.startsWith("-") || /[\0\r\n]/.test(trimmed)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return trimmed;
}

async function resolveCommitRef(
    ref: string,
    label: string,
    executor: GitExecutor,
): Promise<string | null> {
    const safeRef = assertRef(ref, label);
    try {
        const resolved = (await executor.run(["rev-parse", "--verify", `${safeRef}^{commit}`])).trim();
        return /^[0-9a-f]{40}$/i.test(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

function parseNameStatus(output: string): DiffEntry[] {
    const fields = output.split("\0");
    const entries: DiffEntry[] = [];
    for (let index = 0; index < fields.length; ) {
        const rawStatus = fields[index++] ?? "";
        if (!rawStatus) continue;
        const code = rawStatus.charAt(0) as ChangeStatus;
        if (!["A", "M", "D", "R", "C", "T"].includes(code)) {
            if (index < fields.length) index++;
            continue;
        }
        const firstPath = fields[index++] ?? "";
        if (!firstPath) continue;
        if (code === "R" || code === "C") {
            const secondPath = fields[index++] ?? "";
            if (!secondPath) continue;
            entries.push({
                path: assertRepoRelativePath(secondPath),
                oldPath: assertRepoRelativePath(firstPath),
                status: code,
            });
        } else {
            entries.push({ path: assertRepoRelativePath(firstPath), status: code });
        }
    }
    return entries;
}

async function diffEntries(executor: GitExecutor, args: string[]): Promise<DiffEntry[]> {
    const output = await executor.run([
        "diff",
        "--name-status",
        "--find-renames",
        "-z",
        ...args,
        "--",
    ]);
    return parseNameStatus(output);
}

async function untrackedEntries(executor: GitExecutor): Promise<DiffEntry[]> {
    const output = await executor.run(["ls-files", "--others", "--exclude-standard", "-z"]);
    return output
        .split("\0")
        .filter(Boolean)
        .map((filePath) => ({ path: assertRepoRelativePath(filePath), status: "A" as const }));
}

function mergeEntries(...groups: DiffEntry[][]): DiffEntry[] {
    const byPath = new Map<string, DiffEntry>();
    for (const group of groups) {
        for (const entry of group) {
            const existing = byPath.get(entry.path);
            if (!existing) {
                byPath.set(entry.path, entry);
                continue;
            }
            const oldPath = existing.oldPath ?? entry.oldPath;
            let status = existing.status;
            if (entry.status === "R" || entry.status === "C") status = entry.status;
            else if (status === "D" && entry.status === "A") status = "M";
            else if (status === "A" && entry.status === "M") status = "A";
            else if (entry.status !== "A") status = entry.status;
            byPath.set(entry.path, { path: entry.path, oldPath, status });
        }
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function selectedEntries(
    entries: DiffEntry[],
    files: Array<WorkingFile | ProjectComparisonFile>,
): DiffEntry[] {
    const wanted = new Set<string>();
    for (const file of files) {
        wanted.add(assertRepoRelativePath(file.path));
        if ("oldPath" in file && file.oldPath) {
            wanted.add(assertRepoRelativePath(file.oldPath));
        }
    }
    return entries.filter(
        (entry) => wanted.has(entry.path) || (entry.oldPath ? wanted.has(entry.oldPath) : false),
    );
}

function toResources(
    entries: DiffEntry[],
    repoRoot: string,
    originalRef: string | undefined,
    modifiedRef: string | undefined,
    modifiedIsWorkingTree = false,
): ResourceTuple[] {
    return entries.map((entry) => {
        const originalPath = entry.oldPath ?? entry.path;
        const resource = workingTreeUri(repoRoot, entry.path);
        const original =
            entry.status === "A"
                ? undefined
                : originalRef !== undefined
                  ? gitResourceUri(repoRoot, originalPath, originalRef)
                  : undefined;
        const modified =
            entry.status === "D"
                ? undefined
                : modifiedIsWorkingTree
                  ? resource
                  : modifiedRef !== undefined
                    ? gitResourceUri(repoRoot, entry.path, modifiedRef)
                    : undefined;
        return [resource, original, modified];
    });
}

async function openResources(
    title: string,
    resources: ResourceTuple[],
    emptyMessage: string,
): Promise<void> {
    if (resources.length === 0) {
        vscode.window.showInformationMessage(emptyMessage);
        return;
    }
    await vscode.commands.executeCommand("vscode.changes", title, resources);
}

async function workingEntries(executor: GitExecutor, headHash: string | null): Promise<DiffEntry[]> {
    if (headHash) {
        return mergeEntries(await diffEntries(executor, [headHash]), await untrackedEntries(executor));
    }
    const [staged, unstaged, untracked] = await Promise.all([
        diffEntries(executor, ["--cached"]),
        diffEntries(executor, []),
        untrackedEntries(executor),
    ]);
    const stagedAdds = new Set(
        staged.filter((entry) => entry.status === "A").map((entry) => entry.path),
    );
    const canceledAdds = new Set(
        unstaged
            .filter((entry) => entry.status === "D" && stagedAdds.has(entry.path))
            .map((entry) => entry.path),
    );
    return mergeEntries(staged, unstaged, untracked)
        .filter((entry) => !canceledAdds.has(entry.path))
        .map((entry) =>
            stagedAdds.has(entry.path) && entry.status !== "D"
                ? { ...entry, status: "A" as const }
                : entry,
        );
}

async function stageEntries(
    executor: GitExecutor,
    headHash: string | null,
    staged: boolean,
): Promise<DiffEntry[]> {
    if (staged) {
        return diffEntries(executor, headHash ? ["--cached", headHash] : ["--cached"]);
    }
    return mergeEntries(await diffEntries(executor, []), await untrackedEntries(executor));
}

function stashIndexRef(index: number): string {
    if (!Number.isInteger(index) || index < 0) throw new Error(`Invalid stash index: ${index}`);
    return `stash@{${index}}`;
}

export async function openWorkingTreeChanges(
    files: WorkingFile[],
    repoRoot: string,
    executor: GitExecutor,
): Promise<void> {
    const headHash = await resolveCommitRef("HEAD", "HEAD", executor);
    const entries = selectedEntries(await workingEntries(executor, headHash), files);
    await openResources(
        "Working Tree Changes",
        toResources(entries, repoRoot, headHash ?? EMPTY_TREE_HASH, undefined, true),
        "No working tree changes to show.",
    );
}

export async function openStageChanges(
    files: WorkingFile[],
    repoRoot: string,
    executor: GitExecutor,
    staged: boolean,
): Promise<void> {
    const headHash = await resolveCommitRef("HEAD", "HEAD", executor);
    const entries = selectedEntries(await stageEntries(executor, headHash, staged), files);
    await openResources(
        staged ? "Staged Changes" : "Unstaged Changes",
        toResources(
            entries,
            repoRoot,
            staged ? headHash ?? EMPTY_TREE_HASH : INDEX_REF,
            staged ? INDEX_REF : undefined,
            !staged,
        ),
        staged ? "No staged changes to show." : "No unstaged changes to show.",
    );
}

export async function openShelvedChanges(
    index: number,
    repoRoot: string,
    executor: GitExecutor,
    expectedHash?: string,
): Promise<void> {
    const stashRef = stashIndexRef(index);
    const stashHash = await resolveCommitRef(expectedHash ?? stashRef, "stash", executor);
    if (!stashHash) {
        await openResources(`Stash ${index} Changes`, [], `Stash ${index} is no longer available.`);
        return;
    }
    const parents = await getCommitParentHashes(stashHash, executor);
    const baseHash = parents[0] ?? EMPTY_TREE_HASH;
    const untrackedHash = parents.length >= 3 ? parents[2] : undefined;
    const [tracked, untracked] = await Promise.all([
        diffEntries(executor, [baseHash, stashHash]),
        untrackedHash
            ? diffEntries(executor, [EMPTY_TREE_HASH, untrackedHash])
            : Promise.resolve([]),
    ]);
    const entries = mergeEntries(tracked, untracked);
    const resources: ResourceTuple[] = [];
    for (const entry of entries) {
        const isUntracked = untracked.some((candidate) => candidate.path === entry.path);
        const resource = workingTreeUri(repoRoot, entry.path);
        resources.push([
            resource,
            entry.status === "A"
                ? undefined
                : gitResourceUri(repoRoot, entry.oldPath ?? entry.path, baseHash),
            entry.status === "D"
                ? undefined
                : gitResourceUri(
                      repoRoot,
                      entry.path,
                      isUntracked && untrackedHash ? untrackedHash : stashHash,
                  ),
        ]);
    }
    await openResources(
        `Stash ${index} Changes`,
        resources,
        `Stash ${index} has no changes to show.`,
    );
}

export async function openCommitChanges(
    hash: string,
    repoRoot: string,
    executor: GitExecutor,
): Promise<void> {
    const commitHash = await resolveCommitRef(hash, "commit", executor);
    if (!commitHash) throw new Error(`Invalid commit: ${hash}`);
    const parents = await getCommitParentHashes(commitHash, executor);
    let parentHash = parents[0] ?? EMPTY_TREE_HASH;
    if (parents.length > 1) {
        const pick = await pickMainlineParent(commitHash, "Open Commit Changes", executor, parents);
        if (pick.kind === "cancelled") return;
        if (pick.kind !== "selected" || !pick.parentNumber) return;
        parentHash = parents[pick.parentNumber - 1] ?? EMPTY_TREE_HASH;
    }
    const entries = await diffEntries(executor, [parentHash, commitHash]);
    await openResources(
        `Commit ${commitHash.slice(0, 8)} Changes`,
        toResources(entries, repoRoot, parentHash, commitHash),
        "Commit has no changes to show.",
    );
}

export async function openBranchComparisonChanges(
    files: ProjectComparisonFile[],
    ref: string,
    target: ProjectComparisonTarget,
    repoRoot: string,
    executor: GitExecutor,
): Promise<void> {
    const sourceHash = await resolveCommitRef(ref, "comparison ref", executor);
    if (!sourceHash) throw new Error(`Invalid comparison ref: ${ref}`);
    const targetHash =
        target.kind === "current-branch"
            ? await resolveCommitRef("HEAD", "HEAD", executor)
            : undefined;
    const entries =
        target.kind === "current-branch"
            ? selectedEntries(
                  await diffEntries(executor, [sourceHash, targetHash ?? EMPTY_TREE_HASH]),
                  files,
              )
            : selectedEntries(
                  mergeEntries(
                      await diffEntries(executor, [sourceHash]),
                      await untrackedEntries(executor),
                  ),
                  files,
              );
    await openResources(
        `${ref.trim()} ↔ ${target.label}`,
        toResources(
            entries,
            repoRoot,
            sourceHash,
            targetHash ?? undefined,
            target.kind === "working-tree",
        ),
        "No branch comparison changes to show.",
    );
}
