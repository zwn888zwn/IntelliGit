// Shared file operation utilities used by extension host and view providers.

import * as path from "path";
import * as vscode from "vscode";
import type { GitOps } from "../git/operations";
import { decodeGitQuotedPath } from "../git/pathEncoding";
import { getErrorMessage, isUntrackedPathspecError } from "./errors";

/**
 * Validate that a relative file path stays inside the repo root.
 * Rejects absolute paths, '..' traversal, and empty strings.
 * Returns the normalized relative path or throws.
 */
export function assertRepoRelativePath(filePath: string): string {
    const decodedPath = decodeGitQuotedPath(filePath);
    if (!decodedPath || path.isAbsolute(decodedPath)) {
        throw new Error(`Rejected non-relative path: ${filePath}`);
    }
    if (decodedPath.includes("\0") || decodedPath.includes("\r") || decodedPath.includes("\n")) {
        throw new Error(`Rejected path containing control characters: ${filePath}`);
    }
    const normalized = path.normalize(decodedPath);
    if (normalized === ".") {
        throw new Error(`Rejected repo root path: ${filePath}`);
    }
    const segments = normalized.split(path.sep);
    if (segments.some((seg) => seg === "..")) {
        throw new Error(`Rejected path escaping repo root: ${filePath}`);
    }
    // Always return forward-slash paths for git compatibility.
    // path.normalize converts '/' to '\' on Windows, which breaks
    // git object lookups like "git show HEAD:src\file.ts".
    return normalized.split(path.sep).join("/");
}

/**
 * Delete a file via git rm, falling back to filesystem delete for untracked files.
 * Returns true if deleted successfully, false if an error was shown.
 */
export async function deleteFileWithFallback(
    gitOps: GitOps,
    workspaceRoot: vscode.Uri,
    filePath: string,
): Promise<boolean> {
    try {
        await gitOps.deleteFile(filePath, true);
    } catch (error) {
        if (!isUntrackedPathspecError(error)) {
            const message = getErrorMessage(error);
            console.error("Failed to delete file with git rm:", error);
            vscode.window.showErrorMessage(`Delete failed: ${message}`);
            return false;
        }

        try {
            const uri = vscode.Uri.joinPath(workspaceRoot, filePath);
            await vscode.workspace.fs.delete(uri);
        } catch (fsError) {
            const message = getErrorMessage(fsError);
            console.error("Failed to delete file from filesystem:", fsError);
            vscode.window.showErrorMessage(`Delete failed: ${message}`);
            return false;
        }
    }
    return true;
}
