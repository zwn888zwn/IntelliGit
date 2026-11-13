import "../shared/initTooltips";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getVsCodeApi } from '../shared/vscodeApi';
import { detectTheme, highlightLine, initShiki, langForPath } from '../merge-editor/shikiHighlighter';
import type { TodoFile, TodoMatch } from '../../../services/todo/scanner';
import type { TodoScope } from '../../../views/TodoViewProvider';

type State={files:TodoFile[];scope:TodoScope;project:string;current?:string;loading:boolean;limited:boolean;skipped?:{path:string;reason:string}[];error?:string;selected?:string;count:number};
type Preview={id:string;path:string;start:number;line:number;lines:string[]};
type Row={file:string;match?:TodoMatch;count?:number};
const idFor=(file:string,match:TodoMatch)=>`${file}:${match.line}:${match.column}`;
const api=getVsCodeApi<{type:string;scope?:TodoScope;id?:string}>();
function TodoApp():React.ReactElement {
    const [state,setState]=useState<State>({files:[],scope:'project',project:'',loading:true,limited:false,count:0});
    const [preview,setPreview]=useState<Preview>();
    const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
    const [filter,setFilter]=useState('');
    const [scroll,setScroll]=useState(0);
    const [height,setHeight]=useState(400);
    const [theme,setTheme]=useState(detectTheme);
    const list=useRef<HTMLDivElement>(null);
    const code=useRef<HTMLDivElement>(null);
    const selected=useRef<string>();
    useEffect(()=>{
        initShiki();
        const receive=(event:MessageEvent)=>{
            if(event.data.type==='update'){
                const next=event.data as State;setState(next);selected.current=next.selected;
                if(!next.selected)setPreview(undefined);
            }
            if(event.data.type==='preview'&&event.data.id===selected.current)setPreview(event.data);
        };
        window.addEventListener('message',receive);api.postMessage({type:'ready'});
        const observer=new MutationObserver(()=>setTheme(detectTheme()));observer.observe(document.body,{attributes:true,attributeFilter:['class']});
        return()=>{window.removeEventListener('message',receive);observer.disconnect();};
    },[]);
    useEffect(()=>{
        if(!list.current)return;
        const observer=new ResizeObserver(entries=>setHeight(entries[0].contentRect.height));observer.observe(list.current);
        return()=>observer.disconnect();
    },[]);
    useEffect(()=>{
        const container=code.current;
        const row=container?.querySelector('.code-line.current');
        if(container&&row){
            const bounds=row.getBoundingClientRect();
            container.scrollTop+=bounds.top-container.getBoundingClientRect().top-(container.clientHeight-bounds.height)/2;
        }
    },[preview]);
    const files=useMemo(()=>state.files.map(file=>({...file,matches:file.matches.filter(match=>!filter||`${file.path} ${match.text}`.toLowerCase().includes(filter.toLowerCase()))})).filter(file=>file.matches.length),[state.files,filter]);
    const rows=useMemo(()=>files.flatMap(file=>[
        {file:file.path,count:file.matches.length},
        ...(collapsed.has(file.path)?[]:file.matches.map(match=>({file:file.path,match}))),
    ] as Row[]),[files,collapsed]);
    useEffect(()=>{if(list.current){list.current.scrollTop=0;setScroll(0);}},[state.scope,filter,state.project]);
    const choose=(row:Row)=>{if(row.match){selected.current=idFor(row.file,row.match);api.postMessage({type:'select',id:selected.current});}};
    const open=(row:Row)=>{if(row.match)api.postMessage({type:'open',id:idFor(row.file,row.match)});};
    const keyDown=(event:React.KeyboardEvent)=>{
        if(event.key==='Enter'&&state.selected){api.postMessage({type:'open',id:state.selected});event.preventDefault();return;}
        if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
        const indexes=rows.flatMap((row,index)=>row.match?[index]:[]);if(!indexes.length)return;
        const current=indexes.findIndex(index=>idFor(rows[index].file,rows[index].match!)===state.selected);
        const index=indexes[Math.max(0,Math.min(indexes.length-1,current+(event.key==='ArrowDown'?1:-1)))];
        choose(rows[index]);
        if(list.current){if(index*28<list.current.scrollTop)list.current.scrollTop=index*28;else if((index+1)*28>list.current.scrollTop+height)list.current.scrollTop=(index+1)*28-height;}
        event.preventDefault();
    };
    const first=Math.max(0,Math.floor(scroll/28)-5);
    const visible=rows.slice(first,first+Math.ceil(height/28)+10);
    const language=preview?langForPath(preview.path):null;
    return <main className="todo-app">
        <style>{styles}</style>
        <header>
            <nav aria-label="TODO 搜索范围">
                {([['project','Project'],['current','Current File']] as [TodoScope,string][]).map(([scope,label])=><button key={scope} className={state.scope===scope?'active':''} aria-pressed={state.scope===scope} onClick={()=>api.postMessage({type:'scope',scope})}>{label}{state.scope===scope&&<small>{state.count}</small>}</button>)}
            </nav>
            <span className="project" title={state.current}>{state.scope==='current'?(state.current?.split('/').pop()||'未打开文件'):''}</span>
            <input aria-label="筛选 TODO" placeholder="Filter TODOs" value={filter} onChange={event=>setFilter(event.target.value)}/>
            <button aria-label="刷新 TODO" title="刷新" onClick={()=>api.postMessage({type:'refresh'})}>↻</button>
        </header>
        <section className="panes">
            <div className="results" ref={list} tabIndex={0} role="tree" aria-label="TODO 结果" onKeyDown={keyDown} onScroll={event=>setScroll(event.currentTarget.scrollTop)}>
                {!rows.length&&<div className="empty">{state.loading?'正在查找 TODO…':state.error||'此范围内没有 TODO / FIXME 注释'}</div>}
                <div style={{height:rows.length*28,position:'relative'}}>
                    {visible.map((row,index)=>{
                        const id=row.match?idFor(row.file,row.match):row.file;
                        return <div key={id} style={{position:'absolute',top:(first+index)*28,height:28,width:'100%'}}>
                            {row.match?<button role="treeitem" aria-selected={state.selected===id} className={`match ${state.selected===id?'selected':''}`} title={`${row.file}:${row.match.line+1}\n${row.match.text}`} onClick={()=>choose(row)} onDoubleClick={()=>open(row)}>
                                <span className="position">({row.match.line+1}, {row.match.column+1})</span><span className="todo-text"><b>{row.match.tag}</b>{row.match.text.slice(row.match.tag.length)}</span>
                            </button>:<button role="treeitem" aria-expanded={!collapsed.has(row.file)} className="file" onClick={()=>setCollapsed(old=>{const next=new Set(old);if(next.has(row.file))next.delete(row.file);else next.add(row.file);return next;})}>
                                <span className="chevron">{collapsed.has(row.file)?'›':'⌄'}</span><span className="file-icon">{row.file.endsWith('.go')?'GO':'◇'}</span><span>{row.file.split('/').pop()}</span><span className="directory">{row.file.includes('/')?row.file.slice(0,row.file.lastIndexOf('/')):''}</span><small>{row.count} {row.count===1?'item':'items'}</small>
                            </button>}
                        </div>;
                    })}
                </div>
            </div>
            <div className="preview">
                {preview?<><div className="preview-title"><span title={preview.path}>{preview.path}</span><button onClick={()=>api.postMessage({type:'open',id:preview.id})}>Open ↗</button></div><div className="code" ref={code}>
                    {preview.lines.map((line,index)=>{
                        const tokens=language?highlightLine(line,language,theme):null;
                        return <div key={index} className={`code-line ${preview.start+index===preview.line?'current':''}`}><span className="line-number">{preview.start+index+1}</span><span className="source">{tokens?tokens.map((token,n)=><span key={n} style={{color:token.color}}>{token.text}</span>):line}</span></div>;
                    })}
                </div></>:<div className="empty">单击查看上下文，双击或 Enter 打开源码</div>}
            </div>
        </section>
        <footer>{state.loading?'正在扫描…':`${state.count} items`}{state.limited?' · 结果已达上限，请缩小范围':''}{state.skipped?.length?<span title={state.skipped.map(file=>`${file.path}: ${file.reason}`).join('\n')}> · {state.skipped.length} 个文件未扫描</span>:null}{state.error?` · ${state.error}`:''}<span>TODO · FIXME</span></footer>
    </main>;
}
const styles=`
.todo-app{height:100%;display:flex;flex-direction:column;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.todo-app button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:5px;padding:4px 8px}.todo-app button:hover{background:var(--vscode-toolbar-hoverBackground)}.todo-app button:focus-visible,.results:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.todo-app header{display:flex;align-items:center;gap:10px;min-height:44px;padding:5px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}.todo-app nav{display:flex;gap:6px;white-space:nowrap}.todo-app nav button.active{background:var(--vscode-list-inactiveSelectionBackground);box-shadow:inset 0 0 0 1px var(--vscode-focusBorder)}.todo-app small{font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px}.project{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.todo-app input{min-width:70px;width:150px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:4px 8px;outline:none}.todo-app input:focus{border-color:var(--vscode-focusBorder)}
.panes{display:flex;flex:1;min-height:0}.results{width:53%;min-width:220px;overflow:auto;padding:8px 8px 8px 4px}.preview{flex:1;min-width:0;border-left:1px solid var(--vscode-panel-border);display:flex;flex-direction:column}.file,.match{height:28px;width:100%;display:flex;align-items:center;text-align:left;white-space:nowrap;overflow:hidden}.file{gap:8px}.file .directory{font-size:12px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis}.file-icon{font-size:9px;font-weight:700;color:var(--vscode-symbolIcon-fileForeground,#4db5ce)}.chevron{width:12px;flex-shrink:0}.match{gap:10px;padding-left:40px!important}.match.selected{background:var(--vscode-list-inactiveSelectionBackground)}.results:focus-within .match.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.position{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:var(--vscode-descriptionForeground)}.todo-text{color:var(--vscode-textLink-foreground);font-style:italic;overflow:hidden;text-overflow:ellipsis}.todo-text b{font-style:normal}.empty{padding:24px;color:var(--vscode-descriptionForeground);font-size:12px}.preview-title{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 12px;border-bottom:1px solid var(--vscode-panel-border);font-size:12px;color:var(--vscode-descriptionForeground)}.preview-title span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.preview-title button{white-space:nowrap;color:var(--vscode-textLink-foreground)}.code{overflow:auto;flex:1;padding:6px 0;font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);line-height:1.6}.code-line{display:flex;min-width:max-content;min-height:1.6em}.code-line.current{background:var(--vscode-editor-lineHighlightBackground,var(--vscode-list-inactiveSelectionBackground))}.line-number{width:50px;flex-shrink:0;text-align:right;padding-right:14px;color:var(--vscode-editorLineNumber-foreground);user-select:none}.source{white-space:pre;padding-right:20px}.todo-app footer{display:flex;justify-content:space-between;border-top:1px solid var(--vscode-panel-border);padding:4px 12px;color:var(--vscode-descriptionForeground);font-size:11px;min-height:24px}@media(max-width:650px){.project{display:none}.todo-app header{gap:4px;padding:5px}.todo-app nav{gap:0}.todo-app input{width:90px}.results{min-width:180px;width:50%}.match{padding-left:18px!important}.position{display:none}}
`;
if (typeof document !== 'undefined' && document.getElementById('root'))createRoot(document.getElementById('root')!).render(<TodoApp/>);
