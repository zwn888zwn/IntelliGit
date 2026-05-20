import * as vscode from "vscode";
import type { Branch, RepositoryContextInfo } from "../types";

export class BranchStatusBarController implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.name = "IntelliGit Branch";
        this.item.command = "intelligit.showBranchPopup";
        this.item.accessibilityInformation = {
            label: "IntelliGit branch menu",
            role: "button",
        };
    }

    update(
        repository: { info: RepositoryContextInfo } | null,
        branches: Branch[],
    ): void {
        if (!repository) {
            this.item.hide();
            return;
        }

        const current = branches.find((branch) => branch.isCurrent);
        if (!current) {
            this.item.text = "$(git-branch) Detached HEAD";
            this.item.tooltip = `IntelliGit: ${repository.info.relativePath ?? repository.info.name}`;
            this.item.show();
            return;
        }

        const tracking = formatTrackingCounts(current);
        this.item.text = `$(git-branch) ${current.name}${tracking ? ` ${tracking}` : ""}`;
        this.item.tooltip = buildBranchTooltip(repository.info, current);
        this.item.show();
    }

    dispose(): void {
        this.item.dispose();
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
