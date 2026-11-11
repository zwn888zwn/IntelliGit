import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { JsonTreeView } from "./JsonTreeView";
import { createRoot } from "react-dom/client";
import { getVsCodeApi } from "../shared/vscodeApi";
import { type JsonPage, type JsonPreviewMessage } from "../../../services/jsonPreview/types";

const ROW_HEIGHT = 22;
const PAGE_WINDOW = 3;
const OVERSCAN = 15;
const sizeText = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function JsonPreviewApp({ onTreeView }: { onTreeView: () => void }): React.ReactElement {
    const vscode = getVsCodeApi<{ type: string; generation?: number; index?: number; mode?: string }, Record<string, unknown>>();
    const viewport = useRef<HTMLDivElement>(null);
    const pagesRef = useRef<JsonPage[]>([]);
    const generation = useRef(0);
    const pending = useRef(true);
    const blocked = useRef(false);
    const adjustment = useRef(0);
    const previousScroll = useRef(0);
    const [pages, setPages] = useState<JsonPage[]>([]);
    const [info, setInfo] = useState({ name: "", size: 0, bytesRead: 0, formattedLines: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [position, setPosition] = useState(0);
    const [height, setHeight] = useState(600);
    const [indent, setIndent] = useState(2);
    const [showHelp, setShowHelp] = useState(false);

    function request(index: number): void {
        if (pending.current || blocked.current || index < 0) return;
        pending.current = true;
        setLoading(true);
        vscode.postMessage({ type: "page", generation: generation.current, index });
    }

    useEffect(() => {
        const receive = (event: MessageEvent<JsonPreviewMessage>) => {
            const message = event.data;
            if (message.type === "reset") {
                if (message.generation < generation.current) return;
                generation.current = message.generation;
                pagesRef.current = [];
                setPages([]);
                setInfo({ name: message.name, size: message.size, bytesRead: 0, formattedLines: 0 });
                setError("");
                blocked.current = false;
                pending.current = true;
                setLoading(true);
                if (viewport.current) viewport.current.scrollTop = 0;
                previousScroll.current = 0;
                setPosition(0);
                return;
            }
            if (message.generation !== generation.current) return;
            pending.current = false;
            setLoading(false);
            if (message.type === "error") {
                blocked.current = true;
                setError(message.message);
            } else if (message.type === "page") {
                const page = message.page;
                const old = pagesRef.current;
                if (old.some(entry => entry.index === page.index)) return;
                let next = [...old, page].sort((a, b) => a.index - b.index);
                let delta = 0;
                if (old.length && page.index < old[0].index) {
                    delta = page.lines.length * ROW_HEIGHT;
                    next = next.slice(0, PAGE_WINDOW);
                } else if (next.length > PAGE_WINDOW) {
                    delta = -next[0].lines.length * ROW_HEIGHT;
                    next = next.slice(1);
                }
                adjustment.current = delta;
                pagesRef.current = next;
                setPages(next);
                setInfo(current => ({ ...current, bytesRead: message.bytesRead, formattedLines: message.formattedLines }));
                if (page.error) setError(page.error);
            }
        };
        window.addEventListener("message", receive);
        vscode.postMessage({ type: "ready", mode: "code" });
        return () => window.removeEventListener("message", receive);
    }, [vscode]);

    useLayoutEffect(() => {
        if (viewport.current && adjustment.current) {
            viewport.current.scrollTop += adjustment.current;
            previousScroll.current = viewport.current.scrollTop;
            setPosition(viewport.current.scrollTop);
            adjustment.current = 0;
        }
    }, [pages]);

    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const lines = pages.flatMap(page => page.lines);
    const first = pages[0];
    const last = pages[pages.length - 1];
    const start = Math.max(0, Math.floor(position / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(lines.length, Math.ceil((position + height) / ROW_HEIGHT) + OVERSCAN);
    const visible = lines.slice(start, end);
    const canPrevious = !!first && first.index > 0;
    const canNext = !!last && !last.done;

    return <main className="json-preview">
        <style>{`
            .json-preview { height:100%; display:flex; flex-direction:column; color:var(--vscode-editor-foreground); background:var(--vscode-editor-background); }
            .json-toolbar { display:flex; align-items:center; gap:10px; min-height:38px; padding:5px 12px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background,var(--vscode-editor-background)); }
            .json-icon { color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe); font:600 15px var(--vscode-editor-font-family,monospace); }
            .json-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:500; }
            .json-readonly { color:var(--vscode-descriptionForeground); font-size:11px; white-space:nowrap; }
            .json-preview button,.json-preview select { font:inherit; color:var(--vscode-foreground); background:transparent; border:1px solid transparent; border-radius:4px; padding:3px 6px; cursor:pointer; }
            .json-preview select { font-size:11px; background:var(--vscode-editorWidget-background,var(--vscode-editor-background)); }
            .json-preview button:hover { background:var(--vscode-toolbar-hoverBackground); }
            .json-preview button:disabled { opacity:.4; cursor:default; }
            .json-preview button:focus-visible,.json-preview select:focus-visible,.json-viewport:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
            .json-icon-button { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; flex-shrink:0; }
            .json-hint { padding:8px 12px; font-size:11px; line-height:18px; color:var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-panel-border); }
            .json-error { padding:8px 12px; color:var(--vscode-errorForeground); background:var(--vscode-inputValidation-errorBackground); white-space:pre-wrap; }
            .json-viewport { flex:1; min-height:0; overflow:auto; position:relative; overflow-anchor:none; scrollbar-color:auto; }
            .json-viewport::-webkit-scrollbar { width:8px; height:8px; }
            .json-viewport::-webkit-scrollbar-track,.json-viewport::-webkit-scrollbar-corner { background:transparent; }
            .json-viewport::-webkit-scrollbar-thumb { background:var(--vscode-scrollbarSlider-background); border-radius:4px; }
            .json-lines { position:relative; min-width:100%; }
            .json-line { position:absolute; left:0; display:flex; width:max-content; min-width:100%; height:22px; font:13px/22px var(--vscode-editor-font-family,monospace); white-space:pre; }
            .json-line:hover { background:var(--vscode-editor-lineHighlightBackground,var(--vscode-list-hoverBackground)); }
            .json-gutter { position:sticky; left:0; z-index:1; flex:0 0 64px; width:64px; text-align:right; padding-right:16px; user-select:none; background:var(--vscode-editor-background); color:var(--vscode-editorLineNumber-foreground); font-size:12px; }
            .json-line:hover .json-gutter { color:var(--vscode-editorLineNumber-activeForeground,var(--vscode-editor-foreground)); }
            .json-indent { flex-shrink:0; user-select:none; background-image:linear-gradient(to right,var(--vscode-editorIndentGuide-background1,#ffffff12) 1px,transparent 1px); background-repeat:repeat-x; }
            .json-code { display:block; font:inherit; line-height:inherit; color:inherit; background:transparent; border:0; border-radius:0; margin:0; padding:0 24px 0 0; }
            .json-code ::selection { background:var(--vscode-editor-selectionBackground,#264f78); }
            .json-key { color:#9cdcfe; } .json-string { color:#ce9178; } .json-number { color:#b5cea8; } .json-literal { color:#569cd6; }
            .json-punctuation { color:var(--vscode-editor-foreground); opacity:.85; }
            .vscode-light .json-key,.vscode-high-contrast-light .json-key { color:#0451a5; } .vscode-light .json-string,.vscode-high-contrast-light .json-string { color:#a31515; }
            .vscode-light .json-number,.vscode-high-contrast-light .json-number { color:#098658; } .vscode-light .json-literal,.vscode-high-contrast-light .json-literal { color:#0000ff; }
            .vscode-light .json-indent { background-image:linear-gradient(to right,var(--vscode-editorIndentGuide-background1,#00000012) 1px,transparent 1px); }
            .json-footer { display:flex; align-items:center; gap:8px; min-height:28px; border-top:1px solid var(--vscode-panel-border); padding:3px 12px; font-size:11px; color:var(--vscode-descriptionForeground); }
            .json-status { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
            .json-footer button { white-space:nowrap; font-size:11px; }
            .json-empty { padding:24px; color:var(--vscode-descriptionForeground); }
            @media (max-width:480px) { .json-toolbar { gap:5px; padding-inline:8px; } .json-readonly { display:none; } .json-footer { padding-inline:8px; } }
        `}</style>
        <header className="json-toolbar">
            <span className="json-icon" aria-hidden="true">{`{ }`}</span>
            <span className="json-name" title={info.name}>{info.name.split(/[\\/]/).pop() || "JSON 预览"}</span>
            <span className="json-readonly">只读预览</span>
            <button onClick={onTreeView}>结构</button>
            <select aria-label="缩进" value={indent} onChange={event => setIndent(Number(event.target.value))}>
                <option value={2}>2 空格</option><option value={4}>4 空格</option></select>
            <button className="json-icon-button" aria-label="刷新" title="重新读取文件" onClick={() => { pending.current = true; setLoading(true); vscode.postMessage({ type: "refresh" }); }}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M13.2 6A5.4 5.4 0 1 0 13 10M13.2 2.4V6H9.6" /></svg>
            </button>
            <button className="json-icon-button" aria-label="预览说明" title="预览说明" aria-expanded={showHelp} onClick={() => setShowHelp(value => !value)}>
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><circle cx="8" cy="8" r="6" /><path d="M8 7v4M8 4.5v1" /></svg>
            </button>
        </header>
        {showHelp && <div className="json-hint">上下滚动按需加载，不修改原文件。行号为格式化后的显示行号；↪ 表示超长内容的续行。</div>}
        {error && <div className="json-error" role="alert">{error}</div>}
        <div className="json-viewport" ref={viewport} tabIndex={0} aria-label="格式化 JSON 内容" onScroll={event => {
            const element = event.currentTarget;
            const top = element.scrollTop;
            const direction = top - previousScroll.current;
            previousScroll.current = top;
            setPosition(top);
            if (direction > 0 && element.scrollHeight - top - element.clientHeight < 400 && canNext) request(last.index + 1);
            if (direction < 0 && top < 120 && canPrevious) request(first.index - 1);
        }}>
            {!lines.length && <div className="json-empty">{loading ? "正在读取第一批内容…" : error ? "预览已停止" : "没有可显示的内容"}</div>}
            <div className="json-lines" style={{ height: lines.length * ROW_HEIGHT }}>
                {visible.map((line, index) => <div className="json-line" key={line.number} style={{ top: (start + index) * ROW_HEIGHT }}>
                    <span className="json-gutter" title={line.continued ? "超长内容续行" : "格式化后的显示行号"}>{line.number}{line.continued ? " ↪" : "  "}</span>
                    <span className="json-indent" aria-hidden="true" style={{ width: `${Math.min(line.depth, 64) * indent}ch`, backgroundSize: `${indent}ch 100%` }} />
                    <span className="json-code" title={line.depth > 64 ? `嵌套深度 ${line.depth}` : undefined}>
                        {line.parts.map((part, partIndex) => <span key={partIndex} className={`json-${part.kind}`}>{part.text}</span>)}
                    </span>
                </div>)}
            </div>
        </div>
        <footer className="json-footer"><span className="json-status" role="status">{loading ? "加载中… · " : ""}
            {info.formattedLines.toLocaleString()} 行 · {last?.done && !error ? sizeText(info.size) : `${sizeText(info.bytesRead)} / ${sizeText(info.size)} · 按需加载` }</span>
            {(canPrevious || canNext) && <><button disabled={!canPrevious || loading || blocked.current} onClick={() => request(first.index - 1)}>上一批</button>
            <button disabled={!canNext || loading || blocked.current} onClick={() => request(last.index + 1)}>下一批</button></>}
        </footer>
    </main>;
}

function JsonPreviewRoot(): React.ReactElement {
    const [mode, setMode] = useState<"tree" | "code">("tree");
    return mode === "tree" ? <JsonTreeView onCodeView={() => setMode("code")} /> : <JsonPreviewApp onTreeView={() => setMode("tree")} />;
}

createRoot(document.getElementById("root")!).render(<JsonPreviewRoot />);
