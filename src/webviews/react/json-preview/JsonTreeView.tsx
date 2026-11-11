import React, { useEffect, useRef, useState } from "react";
import { getVsCodeApi } from "../shared/vscodeApi";
import type { JsonTreeCursor, JsonTreeMessage, JsonTreeNode } from "../../../services/jsonPreview/types";

const ROW = 26;
const MAX_NODES = 3000;
const BATCH_RESERVE = 100;
const container = (node: JsonTreeNode) => node.kind === "object" || node.kind === "array";
type Children = { nodes: JsonTreeNode[]; request: number; complete: boolean; next?: JsonTreeCursor;
    history: (JsonTreeCursor | undefined)[]; page: number; error?: string };
type Row = { key: string; depth: number; node: JsonTreeNode; type: "node" | "pager" | "close" };

export function JsonTreeView({ onCodeView }: { onCodeView: () => void }): React.ReactElement {
    const api = getVsCodeApi<Record<string, unknown>, Record<string, unknown>>();
    const generation = useRef(0);
    const children = useRef(new Map<number, Children>());
    const expanded = useRef(new Set<number>());
    const nodes = useRef(new Map<number, JsonTreeNode>());
    const sequence = useRef(0);
    const viewport = useRef<HTMLDivElement>(null);
    const selectedRef = useRef<number>();
    const [root, setRoot] = useState<JsonTreeNode>();
    const [info, setInfo] = useState({ name: "", size: 0 });
    const [selected, setSelected] = useState<JsonTreeNode>();
    const [value, setValue] = useState({ text: "", truncated: false });
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [revision, redraw] = useState(0);
    const [scrollTop, setScrollTop] = useState(0);
    const [height, setHeight] = useState(600);
    const [help, setHelp] = useState(false);
    const update = () => redraw(current => current + 1);

    function cancel(parent: number): void {
        const state = children.current.get(parent);
        if (state && !state.complete) {
            api.postMessage({ type: "cancelChildren", generation: generation.current, parent });
            state.request = ++sequence.current;
        }
    }
    function forget(parent: number): void {
        const state = children.current.get(parent);
        cancel(parent);
        for (const child of state?.nodes ?? []) {
            forget(child.offset);
            expanded.current.delete(child.offset);
            nodes.current.delete(child.offset);
            if (selectedRef.current === child.offset) {
                selectedRef.current = undefined; setSelected(undefined);
            }
        }
        children.current.delete(parent);
    }
    function load(node: JsonTreeNode, page = 0): void {
        const previous = children.current.get(node.offset);
        const history = previous ? [...previous.history] : [undefined];
        if (previous && page === previous.page + 1 && previous.next) history[page] = previous.next;
        if (page < 0 || page >= history.length) return;
        forget(node.offset);
        const request = ++sequence.current;
        children.current.set(node.offset, { nodes: [], request, complete: false, history, page });
        api.postMessage({ type: "children", generation: generation.current, parent: node.offset, request, cursor: history[page] });
        update();
    }
    function toggle(node: JsonTreeNode): void {
        if (!container(node)) { select(node); return; }
        if (expanded.current.has(node.offset)) {
            expanded.current.delete(node.offset);
            // Releasing this subtree also cancels any scans started underneath it.
            forget(node.offset);
            update();
            return;
        }
        if (nodes.current.size + BATCH_RESERVE > MAX_NODES) {
            setError("展开的内容较多，请先收起部分节点，再展开这里。");
            return;
        }
        expanded.current.add(node.offset);
        load(node);
    }
    function select(node: JsonTreeNode): void {
        selectedRef.current = node.offset;
        setSelected(node);
        setValue({ text: node.preview, truncated: node.truncated });
        if (!container(node)) api.postMessage({ type: "value", generation: generation.current, offset: node.offset });
    }

    useEffect(() => {
        const receive = (event: MessageEvent<JsonTreeMessage>) => {
            const message = event.data;
            if (message.type === "reset") {
                if (message.generation < generation.current) return;
                generation.current = message.generation;
                children.current.clear(); expanded.current.clear(); nodes.current.clear();
                selectedRef.current = undefined;
                setRoot(undefined); setSelected(undefined); setError(""); setLoading(true);
                setInfo({ name: message.name, size: message.size });
                if (viewport.current) viewport.current.scrollTop = 0;
                setScrollTop(0);
                update();
                return;
            }
            if (message.generation !== generation.current) return;
            if (message.type === "root") {
                setRoot(message.node); nodes.current.set(message.node.offset, message.node); setLoading(false);
                if (container(message.node)) { expanded.current.add(message.node.offset); load(message.node); }
            } else if (message.type === "children") {
                const state = children.current.get(message.parent);
                if (!state || state.request !== message.request) return;
                for (const node of message.nodes) {
                    if (nodes.current.size >= MAX_NODES) {
                        cancel(message.parent); state.complete = true; state.error = "请收起部分节点后再展开此处"; break;
                    }
                    state.nodes.push(node); nodes.current.set(node.offset, node);
                }
                if (message.complete) { state.complete = true; state.next = message.next; state.error = message.error; }
                update();
            } else if (message.type === "value" && message.offset === selectedRef.current) {
                setValue({ text: message.text, truncated: message.truncated });
            } else if (message.type === "error") { setLoading(false); setError(message.message); }
        };
        window.addEventListener("message", receive);
        api.postMessage({ type: "ready", mode: "tree" });
        return () => window.removeEventListener("message", receive);
    }, [api]);

    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const observer = new ResizeObserver(() => setHeight(element.clientHeight));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const rows: Row[] = [];
    const add = (node: JsonTreeNode, depth: number) => {
        rows.push({ key: `n${node.offset}`, node, depth, type: "node" });
        if (!expanded.current.has(node.offset)) return;
        const state = children.current.get(node.offset);
        for (const child of state?.nodes ?? []) add(child, depth + 1);
        if (state && (!state.complete || state.next || state.page > 0 || state.error)) rows.push({ key: `p${node.offset}`, node, depth: depth + 1, type: "pager" });
        rows.push({ key: `c${node.offset}`, node, depth, type: "close" });
    };
    if (root) add(root, 0);
    const start = Math.max(0, Math.floor(scrollTop / ROW) - 12);
    const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 12);
    useEffect(() => {
        const element = viewport.current;
        if (element && element.scrollTop > Math.max(0, rows.length * ROW - element.clientHeight)) {
            element.scrollTop = Math.max(0, rows.length * ROW - element.clientHeight);
            setScrollTop(element.scrollTop);
        }
    }, [revision, rows.length]);

    function changePage(node: JsonTreeNode, page: number): void {
        const anchor = rows.findIndex(row => row.type === "node" && row.node.offset === node.offset);
        load(node, page);
        if (viewport.current) { viewport.current.scrollTop = Math.max(0, anchor * ROW); setScrollTop(viewport.current.scrollTop); }
    }
    function moveSelection(event: React.KeyboardEvent, row: Row): void {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ArrowRight" && container(row.node) && !expanded.current.has(row.node.offset)) { event.preventDefault(); toggle(row.node); }
        if (event.key === "ArrowLeft" && expanded.current.has(row.node.offset)) { event.preventDefault(); toggle(row.node); }
        if (event.key === "Enter") { event.preventDefault(); select(row.node); }
    }

    return <main className="json-tree">
        <style>{`
            .json-tree { height:100%; display:flex; flex-direction:column; color:var(--vscode-editor-foreground); background:var(--vscode-editor-background); }
            .jt-toolbar { min-height:38px; display:flex; gap:10px; align-items:center; padding:5px 12px; border-bottom:1px solid var(--vscode-panel-border); }
            .jt-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
            .jt-icon,.jt-key { color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe); }
            .json-tree button { font:inherit; color:inherit; background:transparent; border:1px solid transparent; border-radius:4px; cursor:pointer; padding:3px 6px; }
            .json-tree button:hover { background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground)); }
            .json-tree button:disabled { opacity:.5; cursor:default; }
            .json-tree button:focus-visible,.jt-row:focus-visible,.jt-value:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
            .jt-mode { color:var(--vscode-textLink-foreground)!important; background:var(--vscode-toolbar-hoverBackground)!important; }
            .jt-hint,.jt-error { padding:8px 12px; font-size:12px; line-height:18px; border-bottom:1px solid var(--vscode-panel-border); }
            .jt-error { color:var(--vscode-errorForeground,#f88); }
            .jt-scroll { flex:1; min-height:0; overflow:auto; position:relative; overflow-anchor:none; }
            .jt-space { position:relative; min-width:100%; }
            .jt-row { position:absolute; left:0; display:flex; align-items:center; width:max-content; min-width:100%; height:26px; font:13px/26px var(--vscode-editor-font-family,monospace); white-space:nowrap; padding-right:18px; }
            .jt-row:hover { background:var(--vscode-list-hoverBackground); }
            .jt-row[aria-selected=true] { background:var(--vscode-editor-inactiveSelectionBackground,#264f7855); box-shadow:inset 2px 0 var(--vscode-focusBorder); }
            .jt-arrow { flex:0 0 22px; width:22px; height:22px; padding:0!important; display:inline-flex; align-items:center; justify-content:center; }
            .jt-label { max-width:480px; overflow:hidden; text-overflow:ellipsis; flex-shrink:0; margin-right:8px; }
            .jt-index { color:var(--vscode-descriptionForeground); }
            .jt-preview { max-width:900px; overflow:hidden; text-overflow:ellipsis; }
            .jt-string { color:#ce9178; } .jt-number { color:#b5cea8; } .jt-literal { color:#569cd6; }
            .vscode-light .jt-string,.vscode-high-contrast-light .jt-string { color:#a31515; } .vscode-light .jt-number,.vscode-high-contrast-light .jt-number { color:#098658; } .vscode-light .jt-literal,.vscode-high-contrast-light .jt-literal { color:#0000ff; }
            .vscode-light .jt-key,.vscode-high-contrast-light .jt-key { color:#0451a5; }
            .jt-progress,.jt-status { color:var(--vscode-descriptionForeground); font-size:11px; }
            .jt-footer { min-height:27px; display:flex; align-items:center; justify-content:space-between; padding:4px 12px; border-top:1px solid var(--vscode-panel-border); }
            .jt-detail { border-top:1px solid var(--vscode-panel-border); padding:7px 12px; }
            .jt-detail-title { display:flex; align-items:center; gap:10px; color:var(--vscode-descriptionForeground); font-size:11px; margin-bottom:5px; }
            .jt-detail-title span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .jt-value { display:block; width:100%; height:95px; resize:none; box-sizing:border-box; border:1px solid var(--vscode-input-border,var(--vscode-panel-border)); border-radius:4px; padding:7px; background:var(--vscode-input-background,var(--vscode-editor-background)); color:var(--vscode-input-foreground,var(--vscode-editor-foreground)); font:12px/18px var(--vscode-editor-font-family,monospace); }
            .jt-empty { padding:20px; color:var(--vscode-descriptionForeground); }
            @media(max-width:550px) { .jt-toolbar { gap:4px; padding-inline:6px; } .jt-label { max-width:200px; } .jt-toolbar button { font-size:11px; } }
        `}</style>
        <header className="jt-toolbar"><span className="jt-icon">{`{ }`}</span>
            <span className="jt-name" title={info.name}>{info.name.split(/[\\/]/).pop() || "JSON 预览"}</span>
            <button className="jt-mode" aria-pressed="true">结构</button><button onClick={onCodeView}>代码</button>
            <button onClick={() => { if (root) { forget(root.offset); expanded.current.clear(); setError(""); update(); if (viewport.current) viewport.current.scrollTop = 0; } }}>全部收起</button>
            <button onClick={() => api.postMessage({ type: "refresh", mode: "tree" })}>刷新</button>
            <button aria-label="结构预览说明" aria-expanded={help} onClick={() => setHelp(value => !value)}>ⓘ</button>
        </header>
        {help && <div className="jt-hint">点击箭头展开或收起，点击节点可选中并复制值。只读取展开节点的直接子项，每批最多 100 项；下一批按需扫描，未读取的内容不统计数量。此视图只读。</div>}
        {error && <div className="jt-error" role="alert">{error}</div>}
        <div className="jt-scroll" ref={viewport} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} role="tree" aria-label="JSON 结构">
            {!root && <div className="jt-empty">{loading ? "正在打开文件…" : "无法预览"}</div>}
            <div className="jt-space" style={{ height: rows.length * ROW }}>
                {rows.slice(start, end).map((row, index) => {
                    const state = children.current.get(row.node.offset);
                    const isOpen = expanded.current.has(row.node.offset);
                    return <div key={row.key} className="jt-row" style={{ top: (start + index) * ROW, paddingLeft: 12 + Math.min(row.depth, 64) * 18 }}
                        role={row.type === "node" ? "treeitem" : undefined} aria-level={row.type === "node" ? row.depth + 1 : undefined}
                        aria-expanded={row.type === "node" && container(row.node) ? isOpen : undefined}
                        aria-selected={row.type === "node" ? selected?.offset === row.node.offset : undefined}
                        tabIndex={row.type === "node" ? 0 : undefined}
                        onKeyDown={event => moveSelection(event, row)}
                        onClick={row.type === "node" ? () => select(row.node) : undefined}>
                        {row.type === "pager" ? <>
                            {state?.error ? <span className="jt-error" role="alert">{state.error}</span> : !state?.complete ? <span className="jt-progress">正在读取后续内容…</span> : <>
                                <button disabled={!state.page} onClick={() => changePage(row.node, state.page - 1)}>上一批</button>
                                <span className="jt-progress">第 {state.page + 1} 批</span>
                                <button disabled={!state.next} onClick={() => changePage(row.node, state.page + 1)}>下一批</button>
                            </>}
                        </> : row.type === "close" ? <><span className="jt-arrow" /><span>{row.node.kind === "object" ? "}" : "]"}</span></> : <>
                            {container(row.node) ? <button className="jt-arrow" aria-label={`${isOpen ? "收起" : "展开"} ${row.node.label}`} onClick={event => { event.stopPropagation(); toggle(row.node); }}>
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ transform: isOpen ? "rotate(90deg)" : undefined }}><path d="M5 3l6 5-6 5z" /></svg>
                            </button> : <span className="jt-arrow" />}
                            <span className={`jt-label ${row.node.ordinal !== undefined || row.node.offset === root?.offset ? "jt-index" : "jt-key"}`} title={row.node.label}>
                                {row.node.ordinal !== undefined || row.node.offset === root?.offset ? row.node.label : JSON.stringify(row.node.label)}{row.node.offset === root?.offset ? "" : " :"}
                            </span>
                            <span className={`jt-preview jt-${row.node.kind}`}>
                                {container(row.node) && isOpen ? row.node.kind === "object" ? "{" : "[" : row.node.preview}{row.node.truncated ? "…" : ""}
                            </span>
                        </>}
                    </div>;
                })}
            </div>
        </div>
        {selected && <section className="jt-detail" aria-label="选中节点">
            <div className="jt-detail-title"><span title={selected.label}>{selected.label} · {container(selected) ? "点击箭头展开" : "值原文，可选择复制"}{value.truncated ? " · 仅显示开头 16 KB" : ""}</span>
                <button aria-label="关闭选中值" onClick={() => { selectedRef.current = undefined; setSelected(undefined); }}>×</button></div>
            <textarea className="jt-value" aria-label="选中节点的值" readOnly value={value.text} spellCheck={false} />
        </section>}
        <footer className="jt-footer"><span className="jt-status">只读 · 按需展开</span><span className="jt-status">{info.size < 1024 * 1024 ? `${(info.size / 1024).toFixed(1)} KB` : `${(info.size / 1024 / 1024).toFixed(1)} MB`}</span></footer>
    </main>;
}
