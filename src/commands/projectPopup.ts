import { execFile } from "child_process";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getErrorMessage } from "../utils/errors";

interface RecentProject {
    folderUri?: vscode.Uri;
    workspace?: { configPath: vscode.Uri };
    remoteAuthority?: string;
}

interface ProjectItem extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    remoteAuthority?: string;
    isWorkspace?: boolean;
    current?: boolean;
    command?: string;
}

export function registerProjectSwitcher(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("intelligit.openRecentProject", openRecentProject),
    );
}

function projectIcon(name: string, uri?: vscode.Uri, remoteAuthority?: string): vscode.Uri {
    const words = name.replace(/([a-z\d])([A-Z])/g, "$1 $2").match(/[\p{L}\p{N}]+/gu) ?? [];
    const initials = Array.from(words.slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase())
        .slice(0, 2).join("") || "P";
    const key = uri ? `${uri.scheme}:${uri.authority ?? ""}:${uri.path}|${uri.scheme === "file" ? remoteAuthority ?? "" : ""}` : name;
    let hash = 0;
    for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    const colors = ["#E4825C", "#8AA451", "#439D84", "#B78A16", "#6563D9", "#4E8DCF", "#C3679C", "#9A72C5"];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="9" fill="${colors[hash % colors.length]}"/><text x="20" y="21" text-anchor="middle" dominant-baseline="central" fill="white" font-family="sans-serif" font-size="${initials.length > 1 ? 17 : 23}" font-weight="500">${escapeHtml(initials)}</text></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function escapeHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export async function openRecentProject(): Promise<void> {
    let recent: { workspaces: RecentProject[] } | undefined;
    try {
        // VS Code exposes recent projects through an internal command only.
        recent = await vscode.commands.executeCommand("_workbench.getRecentlyOpened");
    } catch {
        // Keep the existing picker available on hosts without this command.
    }
    if (!Array.isArray(recent?.workspaces)) {
        await vscode.commands.executeCommand("workbench.action.openRecent");
        return;
    }

    const items: ProjectItem[] = [
        { label: "$(folder-opened) 打开项目…", command: "vscode.openFolder" },
        { label: "$(git-pull-request) 克隆仓库…", command: "git.clone" },
    ];
    const seen = new Set<string>();
    const addProject = (
        uri: vscode.Uri,
        current: boolean,
        isWorkspace = false,
        remoteAuthority?: string,
        name?: string,
    ): void => {
        const key = `${uri.scheme}:${uri.authority ?? ""}:${uri.path}|${uri.scheme === "file" ? remoteAuthority ?? "" : ""}`;
        if (seen.has(key)) return;
        seen.add(key);
        const projectPath = uri.scheme === "file" ? uri.fsPath : uri.path;
        const home = os.homedir();
        const displayPath = uri.scheme === "file" && projectPath.startsWith(home + path.sep)
            ? "~" + projectPath.slice(home.length) : projectPath;
        const authority = remoteAuthority || uri.authority;
        const projectName = name ?? path.posix.basename(uri.path).replace(/\.code-workspace$/, "");
        items.push({
            label: projectName,
            iconPath: projectIcon(projectName, uri, remoteAuthority),
            description: isWorkspace ? "工作区" : undefined,
            detail: `${displayPath}${authority ? ` · ${authority}` : ""}`,
            uri,
            remoteAuthority,
            isWorkspace,
            current,
        });
    };
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (vscode.workspace.workspaceFile || folders.length) {
        items.push({ label: "当前项目", kind: vscode.QuickPickItemKind.Separator });
        if (vscode.workspace.workspaceFile) {
            addProject(vscode.workspace.workspaceFile, true, true, undefined, vscode.workspace.name);
        } else {
            for (const folder of folders) addProject(folder.uri, true, false, undefined, folder.name);
        }
    }
    const recentStart = items.length;
    items.push({ label: "最近项目", kind: vscode.QuickPickItemKind.Separator });
    for (const entry of recent.workspaces) {
        const rawUri = entry.folderUri ?? entry.workspace?.configPath;
        if (!rawUri) continue;
        const uri = vscode.Uri.from(rawUri);
        addProject(uri, false, Boolean(entry.workspace), entry.remoteAuthority);
    }
    if (items.length === recentStart + 1) items.pop();

    const picker = vscode.window.createQuickPick<ProjectItem>();
    picker.title = "切换项目";
    picker.placeholder = "搜索项目名称、路径或分支";
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = items;
    picker.activeItems = items.filter((item) => item.uri && !item.current).slice(0, 1);
    let closed = false;
    const pending = items.filter(
        (item) => item.uri?.scheme === "file"
            && !item.isWorkspace && !item.remoteAuthority && !vscode.env.remoteName,
    );
    picker.busy = pending.length > 0;
    const selection = new Promise<ProjectItem | undefined>((resolve) => {
        const accept = picker.onDidAccept(() => {
            const item = picker.selectedItems[0];
            if (item) resolve(item);
        });
        const hide = picker.onDidHide(() => {
            closed = true;
            resolve(undefined);
            accept.dispose();
            hide.dispose();
            picker.dispose();
        });
    });
    picker.show();
    // Populate branches without holding up the picker or spawning one Git process per project.
    void Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (!closed) {
            const item = pending.shift();
            if (!item?.uri) return;
            const branch = await readBranch(item.uri.fsPath);
            if (closed) return;
            if (branch) {
                item.description = `$(git-branch) ${branch}`;
                const active = picker.activeItems;
                picker.items = [...items];
                picker.activeItems = active;
            }
        }
    })).then(() => {
        if (!closed) picker.busy = false;
    });

    const selected = await selection;
    if (!closed) picker.hide();
    if (!selected || selected.current) return;
    try {
        if (selected.command) {
            await vscode.commands.executeCommand(selected.command);
        } else if (selected.uri) {
            const currentUri = vscode.workspace.workspaceFolders?.[0]?.uri;
            const canAttach = !selected.isWorkspace && !selected.remoteAuthority && (
                (!vscode.env.remoteName && selected.uri.scheme === "file")
                || (currentUri?.scheme === selected.uri.scheme
                    && currentUri.authority === selected.uri.authority)
            );
            const mode = await vscode.window.showInformationMessage(
                `如何打开 ${path.posix.basename(selected.uri.path)}？`,
                { modal: true },
                "当前窗口", "新窗口", ...(canAttach ? ["添加到当前工作区"] : []),
            );
            if (!mode) return;
            if (mode === "添加到当前工作区") {
                const added = vscode.workspace.updateWorkspaceFolders(
                    vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: selected.uri },
                );
                if (!added) throw new Error("无法添加文件夹到当前工作区");
                return;
            }
            const options = {
                forceNewWindow: mode === "新窗口",
                forceReuseWindow: mode === "当前窗口",
            };
            if (selected.remoteAuthority) {
                await vscode.commands.executeCommand("_files.windowOpen", [
                    selected.isWorkspace ? { workspaceUri: selected.uri } : { folderUri: selected.uri },
                ], { ...options, remoteAuthority: selected.remoteAuthority });
            } else {
                await vscode.commands.executeCommand("vscode.openFolder", selected.uri, options);
            }
        }
    } catch (error) {
        await vscode.window.showErrorMessage(`无法打开项目：${getErrorMessage(error)}`);
    }
}

async function readBranch(root: string): Promise<string | undefined> {
    const run = (args: string[]) => new Promise<string | undefined>((resolve) => {
        execFile("git", ["-C", root, ...args], { timeout: 1500, maxBuffer: 16 * 1024 },
            (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
    });
    const branch = await run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch) return branch;
    const commit = await run(["rev-parse", "--short", "HEAD"]);
    return commit ? `Detached HEAD · ${commit}` : undefined;
}
