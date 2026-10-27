import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { CopilotLogSnapshot } from "../../src/services/copilotLogReader";

const mocks = vi.hoisted(() => {
    const item = { text: "", tooltip: "", name: "", command: "", show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
    return {
        item,
        createStatusBarItem: vi.fn(() => item),
        readLatest: vi.fn(),
        missingMetrics: false,
        readdir: vi.fn(),
        cleanup: vi.fn(),
        update: vi.fn(),
        values: new Map<string, unknown>(),
        commands: new Map<string, (...args: unknown[]) => unknown>(),
        executeCommand: vi.fn(),
        showQuickPick: vi.fn(),
        showInformationMessage: vi.fn(),
        showErrorMessage: vi.fn(),
        configListeners: [] as Array<(event: { affectsConfiguration: (key: string) => boolean }) => void>,
        watchers: [] as Array<{
            change: Array<() => void>;
            create: Array<() => void>;
            delete: Array<() => void>;
            dispose: ReturnType<typeof vi.fn>;
            listenerDisposables: Array<{ dispose: ReturnType<typeof vi.fn> }>;
        }>,
        subscriptions: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
    };
});

vi.mock("fs/promises", () => ({ readdir: mocks.readdir }));
vi.mock("../../src/services/copilotLogReader", () => ({
    CopilotLogReader: class {
        readLatest = mocks.readLatest;
        get hasCompletedTurnsWithoutMetrics() { return mocks.missingMetrics; }
    },
}));
vi.mock("../../src/services/copilotLogCleanup", () => ({ cleanupCopilotLogs: mocks.cleanup }));
vi.mock("vscode", () => ({
    StatusBarAlignment: { Right: 2 },
    ConfigurationTarget: { Global: 1 },
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    RelativePattern: class {
        constructor(public base: unknown, public pattern: string) {}
    },
    window: {
        createStatusBarItem: mocks.createStatusBarItem,
        showQuickPick: mocks.showQuickPick,
        showInformationMessage: mocks.showInformationMessage,
        showErrorMessage: mocks.showErrorMessage,
    },
    commands: {
        registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
            mocks.commands.set(name, handler);
            const subscription = { dispose: vi.fn(() => { mocks.commands.delete(name); }) };
            mocks.subscriptions.push(subscription);
            return subscription;
        },
        executeCommand: mocks.executeCommand,
    },
    workspace: {
        getConfiguration: () => ({
            get: (key: string, fallback?: unknown) => mocks.values.has(key) ? mocks.values.get(key) : fallback,
            update: mocks.update,
        }),
        onDidChangeConfiguration: (listener: (event: { affectsConfiguration: (key: string) => boolean }) => void) => {
            mocks.configListeners.push(listener);
            const subscription = { dispose: vi.fn() };
            mocks.subscriptions.push(subscription);
            return subscription;
        },
        createFileSystemWatcher: () => {
            const watcher = {
                change: [] as Array<() => void>, create: [] as Array<() => void>, delete: [] as Array<() => void>,
                dispose: vi.fn(), listenerDisposables: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
            };
            const listen = (listeners: Array<() => void>, listener: () => void) => {
                listeners.push(listener);
                const subscription = { dispose: vi.fn() };
                watcher.listenerDisposables.push(subscription);
                return subscription;
            };
            mocks.watchers.push(watcher);
            return {
                dispose: watcher.dispose,
                onDidChange: (listener: () => void) => listen(watcher.change, listener),
                onDidCreate: (listener: () => void) => listen(watcher.create, listener),
                onDidDelete: (listener: () => void) => listen(watcher.delete, listener),
            };
        },
    },
}));

import { CopilotStatusBarController } from "../../src/services/CopilotStatusBarController";

const LOG_SETTING = "github.copilot.chat.agentDebugLog.fileLogging";
const controllers: CopilotStatusBarController[] = [];

function snapshot(overrides: Partial<CopilotLogSnapshot["request"]> = {}): CopilotLogSnapshot {
    return {
        request: { startedAt: 1000, durationMs: 29900, ttftMs: 2300, outputTokens: 1240, model: "gpt-test", ...overrides },
        turn: { requestCount: 3, outputTokens: 2000, durationMs: 40000 },
    };
}

async function createController(): Promise<CopilotStatusBarController> {
    const controller = new CopilotStatusBarController({
        globalStorageUri: { fsPath: "/fake/User/globalStorage/intelligit" },
        storageUri: { fsPath: "/fake/User/workspaceStorage/workspace/intelligit" },
    } as vscode.ExtensionContext);
    controllers.push(controller);
    await vi.advanceTimersByTimeAsync(0);
    return controller;
}

function changeSetting(key: string): void {
    mocks.configListeners.forEach((listener) => listener({ affectsConfiguration: (candidate) => candidate === key }));
}

