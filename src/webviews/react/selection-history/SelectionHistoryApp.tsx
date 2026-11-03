import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { HistoryRange, SelectionHistoryEntry } from "../../../git/selectionHistory";

type State = {
    filePath: string; head: string; range: HistoryRange; mapped: boolean;
    entries: Pick<SelectionHistoryEntry, "hash" | "author" | "date" | "subject">[];
    selected?: string; hasMore: boolean; loading: boolean; error?: string;
};

function SelectionHistoryApp(): React.ReactElement {
    const vscode = getVsCodeApi<{ type: "ready" | "more" | "select"; hash?: string }, Record<string, unknown>>();
    const [state, setState] = useState<State>();
    useEffect(() => {
        const receive = (event: MessageEvent<State & { type: string }>) => {
            if (event.data.type === "update") setState(event.data);
        };
        window.addEventListener("message", receive);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", receive);
    }, [vscode]);
    return <main style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <style>{`
            button { font: inherit; color: inherit; cursor: pointer; border: 0; }
            .history-entry { display: block; width: 100%; padding: 10px 12px; text-align: left; background: transparent; border-bottom: 1px solid var(--vscode-panel-border); }
            .history-entry:hover { background: var(--vscode-list-hoverBackground); }
            .history-entry[aria-pressed=true] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
            button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
            .meta { opacity: .75; font-size: 11px; margin-top: 5px; }
        `}</style>
        <header style={{ padding: 12, borderBottom: "1px solid var(--vscode-panel-border)" }}>
            <strong style={{ overflowWrap: "anywhere" }}>{state?.filePath ?? "代码历史"}</strong>
            {state && <p className="meta">HEAD {state.head.slice(0, 8)} · 第 {state.range.start}–{state.range.end} 行</p>}
            <p className="meta">仅显示影响选中片段的已提交修改</p>
            {state?.mapped && <p className="meta">已将当前选择映射到 HEAD，未提交修改不计入历史。</p>}
        </header>
        <div style={{ flex: 1, overflow: "auto" }} aria-label="选中代码的提交历史">
            {state?.entries.map((entry) => <button key={entry.hash} className="history-entry"
                aria-pressed={state.selected === entry.hash}
                onClick={() => vscode.postMessage({ type: "select", hash: entry.hash })}>
                <div style={{ overflowWrap: "anywhere" }}>{entry.subject}</div>
                <div className="meta">{entry.hash.slice(0, 8)} · {entry.author}</div>
                <div className="meta">{new Date(entry.date).toLocaleString()}</div>
            </button>)}
            {state?.error && <p role="alert" style={{ padding: 12, color: "var(--vscode-errorForeground)" }}>{state.error}</p>}
            {(!state || state.loading) && <p role="status" style={{ padding: 12 }}>正在读取历史…</p>}
            {state && !state.loading && !state.error && !state.entries.length && <p style={{ padding: 12 }}>这段代码没有可显示的提交历史。</p>}
            {state?.hasMore && <button disabled={state.loading} style={{ padding: 12, width: "100%", background: "var(--vscode-button-secondaryBackground)" }}
                onClick={() => vscode.postMessage({ type: "more" })}>再加载 100 条</button>}
        </div>
    </main>;
}

createRoot(document.getElementById("root")!).render(<SelectionHistoryApp />);
