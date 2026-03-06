// Auto-refresh service extracted from extension.ts.
// Manages debounced light (commit panel only) and full
// (branches + graph + panel + conflicts) refresh cycles,
// plus file system watchers on the .git directory.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { GitOps } from "../git/operations";
import type { Branch } from "../types";
import { CommitGraphViewProvider } from "../views/CommitGraphViewProvider";
import { CommitPanelViewProvider } from "../views/CommitPanelViewProvider";
import { MergeConflictsTreeProvider } from "../views/MergeConflictsTreeProvider";

export interface RefreshServiceDeps {
    gitOps: GitOps;
    commitGraph: CommitGraphViewProvider;
    commitPanel: CommitPanelViewProvider;
    mergeConflicts: MergeConflictsTreeProvider;
    mergeConflictsView: vscode.TreeView<unknown>;
    onBranchesUpdated: (branches: Branch[]) => void;
}

export class RefreshService implements vscode.Disposable {
    private lightTimer: ReturnType<typeof setTimeout> | undefined;
    private fullTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly fsWatchers: fs.FSWatcher[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly deps: RefreshServiceDeps,
        private readonly repoRoot: string,
    ) {}

    async refreshMergeConflicts(): Promise<void> {
        const count = await this.deps.mergeConflicts.refresh();
        this.deps.mergeConflictsView.description = count > 0 ? `${count}` : "";
        vscode.commands.executeCommand("setContext", "intelligit.hasMergeConflicts", count > 0);
    }

    async refreshConflictUi(): Promise<void> {
        await this.deps.commitPanel.refresh();
        await this.refreshMergeConflicts();
    }

    async refreshAll(): Promise<void> {
        await vscode.commands.executeCommand("intelligit.refresh");
    }

    debouncedLightRefresh(): void {
        if (this.lightTimer) clearTimeout(this.lightTimer);
        this.lightTimer = setTimeout(async () => {
            await this.deps.commitPanel.refresh();
        }, 300);
    }

    debouncedFullRefresh(): void {
        if (this.fullTimer) clearTimeout(this.fullTimer);
        this.fullTimer = setTimeout(async () => {
            const branches = await this.deps.gitOps.getBranches();
            this.deps.onBranchesUpdated(branches);
            this.deps.commitGraph.setBranches(branches);
            await this.deps.commitGraph.refresh();
            await this.deps.commitPanel.refresh();
            await this.refreshMergeConflicts();
        }, 500);
    }

    registerFileWatchers(): void {
        const handler = () => this.debouncedLightRefresh();

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(handler),
            vscode.workspace.onDidSaveTextDocument(handler),
            vscode.workspace.onDidCreateFiles(handler),
            vscode.workspace.onDidDeleteFiles(handler),
            vscode.workspace.onDidRenameFiles(handler),
        );

        this.registerGitDirWatchers();
    }

    private registerGitDirWatchers(): void {
        const gitDir = path.join(this.repoRoot, ".git");
        const gitStateFiles = new Set([
            "HEAD",
            "FETCH_HEAD",
            "packed-refs",
            "MERGE_HEAD",
            "REBASE_HEAD",
        ]);

        try {
            const dirWatcher = fs.watch(gitDir, (_event, filename) => {
                if (filename && gitStateFiles.has(filename)) {
                    this.debouncedFullRefresh();
                }
            });
            this.fsWatchers.push(dirWatcher);
        } catch {
            /* .git dir may not be watchable */
        }

        try {
            const refsWatcher = fs.watch(path.join(gitDir, "refs"), { recursive: true }, () =>
                this.debouncedFullRefresh(),
            );
            this.fsWatchers.push(refsWatcher);
        } catch {
            /* refs dir may not exist yet */
        }
    }

    dispose(): void {
        if (this.lightTimer) clearTimeout(this.lightTimer);
        if (this.fullTimer) clearTimeout(this.fullTimer);
        for (const watcher of this.fsWatchers) {
            watcher.close();
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}
