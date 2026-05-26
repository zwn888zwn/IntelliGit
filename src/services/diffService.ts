// Diff and comparison operations extracted from extension.ts.
// Handles opening diffs against git refs, commit file diffs,
// and applying/reverting single-file patches.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { ProjectComparisonFile, WorkingFile } from "../types";
import { getErrorMessage } from "../utils/errors";
import { runWithNotificationProgress } from "../utils/notifications";
import { getCommitParentHashes, pickMainlineParent, buildCommitFilePatch } from "./gitHelpers";
import { assertRepoRelativePath } from "../utils/fileOps";
import { EMPTY_TREE_HASH } from "../utils/constants";

const DIFF_DOCUMENT_SCHEME = "intelligit-diff";
const DIFF_EDITABLE_SCHEME = "intelligit-diff-editable";

const BINARY_FILE_EXTENSIONS = new Set([
    ".7z",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".pdf",
    ".png",
    ".pprof",
    ".so",
    ".tar",
    ".webp",
    ".zip",
]);

class IntelliGitDiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private nextId = 1;

    readonly onDidChange = this.changeEmitter.event;

    createUri(
        filePath: string,
        ref: string,
        content: string,
        options: { forcePlainTextUri?: boolean } = {},
    ): vscode.Uri {
        const id = String(this.nextId++);
        const uri = vscode.Uri.from({
            scheme: DIFF_DOCUMENT_SCHEME,
            path: makeTextDiffUriPath(id, filePath, options.forcePlainTextUri),
            query: new URLSearchParams({
                ref,
                id,
                path: normalizeGitPath(filePath),
            }).toString(),
        });
        this.contents.set(uri.toString(), content);
        return uri;
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.contents.get(uri.toString()) ?? "";
    }

    release(uri: vscode.Uri): void {
        this.contents.delete(uri.toString());
    }

    dispose(): void {
        this.contents.clear();
        this.changeEmitter.dispose();
    }
}

class IntelliGitEditableDiffFileSystemProvider
    implements vscode.FileSystemProvider, vscode.Disposable
{
    private readonly files = new Map<string, Uint8Array>();
    private readonly workingTreeTargets = new Map<string, vscode.Uri>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    private nextId = 1;

    readonly onDidChangeFile = this.changeEmitter.event;

    createUri(
        filePath: string,
        ref: string,
        content: string,
        options: { forcePlainTextUri?: boolean } = {},
    ): vscode.Uri {
        const id = String(this.nextId++);
        const uri = vscode.Uri.from({
            scheme: DIFF_EDITABLE_SCHEME,
            path: makeTextDiffUriPath(id, filePath, options.forcePlainTextUri),
            query: new URLSearchParams({
                ref,
                id,
                path: normalizeGitPath(filePath),
            }).toString(),
        });
        this.files.set(uri.toString(), Buffer.from(content, "utf8"));
        return uri;
    }

    createWorkingTreeUri(filePath: string, content: Uint8Array, targetUri: vscode.Uri): vscode.Uri {
        const id = String(this.nextId++);
        const uri = vscode.Uri.from({
            scheme: DIFF_EDITABLE_SCHEME,
            path: makeTextDiffUriPath(id, filePath),
            query: new URLSearchParams({
                ref: "working-tree",
                id,
                path: normalizeGitPath(filePath),
            }).toString(),
        });
        this.files.set(uri.toString(), content);
        this.workingTreeTargets.set(uri.toString(), targetUri);
        return uri;
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const content = this.files.get(uri.toString());
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const now = Date.now();
        return {
            type: vscode.FileType.File,
            ctime: now,
            mtime: now,
            size: content.byteLength,
        };
    }

    readDirectory(): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions("Directory operations are not supported.");
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const content = this.files.get(uri.toString());
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return content;
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const targetUri = this.workingTreeTargets.get(uri.toString());
        if (targetUri) {
            await vscode.workspace.fs.writeFile(targetUri, content);
        }
        this.files.set(uri.toString(), content);
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(uri: vscode.Uri): void {
        this.files.delete(uri.toString());
        this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
        const content = this.files.get(oldUri.toString());
        if (!content) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        this.files.delete(oldUri.toString());
        this.files.set(newUri.toString(), content);
        this.changeEmitter.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }

    release(uri: vscode.Uri): void {
        this.files.delete(uri.toString());
        this.workingTreeTargets.delete(uri.toString());
    }

    dispose(): void {
        this.files.clear();
        this.workingTreeTargets.clear();
        this.changeEmitter.dispose();
    }
}

