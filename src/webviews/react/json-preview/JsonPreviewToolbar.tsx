import React from "react";
import { LuBraces, LuCode, LuFoldVertical, LuInfo, LuListTree, LuRefreshCw } from "react-icons/lu";

type Props = {
    name: string;
    mode: "tree" | "code";
    onModeChange: () => void;
    onRefresh: () => void;
    help: boolean;
    onToggleHelp: () => void;
} & ({ mode: "tree"; onCollapse: () => void } | { mode: "code"; indent: number; onIndentChange: (indent: number) => void });

export function JsonPreviewToolbar(props: Props): React.ReactElement {
    return <header className="json-preview-toolbar">
        <style>{`
            .json-preview-toolbar { display:flex; align-items:center; gap:10px; height:40px; min-height:40px; box-sizing:border-box; padding:5px 12px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editor-background); flex-shrink:0; }
            .json-preview-toolbar .preview-file-icon { color:var(--vscode-symbolIcon-propertyForeground,#9cdcfe); flex-shrink:0; }
            .preview-file-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:500; }
            .preview-readonly { color:var(--vscode-descriptionForeground); font-size:11px; white-space:nowrap; }
            .json-preview-toolbar .preview-modes { display:flex; flex-shrink:0; gap:2px; padding:2px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:6px; background:var(--vscode-input-background); }
            .json-preview-toolbar button { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:26px; box-sizing:border-box; font:12px var(--vscode-font-family, sans-serif); font-weight:400; color:var(--vscode-descriptionForeground); background:transparent; border:1px solid transparent; border-radius:4px; padding:3px 6px; cursor:pointer; }
            .json-preview-toolbar .preview-modes button { width:58px; }
            .json-preview-toolbar .preview-modes button[aria-pressed=true] { background:var(--vscode-list-activeSelectionBackground,#094771); color:var(--vscode-list-activeSelectionForeground,#fff); }
            .json-preview-toolbar button:hover { background:var(--vscode-toolbar-hoverBackground); }
            .json-preview-toolbar button:focus-visible,.json-preview-toolbar select:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:-1px; }
            .preview-mode-action { width:88px; flex:0 0 88px; display:flex; align-items:center; justify-content:center; }
            .json-preview-toolbar .preview-mode-action button,.json-preview-toolbar .preview-mode-action select { width:88px; height:26px; box-sizing:border-box; font:12px var(--vscode-font-family,sans-serif); color:var(--vscode-foreground); }
            .json-preview-toolbar .preview-mode-action select { border:1px solid var(--vscode-dropdown-border,transparent); border-radius:4px; background:var(--vscode-dropdown-background,var(--vscode-editor-background)); padding:2px 6px; }
            .json-preview-toolbar .preview-icon-action { width:26px; flex:0 0 26px; padding:4px; }
            @media(max-width:550px) { .json-preview-toolbar { gap:4px; padding-inline:6px; } .preview-readonly { display:none; } }
        `}</style>
        <LuBraces size={16} className="preview-file-icon" aria-hidden="true" />
        <span className="preview-file-name" title={props.name}>{props.name.split(/[\\/]/).pop() || "JSON 预览"}</span>
        <span className="preview-readonly">只读预览</span>
        <div className="preview-modes" role="group" aria-label="预览模式">
            <button aria-pressed={props.mode === "tree"} onClick={() => { if (props.mode !== "tree") props.onModeChange(); }}><LuListTree size={14} aria-hidden="true" />结构</button>
            <button aria-pressed={props.mode === "code"} onClick={() => { if (props.mode !== "code") props.onModeChange(); }}><LuCode size={14} aria-hidden="true" />代码</button>
        </div>
        <div className="preview-mode-action">
            {props.mode === "tree" ? <button onClick={props.onCollapse} title="收起所有节点"><LuFoldVertical size={14} aria-hidden="true" />全部收起</button>
                : <select aria-label="缩进" value={props.indent} onChange={event => props.onIndentChange(Number(event.target.value))}><option value={2}>2 空格</option><option value={4}>4 空格</option></select>}
        </div>
        <button className="preview-icon-action" aria-label="刷新" title="重新读取文件" onClick={props.onRefresh}><LuRefreshCw size={15} aria-hidden="true" /></button>
        <button className="preview-icon-action" aria-label="预览说明" title="预览说明" aria-expanded={props.help} onClick={props.onToggleHelp}><LuInfo size={15} aria-hidden="true" /></button>
    </header>;
}
