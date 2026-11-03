// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { flush, initReactDomTestEnvironment } from "./utils/reactDomTestUtils";
initReactDomTestEnvironment();

it("shows only returned fragment commits, changes selection and requests older history", async () => {
    const postMessage = vi.fn();
    Object.defineProperty(globalThis, "acquireVsCodeApi", { configurable: true,
        value: () => ({ postMessage, getState: () => ({}), setState: vi.fn() }) });
    document.body.innerHTML = '<div id="root"></div>';
    await act(async () => { await import("../../src/webviews/react/selection-history/SelectionHistoryApp"); });
    expect(postMessage).toHaveBeenCalledWith({ type: "ready" });
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: {
        type: "update", filePath: "code.go", head: "a".repeat(40), range: { start: 3, end: 5 }, mapped: true,
        entries: [
            { hash: "b".repeat(40), author: "Developer", date: "2026-01-01T00:00:00Z", subject: "Fix selected function" },
            { hash: "c".repeat(40), author: "Developer", date: "2025-01-01T00:00:00Z", subject: "Add selected function" },
        ], selected: "b".repeat(40), hasMore: true, loading: false,
    } })); });
    await flush();
    expect(document.body.textContent).toContain("未提交修改不计入历史");
    const entries = document.querySelectorAll('button.history-entry');
    expect(entries.length).toBe(2);
    expect(entries[0].getAttribute("aria-pressed")).toBe("true");
    act(() => { entries[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(postMessage).toHaveBeenCalledWith({ type: "select", hash: "c".repeat(40) });
    const more = [...document.querySelectorAll("button")].find(button => button.textContent === "再加载 100 条")!;
    act(() => { more.click(); });
    expect(postMessage).toHaveBeenCalledWith({ type: "more" });
});