let diffContentProvider: IntelliGitDiffContentProvider | null = null;
let editableDiffProvider: IntelliGitEditableDiffFileSystemProvider | null = null;

export function registerDiffContentProvider(subscriptions: vscode.Disposable[]): void {
    if (diffContentProvider && editableDiffProvider) return;

    diffContentProvider = new IntelliGitDiffContentProvider();
    editableDiffProvider = new IntelliGitEditableDiffFileSystemProvider();
    subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            DIFF_DOCUMENT_SCHEME,
            diffContentProvider,
        ),
        vscode.workspace.registerFileSystemProvider(
            DIFF_EDITABLE_SCHEME,
            editableDiffProvider,
            { isCaseSensitive: true },
        ),
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.uri.scheme === DIFF_DOCUMENT_SCHEME) {
                diffContentProvider?.release(document.uri);
                return;
            }
            if (document.uri.scheme === DIFF_EDITABLE_SCHEME) {
                editableDiffProvider?.release(document.uri);
            }
        }),
        diffContentProvider,
        editableDiffProvider,
    );
}

function getDiffContentProvider(): IntelliGitDiffContentProvider {
    if (!diffContentProvider) {
        throw new Error("IntelliGit diff content provider is not registered.");
    }
    return diffContentProvider;
}

function getEditableDiffProvider(): IntelliGitEditableDiffFileSystemProvider {
    if (!editableDiffProvider) {
        throw new Error("IntelliGit editable diff provider is not registered.");
    }
    return editableDiffProvider;
}

export function normalizeGitPath(fsPathValue: string): string {
    return fsPathValue.split(path.sep).join("/");
}

function makeTextDiffUriPath(
    id: string,
    filePath: string,
    forcePlainTextUri = false,
): string {
    const normalized = normalizeGitPath(filePath);
    if (forcePlainTextUri || shouldUsePlainTextDiffUri(normalized)) {
        return `/__intelligit_text_diff__/${id}.txt`;
    }
    const fileName = path.posix.basename(normalized) || "file.txt";
    return `/__intelligit_text_diff__/${id}/${fileName}`;
}

function shouldUsePlainTextDiffUri(filePath: string): boolean {
    const extension = path.posix.extname(filePath).toLowerCase();
    return extension === ".md" || isBinaryFilePath(filePath);
}

