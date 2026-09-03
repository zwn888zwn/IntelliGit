import * as fs from "fs/promises";
import * as path from "path";
import {
    getNodePath,
    parseTree,
    printParseErrorCode,
    type Edit,
    type Node,
    type ParseError,
} from "jsonc-parser";
import type { Branch, GitWorktree } from "../types";

export interface WorktreeAddArgsInput {
    targetPath: string;
    fromBranch: string;
    newBranchName?: string;
}

export interface RemoteBranchTarget {
    remote: string;
    remoteBranch: string;
}

const WORKTREE_LOCAL_PATHS = [".envrc", ".vscode"] as const;

export function sanitizeWorktreeNamePart(value: string): string {
    const sanitized = replaceControlCharsWithDash(value.trim())
        .replace(/[\\/]+/g, "-")
        .replace(/[^A-Za-z0-9._@-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "");
    return sanitized || "worktree";
}

export function getDefaultWorktreeLocation(repoRoot: string): string {
    return path.dirname(repoRoot);
}

export function getDefaultWorktreeProjectName(repoRoot: string, branchName: string): string {
    return `${path.basename(repoRoot)}-${sanitizeWorktreeNamePart(branchName)}`;
}

export async function copyWorktreeLocalFiles(
    repoRoot: string,
    targetPath: string,
): Promise<void> {
    const targetSettingsPath = path.join(targetPath, ".vscode", "settings.json");
    let targetSettingsExisted = false;
    try {
        await fs.stat(targetSettingsPath);
        targetSettingsExisted = true;
    } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    await Promise.all(
        WORKTREE_LOCAL_PATHS.map(async (relativePath) => {
            const source = path.join(repoRoot, relativePath);
            const target = path.join(targetPath, relativePath);
            try {
                await fs.cp(source, target, {
                    recursive: true,
                    force: false,
                    errorOnExist: false,
                });
            } catch (error) {
                if (isNodeError(error) && error.code === "ENOENT") return;
                throw error;
            }
        }),
    );
    if (!targetSettingsExisted) {
        await rewriteCopiedVsCodeSettings(targetSettingsPath, repoRoot, targetPath);
    }
}

export function getWorktreeWorkspacePath(worktreePath: string): string {
    return `${path.resolve(worktreePath)}.code-workspace`;
}

export async function findWorktreeWorkspacePath(worktreePath: string): Promise<string | null> {
    const workspacePath = getWorktreeWorkspacePath(worktreePath);
    try {
        const stat = await fs.stat(workspacePath);
        return stat.isFile() ? workspacePath : null;
    } catch {
        return null;
    }
}

export async function copyWorktreeWorkspaceFile(
    sourceWorkspacePath: string,
    repoRoot: string,
    targetPath: string,
): Promise<string> {
    const sourceText = await fs.readFile(sourceWorkspacePath, "utf8");
    const errors: ParseError[] = [];
    const root = parseTree(sourceText, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (!root || errors.length > 0) {
        const detail = errors[0] ? printParseErrorCode(errors[0].error) : "Empty workspace file";
        throw new Error(`Invalid workspace file: ${detail}`);
    }

    const targetWorkspacePath = getWorktreeWorkspacePath(targetPath);
    const edits: Edit[] = [];
    visitWorkspaceValues(root, (node) => {
        const value = node.value;
        if (typeof value !== "string") return;

        const nodePath = getNodePath(node);
        const isFolderPath =
            nodePath.length === 3 &&
            nodePath[0] === "folders" &&
            typeof nodePath[1] === "number" &&
            nodePath[2] === "path";
        const nextValue = isFolderPath
            ? mapWorkspaceFolderPath(
                  value,
                  sourceWorkspacePath,
                  targetWorkspacePath,
                  repoRoot,
                  targetPath,
              )
            : replaceRepositoryPathReferences(value, repoRoot, targetPath);
        if (nextValue === value) return;

        edits.push({
            offset: node.offset,
            length: node.length,
            content: JSON.stringify(nextValue),
        });
    });

    let targetText = sourceText;
    for (const edit of edits.sort((left, right) => right.offset - left.offset)) {
        targetText =
            targetText.slice(0, edit.offset) +
            edit.content +
            targetText.slice(edit.offset + edit.length);
    }
    await fs.writeFile(targetWorkspacePath, targetText, { encoding: "utf8", flag: "wx" });
    return targetWorkspacePath;
}

export function validateWorktreeProjectName(projectName: string): string | null {
    const trimmed = projectName.trim();
    if (!trimmed) return "Project name is required.";
    if (trimmed === "." || trimmed === "..") return "Project name must be a directory name.";
    if (path.isAbsolute(trimmed)) return "Project name must not be an absolute path.";
    if (trimmed.includes("/") || trimmed.includes("\\")) {
        return "Project name must not contain path separators.";
    }
    if (containsControlChars(trimmed)) {
        return "Project name must not contain control characters.";
    }
    return null;
}

export async function resolveAndValidateWorktreeTarget(
    location: string,
    projectName: string,
): Promise<string> {
    const trimmedLocation = location.trim();
    const trimmedProjectName = projectName.trim();
    const projectNameError = validateWorktreeProjectName(trimmedProjectName);
    if (projectNameError) throw new Error(projectNameError);
    if (!trimmedLocation) throw new Error("Location is required.");

    let locationStat;
    try {
        locationStat = await fs.stat(trimmedLocation);
    } catch {
        throw new Error(`Location does not exist: ${trimmedLocation}`);
    }
    if (!locationStat.isDirectory()) {
        throw new Error(`Location is not a directory: ${trimmedLocation}`);
    }

    const targetPath = path.join(trimmedLocation, trimmedProjectName);
    try {
        await fs.stat(targetPath);
        throw new Error(`Target directory already exists: ${targetPath}`);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return targetPath;
        throw error;
    }
}

export function buildWorktreeAddArgs({
    targetPath,
    fromBranch,
    newBranchName,
}: WorktreeAddArgsInput): string[] {
    const trimmedNewBranchName = newBranchName?.trim();
    if (trimmedNewBranchName) {
        if (!isValidBranchName(trimmedNewBranchName)) {
            throw new Error(`Invalid branch name '${trimmedNewBranchName}'.`);
        }
        return ["worktree", "add", "-b", trimmedNewBranchName, targetPath, fromBranch];
    }
    return ["worktree", "add", targetPath, fromBranch];
}

export function buildWorktreeRemoveArgs(targetPath: string): string[] {
    const trimmedTargetPath = targetPath.trim();
    if (!trimmedTargetPath) throw new Error("Worktree path is required.");
    return ["worktree", "remove", trimmedTargetPath];
}

export function parseWorktreeListPorcelain(output: string): GitWorktree[] {
    const entries: GitWorktree[] = [];
    let current: GitWorktree | null = null;

    const pushCurrent = (): void => {
        if (current) entries.push(current);
        current = null;
    };

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        if (!line) {
            pushCurrent();
            continue;
        }
        if (line.startsWith("worktree ")) {
            pushCurrent();
            current = { path: line.slice("worktree ".length), detached: false };
            continue;
        }
        if (!current) continue;
        if (line.startsWith("HEAD ")) {
            current.head = line.slice("HEAD ".length);
            continue;
        }
        if (line.startsWith("branch ")) {
            current.branch = normalizeWorktreeBranchRef(line.slice("branch ".length));
            current.detached = false;
            continue;
        }
        if (line === "detached") {
            current.detached = true;
            continue;
        }
        if (line === "bare") {
            current.bare = true;
            continue;
        }
        if (line.startsWith("prunable")) {
            current.prunable = line.slice("prunable".length).trim() || "true";
        }
    }

    pushCurrent();
    return entries;
}

export function isLocalBranchCheckedOut(branch: Branch, worktrees: GitWorktree[]): boolean {
    if (branch.isRemote) return false;
    return !!findWorktreeForBranch(branch, worktrees);
}

export function findWorktreeForBranch(
    branch: Branch,
    worktrees: GitWorktree[],
): GitWorktree | null {
    if (branch.isRemote) return null;
    return worktrees.find((worktree) => worktree.branch === branch.name) ?? null;
}

export function isCurrentWorktreePath(repoRoot: string, worktreePath: string): boolean {
    return normalizePath(repoRoot) === normalizePath(worktreePath);
}

export function resolveRemoteBranchTarget(branch: Branch): RemoteBranchTarget | null {
    if (!branch.isRemote) return null;
    const remote = branch.remote || branch.name.split("/")[0];
    if (!remote) return null;
    const prefix = `${remote}/`;
    const remoteBranch = branch.name.startsWith(prefix)
        ? branch.name.slice(prefix.length)
        : branch.name.split("/").slice(1).join("/");
    if (!remoteBranch) return null;
    return { remote, remoteBranch };
}

function normalizeWorktreeBranchRef(ref: string): string {
    if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
    if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
    return ref;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error;
}

function isValidBranchName(value: string): boolean {
    if (!value || value.length > 255) return false;
    if (value.startsWith("-") || value.startsWith(".")) return false;
    if (value.endsWith(".") || value.endsWith("/") || value.endsWith(".lock")) return false;
    if (value.includes("..") || value.includes("//")) return false;
    if (/[ ~^:?*[\]\\]/.test(value)) return false;
    if (containsControlChars(value)) return false;
    if (value.includes("@{")) return false;
    return value
        .split("/")
        .every((segment) => segment && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

function replaceControlCharsWithDash(value: string): string {
    let result = "";
    let lastWasDash = false;
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            if (!lastWasDash) result += "-";
            lastWasDash = true;
            continue;
        }
        result += value[i];
        lastWasDash = value[i] === "-";
    }
    return result;
}

function containsControlChars(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
}

function visitWorkspaceValues(node: Node, visitor: (node: Node) => void): void {
    const isPropertyKey =
        node.parent?.type === "property" && node.parent.children?.[0] === node;
    if (!isPropertyKey) visitor(node);
    node.children?.forEach((child) => visitWorkspaceValues(child, visitor));
}

function mapWorkspaceFolderPath(
    folderPath: string,
    sourceWorkspacePath: string,
    targetWorkspacePath: string,
    repoRoot: string,
    targetPath: string,
): string {
    const sourceFolderPath = path.isAbsolute(folderPath)
        ? path.resolve(folderPath)
        : path.resolve(path.dirname(sourceWorkspacePath), folderPath);
    const relativeToRepo = path.relative(path.resolve(repoRoot), sourceFolderPath);
    if (
        relativeToRepo.startsWith(`..${path.sep}`) ||
        relativeToRepo === ".." ||
        path.isAbsolute(relativeToRepo)
    ) {
        return folderPath;
    }

    const mappedFolderPath = path.join(path.resolve(targetPath), relativeToRepo);
    if (path.isAbsolute(folderPath)) return mappedFolderPath;

    const relativeToWorkspace = path.relative(path.dirname(targetWorkspacePath), mappedFolderPath);
    return (relativeToWorkspace || ".").replace(/\\/g, "/");
}

function replaceRepositoryPathReferences(
    value: string,
    repoRoot: string,
    targetPath: string,
): string {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const resolvedTargetPath = path.resolve(targetPath);
    const escapedRepoRoot = JSON.stringify(resolvedRepoRoot).slice(1, -1);
    const escapedTargetPath = JSON.stringify(resolvedTargetPath).slice(1, -1);
    const variants = new Map<string, string>([
        [resolvedRepoRoot, resolvedTargetPath],
        [resolvedRepoRoot.replace(/\\/g, "/"), resolvedTargetPath.replace(/\\/g, "/")],
        [escapedRepoRoot, escapedTargetPath],
    ]);

    let result = value;
    for (const [source, target] of variants) {
        result = replacePathReference(result, source, target);
    }
    return result;
}

async function rewriteCopiedVsCodeSettings(
    settingsPath: string,
    repoRoot: string,
    targetPath: string,
): Promise<void> {
    try {
        const sourceText = await fs.readFile(settingsPath, "utf8");
        const targetText = replaceRepositoryPathReferences(sourceText, repoRoot, targetPath);
        if (targetText !== sourceText) await fs.writeFile(settingsPath, targetText, "utf8");
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return;
        throw error;
    }
}

function replacePathReference(value: string, source: string, target: string): string {
    const compareValue = process.platform === "win32" ? value.toLowerCase() : value;
    const compareSource = process.platform === "win32" ? source.toLowerCase() : source;
    let result = "";
    let cursor = 0;

    while (cursor < value.length) {
        const index = compareValue.indexOf(compareSource, cursor);
        if (index < 0) break;
        const previous = value[index - 1];
        const next = value[index + source.length];
        const hasStartBoundary =
            previous === undefined ||
            previous === "/" ||
            previous === "\\" ||
            /[\s=:;,([{'"}]/.test(previous);
        const hasEndBoundary =
            next === undefined || next === "/" || next === "\\" || next === ":" || next === ";";
        if (!hasStartBoundary || !hasEndBoundary) {
            result += value.slice(cursor, index + source.length);
            cursor = index + source.length;
            continue;
        }
        result += value.slice(cursor, index) + target;
        cursor = index + source.length;
    }

    return cursor === 0 ? value : result + value.slice(cursor);
}

function normalizePath(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
