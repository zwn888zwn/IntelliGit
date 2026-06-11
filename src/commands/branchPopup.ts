import * as vscode from "vscode";
import type { Branch, RepositoryContextInfo } from "../types";

export class BranchStatusBarController implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly abortMergeItem: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.name = "IntelliGit Branch";
        this.item.command = "intelligit.showBranchPopup";
        this.item.accessibilityInformation = {
            label: "IntelliGit branch menu",
            role: "button",
        };

        this.abortMergeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.abortMergeItem.name = "IntelliGit Abort Merge";
        this.abortMergeItem.text = "$(close)";
        this.abortMergeItem.command = "intelligit.abortMerge";
        this.abortMergeItem.tooltip = "Abort current merge";
        this.abortMergeItem.backgroundColor = new vscode.ThemeColor(
            "statusBarItem.errorBackground",
        );
        this.abortMergeItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
        this.abortMergeItem.accessibilityInformation = {
            label: "Abort current IntelliGit merge",
            role: "button",
        };
    }

    update(
        repository: { info: RepositoryContextInfo } | null,
        branches: Branch[],
        options: { mergeInProgress?: boolean } = {},
    ): void {
        if (!repository) {
            this.item.hide();
            this.abortMergeItem.hide();
            return;
        }

        const current = branches.find((branch) => branch.isCurrent);
        if (!current) {
            this.item.text = "$(git-branch) Detached HEAD";
            this.item.tooltip = `IntelliGit: ${repository.info.relativePath ?? repository.info.name}`;
            this.item.command = "intelligit.showBranchPopup";
            this.abortMergeItem.hide();
            this.item.show();
            return;
        }

        if (options.mergeInProgress) {
            this.item.text = `$(warning) Merging ${current.name}`;
            this.item.tooltip = [
                `IntelliGit: ${repository.info.relativePath ?? repository.info.name}`,
                `Merge in progress on ${current.name}`,
                "Click to open conflict resolution.",
            ].join("\n");
            this.item.command = "intelligit.openConflictSession";
            this.item.show();
            this.abortMergeItem.show();
            return;
        }

        const tracking = formatTrackingCounts(current);
        this.item.text = `$(git-branch) ${current.name}${tracking ? ` ${tracking}` : ""}`;
        this.item.tooltip = buildBranchTooltip(repository.info, current);
        this.item.command = "intelligit.showBranchPopup";
        this.abortMergeItem.hide();
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
        this.abortMergeItem.dispose();
    }
}

function formatTrackingCounts(branch: Branch): string {
    const parts: string[] = [];
    if (isPositiveCount(branch.ahead)) parts.push(`↗ ${branch.ahead}`);
    if (isPositiveCount(branch.behind)) parts.push(`↙ ${branch.behind}`);
    return parts.join(" ");
}

function isPositiveCount(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function buildBranchTooltip(info: RepositoryContextInfo, branch: Branch): string {
    const lines = [`IntelliGit: ${info.relativePath ?? info.name}`, `Branch: ${branch.name}`];
    if (branch.upstream) lines.push(`Tracked: ${branch.upstream}`);
    if (branch.ahead > 0) lines.push(`Outgoing commits: ${branch.ahead}`);
    if (branch.behind > 0) lines.push(`Incoming commits: ${branch.behind}`);
    return lines.join("\n");
}