export function getRepoRelativeFilePathFromUri(uri: vscode.Uri, repoRoot: string): string | null {
    if (uri.scheme !== "file") return null;
    const relative = path.relative(repoRoot, uri.fsPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return normalizeGitPath(relative);
}

export function getEditorContextFileUri(ctx?: unknown): vscode.Uri | null {
    if (ctx instanceof vscode.Uri) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri?.scheme === "file" ? activeUri : null;
}

function isUriLike(value: unknown): value is vscode.Uri {
    if (!value || typeof value !== "object") return false;
    const maybe = value as { scheme?: unknown; path?: unknown };
    return typeof maybe.scheme === "string" && typeof maybe.path === "string";
}

export function getCommitDiffEditorUri(ctx?: unknown): vscode.Uri | null {
    if (isUriLike(ctx) && ctx.scheme === DIFF_EDITABLE_SCHEME) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri?.scheme === DIFF_EDITABLE_SCHEME ? activeUri : null;
}

export function getCommitDiffFilePathFromUri(uri: vscode.Uri): string | null {
    if (uri.scheme !== DIFF_EDITABLE_SCHEME) return null;
    const rawPath =
        new URLSearchParams(uri.query).get("path")?.trim() ??
        uri.path.replace(/^\/+/, "").trim();
    if (!rawPath) return null;
    return assertRepoRelativePath(rawPath);
}

export function getDiffOriginalFilePathFromUri(uri: vscode.Uri): string | null {
    if (uri.scheme !== DIFF_DOCUMENT_SCHEME && uri.scheme !== DIFF_EDITABLE_SCHEME) return null;
    const rawPath =
        new URLSearchParams(uri.query).get("path")?.trim() ??
        uri.path.replace(/^\/+/, "").trim();
    if (!rawPath) return null;
    return assertRepoRelativePath(rawPath);
}

export function getCommitDiffSourceFileUri(
    uri: vscode.Uri,
    repoRoot: vscode.Uri,
): vscode.Uri | null {
    const filePath = getCommitDiffFilePathFromUri(uri);
    if (!filePath) return null;
    return vscode.Uri.joinPath(repoRoot, filePath);
}

export async function commitDiffSourceFileExists(
    uri: vscode.Uri | null | undefined,
    repoRoot: vscode.Uri | null | undefined,
): Promise<boolean> {
    if (!uri || !repoRoot) return false;
    const sourceUri = getCommitDiffSourceFileUri(uri, repoRoot);
    if (!sourceUri) return false;
    try {
        await vscode.workspace.fs.stat(sourceUri);
        return true;
    } catch {
        return false;
    }
}

export interface CommitInfoFileContext {
    filePath: string;
    commitHash: string;
    commitShortHash?: string;
    repoRoot?: string;
}

export function getCommitInfoFileContext(value: unknown): CommitInfoFileContext | null {
    if (!value || typeof value !== "object") return null;
    const maybe = value as {
        filePath?: unknown;
        commitHash?: unknown;
        commitShortHash?: unknown;
        repoRoot?: unknown;
    };
    if (typeof maybe.filePath !== "string" || typeof maybe.commitHash !== "string") return null;
    const filePath = maybe.filePath.trim();
    const commitHash = maybe.commitHash.trim();
    const commitShortHash =
        typeof maybe.commitShortHash === "string" ? maybe.commitShortHash.trim() : undefined;
    const repoRoot = typeof maybe.repoRoot === "string" ? maybe.repoRoot.trim() : undefined;
    if (!filePath || !commitHash) return null;
    return { filePath, commitHash, commitShortHash, repoRoot };
}

export async function openDiffAgainstGitRef(
    fileUri: vscode.Uri,
    repoRelativeFilePath: string,
    ref: string,
    sourceLabel: "revision" | "branch",
    gitOps: GitOps,
): Promise<void> {
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    const refSnapshot = makeTextDiffSnapshot(
        repoRelativeFilePath,
        await gitOps.getFileContentAtRef(repoRelativeFilePath, trimmedRef),
        trimmedRef,
    );
    const leftDoc = await vscode.workspace.openTextDocument(
        getDiffContentProvider().createUri(
            repoRelativeFilePath,
            trimmedRef,
            refSnapshot.content,
            { forcePlainTextUri: refSnapshot.forcePlainTextUri },
        ),
    );
    const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, fileUri, title);
}

