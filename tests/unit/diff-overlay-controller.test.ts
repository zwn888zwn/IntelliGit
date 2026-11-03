import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { DiffOverlayController } from "../../src/services/DiffOverlayController";

const state = vi.hoisted(() => ({
    groups: [] as vscode.TabGroup[],
    active: undefined as vscode.TabGroup | undefined,
    events: new Set<(event: vscode.TabChangeEvent) => void>(),
    handlers: new Map<string, () => Promise<void>>(),
    enabled: true,
    modal: "some",
    commands: ["workbench.action.closeModalEditor"],
    execute: vi.fn(),
    close: vi.fn(),
}));

vi.mock("vscode", () => {
    class Diff {
        constructor(public original: { toString(): string }, public modified: { toString(): string }) {}
    }
    const event = (listener: (event: vscode.TabChangeEvent) => void) => {
        state.events.add(listener);
        return { dispose: () => state.events.delete(listener) };
    };
    return {
        TabInputTextDiff: Diff,
        TabInputNotebookDiff: class extends Diff {},
        window: {
            tabGroups: {
                get all() { return state.groups; },
                get activeTabGroup() { return state.active; },
                onDidChangeTabs: event,
                onDidChangeTabGroups: event,
                close: state.close,
            },
        },
        workspace: {
            onDidChangeConfiguration: () => ({ dispose() {} }),
            getConfiguration: (section: string) => ({
                get: () => section === "intelligit" ? state.enabled : state.modal,
            }),
        },
        commands: {
            registerCommand: (id: string, handler: () => Promise<void>) => {
                state.handlers.set(id, handler);
                return { dispose: () => state.handlers.delete(id) };
            },
            getCommands: async () => state.commands,
            executeCommand: state.execute,
        },
    };
});

let controller: DiffOverlayController;
const uri = (value: string) => ({ toString: () => value }) as vscode.Uri;
const diff = (name = "file") => new vscode.TabInputTextDiff(uri(`git:${name}`), uri(`file:${name}`));

function group(input: unknown = {}, label = "source"): vscode.TabGroup {
    const result = { viewColumn: state.groups.length + 1, tabs: [] } as unknown as vscode.TabGroup;
    const tab = { input, group: result, label } as vscode.Tab;
    Object.assign(result, { tabs: [tab], activeTab: tab });
    state.groups.push(result);
    state.active = result;
    return result;
}

function emit(opened: vscode.Tab[] = []): void {
    for (const callback of state.events) callback({ opened, closed: [], changed: [] });
}
async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(10); }

beforeEach(() => {
    vi.useFakeTimers();
    state.groups = [];
    state.events.clear();
    state.handlers.clear();
    state.enabled = true;
    state.modal = "some";
    state.commands = ["workbench.action.closeModalEditor"];
    state.execute.mockReset();
    state.close.mockReset().mockImplementation(async (tab: vscode.Tab) => {
        Object.assign(tab.group, { tabs: tab.group.tabs.filter((value) => value !== tab) });
        emit();
        return true;
    });
    state.execute.mockImplementation(async (_command, original, modified, label) => {
        group(new vscode.TabInputTextDiff(original, modified), label);
        emit();
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    controller?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("DiffOverlayController", () => {
    it("routes a native diff with its original URIs and removes only the old tab", async () => {
        const input = diff();
        const source = group(input).activeTab!;
        controller = new DiffOverlayController();
        await flush();
        expect(state.execute).toHaveBeenCalledWith("_workbench.diff", input.original, input.modified, "source", [
            -4, { pinned: true, modal: { size: { width: 1400, height: 900 } } },
        ]);
        expect(state.close).toHaveBeenCalledWith(source, true);
        emit();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(1);
    });

    it("leaves ordinary editors alone, and routes a later diff without an extra command", async () => {
        group();
        controller = new DiffOverlayController();
        await flush();
        expect(state.execute).not.toHaveBeenCalled();
        group(diff());
        emit();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(1);
    });

    it.each(["disabled", "modal off", "unsupported"])("keeps native tabs when %s", async (mode) => {
        group(diff());
        if (mode === "disabled") state.enabled = false;
        if (mode === "modal off") state.modal = "off";
        if (mode === "unsupported") state.commands = [];
        controller = new DiffOverlayController();
        await flush();
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.close).not.toHaveBeenCalled();
    });

    it("keeps the source when opening fails or the host leaves it in the same group", async () => {
        const source = group(diff()).activeTab;
        state.execute.mockRejectedValueOnce(new Error("unsupported"));
        controller = new DiffOverlayController();
        await flush();
        expect(state.close).not.toHaveBeenCalled();
        expect(state.active?.activeTab).toBe(source);
        group(diff("another"));
        state.execute.mockResolvedValue(undefined);
        emit();
        await flush();
        expect(state.close).not.toHaveBeenCalled();
    });

    it("never closes a preview tab that changed to a different file while awaiting the host", async () => {
        const source = group(diff()).activeTab!;
        state.execute.mockImplementation(async (_command, original, modified, label) => {
            Object.assign(source, { input: diff("new-file") });
            group(new vscode.TabInputTextDiff(original, modified), label);
        });
        controller = new DiffOverlayController();
        await flush();
        expect(state.close).not.toHaveBeenCalled();
    });

    it("opens a fresh overlay after the previous one closes", async () => {
        group(diff());
        controller = new DiffOverlayController();
        await flush();
        state.groups = state.groups.filter((item) => item !== state.active);
        group(diff("next"));
        emit();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(2);
    });

    it("does not pop an explicitly docked diff back into the overlay", async () => {
        const input = diff();
        group(input);
        controller = new DiffOverlayController();
        await flush();
        const overlay = state.active;
        const docked = group(input).activeTab!;
        emit([docked]);
        state.groups = state.groups.filter((item) => item !== overlay);
        emit();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(1);
        expect(state.active?.activeTab).toBe(docked);
    });

    it("routes notebook diffs through the same native diff resolver", async () => {
        group(new vscode.TabInputNotebookDiff(uri("git:notebook"), uri("file:notebook"), "jupyter"));
        controller = new DiffOverlayController();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(1);
    });

    it("does not intercept new files already being reviewed inside the overlay", async () => {
        group(diff());
        controller = new DiffOverlayController();
        await flush();
        const next = { input: diff("next"), group: state.active } as vscode.Tab;
        Object.assign(state.active!, { tabs: [next], activeTab: next });
        emit();
        await flush();
        expect(state.execute).toHaveBeenCalledTimes(1);
    });

    it("stops listening when disposed", async () => {
        group(diff());
        controller = new DiffOverlayController();
        controller.dispose();
        await flush();
        expect(state.execute).not.toHaveBeenCalled();
        expect(state.events.size).toBe(0);
    });
});