async function runCommand(name: string): Promise<void> {
    await mocks.commands.get(name)?.();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.values.clear();
    mocks.values.set("copilotPerformance.enabled", true);
    mocks.missingMetrics = false;
    mocks.commands.clear();
    mocks.watchers.length = 0;
    mocks.configListeners.length = 0;
    mocks.subscriptions.length = 0;
    Object.assign(mocks.item, { text: "", tooltip: "", name: "", command: "" });
    mocks.readLatest.mockResolvedValue(snapshot());
    mocks.readdir.mockResolvedValue([{ name: "session", isDirectory: () => true }]);
    mocks.cleanup.mockResolvedValue({ deletedSessions: 2, freedBytes: 3 * 1024 * 1024, remainingBytes: 4 * 1024 * 1024 });
    mocks.showQuickPick.mockResolvedValue(undefined);
    mocks.showInformationMessage.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);
});

afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
    vi.useRealTimers();
});

describe("CopilotStatusBarController", () => {
    it("hides the item by default without background work and keeps log management available", async () => {
        mocks.values.delete("copilotPerformance.enabled");
        await createController();
        expect(mocks.item.hide).toHaveBeenCalled();
        expect(mocks.item.show).not.toHaveBeenCalled();
        expect(mocks.watchers).toHaveLength(0);
        expect(mocks.readLatest).not.toHaveBeenCalled();
        expect(mocks.cleanup).not.toHaveBeenCalled();
        expect(mocks.update).not.toHaveBeenCalled();
        expect(mocks.commands.has("intelligit.copilotLogActions")).toBe(true);
        mocks.showQuickPick.mockResolvedValue({ action: "disable" });
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.update.mock.calls).toEqual([[`${LOG_SETTING}.enabled`, false, 1]]);
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(
            expect.stringContaining("分别重载后停止写入"), "重载窗口",
        );
        expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
        expect(mocks.cleanup).not.toHaveBeenCalled();
        mocks.showInformationMessage.mockResolvedValue("重载窗口");
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("explains missing provider metrics after completed turns instead of waiting indefinitely", async () => {
        mocks.readLatest.mockResolvedValue(undefined);
        mocks.missingMetrics = true;
        mocks.values.set(`${LOG_SETTING}.enabled`, true);
        await createController();
        expect(mocks.item.text).toBe("$(warning) Copilot: 日志缺少请求指标");
        expect(mocks.item.tooltip).toContain("日志已记录轮次结束，但没有 llm_request 请求指标");
        expect(mocks.item.tooltip).toContain("无法计算真实 tok/s 和 TTFT");
        expect(mocks.item.text).not.toContain("等待请求");
    });

    it("shows the last completed request on the right with generation speed and turn details", async () => {
        await createController();
        expect(mocks.createStatusBarItem).toHaveBeenCalledWith("intelligit.copilotPerformance", 2, expect.any(Number));
        expect(mocks.item.text).toBe("$(zap) 44.9 tok/s · TTFT 2.3s · gpt-test");
        expect(mocks.item.tooltip).toContain(`输出 Token：${(1240).toLocaleString()}`);
        expect(mocks.item.tooltip).toContain("请求总耗时：29.9s");
        expect(mocks.item.tooltip).toContain("本轮已完成：3 次 LLM 请求");
        expect(mocks.item.tooltip).toContain(`本轮输出 Token：${(2000).toLocaleString()}`);
        expect(mocks.item.tooltip).toContain("隐藏推理");
        expect(mocks.item.show).toHaveBeenCalled();
        expect(mocks.readLatest).toHaveBeenCalledWith(expect.arrayContaining([
            "/fake/User/globalStorage/github.copilot-chat/debug-logs/session/main.jsonl",
            "/fake/User/workspaceStorage/workspace/GitHub.copilot-chat/debug-logs/session/main.jsonl",
        ]));
    });

    it.each([
        { ttftMs: undefined },
        { outputTokens: undefined },
        { durationMs: 2300 },
        { durationMs: 1000 },
    ])("shows unavailable speed when the measurement cannot support it: %o", async (values) => {
        mocks.readLatest.mockResolvedValue(snapshot(values));
        await createController();
        expect(mocks.item.text).toContain("— tok/s");
        expect(mocks.item.text).not.toMatch(/NaN|Infinity/);
        if ("ttftMs" in values) expect(mocks.item.text).toContain("TTFT —");
        if ("outputTokens" in values) expect(mocks.item.tooltip).toContain("输出 Token：不可用");
    });

    it("debounces file events and keeps the previous result while a new request is incomplete", async () => {
        await createController();
        const previous = mocks.item.text;
        mocks.readLatest.mockResolvedValue(undefined);
        mocks.watchers[0].change[0]();
        await vi.advanceTimersByTimeAsync(100);
        mocks.watchers[0].create[0]();
        mocks.watchers[0].delete[0]();
        await vi.advanceTimersByTimeAsync(199);
        expect(mocks.readLatest).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(mocks.readLatest).toHaveBeenCalledTimes(2);
        expect(mocks.item.text).toBe(previous);
        mocks.readLatest.mockResolvedValue(snapshot({ model: "next-model" }));
        mocks.watchers[0].change[0]();
        await vi.advanceTimersByTimeAsync(200);
        expect(mocks.item.text).toContain("next-model");
    });

    it("stops watchers and scheduled work when disabled and starts them again when enabled", async () => {
        await createController();
        const oldWatchers = [...mocks.watchers];
        oldWatchers[0].change[0]();
        mocks.values.set("copilotPerformance.enabled", false);
        changeSetting("intelligit.copilotPerformance.enabled");
        expect(mocks.item.hide).toHaveBeenCalled();
        for (const watcher of oldWatchers) {
            expect(watcher.dispose).toHaveBeenCalledOnce();
            watcher.listenerDisposables.forEach((subscription) => expect(subscription.dispose).toHaveBeenCalledOnce());
        }
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mocks.readLatest).toHaveBeenCalledTimes(1);
        expect(mocks.cleanup).toHaveBeenCalledTimes(1);
        mocks.values.set("copilotPerformance.enabled", true);
        changeSetting("intelligit.copilotPerformance.enabled");
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.watchers.length).toBe(oldWatchers.length * 2);
        expect(mocks.readLatest).toHaveBeenCalledTimes(2);
    });

    it("disposes the item, commands, listeners and pending timers", async () => {
        const controller = await createController();
        mocks.watchers[0].change[0]();
        controller.dispose();
        controllers.splice(controllers.indexOf(controller), 1);
        expect(mocks.item.dispose).toHaveBeenCalledOnce();
        mocks.watchers.forEach((watcher) => expect(watcher.dispose).toHaveBeenCalledOnce());
        mocks.subscriptions.forEach((subscription) => expect(subscription.dispose).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mocks.readLatest).toHaveBeenCalledTimes(1);
        expect(mocks.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.commands.size).toBe(0);
    });

    it("offers a logging action before any request exists and updates when logging is enabled", async () => {
        mocks.readLatest.mockResolvedValue(undefined);
        await createController();
        expect(mocks.item.text).toContain("未开启日志");
        expect(mocks.item.command).toBe("intelligit.copilotLogActions");
        expect(mocks.update).not.toHaveBeenCalled();
        mocks.values.set(`${LOG_SETTING}.enabled`, true);
        changeSetting(LOG_SETTING);
        expect(mocks.item.text).toContain("等待请求");
        mocks.showQuickPick.mockResolvedValue({ action: "settings" });
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.openSettings", LOG_SETTING);
    });

    it("enables bounded file logging only after selection, and reloads only after explicit selection", async () => {
        await createController();
        expect(mocks.update).not.toHaveBeenCalled();
        mocks.showQuickPick.mockResolvedValue({ action: "enable" });
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.update.mock.calls).toEqual([
            [`${LOG_SETTING}.maxRetainedSessionLogs`, 10, 1],
            [`${LOG_SETTING}.maxSessionLogSizeMB`, 5, 1],
            [`${LOG_SETTING}.enabled`, true, 1],
        ]);
        expect(mocks.executeCommand).not.toHaveBeenCalledWith("workbench.action.reloadWindow");
        mocks.showInformationMessage.mockResolvedValue("重载窗口");
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.executeCommand).toHaveBeenCalledWith("workbench.action.reloadWindow");
    });

    it("preserves stricter size and retention settings when enabling file logging", async () => {
        mocks.values.set(`${LOG_SETTING}.maxRetainedSessionLogs`, 3);
        mocks.values.set(`${LOG_SETTING}.maxSessionLogSizeMB`, 2);
        await createController();
        mocks.showQuickPick.mockResolvedValue({ action: "enable" });
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.update).toHaveBeenCalledWith(`${LOG_SETTING}.maxRetainedSessionLogs`, 3, 1);
        expect(mocks.update).toHaveBeenCalledWith(`${LOG_SETTING}.maxSessionLogSizeMB`, 2, 1);
    });

    it("runs safe cleanup automatically and allows manual cleanup through either command or menu", async () => {
        await createController();
        expect(mocks.cleanup).toHaveBeenCalledWith(expect.any(Array), { clearOld: false });
        await runCommand("intelligit.clearCopilotLogs");
        expect(mocks.cleanup).toHaveBeenLastCalledWith(expect.any(Array), { clearOld: true });
        expect(mocks.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("已清理 2 个历史调试日志目录"));
        mocks.showQuickPick.mockResolvedValue({ action: "clear" });
        await runCommand("intelligit.copilotLogActions");
        expect(mocks.cleanup).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(mocks.cleanup).toHaveBeenLastCalledWith(expect.any(Array), { clearOld: false });
    });

    it("reports a manual cleanup failure without changing the last measurement", async () => {
        await createController();
        const previous = mocks.item.text;
        mocks.cleanup.mockRejectedValue(new Error("permission denied"));
        await runCommand("intelligit.clearCopilotLogs");
        expect(mocks.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("无法清理"));
        expect(mocks.item.text).toBe(previous);
    });
});