export async function openCommitFileDiff(
    commitHash: string,
    filePath: string,
    repoRoot: string,
    gitOps: GitOps,
    executor: GitExecutor,
    options: { parentRef?: string; parentDisplayHash?: string } = {},
): Promise<{
    parentRef: string;
    parentDisplayHash: string;
    leftUri: vscode.Uri;
    rightUri: vscode.Uri;
} | null> {
    const safePath = assertRepoRelativePath(filePath);

    let parentRef: string;
    let parentDisplayHash: string;
    if (options.parentRef) {
        parentRef = options.parentRef;
        parentDisplayHash = options.parentDisplayHash ?? options.parentRef;
    } else {
        const parents = await getCommitParentHashes(commitHash, executor);
        if (parents.length <= 1) {
            parentRef = parents.length === 0 ? EMPTY_TREE_HASH : parents[0];
            parentDisplayHash = parentRef;
        } else {
            const result = await pickMainlineParent(
                commitHash,
                "Open Commit File Diff",
                executor,
                parents,
            );
            if (result.kind === "cancelled") return null;
            if (result.kind === "notMerge") return null;
            parentRef = `${commitHash}^${result.parentNumber}`;
            parentDisplayHash = parents[result.parentNumber! - 1] ?? parentRef;
        }
    }

    let leftContent: string;
    try {
        leftContent = await gitOps.getFileContentAtRef(safePath, parentRef);
    } catch {
        leftContent = "";
    }

    let rightContent: string;
    try {
        rightContent = await gitOps.getFileContentAtRef(safePath, commitHash);
    } catch {
        rightContent = "";
    }

    const leftSnapshot = makeTextDiffSnapshot(safePath, leftContent, parentDisplayHash);
    const rightSnapshot = makeTextDiffSnapshot(safePath, rightContent, commitHash);
    const diffProvider = getDiffContentProvider();
    const leftDoc = await vscode.workspace.openTextDocument(
        diffProvider.createUri(safePath, parentRef, leftSnapshot.content, {
            forcePlainTextUri: leftSnapshot.forcePlainTextUri,
        }),
    );
    const rightDoc = await vscode.workspace.openTextDocument(
        getEditableDiffProvider().createUri(safePath, commitHash, rightSnapshot.content, {
            forcePlainTextUri: rightSnapshot.forcePlainTextUri,
        }),
    );
    const shortParent = parentDisplayHash.slice(0, 8);
    const shortCommit = commitHash.slice(0, 8);
    const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title);
    return { parentRef, parentDisplayHash, leftUri: leftDoc.uri, rightUri: rightDoc.uri };
}

export async function openBranchComparisonFileDiff(
    file: ProjectComparisonFile,
    ref: string,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const safePath = assertRepoRelativePath(file.path);
    const leftPath = file.oldPath ? assertRepoRelativePath(file.oldPath) : safePath;
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    const leftSnapshot = makeTextDiffSnapshot(
        leftPath,
        await gitOps.getFileContentAtRef(leftPath, trimmedRef).catch(() => ""),
        trimmedRef,
    );

    const leftDoc = await vscode.workspace.openTextDocument(
        getDiffContentProvider().createUri(leftPath, trimmedRef, leftSnapshot.content, {
            forcePlainTextUri: leftSnapshot.forcePlainTextUri,
        }),
    );

    let rightUri: vscode.Uri;
    const workingTreeUri = vscode.Uri.file(path.join(repoRoot, safePath));
    if (file.status !== "D" && (await fileExists(workingTreeUri)) && !isBinaryFilePath(safePath)) {
        rightUri = workingTreeUri;
    } else {
        const rightContent =
            file.status !== "D" && isBinaryFilePath(safePath)
                ? await readWorkingTreeTextSnapshot(workingTreeUri)
                : "";
        const rightDoc = await vscode.workspace.openTextDocument(
            getDiffContentProvider().createUri(
                safePath,
                "current",
                rightContent,
                { forcePlainTextUri: rightContent.length > 0 },
            ),
        );
        rightUri = rightDoc.uri;
    }

    const title = `${safePath} (${trimmedRef} ↔ Current)`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightUri, title);
}

