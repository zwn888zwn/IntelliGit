import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VS from "vscode";
const mocks = vi.hoisted(() => ({ symbols: vi.fn(), refresh: vi.fn(), enabled: true, commands: new Map(), listeners: new Map() }));
vi.mock("vscode", () => {
    class Range { start: any; end: any; constructor(start: any, end: any, endLine?: number, endCharacter?: number) { this.start = typeof start === "number" ? {line:start,character:end} : start; this.end = typeof start === "number" ? {line:endLine,character:endCharacter} : end; } contains(p: any) { return p.line >= this.start.line && p.line <= this.end.line; } }
    const listen = (name: string) => (callback: any) => { mocks.listeners.set(name, callback); return { dispose() {} }; };
    return {
        Range, CodeLens: class { constructor(public range: any, public command?: any) {} },
        EventEmitter: class { event = () => ({ dispose() {} }); fire = mocks.refresh; dispose() {} },
        SymbolKind: { Function: 11, Method: 5, Constructor: 8, Class: 4, Struct: 22, Interface: 10, Enum: 9, Field: 7, Constant: 13, Variable: 12 },
        languages: { registerCodeLensProvider: () => ({ dispose() {} }), onDidChangeDiagnostics: listen('diagnostics') },
        commands: { executeCommand: mocks.symbols, registerCommand: (id: string, fn: any) => { mocks.commands.set(id, fn); return { dispose() {} }; } },
        window: { visibleTextEditors: [], onDidChangeVisibleTextEditors: listen('visible') },
        workspace: { getConfiguration: () => ({ get: () => mocks.enabled }), openTextDocument: vi.fn(),
            onDidChangeTextDocument: listen('change'), onDidSaveTextDocument: listen('save'),
            onDidCloseTextDocument: listen('close'), onDidChangeConfiguration: listen('config') },
    };
});
import { SymbolInsightsProvider, summarizeAuthors } from "../../src/services/SymbolInsightsProvider";
import { Range } from "vscode";
const range = (start: number, end: number) => new Range({ line: start, character: 0 } as VS.Position, { line: end, character: 10 } as VS.Position);
const symbol = (kind: number, start: number, end: number, children: any[] = []) => ({ kind, range: range(start, end), selectionRange: range(start, start), children });
const line = (n: number, name: string, email = name, isUncommitted = false) => ({ line: n, author: name, authorEmail: email, isUncommitted, commitHash: 'a'.repeat(40), shortHash: 'aaaaaaaa', date: '', summary: '' });
const token = { isCancellationRequested: false } as VS.CancellationToken;
let provider: SymbolInsightsProvider;
let document: VS.TextDocument;
let blame: ReturnType<typeof vi.fn>;
beforeEach(() => {
    mocks.enabled = true; mocks.symbols.mockReset(); mocks.refresh.mockClear();
    document = { uri: { scheme: 'file', fsPath: '/repo/file.go', toString: () => 'file:///repo/file.go' },
        languageId: 'go', version: 1, lineCount: 20, isClosed: false, offsetAt: () => 200, lineAt: (line: number) => ({ range: range(line, line) }),
        getText: () => '// unsaved\nfunc demo() {}' } as unknown as VS.TextDocument;
    blame = vi.fn(async () => [line(2, 'Alice'), line(3, 'Bob'), line(4, 'Alice'), line(5, 'Alice'), line(8, 'Jack')]);
    provider = new SymbolInsightsProvider(() => ({ root: '/repo', gitOps: { getBlame: blame } } as any), vi.fn());
});
afterEach(() => provider.dispose());
describe('symbol insights', () => {
    const provide = () => provider.provideCodeLenses(document,token);
    const resolve = async (lenses: VS.CodeLens[]) => Promise.all(lenses.map(lens=>provider.resolveCodeLens(lens,token)));
    const setupSymbols = () => mocks.symbols.mockImplementation(async (command: string) => command === 'vscode.executeDocumentSymbolProvider'
        ? [symbol(11,2,5),symbol(5,8,9),symbol(22,12,15,[symbol(7,13,13)]),symbol(13,17,17),symbol(11,2,5)]
        : [{uri:document.uri,range:range(2,2)},{uri:document.uri,range:range(18,18)},{uri:document.uri,range:range(18,18)}]);
    it('places two separately clickable metrics above declarations, excluding fields and duplicate symbols', async () => {
        setupSymbols();
        const lenses=await provide();
        expect(lenses.map(lens=>lens.range.start.line)).toEqual([2,2,8,8,12,12,17,17]);
        expect(blame).not.toHaveBeenCalled();
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider')).toHaveLength(0);
        const resolved=await resolve(lenses);
        expect(blame).toHaveBeenCalledTimes(1);
        expect(blame.mock.calls[0]).toEqual(['file.go',{contents:document.getText(),signal:expect.any(AbortSignal)}]);
        expect(resolved[0].command?.title).toBe('1 usage');
        expect(resolved[0].command?.arguments?.[2]).toHaveLength(1);
        expect(resolved[1].command).toMatchObject({title:'$(intelligit-author) Alice +1',command:'intelligit.toggleSymbolBlame',arguments:[document.uri,1]});
        expect(resolved[3].command?.title).toBe('$(intelligit-author) Jack');
        await resolve(await provide());expect(blame).toHaveBeenCalledTimes(1);
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider')).toHaveLength(4);
    });
    it('only loads authors and references when VS Code resolves visible lenses',async()=>{
        setupSymbols();const lenses=await provide();
        await resolve(lenses.slice(0,2));
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider')).toHaveLength(1);
        expect(blame).toHaveBeenCalledTimes(1);
    });
    it('uses email identities, ignores uncommitted lines and respects range boundaries', () => {
        expect(summarizeAuthors([line(0,'Other'),line(1,'Alice','a'),line(2,'Alias','a'),line(3,'Alice','b'),line(4,'You','you',true)],1,4))
            .toEqual([{name:'Alice',lines:2},{name:'Alice',lines:1}]);
    });
    it('discards in-flight answers after editing and aborts the old snapshot', async () => {
        setupSymbols();let finish!: (value:any)=>void;
        blame.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
        const lenses=await provide();const pending=provider.resolveCodeLens(lenses[1],token);
        (document as any).version++;
        mocks.listeners.get('change')({document,contentChanges:[{}]});
        expect((blame.mock.calls[0] as any)[1].signal.aborted).toBe(true);
        finish([line(2,'Wrong')]);expect((await pending).command).toBeUndefined();
    });
    it('refreshes after Git changes and honors disabled and large-file states',async()=>{
        setupSymbols();await resolve(await provide());provider.invalidate();blame.mockResolvedValue([line(2,'New')]);
        expect((await resolve(await provide()))[1].command?.title).toBe('$(intelligit-author) New');
        mocks.enabled=false;expect(await provide()).toEqual([]);
        mocks.enabled=true;(document as any).lineCount=20001;expect(await provide()).toEqual([]);
    });
    it('never attributes an unmatched file to the active repository',async()=>{
        provider.dispose();provider=new SymbolInsightsProvider(()=>null,vi.fn());
        expect(await provide()).toEqual([]);expect(blame).not.toHaveBeenCalled();
    });
    it('resolves a retained lens after Git refresh without leaving a blank CodeLens row',async()=>{
        setupSymbols();const lenses=await provide();
        provider.invalidate();
        expect((await provider.resolveCodeLens(lenses[0],token)).command?.title).toBe('1 usage');
        expect((await provider.resolveCodeLens(lenses[1],token)).command?.title).toBe('$(intelligit-author) Alice +1');
    });
    it('retries while the language server starts, with a bounded retry count',async()=>{
        vi.useFakeTimers();
        try {
            mocks.symbols.mockResolvedValue(undefined);
            for(let attempt=0;attempt<12;attempt++) {
                expect(await provide()).toEqual([]);
                await vi.advanceTimersByTimeAsync(500);
            }
            expect(mocks.refresh).toHaveBeenCalledTimes(10);
            setupSymbols();
            expect(await provide()).toHaveLength(8);
        } finally { vi.useRealTimers(); }
    });
    it('matches GoLand declaration boundaries and keeps authors for entry points',async()=>{
        const declaration = (kind:number,start:number,name:string,children:any[]=[]) => ({...symbol(kind,start,start+1,children),name});
        mocks.symbols.mockImplementation(async (command:string) => command==='vscode.executeDocumentSymbolProvider' ? [
            declaration(11,2,'init',[declaration(12,3,'local')]),
            declaration(12,8,'Global'),
            declaration(10,12,'Service',[declaration(5,13,'Call')]),
        ] : []);
        const lenses=await provide();
        expect(lenses.map(lens=>lens.range.start.line)).toEqual([2,8,8,12,12]);
        expect((await resolve(lenses))[0].command?.title).toBe('$(intelligit-author) Alice +1');
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider').map(call=>call[2].line)).toEqual([8,12]);
        (document.uri as any).fsPath='/repo/file_test.go';
        mocks.symbols.mockImplementation(async(command:string)=>command==='vscode.executeDocumentSymbolProvider'?[declaration(11,2,'TestSomething')]:[]);
        provider.invalidate();mocks.symbols.mockClear();await resolve(await provide());
        expect(mocks.symbols.mock.calls.some(call=>call[0]==='vscode.executeReferenceProvider')).toBe(false);
    });
});
