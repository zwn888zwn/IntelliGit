import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as VS from "vscode";
const mocks = vi.hoisted(() => ({ symbols: vi.fn(), enabled: true, commands: new Map(), listeners: new Map() }));
vi.mock("vscode", () => {
    class Range { start: any; end: any; constructor(start: any, end: any) { this.start = start; this.end = end; } contains(p: any) { return p.line >= this.start.line && p.line <= this.end.line; } }
    const listen = (name: string) => (callback: any) => { mocks.listeners.set(name, callback); return { dispose() {} }; };
    return {
        Range, InlayHint: class { constructor(public position: any, public label: any) {} }, InlayHintLabelPart: class { constructor(public value: string) {} },
        EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
        SymbolKind: { Function: 11, Method: 5, Constructor: 8, Class: 4, Struct: 22, Interface: 10, Enum: 9, Field: 7, Constant: 13, Variable: 12 },
        languages: { registerInlayHintsProvider: () => ({ dispose() {} }), onDidChangeDiagnostics: listen('diagnostics') },
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
    mocks.enabled = true; mocks.symbols.mockReset();
    document = { uri: { scheme: 'file', fsPath: '/repo/file.go', toString: () => 'file:///repo/file.go' },
        languageId: 'go', version: 1, lineCount: 20, isClosed: false, offsetAt: () => 200, lineAt: (line: number) => ({ range: range(line, line) }),
        getText: () => '// unsaved\nfunc demo() {}' } as unknown as VS.TextDocument;
    blame = vi.fn(async () => [line(2, 'Alice'), line(3, 'Bob'), line(4, 'Alice'), line(5, 'Alice'), line(8, 'Jack')]);
    provider = new SymbolInsightsProvider(() => ({ root: '/repo', gitOps: { getBlame: blame } } as any), vi.fn());
});
afterEach(() => provider.dispose());
describe('symbol insights', () => {
    const provide = () => provider.provideInlayHints(document,range(0,19),token);
    const parts = (hint: VS.InlayHint) => hint.label as VS.InlayHintLabelPart[];
    const setupSymbols = () => mocks.symbols.mockImplementation(async (command: string) => command === 'vscode.executeDocumentSymbolProvider'
        ? [symbol(11,2,5),symbol(5,8,9),symbol(22,12,15,[symbol(7,13,13)]),symbol(13,17,17),symbol(11,2,5)]
        : [{uri:document.uri,range:range(2,2)},{uri:document.uri,range:range(18,18)},{uri:document.uri,range:range(18,18)}]);
    it('includes functions, methods, types and constants at line ends, excluding fields and duplicate symbols', async () => {
        setupSymbols();
        const hints=await provide();
        expect(hints.map(hint=>hint.position.line)).toEqual([2,8,12,17]);
        expect(blame).toHaveBeenCalledTimes(1);
        expect(blame.mock.calls[0]).toEqual(['file.go',{contents:document.getText(),signal:expect.any(AbortSignal)}]);
        expect(parts(hints[0]).map(part=>part.value).join('')).toBe('1 usage · Alice +1');
        expect(parts(hints[0])[0].command?.arguments?.[2]).toHaveLength(1);
        expect(parts(hints[0])[2].command?.arguments).toEqual([document.uri,range(2,5),1]);
        expect(parts(hints[1]).at(-1)?.value).toBe('Jack');
        await provide();expect(blame).toHaveBeenCalledTimes(1);
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider')).toHaveLength(4);
    });
    it('only resolves declarations in the requested visible range',async()=>{
        setupSymbols();const hints=await provider.provideInlayHints(document,range(16,19),token);
        expect(hints).toHaveLength(1);expect(hints[0].position.line).toBe(17);
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider')).toHaveLength(1);
    });
    it('uses email identities, ignores uncommitted lines and respects range boundaries', () => {
        expect(summarizeAuthors([line(0,'Other'),line(1,'Alice','a'),line(2,'Alias','a'),line(3,'Alice','b'),line(4,'You','you',true)],1,4))
            .toEqual([{name:'Alice',lines:2},{name:'Alice',lines:1}]);
    });
    it('discards in-flight answers after editing and aborts the old snapshot', async () => {
        setupSymbols();let finish!: (value:any)=>void;
        blame.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
        const pending=provide();await vi.waitFor(()=>expect(blame).toHaveBeenCalled());
        (document as any).version++;
        mocks.listeners.get('change')({document,contentChanges:[{}]});
        expect((blame.mock.calls[0] as any)[1].signal.aborted).toBe(true);
        finish([line(2,'Wrong')]);expect(await pending).toEqual([]);
    });
    it('refreshes after Git changes and honors disabled, large-file and cancelled states',async()=>{
        setupSymbols();await provide();provider.invalidate();blame.mockResolvedValue([line(2,'New')]);
        expect(parts((await provide())[0]).at(-1)?.value).toBe('New');
        mocks.enabled=false;expect(await provide()).toEqual([]);
        mocks.enabled=true;(document as any).lineCount=20001;expect(await provide()).toEqual([]);
    });
    it('never attributes an unmatched file to the active repository',async()=>{
        provider.dispose();provider=new SymbolInsightsProvider(()=>null,vi.fn());
        expect(await provide()).toEqual([]);expect(blame).not.toHaveBeenCalled();
    });
    it('matches GoLand declaration boundaries and keeps authors for entry points',async()=>{
        const declaration = (kind:number,start:number,name:string,children:any[]=[]) => ({...symbol(kind,start,start+1,children),name});
        mocks.symbols.mockImplementation(async (command:string) => command==='vscode.executeDocumentSymbolProvider' ? [
            declaration(11,2,'init',[declaration(12,3,'local')]),
            declaration(12,8,'Global'),
            declaration(10,12,'Service',[declaration(5,13,'Call')]),
        ] : []);
        const hints=await provide();
        expect(hints.map(hint=>hint.position.line)).toEqual([2,8,12]);
        expect(parts(hints[0]).map(part=>part.value)).toEqual(['Alice +1']);
        expect(mocks.symbols.mock.calls.filter(call=>call[0]==='vscode.executeReferenceProvider').map(call=>call[2].line)).toEqual([8,12]);
        (document.uri as any).fsPath='/repo/file_test.go';
        mocks.symbols.mockImplementation(async(command:string)=>command==='vscode.executeDocumentSymbolProvider'?[declaration(11,2,'TestSomething')]:[]);
        provider.invalidate();mocks.symbols.mockClear();
        await provide();
        expect(mocks.symbols.mock.calls.some(call=>call[0]==='vscode.executeReferenceProvider')).toBe(false);
    });
});