export async function openWorkingTreeFileDiff(
    file: WorkingFile,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const safePath = assertRepoRelativePath(file.path);
    const leftPath = safePath;
    const isKnownBinary = isBinaryFilePath(safePath);
    const workingTreeUri = vscode.Uri.file(path.join(repoRoot, safePath));
    const leftContent =
        file.status === "?" || file.status === "A"
            ? ""
            : isKnownBinary
              ? binaryPlaceholder(leftPath, "HEAD")
              : await gitOps.getFileContentAtRef(leftPath, "HEAD").catch(() => "");
    const leftSnapshot = makeTextDiffSnapshot(leftPath, leftContent, "HEAD");

    const diffProvider = getDiffContentProvider();
    const leftDoc = await vscode.workspace.openTextDocument(
        diffProvider.createUri(leftPath, "HEAD", leftSnapshot.content, {
            forcePlainTextUri: leftSnapshot.forcePlainTextUri,
        }),
    );
    let rightUri: vscode.Uri;
    if (file.status === "D" || isKnownBinary) {
        const rightContent =
            file.status === "D"
                ? ""
                : await readWorkingTreeTextSnapshot(workingTreeUri);
        const rightSnapshot = makeTextDiffSnapshot(safePath, rightContent, "working tree");
        const rightDoc = await vscode.workspace.openTextDocument(
            diffProvider.createUri(safePath, "working-tree", rightSnapshot.content, {
                forcePlainTextUri: rightSnapshot.forcePlainTextUri,
            }),
        );
        rightUri = rightDoc.uri;
    } else {
        let workingTreeContent: Uint8Array;
        try {
            workingTreeContent = await vscode.workspace.fs.readFile(workingTreeUri);
        } catch {
            workingTreeContent = new Uint8Array();
        }
        if (isProbablyBinary(workingTreeContent)) {
            const rightDoc = await vscode.workspace.openTextDocument(
                diffProvider.createUri(
                    safePath,
                    "working-tree",
                    binaryPlaceholder(path.basename(safePath), "working tree"),
                    { forcePlainTextUri: true },
                ),
            );
            rightUri = rightDoc.uri;
        } else {
            rightUri = getEditableDiffProvider().createWorkingTreeUri(
                safePath,
                workingTreeContent,
                workingTreeUri,
            );
        }
    }
    const title = `${safePath} (HEAD ↔ Working Tree)`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightUri, title);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function readWorkingTreeTextSnapshot(uri: vscode.Uri): Promise<string> {
    const filePath = uri.fsPath;
    if (isBinaryFilePath(filePath)) {
        return binaryPlaceholder(path.basename(filePath), "working tree");
    }
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        if (isProbablyBinary(bytes)) {
            return binaryPlaceholder(path.basename(filePath), "working tree");
        }
        return Buffer.from(bytes).toString("utf8");
    } catch {
        return "";
    }
}

function isBinaryFilePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".pb.gz")) return true;
    return BINARY_FILE_EXTENSIONS.has(path.extname(lower));
}

function makeTextDiffSnapshot(
    filePath: string,
    content: string,
    side: string,
): { content: string; forcePlainTextUri: boolean } {
    if (content.length === 0) {
        return { content, forcePlainTextUri: false };
    }
    if (isBinaryFilePath(filePath) || isProbablyBinaryText(content)) {
        return {
            content: binaryPlaceholder(path.posix.basename(normalizeGitPath(filePath)), side),
            forcePlainTextUri: true,
        };
    }
    return { content, forcePlainTextUri: false };
}

function isProbablyBinary(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
    if (sample.length === 0) return false;
    let suspicious = 0;
    for (const byte of sample) {
        if (byte === 0) return true;
        if (byte < 7 || (byte > 14 && byte < 32)) suspicious++;
    }
    return suspicious / sample.length > 0.08;
}

