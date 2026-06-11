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
const GIT_SCHEME = "git";
const COMMIT_DIFF_GIT_QUERY_KEY = "intelligitCommitDiff";
const COMMIT_DIFF_TEXT_QUERY_KEY = "intelligitCommitDiff";

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
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
    ".bmp",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
]);
const TRANSPARENT_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sZ4VwAAAABJRU5ErkJggg==";

class IntelliGitDiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly contents = new Map<string, string>();
    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
    private nextId = 1;

    readonly onDidChange = this.changeEmitter.event;

    createUri(
        filePath: string,
        ref: string,
        content: string,
        options: {
            forcePlainTextUri?: boolean;
            markAsCommitDiff?: boolean;
            originalPath?: string;
            sourceFsPath?: string;
        } = {},
    ): vscode.Uri {
        const id = String(this.nextId++);
        const query = new URLSearchParams({
            ref,
            id,
            path: normalizeGitPath(filePath),
        });
        if (options.markAsCommitDiff) {
            query.set(COMMIT_DIFF_TEXT_QUERY_KEY, "1");
        }
        if (options.originalPath) {
            query.set("originalPath", normalizeGitPath(options.originalPath));
        }
        if (options.sourceFsPath) {
            query.set("sourceFsPath", options.sourceFsPath);
        }
        const uri = vscode.Uri.from({
            scheme: DIFF_DOCUMENT_SCHEME,
            path: makeTextDiffUriPath(id, filePath, options.forcePlainTextUri),
            query: query.toString(),
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

    createWorkingTreeUri(
        filePath: string,
        content: Uint8Array,
        targetUri: vscode.Uri,
        options: { forcePlainTextUri?: boolean } = {},
    ): vscode.Uri {
        const id = String(this.nextId++);
        const uri = vscode.Uri.from({
            scheme: DIFF_EDITABLE_SCHEME,
            path: makeTextDiffUriPath(id, filePath, options.forcePlainTextUri),
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
        vscode.languages.registerDefinitionProvider(
            [{ scheme: GIT_SCHEME }, { scheme: DIFF_DOCUMENT_SCHEME }],
            createCommitDiffDefinitionProvider(),
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

function isPreviewableImageFilePath(filePath: string): boolean {
    return PREVIEWABLE_IMAGE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function createGitResourceUri(
    fileUri: vscode.Uri,
    ref: string,
    options: { markAsCommitDiff?: boolean; originalPath?: string } = {},
): vscode.Uri {
    return vscode.Uri.from({
        scheme: GIT_SCHEME,
        path: fileUri.path,
        query: JSON.stringify({
            path: fileUri.fsPath,
            ref,
            ...(options.originalPath ? { originalPath: options.originalPath } : {}),
            ...(options.markAsCommitDiff ? { [COMMIT_DIFF_GIT_QUERY_KEY]: true } : {}),
        }),
    });
}

function parseGitResourceQuery(
    uri: vscode.Uri,
): { path?: string; ref?: string; originalPath?: string; intelligitCommitDiff?: boolean } | null {
    if (uri.scheme !== GIT_SCHEME || !uri.query) return null;
    try {
        const parsed = JSON.parse(uri.query) as {
            path?: unknown;
            ref?: unknown;
            originalPath?: unknown;
            intelligitCommitDiff?: unknown;
        };
        return {
            path: typeof parsed.path === "string" ? parsed.path : undefined,
            ref: typeof parsed.ref === "string" ? parsed.ref : undefined,
            originalPath: typeof parsed.originalPath === "string" ? parsed.originalPath : undefined,
            intelligitCommitDiff:
                typeof parsed.intelligitCommitDiff === "boolean"
                    ? parsed.intelligitCommitDiff
                    : undefined,
        };
    } catch {
        return null;
    }
}

function parseDiffDocumentQuery(uri: vscode.Uri): URLSearchParams | null {
    if (uri.scheme !== DIFF_DOCUMENT_SCHEME && uri.scheme !== DIFF_EDITABLE_SCHEME) return null;
    return new URLSearchParams(uri.query);
}

function sanitizeTempFileSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function createTransparentImagePlaceholderUri(
    filePath: string,
    side: "left" | "right",
): Promise<vscode.Uri> {
    const fileName = path.posix.basename(normalizeGitPath(filePath)) || "image";
    const placeholderDir = path.join(os.tmpdir(), "intelligit-image-placeholders");
    const placeholderPath = path.join(
        placeholderDir,
        `${sanitizeTempFileSegment(fileName)}-${side}.png`,
    );
    const placeholderUri = vscode.Uri.file(placeholderPath);
    await vscode.workspace.fs.writeFile(
        placeholderUri,
        Buffer.from(TRANSPARENT_PNG_BASE64, "base64"),
    );
    return placeholderUri;
}

function isIntelliGitCommitDiffTextUri(uri: vscode.Uri): boolean {
    return parseDiffDocumentQuery(uri)?.get(COMMIT_DIFF_TEXT_QUERY_KEY) === "1";
}

function isIntelliGitCommitDiffUri(uri: vscode.Uri): boolean {
    return isIntelliGitCommitDiffGitUri(uri) || isIntelliGitCommitDiffTextUri(uri);
}

function isIntelliGitCommitDiffGitUri(uri: vscode.Uri): boolean {
    return parseGitResourceQuery(uri)?.intelligitCommitDiff === true;
}

function getCommitDiffSourceUriFromGitUri(uri: vscode.Uri): vscode.Uri | null {
    const filePath = parseGitResourceQuery(uri)?.path?.trim();
    if (!filePath) return null;
    return vscode.Uri.file(filePath);
}

function getCommitDiffSourceUri(uri: vscode.Uri): vscode.Uri | null {
    if (uri.scheme === GIT_SCHEME) {
        return getCommitDiffSourceUriFromGitUri(uri);
    }
    const sourceFsPath = parseDiffDocumentQuery(uri)?.get("sourceFsPath")?.trim();
    if (!sourceFsPath) return null;
    return vscode.Uri.file(sourceFsPath);
}

function isWordBoundaryCharacter(value: string | undefined): boolean {
    return !value || !/[A-Za-z0-9_]/.test(value);
}

function findWordPositionInLine(lineText: string, symbol: string): number | null {
    if (!symbol) return null;
    for (let index = lineText.indexOf(symbol); index >= 0; index = lineText.indexOf(symbol, index + 1)) {
        const before = lineText[index - 1];
        const after = lineText[index + symbol.length];
        if (isWordBoundaryCharacter(before) && isWordBoundaryCharacter(after)) {
            return index;
        }
    }
    return null;
}

function findDefinitionAnchorPosition(
    diffDocument: vscode.TextDocument,
    sourceDocument: vscode.TextDocument,
    position: vscode.Position,
): vscode.Position {
    const wordRange = diffDocument.getWordRangeAtPosition(position);
    const symbol = wordRange ? diffDocument.getText(wordRange) : "";
    if (!symbol) return position;

    const sameLine = Math.min(position.line, Math.max(0, sourceDocument.lineCount - 1));
    const sameLineIndex = findWordPositionInLine(sourceDocument.lineAt(sameLine).text, symbol);
    if (sameLineIndex !== null) {
        return new vscode.Position(sameLine, sameLineIndex);
    }

    for (let offset = 1; offset < sourceDocument.lineCount; offset++) {
        const upwardLine = sameLine - offset;
        if (upwardLine >= 0) {
            const match = findWordPositionInLine(sourceDocument.lineAt(upwardLine).text, symbol);
            if (match !== null) return new vscode.Position(upwardLine, match);
        }
        const downwardLine = sameLine + offset;
        if (downwardLine < sourceDocument.lineCount) {
            const match = findWordPositionInLine(sourceDocument.lineAt(downwardLine).text, symbol);
            if (match !== null) return new vscode.Position(downwardLine, match);
        }
    }

    return position;
}

function createCommitDiffDefinitionProvider(): vscode.DefinitionProvider {
    return {
        async provideDefinition(document, position) {
            if (!isIntelliGitCommitDiffUri(document.uri)) return null;
            return executeCommitDiffDefinition(document, position, { openResult: false });
        },
    };
}

type NavigableSymbol = {
    start: number;
    end: number;
    symbol: string;
};

function collectNavigableSymbols(lineText: string): NavigableSymbol[] {
    const symbols = new Map<string, NavigableSymbol>();
    const add = (symbol: string, start: number) => {
        if (!symbol) return;
        const end = start + symbol.length;
        symbols.set(`${start}:${end}:${symbol}`, { start, end, symbol });
    };

    const declarationPattern = /\bfunc(?:\s*\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let declarationMatch: RegExpExecArray | null;
    while ((declarationMatch = declarationPattern.exec(lineText)) !== null) {
        const symbol = declarationMatch[1] ?? "";
        const fullMatch = declarationMatch[0] ?? "";
        const symbolOffset = fullMatch.lastIndexOf(symbol);
        if (symbolOffset < 0) continue;
        add(symbol, declarationMatch.index + symbolOffset);
    }

    return [...symbols.values()];
}

function findDeclarationSymbol(
    lineText: string,
    symbol: string,
): NavigableSymbol | undefined {
    return collectNavigableSymbols(lineText).find(
        (candidate) => candidate.symbol === symbol,
    );
}

async function executeCommitDiffDefinition(
    document: Pick<vscode.TextDocument, "uri" | "getWordRangeAtPosition" | "getText">,
    position: vscode.Position,
    options: { openResult: boolean },
): Promise<vscode.Location[] | vscode.LocationLink[] | null> {
    if (!isIntelliGitCommitDiffUri(document.uri)) return null;
    const sourceUri = getCommitDiffSourceUri(document.uri);
    if (!sourceUri) return null;

    let sourceDocument: vscode.TextDocument;
    try {
        sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
    } catch {
        return null;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    const symbol = wordRange ? document.getText(wordRange) : "";
    const sourcePosition = findDefinitionAnchorPosition(
        document as vscode.TextDocument,
        sourceDocument,
        position,
    );
    const declarationSymbol = symbol
        ? findDeclarationSymbol(sourceDocument.lineAt(sourcePosition.line).text, symbol)
        : undefined;
    if (declarationSymbol) {
        const declarationRange = new vscode.Range(
            new vscode.Position(sourcePosition.line, declarationSymbol.start),
            new vscode.Position(sourcePosition.line, declarationSymbol.end),
        );
        const declarationLocation = [{ uri: sourceUri, range: declarationRange }];
        if (options.openResult) {
            await vscode.window.showTextDocument(sourceUri, { selection: declarationRange });
        }
        return declarationLocation;
    }

    const result = await vscode.commands.executeCommand<
        vscode.Location[] | vscode.LocationLink[] | undefined
    >("vscode.executeDefinitionProvider", sourceUri, sourcePosition);

    if (!options.openResult) {
        return result ?? null;
    }

    const first = Array.isArray(result) ? result[0] : undefined;
    if (first && "targetUri" in first) {
        await vscode.window.showTextDocument(first.targetUri, {
            selection: first.targetSelectionRange ?? first.targetRange,
        });
        return result ?? null;
    }
    if (first && "uri" in first) {
        await vscode.window.showTextDocument(first.uri, { selection: first.range });
        return result ?? null;
    }

    await vscode.window.showTextDocument(sourceUri, {
        selection: new vscode.Range(sourcePosition, sourcePosition),
    });
    return result ?? null;
}

async function gitFileExistsAtRef(
    filePath: string,
    ref: string,
    executor: GitExecutor,
): Promise<boolean> {
    try {
        await executor.run(["cat-file", "-e", `${ref}:${filePath}`]);
        return true;
    } catch {
        return false;
    }
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
    if (isUriLike(ctx) && isIntelliGitCommitDiffTextUri(ctx)) return ctx;
    if (isUriLike(ctx) && isIntelliGitCommitDiffGitUri(ctx)) return ctx;
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && isIntelliGitCommitDiffTextUri(activeUri)) return activeUri;
    if (activeUri && isIntelliGitCommitDiffGitUri(activeUri)) return activeUri;
    return activeUri?.scheme === DIFF_EDITABLE_SCHEME ? activeUri : null;
}

export function getCommitDiffFilePathFromUri(uri: vscode.Uri): string | null {
    if (uri.scheme === GIT_SCHEME) {
        const originalPath = parseGitResourceQuery(uri)?.originalPath?.trim();
        if (!originalPath) return null;
        return assertRepoRelativePath(originalPath);
    }
    if (uri.scheme === DIFF_DOCUMENT_SCHEME) {
        const originalPath = parseDiffDocumentQuery(uri)?.get("originalPath")?.trim();
        if (!originalPath) return null;
        return assertRepoRelativePath(originalPath);
    }
    if (uri.scheme !== DIFF_EDITABLE_SCHEME) return null;
    const rawPath =
        parseDiffDocumentQuery(uri)?.get("path")?.trim() ??
        uri.path.replace(/^\/+/, "").trim();
    if (!rawPath) return null;
    return assertRepoRelativePath(rawPath);
}

export function getDiffOriginalFilePathFromUri(uri: vscode.Uri): string | null {
    if (uri.scheme === GIT_SCHEME) {
        const originalPath = parseGitResourceQuery(uri)?.originalPath?.trim();
        if (!originalPath) return null;
        return assertRepoRelativePath(originalPath);
    }
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
    executor?: GitExecutor,
): Promise<void> {
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;

    if (
        executor &&
        isPreviewableImageFilePath(repoRelativeFilePath) &&
        (await gitFileExistsAtRef(repoRelativeFilePath, trimmedRef, executor))
    ) {
        const title = `${repoRelativeFilePath} (${sourceLabel}: ${trimmedRef}) <-> Working Tree`;
        await vscode.commands.executeCommand(
            "vscode.diff",
            createGitResourceUri(fileUri, trimmedRef),
            fileUri,
            title,
        );
        return;
    }

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

    const workingTreeUri = vscode.Uri.file(path.join(repoRoot, safePath));
    if (isPreviewableImageFilePath(safePath)) {
        const [leftExists, rightExists] = await Promise.all([
            gitFileExistsAtRef(safePath, parentRef, executor),
            gitFileExistsAtRef(safePath, commitHash, executor),
        ]);
        if (leftExists || rightExists) {
            const shortParent = parentDisplayHash.slice(0, 8);
            const shortCommit = commitHash.slice(0, 8);
            const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;
            const leftUri = leftExists
                ? createGitResourceUri(workingTreeUri, parentRef, {
                      markAsCommitDiff: true,
                      originalPath: safePath,
                  })
                : await createTransparentImagePlaceholderUri(safePath, "left");
            const rightUri = rightExists
                ? createGitResourceUri(workingTreeUri, commitHash, {
                      markAsCommitDiff: true,
                      originalPath: safePath,
                  })
                : await createTransparentImagePlaceholderUri(safePath, "right");
            await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
            return { parentRef, parentDisplayHash, leftUri, rightUri };
        }
    }

    const [leftExists, rightExists] = await Promise.all([
        gitFileExistsAtRef(safePath, parentRef, executor),
        gitFileExistsAtRef(safePath, commitHash, executor),
    ]);
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
            markAsCommitDiff: true,
            originalPath: safePath,
            sourceFsPath: workingTreeUri.fsPath,
        }),
    );
    const rightDoc = await vscode.workspace.openTextDocument(
        diffProvider.createUri(safePath, commitHash, rightSnapshot.content, {
            forcePlainTextUri: rightSnapshot.forcePlainTextUri,
            markAsCommitDiff: true,
            originalPath: safePath,
            sourceFsPath: workingTreeUri.fsPath,
        }),
    );
    const shortParent = parentDisplayHash.slice(0, 8);
    const shortCommit = commitHash.slice(0, 8);
    const title = `${safePath} (${shortParent} ↔ ${shortCommit})`;
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, title);
    return { parentRef, parentDisplayHash, leftUri: leftDoc.uri, rightUri: rightDoc.uri };
}

export async function openShelvedFileDiff(
    index: number,
    filePath: string,
    repoRoot: string,
    gitOps: GitOps,
): Promise<{ baseRef: string; stashRef: string; leftUri: vscode.Uri; rightUri: vscode.Uri }> {
    if (!Number.isInteger(index) || index < 0) {
        throw new Error(`Invalid stash index: ${index}`);
    }

    const safePath = assertRepoRelativePath(filePath);
    const baseRef = `stash@{${index}}^`;
    const stashRef = `stash@{${index}}`;
    const workingTreeUri = vscode.Uri.file(path.join(repoRoot, safePath));

    const [baseContent, stashedContent] = await Promise.all([
        gitOps.getFileContentAtRef(safePath, baseRef).catch(() => ""),
        gitOps.getFileContentAtRef(safePath, stashRef).catch(() => ""),
    ]);

    const baseSnapshot = makeTextDiffSnapshot(safePath, baseContent, baseRef);
    const stashSnapshot = makeTextDiffSnapshot(safePath, stashedContent, stashRef);
    const diffProvider = getDiffContentProvider();
    const leftDoc = await vscode.workspace.openTextDocument(
        diffProvider.createUri(safePath, baseRef, baseSnapshot.content, {
            forcePlainTextUri: baseSnapshot.forcePlainTextUri,
            originalPath: safePath,
            sourceFsPath: workingTreeUri.fsPath,
        }),
    );
    const rightDoc = await vscode.workspace.openTextDocument(
        diffProvider.createUri(safePath, stashRef, stashSnapshot.content, {
            forcePlainTextUri: stashSnapshot.forcePlainTextUri,
            originalPath: safePath,
            sourceFsPath: workingTreeUri.fsPath,
        }),
    );

    await vscode.commands.executeCommand(
        "vscode.diff",
        leftDoc.uri,
        rightDoc.uri,
        `${safePath} (Stash ${index})`,
    );
    return { baseRef, stashRef, leftUri: leftDoc.uri, rightUri: rightDoc.uri };
}

export async function openBranchComparisonFileDiff(
    file: ProjectComparisonFile,
    ref: string,
    repoRoot: string,
    gitOps: GitOps,
    executor?: GitExecutor,
): Promise<void> {
    const safePath = assertRepoRelativePath(file.path);
    const leftPath = file.oldPath ? assertRepoRelativePath(file.oldPath) : safePath;
    const trimmedRef = ref.trim();
    if (!trimmedRef) return;
    const workingTreeUri = vscode.Uri.file(path.join(repoRoot, safePath));

    if (
        executor &&
        isPreviewableImageFilePath(safePath) &&
        file.status !== "D" &&
        (await fileExists(workingTreeUri)) &&
        (await gitFileExistsAtRef(leftPath, trimmedRef, executor))
    ) {
        const title = `${safePath} (${trimmedRef} ↔ Current)`;
        await vscode.commands.executeCommand(
            "vscode.diff",
            createGitResourceUri(vscode.Uri.file(path.join(repoRoot, leftPath)), trimmedRef),
            workingTreeUri,
            title,
        );
        return;
    }

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
    if (
        isPreviewableImageFilePath(safePath) &&
        file.status !== "?" &&
        file.status !== "A" &&
        file.status !== "D" &&
        (await fileExists(workingTreeUri))
    ) {
        const title = `${safePath} (HEAD ↔ Working Tree)`;
        await vscode.commands.executeCommand(
            "vscode.diff",
            createGitResourceUri(workingTreeUri, "HEAD"),
            workingTreeUri,
            title,
        );
        return;
    }
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
            rightUri = shouldUsePlainTextDiffUri(safePath)
                ? getEditableDiffProvider().createWorkingTreeUri(
                      safePath,
                      workingTreeContent,
                      workingTreeUri,
                      { forcePlainTextUri: true },
                  )
                : workingTreeUri;
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
    executor?: GitExecutor,
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
            executor,
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
    executor?: GitExecutor,
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

        await openDiffAgainstGitRef(
            fileUri,
            repoRelativeFilePath,
            refName,
            "revision",
            gitOps,
            executor,
        );
    } catch (error) {
        const message = getErrorMessage(error);
        vscode.window.showErrorMessage(`Compare with revision failed: ${message}`);
    }
}

export async function compareCommitInfoFileWithLocal(
    ctx: unknown,
    repoRoot: string,
    gitOps: GitOps,
    executor?: GitExecutor,
): Promise<void> {
    const fileCtx = getCommitInfoFileContext(ctx);
    if (!fileCtx) return;
    try {
        const safePath = assertRepoRelativePath(fileCtx.filePath);
        const fileUri = vscode.Uri.file(path.join(repoRoot, safePath));
        await openDiffAgainstGitRef(
            fileUri,
            safePath,
            fileCtx.commitHash,
            "revision",
            gitOps,
            executor,
        );
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
