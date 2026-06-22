import * as vscode from "vscode";

export type PushRequestLinkKind = "mergeRequest" | "pullRequest";

export interface PushRequestLink {
    url: string;
    kind: PushRequestLinkKind;
}

const CREATE_MERGE_REQUEST_ACTION = "Create Merge Request";
const CREATE_PULL_REQUEST_ACTION = "Create Pull Request";
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function cleanUrl(rawUrl: string): string {
    return rawUrl.replace(/[.,;]+$/g, "");
}

function classifyRequestLink(url: string, context: string): PushRequestLinkKind | null {
    const text = `${context}\n${url}`.toLowerCase();
    if (
        text.includes("merge request") ||
        /\/-\/merge_requests\/new\b/.test(text) ||
        /\/merge-requests\/new\b/.test(text) ||
        /\/merge_requests\/new\b/.test(text)
    ) {
        return "mergeRequest";
    }
    if (
        text.includes("pull request") ||
        /\/pull\/new\b/.test(text) ||
        /\/pull-requests\/new\b/.test(text) ||
        /\/pull_requests\/new\b/.test(text)
    ) {
        return "pullRequest";
    }
    return null;
}

export function findPushRequestLink(pushOutput: string | undefined | null): PushRequestLink | null {
    if (!pushOutput) return null;

    const lines = pushOutput.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const matches = line.matchAll(URL_PATTERN);
        for (const match of matches) {
            const url = cleanUrl(match[0]);
            const context = lines
                .slice(Math.max(0, index - 2), Math.min(lines.length, index + 2))
                .join("\n");
            const kind = classifyRequestLink(url, context);
            if (kind) {
                return { url, kind };
            }
        }
    }

    return null;
}

export async function showPushSuccessWithRequestLink(
    message: string,
    pushOutput: string | undefined | null,
): Promise<void> {
    const link = findPushRequestLink(pushOutput);
    if (!link) {
        await vscode.window.showInformationMessage(message);
        return;
    }

    const action =
        link.kind === "mergeRequest"
            ? CREATE_MERGE_REQUEST_ACTION
            : CREATE_PULL_REQUEST_ACTION;
    const selected = await vscode.window.showInformationMessage(message, action);
    if (selected === action) {
        await vscode.env.openExternal(vscode.Uri.parse(link.url));
    }
}