function isProbablyBinaryText(content: string): boolean {
    const sample = content.slice(0, 8192);
    if (sample.length === 0) return false;
    let suspicious = 0;
    for (let index = 0; index < sample.length; index++) {
        const code = sample.charCodeAt(index);
        if (code === 0) return true;
        if (code === 0xfffd) suspicious++;
        if (code < 7 || (code > 14 && code < 32)) suspicious++;
    }
    return suspicious / sample.length > 0.08;
}

function binaryPlaceholder(filePath: string, side: string): string {
    return `Binary file snapshot is not displayed as text.\n\nFile: ${filePath}\nSide: ${side}\n`;
}

export async function openCommitDiffSourceFile(
    ctx: unknown,
    repoRoot: vscode.Uri,
): Promise<void> {
    const diffUri = getCommitDiffEditorUri(ctx);
    if (!diffUri) {
        vscode.window.showErrorMessage(
            "Open in Editor is only available for IntelliGit commit diff editors.",
        );
        return;
    }

    const sourceUri = getCommitDiffSourceFileUri(diffUri, repoRoot);
    const filePath = sourceUri ? getCommitDiffFilePathFromUri(diffUri) : null;
    if (!sourceUri || !filePath) {
        vscode.window.showErrorMessage("Failed to resolve the source file for this commit diff.");
        return;
    }

    try {
        await vscode.workspace.fs.stat(sourceUri);
    } catch {
        vscode.window.showWarningMessage(`File no longer exists: ${filePath}`);
        return;
    }

    await vscode.window.showTextDocument(sourceUri);
}

export async function applyPatchTextToRepo(
    patchText: string,
    reverse: boolean,
    executor: GitExecutor,
): Promise<void> {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "intelligit-filepatch-"));
    const patchFilePath = path.join(tempDir, "selected-change.patch");
    try {
        await fs.promises.writeFile(patchFilePath, patchText, "utf8");
        const args = [
            "apply",
            "--index",
            "--3way",
            "--whitespace=nowarn",
            ...(reverse ? ["-R"] : []),
            patchFilePath,
        ];
        await executor.run(args);
    } finally {
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch((err) => {
            console.warn(`[intelligit] Failed to clean up temp patch dir ${tempDir}:`, err);
        });
    }
}

