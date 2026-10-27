import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { CopilotLogReader, type CopilotLogSnapshot } from "./copilotLogReader";
import { cleanupCopilotLogs } from "./copilotLogCleanup";

const LOG_SETTING = "github.copilot.chat.agentDebugLog.fileLogging";

export class CopilotStatusBarController implements vscode.Disposable {
    private readonly item = vscode.window.createStatusBarItem(
        "intelligit.copilotPerformance",
        vscode.StatusBarAlignment.Right,
        10,
    );
    private readonly reader = new CopilotLogReader();
    private readonly roots: string[];
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly watchers: vscode.Disposable[] = [];
    private timer: ReturnType<typeof setTimeout> | undefined;
    private cleanupTimer: ReturnType<typeof setInterval> | undefined;
    private snapshot: CopilotLogSnapshot | undefined;
    private refreshing = false;
    private pendingRefresh = false;
    private enabled = false;
    private disposed = false;
    private cleaning = false;

    constructor(context: vscode.ExtensionContext) {
        // Derive paths from VS Code's storage locations, including profiles,
        // portable installations and the current remote extension host.
        this.roots = [...new Set(
            [context.globalStorageUri, context.storageUri].flatMap((uri) => uri
                ? ["github.copilot-chat", "GitHub.copilot-chat"].map((id) =>
                    path.join(path.dirname(uri.fsPath), id, "debug-logs"))
                : []),
        )];
        this.item.name = "IntelliGit Copilot Performance";
        this.item.command = "intelligit.copilotLogActions";
        this.subscriptions.push(
            vscode.commands.registerCommand("intelligit.copilotLogActions", () => this.showActions()),
            vscode.commands.registerCommand("intelligit.clearCopilotLogs", () => this.cleanup(true)),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("intelligit.copilotPerformance.enabled")) {
                    this.configure();
                } else if (event.affectsConfiguration(LOG_SETTING)) {
                    this.render();
                }
            }),
        );
        this.configure();
    }

    dispose(): void {
        this.disposed = true;
        this.stopWatching();
        this.subscriptions.forEach((subscription) => subscription.dispose());
        this.item.dispose();
    }

    private configure(): void {
        this.stopWatching();
        this.enabled = vscode.workspace.getConfiguration("intelligit")
            .get<boolean>("copilotPerformance.enabled", false);
        if (!this.enabled) {
            this.item.hide();
            return;
        }
        for (const root of this.roots) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(root), "*/main.jsonl"),
            );
            const schedule = () => this.scheduleRefresh();
            this.watchers.push(watcher, watcher.onDidCreate(schedule),
                watcher.onDidChange(schedule), watcher.onDidDelete(schedule));
        }
        this.render();
        void this.refresh();
        void this.cleanup(false);
        this.cleanupTimer = setInterval(() => { void this.cleanup(false); }, 60 * 60 * 1000);
    }

    private stopWatching(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.timer = undefined;
        this.cleanupTimer = undefined;
        this.watchers.splice(0).forEach((watcher) => watcher.dispose());
    }

    private scheduleRefresh(): void {
        if (this.disposed || !this.enabled) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
        }, 200);
    }

    private async refresh(): Promise<void> {
        if (this.refreshing) {
            this.pendingRefresh = true;
            return;
        }
        this.refreshing = true;
        try {
            do {
                this.pendingRefresh = false;
                const files = (await Promise.all(this.roots.map(async (root) => {
                    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
                    return entries.filter((entry) => entry.isDirectory())
                        .map((entry) => path.join(root, entry.name, "main.jsonl"));
                }))).flat();
                const snapshot = await this.reader.readLatest(files);
                if (this.disposed || !this.enabled) return;
                if (snapshot) this.snapshot = snapshot;
                this.render();
            } while (this.pendingRefresh);
        } finally {
            this.refreshing = false;
        }
    }

    private render(): void {
        if (this.disposed || !this.enabled) return;
        const loggingEnabled = vscode.workspace.getConfiguration().get<boolean>(`${LOG_SETTING}.enabled`, false);
        if (!this.snapshot) {
            const missingMetrics = this.reader.hasCompletedTurnsWithoutMetrics;
            this.item.text = missingMetrics ? "$(warning) Copilot: 日志缺少请求指标"
                : loggingEnabled ? "$(pulse) Copilot: 等待请求" : "$(pulse) Copilot: 未开启日志";
            this.item.tooltip = [
                "Copilot 请求速度与首响应延迟",
                ...(missingMetrics ? [
                    "日志已记录轮次结束，但没有 llm_request 请求指标。",
                    "当前模型请求链路未输出这些指标，无法计算真实 tok/s 和 TTFT。",
                    "重新开启日志无法补齐历史数据；需要模型提供方记录请求计时和 Token 用量。",
                ] : [
                    "尚未找到已完成的 LLM 请求。",
                    loggingEnabled ? "若刚开启文件日志，请重载当前窗口后发送新请求。"
                        : "点击启用有大小限制的文件日志；首次启用后需要重载窗口。",
                ]),
                "自动清理：保留 7 天，总量目标 100 MB；保护最近会话及 24 小时内更新的日志。",
            ].join("\n");
        } else {
            const { request, turn } = this.snapshot;
            const generationMs = request.durationMs - (request.ttftMs ?? request.durationMs);
            const speed = request.outputTokens !== undefined && request.ttftMs !== undefined && generationMs > 0
                ? `${(request.outputTokens * 1000 / generationMs).toFixed(1)} tok/s` : "— tok/s";
            const ttft = request.ttftMs === undefined ? "—" : `${(request.ttftMs / 1000).toFixed(1)}s`;
            const model = request.model.replace(/[\r\n\t]/g, " ").replace(/\$\(/g, "(") || "未知模型";
            this.item.text = `$(zap) ${speed} · TTFT ${ttft} · ${model}`;
            this.item.tooltip = [
                "最近一次本地 Copilot LLM 请求",
                `模型：${model}`,
                `输出速度：${speed}`,
                `首响应块延迟：${ttft}`,
                `输出 Token：${request.outputTokens?.toLocaleString() ?? "不可用"}`,
                `请求总耗时：${(request.durationMs / 1000).toFixed(1)}s`,
                `完成时间：${new Date(request.startedAt + request.durationMs).toLocaleString()}`,
                ...(turn ? ["", `本轮已完成：${turn.requestCount} 次 LLM 请求`,
                    `本轮输出 Token：${turn.outputTokens.toLocaleString()}`,
                    `本轮请求累计耗时：${(turn.durationMs / 1000).toFixed(1)}s`] : []),
                "",
                "速度 ≈ 输出 Token ÷（总耗时 − TTFT）。",
                "可能包含隐藏推理；TTFT 是首响应块延迟，不一定是首个可见文字。",
                "自动清理：保留 7 天，总量目标 100 MB；近期日志受保护，可暂时超额。",
                ...(!loggingEnabled ? ["文件日志未开启；当前显示上次记录。"] : []),
                "点击管理日志或清理历史日志。",
            ].join("\n");
        }
        this.item.show();
    }

    private async showActions(): Promise<void> {
        const choice = await vscode.window.showQuickPick([
            { label: "启用 Copilot 文件日志", description: "每个 JSONL 5 MB，每个存储位置保留 10 个会话；需重载窗口", action: "enable" },
            { label: "关闭 Copilot 文件日志", description: "全局关闭文件日志；已打开的窗口需要分别重载后停止写入", action: "disable" },
            { label: "清理历史调试日志", description: "保留最近会话及 24 小时内更新的日志，不删除聊天记录", action: "clear" },
            { label: "打开 Copilot 日志设置", description: "调整原生文件大小与会话保留数量", action: "settings" },
        ], { title: "IntelliGit: Copilot 日志管理" });
        if (choice?.action === "clear") {
            await this.cleanup(true);
        } else if (choice?.action === "settings") {
            await vscode.commands.executeCommand("workbench.action.openSettings", LOG_SETTING);
        } else if (choice?.action === "enable" || choice?.action === "disable") {
            const enable = choice.action === "enable";
            const config = vscode.workspace.getConfiguration();
            // Keep any stricter limits the user already chose.
            if (enable) {
                for (const [key, limit] of [["maxRetainedSessionLogs", 10], ["maxSessionLogSizeMB", 5]] as const) {
                    const fullKey = `${LOG_SETTING}.${key}`;
                    const current = config.get<number>(fullKey);
                    await config.update(fullKey, Math.min(current && current > 0 ? current : limit, limit), vscode.ConfigurationTarget.Global);
                }
            }
            await config.update(`${LOG_SETTING}.enabled`, enable, vscode.ConfigurationTarget.Global);
            const reload = "重载窗口";
            const message = enable
                ? "已启用有限额的 Copilot 调试日志。重载窗口后开始记录请求。"
                : "已全局关闭 Copilot 文件日志。已打开的窗口需要分别重载后停止写入；现有日志可以手动清理。";
            if (await vscode.window.showInformationMessage(message, reload) === reload) {
                await vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
        }
    }

    private async cleanup(manual: boolean): Promise<void> {
        if (this.cleaning || this.disposed) return;
        this.cleaning = true;
        try {
            const result = await cleanupCopilotLogs(this.roots, { clearOld: manual });
            if (manual) {
                await vscode.window.showInformationMessage(
                    `已清理 ${result.deletedSessions} 个历史调试日志目录，释放 ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB。` +
                    `剩余 ${(result.remainingBytes / 1024 / 1024).toFixed(1)} MB；最近会话及 24 小时内更新的日志已保留。`,
                );
            }
        } catch {
            if (manual) await vscode.window.showErrorMessage("无法清理 Copilot 调试日志，请检查日志目录权限。");
        } finally {
            this.cleaning = false;
        }
    }
}
