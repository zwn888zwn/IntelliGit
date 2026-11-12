import * as path from "path";
import * as vscode from "vscode";
import { buildWebviewShellHtml } from "./webviewHtml";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import { findTodos, readTodoPreview, scanTodos, TODO_FILE_LIMIT, type TodoFile, type TodoMatch, type SkippedTodoFile } from "../services/todo/scanner";

export type TodoScope = 'project' | 'current';
export const todoId = (file: string, match: TodoMatch) => `${file}:${match.line}:${match.column}`;
export class TodoViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    static readonly viewType = 'intelligit.todo';
    private view?: vscode.WebviewView;
    private files: TodoFile[] = [];
    private eligible = new Set<string>();
    private scope: TodoScope = 'project';
    private root = '';
    private currentUri = vscode.window.activeTextEditor?.document.uri;
    private selected?: string;
    private loading = false;
    private limited = false;
    private skipped: SkippedTodoFile[] = [];
    private previewAbort?: AbortController;
    private error?: string;
    private abort?: AbortController;
    private previewRequest = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private scanTimer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly decoration = vscode.window.createTextEditorDecorationType({
        color: new vscode.ThemeColor('textLink.foreground'), fontStyle: 'italic',
    });

    constructor(private readonly extensionUri: vscode.Uri, private readonly repository: () => RepositoryEntry | null) {
        this.subscriptions.push(this.decoration,
            vscode.window.registerWebviewViewProvider(TodoViewProvider.viewType,this),
            vscode.window.onDidChangeActiveTextEditor(editor=>{
                if (editor?.document.uri.scheme === 'file') this.currentUri = editor.document.uri;
                this.decorate();
                if (this.repository()?.root !== this.root || this.scope==='current') this.refresh(); else this.update();
            }),
            vscode.window.onDidChangeVisibleTextEditors(()=>this.decorate()),
            vscode.workspace.onDidChangeTextDocument(event=>{
                if (!event.contentChanges.length) return;
                if (this.timer) clearTimeout(this.timer);
                this.timer=setTimeout(()=>{
                    this.decorate();
                    // Overlay every dirty document so edits in quick succession are not dropped.
                    for (const document of vscode.workspace.textDocuments) this.updateDocument(document);
                    this.update();
                    if (this.selected) void this.preview(this.selected);
                },500);
            }),
            vscode.workspace.onDidSaveTextDocument(document=>{ this.updateDocument(document); this.update(); }),
            vscode.workspace.onDidCreateFiles(()=>this.refresh()),
            vscode.workspace.onDidDeleteFiles(()=>this.refresh()),
            vscode.workspace.onDidRenameFiles(()=>this.refresh()),
            vscode.workspace.onDidChangeConfiguration(event=>{
                if(event.affectsConfiguration('intelligit.todo.highlight'))this.decorate();
            }),
        );
        const watcher=vscode.workspace.createFileSystemWatcher('**/*');
        const changed=(uri:vscode.Uri)=>{
            if(!this.view?.visible||this.relative(uri)===undefined||/(^|\/)(\.git|node_modules|vendor|dist|build|\.venv)\//.test(uri.path))return;
            if(this.scanTimer)clearTimeout(this.scanTimer);
            this.scanTimer=setTimeout(()=>this.refresh(),1000);
        };
        this.subscriptions.push(watcher,watcher.onDidChange(changed),watcher.onDidCreate(changed),watcher.onDidDelete(changed));
        this.decorate();
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.extensionUri,'dist')]};
        this.subscriptions.push(view.webview.onDidReceiveMessage(message=>{ void this.receive(message).catch(error=>{
            this.error=String(error); this.loading=false; this.update();
        }); }), view.onDidChangeVisibility(()=>{ if(view.visible) this.refresh(); else this.abort?.abort(); }),
        view.onDidDispose(()=>{this.abort?.abort();this.previewAbort?.abort();if(this.view===view)this.view=undefined;}));
        view.webview.html=buildWebviewShellHtml({extensionUri:this.extensionUri,webview:view.webview,scriptFile:'webview-todo.js',title:'TODO'});
    }

    private relative(uri: vscode.Uri | undefined): string | undefined {
        if (!uri || uri.scheme !== 'file' || !this.root) return undefined;
        const relative=path.relative(this.root,uri.fsPath);
        return relative.startsWith('..'+path.sep)||path.isAbsolute(relative)?undefined:relative.split(path.sep).join('/');
    }

    private decorate(): void {
        const enabled=vscode.workspace.getConfiguration('intelligit').get('todo.highlight',true);
        for(const editor of vscode.window.visibleTextEditors) {
            const document=editor.document;
            const size=document.offsetAt(document.lineAt(document.lineCount-1).range.end);
            const matches=enabled&&document.uri.scheme==='file'&&size<=TODO_FILE_LIMIT?findTodos(document.getText(),document.uri.fsPath):[];
            editor.setDecorations(this.decoration,matches.map(match=>new vscode.Range(match.line,match.column,match.line,match.endColumn)));
        }
    }

    private updateDocument(document: vscode.TextDocument): void {
        if(!this.view?.visible || this.loading) return;
        const file=this.relative(document.uri);
        if(!file || !this.eligible.has(file))return;
        const size=document.offsetAt(document.lineAt(document.lineCount-1).range.end);
        if(size>TODO_FILE_LIMIT&&!document.isDirty)return;
        this.skipped=this.skipped.filter(entry=>entry.path!==file);
        if(size>TODO_FILE_LIMIT)this.skipped.push({path:file,reason:'未保存内容超过 1 MiB'});
        const matches=size<=TODO_FILE_LIMIT?findTodos(document.getText(),file):[];
        this.files=this.files.filter(entry=>entry.path!==file);
        if(matches.length)this.files.push({path:file,matches});
        this.files.sort((a,b)=>a.path.localeCompare(b.path));
    }

    refresh(): void {
        if(this.disposed||!this.view?.visible)return;
        this.abort?.abort();
        const abort=new AbortController();this.abort=abort;
        const repo=this.repository();
        if(!repo){this.root='';this.files=[];this.loading=false;this.update();return;}
        if(this.root!==repo.root){this.root=repo.root;this.files=[];this.selected=undefined;}
        this.loading=true;this.error=undefined;this.update();
        const snapshots=new Map<string,string>();
        const largeDirty=new Set<string>();
        for(const doc of vscode.workspace.textDocuments){
            const relative=this.relative(doc.uri);
            if(relative&&doc.isDirty){
                if(doc.offsetAt(doc.lineAt(doc.lineCount-1).range.end)<=TODO_FILE_LIMIT)snapshots.set(relative,doc.getText());
                else largeDirty.add(relative);
            }
        }
        void (async()=>{
            const current=this.relative(this.currentUri);
            const result=await scanTodos(repo.root,repo.executor,snapshots,abort.signal,file=>
                !largeDirty.has(file)&&(this.scope==='project'||file===current));
            if(abort.signal.aborted||this.disposed)return;
            this.files=result.files;this.eligible=new Set(result.paths);this.limited=result.limited;
            this.skipped=[...result.skipped,...[...largeDirty].map(path=>({path,reason:'未保存内容超过 1 MiB'}))];
            this.loading=false;
            for(const document of vscode.workspace.textDocuments) if(document.isDirty)this.updateDocument(document);
            this.update();
            if(this.selected)void this.preview(this.selected);
        })().catch(error=>{if(!abort.signal.aborted){this.loading=false;this.error=String(error);this.update();}});
    }

    private filtered(): TodoFile[] {
        const current=this.relative(this.currentUri);
        return this.files.filter(file=>this.scope==='project'||
            file.path===current);
    }

    private update(): void {
        if(!this.view?.visible||this.disposed)return;
        const files=this.filtered();
        if(this.selected&&!files.some(file=>file.matches.some(match=>todoId(file.path,match)===this.selected))){
            this.selected=undefined;this.previewRequest++;
            this.previewAbort?.abort();
        }
        void this.view.webview.postMessage({type:'update',files,scope:this.scope,
            project:path.basename(this.root),current:this.relative(this.currentUri),loading:this.loading,limited:this.limited,skipped:this.skipped,error:this.error,selected:this.selected,
            count:files.reduce((sum,file)=>sum+file.matches.length,0)});
    }

    private find(id: string) {
        for(const file of this.filtered())for(const match of file.matches)if(todoId(file.path,match)===id)return {file,match};
        return undefined;
    }

    private async preview(id: string): Promise<void> {
        const found=this.find(id);if(!found)return;
        const request=++this.previewRequest;
        this.previewAbort?.abort();const abort=new AbortController();this.previewAbort=abort;
        this.selected=id;this.update();
        const uri=vscode.Uri.file(path.join(this.root,found.file.path));
        const document=vscode.workspace.textDocuments.find(doc=>doc.uri.toString()===uri.toString());
        const start=Math.max(0,found.match.line-8);
        let lines:string[];
        try {
            lines=document
                ? Array.from({length:Math.max(0,Math.min(document.lineCount,found.match.line+21)-start)},(_,index)=>document.lineAt(start+index).text.slice(0,2000))
                : await readTodoPreview(this.root,found.file.path,start,found.match.line+20,abort.signal);
        } catch(error) {
            if(abort.signal.aborted)return;
            this.error=`无法预览：${String(error)}`;this.update();return;
        }
        if(request!==this.previewRequest||abort.signal.aborted||this.disposed)return;
        void this.view?.webview.postMessage({type:'preview',id,path:found.file.path,start,line:found.match.line,
            lines});
    }

    private async receive(message: {type?: string;scope?: TodoScope;id?: string}): Promise<void> {
        if(message.type==='ready'||message.type==='refresh'){this.refresh();return;}
        if(message.type==='scope'&&['project','current'].includes(message.scope??'')){
            this.scope=message.scope!;this.selected=undefined;this.refresh();return;
        }
        if(typeof message.id!=='string')return;
        if(message.type==='select'){await this.preview(message.id);return;}
        if(message.type==='open'){
            const found=this.find(message.id);if(!found)return;
            const position=new vscode.Position(found.match.line,found.match.column);
            await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root,found.file.path)),{
                selection:new vscode.Range(position,position),preview:false,
            });
        }
    }

    dispose(): void {
        this.disposed=true;this.abort?.abort();this.previewRequest++;
        this.previewAbort?.abort();
        if(this.timer)clearTimeout(this.timer);
        if(this.scanTimer)clearTimeout(this.scanTimer);
        for(const subscription of this.subscriptions)subscription.dispose();
    }
}