export async function compareEditorFileWithBranch(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage("Compare with Branch is only available for local files.");
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            "Selected file is outside the current IntelliGit repository workspace.",
        );
        return;
    }

    try {
        const branches = await gitOps.getBranches();
        const picks = branches
            .slice()
            .sort((a, b) => {
                if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
                if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            .map((branch) => ({
                label: branch.isCurrent ? `${branch.name} (current)` : branch.name,
                description: branch.isRemote ? "remote branch" : "local branch",
                detail: branch.hash,
                refName: branch.name,
            }));

        const picked = await vscode.window.showQuickPick(picks, {
            title: "Compare with Branch",
            placeHolder: `Select a branch for ${repoRelativeFilePath}`,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        await openDiffAgainstGitRef(
            fileUri,
            repoRelativeFilePath,
            picked.refName,
            "branch",
            gitOps,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`Compare with branch failed: ${message}`);
    }
}

export async function compareEditorFileWithRevision(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileUri = getEditorContextFileUri(ctx);
    if (!fileUri) {
        vscode.window.showErrorMessage("Compare with Revision is only available for local files.");
        return;
    }

    const repoRelativeFilePath = getRepoRelativeFilePathFromUri(fileUri, repoRoot);
    if (!repoRelativeFilePath) {
        vscode.window.showErrorMessage(
            "Selected file is outside the current IntelliGit repository workspace.",
        );
        return;
    }

    try {
        const historyEntries = await gitOps.getFileHistoryEntries(repoRelativeFilePath, 20);
        const MANUAL_SENTINEL = "__manual__";
        const historyPicks = historyEntries.map((entry) => ({
            label: `${entry.shortHash}  ${entry.subject || "(no subject)"}`,
            description: entry.author,
            detail: entry.date,
            refName: entry.hash,
        }));
        const picks = [
            ...historyPicks,
            {
                label: "$(edit) Enter revision manually",
                description: "Commit hash, tag, or ref name",
                detail: undefined as string | undefined,
                refName: MANUAL_SENTINEL,
            },
        ];

        const picked = await vscode.window.showQuickPick(picks, {
            title: "Compare with Revision",
            placeHolder:
                historyPicks.length > 0
                    ? `Select a recent revision for ${repoRelativeFilePath}`
                    : `No recent file history found. Enter a revision for ${repoRelativeFilePath}`,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        if (!picked) return;

        let refName = picked.refName;
        if (refName === MANUAL_SENTINEL) {
            const input = await vscode.window.showInputBox({
                title: "Compare with Revision",
                prompt: `Enter a commit hash, tag, or ref for ${repoRelativeFilePath}`,
                placeHolder: "HEAD~1",
                ignoreFocusOut: true,
            });
            if (!input?.trim()) return;
            refName = input.trim();
        }

        await openDiffAgainstGitRef(fileUri, repoRelativeFilePath, refName, "revision", gitOps);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`Compare with revision failed: ${message}`);
    }
}

export async function compareCommitInfoFileWithLocal(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;
    try {
        const safePath = assertRepoRelativePath(fileCtx.filePath);
        const fileUri = vscode.Uri.file(path.join(repoRoot, safePath));
        await openDiffAgainstGitRef(fileUri, safePath, fileCtx.commitHash, "revision", gitOps);
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`Compare with local failed: ${message}`);
    }
}

export async function applySelectedCommitFileChange(
    ctx: unknown,
    mode: "cherry-pick" | "revert",
    executor: GitExecutor,
    refreshConflictUi: () => Promise<void>,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;

    const short = fileCtx.commitShortHash || fileCtx.commitHash.slice(0, 8);
    const labels = COMMIT_FILE_CHANGE_MODE_LABELS[mode];

    const confirmed = await vscode.window.showWarningMessage(
        labels.confirmPrompt(short, fileCtx.filePath),
        { modal: true },
        labels.confirmLabel,
    );
    if (confirmed !== labels.confirmLabel) return;

    try {
        const patchText = await buildCommitFilePatch(
            fileCtx.commitHash,
            fileCtx.filePath,
            labels.actionTitle,
            executor,
        );
        if (patchText === null) return; // merge parent selection cancelled
        if (!patchText.trim()) {
            vscode.window.showInformationMessage(
                `No file-level patch found for ${fileCtx.filePath} in ${short}.`,
            );
            return;
        }

        await runWithNotificationProgress(
            `${labels.progressVerb} selected change for ${fileCtx.filePath}...`,
            async () => {
                await applyPatchTextToRepo(patchText, mode === "revert", executor);
            },
        );

        vscode.window.showInformationMessage(
            `${labels.successVerb} selected change from ${short} for ${fileCtx.filePath}.`,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`${labels.errorLabel} failed: ${message}`);
    } finally {
        await refreshConflictUi().catch(() => {});
    }
}

const COMMIT_FILE_CHANGE_MODE_LABELS = {
    "cherry-pick": {
        actionTitle: "Cherry-pick Selected Change",
        confirmLabel: "Apply Change",
        confirmPrompt: (short: string, filePath: string) =>
            `Apply the change from ${short} for ${filePath} to your working tree and stage it?`,
        progressVerb: "Applying",
        successVerb: "Applied",
        errorLabel: "Cherry-pick selected change",
    },
    revert: {
        actionTitle: "Revert Selected Change",
        confirmLabel: "Revert Change",
        confirmPrompt: (short: string, filePath: string) =>
            `Apply the inverse of the change from ${short} for ${filePath} to your working tree and stage it?`,
        progressVerb: "Reverting",
        successVerb: "Reverted",
        errorLabel: "Revert selected change",
    },
} as const;
