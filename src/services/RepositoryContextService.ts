import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { GitExecutor } from "../git/executor";
import { GitOps } from "../git/operations";
import type { RepositoryContextInfo } from "../types";

type RepositoryEntry = {
    root: string;
    uri: vscode.Uri;
    info: RepositoryContextInfo;
    executor: GitExecutor;
    gitOps: GitOps;
};

const IGNORED_DIRECTORY_NAMES = new Set([
    ".git",
    "node_modules",
    ".hg",
    ".svn",
]);

export class RepositoryContextService {
    private repositories: RepositoryEntry[] = [];
    private currentRepositoryRoot: string | null = null;
    private readonly _onDidChangeCurrentRepository = new vscode.EventEmitter<
        RepositoryEntry | null
    >();

    readonly onDidChangeCurrentRepository = this._onDidChangeCurrentRepository.event;

    constructor(private readonly workspaceRoot: vscode.Uri) {}

    async initialize(): Promise<void> {
        await this.refreshRepositories();
    }

    async refreshRepositories(): Promise<RepositoryEntry | null> {
        const previousRoot = this.currentRepositoryRoot;
        const discoveredRoots = await discoverGitRepositories(this.workspaceRoot.fsPath);

        const nextRepositories = new Map<string, RepositoryEntry>();
        for (const root of discoveredRoots) {
            const existing = this.repositories.find((entry) => entry.root === root);
            if (existing) {
                nextRepositories.set(root, existing);
                continue;
            }

            const executor = new GitExecutor(root);
            const gitOps = new GitOps(executor);
            if (!(await gitOps.isRepository())) continue;

            nextRepositories.set(root, {
                root,
                uri: vscode.Uri.file(root),
                info: buildRepositoryContextInfo(this.workspaceRoot.fsPath, root),
                executor,
                gitOps,
            });
        }

        this.repositories = Array.from(nextRepositories.values()).sort((a, b) =>
            a.root.localeCompare(b.root),
        );

        const nextCurrent =
            this.findByRoot(previousRoot) ??
            this.getRepositoryForUri(vscode.window.activeTextEditor?.document.uri) ??
            this.repositories[0] ??
            null;

        this.currentRepositoryRoot = nextCurrent?.root ?? null;
        if (nextCurrent?.root !== previousRoot) {
            this._onDidChangeCurrentRepository.fire(nextCurrent);
        }
        return nextCurrent;
    }

    async followActiveEditor(editor: vscode.TextEditor | undefined): Promise<boolean> {
        const repo = this.getRepositoryForUri(editor?.document.uri);
        if (!repo || repo.root === this.currentRepositoryRoot) {
            return false;
        }
        this.currentRepositoryRoot = repo.root;
        this._onDidChangeCurrentRepository.fire(repo);
        return true;
    }

    switchRepository(root: string): boolean {
        const repo = this.findByRoot(root);
        if (!repo || repo.root === this.currentRepositoryRoot) {
            return false;
        }
        this.currentRepositoryRoot = repo.root;
        this._onDidChangeCurrentRepository.fire(repo);
        return true;
    }

    listRepositories(): RepositoryEntry[] {
        return [...this.repositories];
    }

    getCurrentRepository(): RepositoryEntry | null {
        return this.findByRoot(this.currentRepositoryRoot) ?? null;
    }

    getRepositoryForUri(uri: vscode.Uri | undefined): RepositoryEntry | null {
        if (!uri || uri.scheme !== "file") return null;
        const match = this.repositories
            .filter((entry) => isPathInsideRepository(uri.fsPath, entry.root))
            .sort((a, b) => b.root.length - a.root.length)[0];
        return match ?? null;
    }

    getCurrentRepositoryInfo(): RepositoryContextInfo | null {
        return this.getCurrentRepository()?.info ?? null;
    }

    requireCurrentRepository(): RepositoryEntry {
        const repo = this.getCurrentRepository();
        if (!repo) {
            throw new Error("No git repository found in the current workspace.");
        }
        return repo;
    }

    private findByRoot(root: string | null): RepositoryEntry | null {
        if (!root) return null;
        return this.repositories.find((entry) => entry.root === root) ?? null;
    }
}

export function createRepositoryScopedGitOps(service: RepositoryContextService): GitOps {
    return new Proxy({} as GitOps, {
        get(_target, prop, _receiver) {
            const value = (service.requireCurrentRepository().gitOps as unknown as Record<
                PropertyKey,
                unknown
            >)[prop];
            return typeof value === "function" ? value.bind(service.requireCurrentRepository().gitOps) : value;
        },
    });
}

export function createRepositoryScopedExecutor(service: RepositoryContextService): GitExecutor {
    return new Proxy({} as GitExecutor, {
        get(_target, prop, _receiver) {
            const value = (service.requireCurrentRepository().executor as unknown as Record<
                PropertyKey,
                unknown
            >)[prop];
            return typeof value === "function"
                ? value.bind(service.requireCurrentRepository().executor)
                : value;
        },
    });
}

async function discoverGitRepositories(root: string): Promise<string[]> {
    const results: string[] = [];
    await walk(root);
    return results;

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
        } catch {
            return;
        }

        if (entries.some((entry) => entry.name === ".git")) {
            results.push(dir);
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
            await walk(path.join(dir, entry.name));
        }
    }
}

function buildRepositoryContextInfo(workspaceRoot: string, repoRoot: string): RepositoryContextInfo {
    const relativePath = path.relative(workspaceRoot, repoRoot);
    const normalizedRelative = relativePath && relativePath !== "." ? relativePath : undefined;
    return {
        name: path.basename(repoRoot) || repoRoot,
        root: repoRoot,
        relativePath: normalizedRelative,
    };
}

function isPathInsideRepository(filePath: string, repoRoot: string): boolean {
    const relative = path.relative(repoRoot, filePath);
    return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
