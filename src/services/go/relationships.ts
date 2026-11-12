import * as vscode from "vscode";

export type RelationKind = "I↑" | "I↓" | "O↑" | "O↓" | "recursive";
export interface Relation { kind: RelationKind; targets: vscode.Location[]; incomplete?: boolean }
export interface Declaration {
    document: vscode.TextDocument;
    symbol: vscode.DocumentSymbol;
    inInterface: boolean;
}
interface TypeInfo extends Declaration {
    methods: Map<string, Declaration>;
    bases: vscode.Location[];
    children: vscode.Location[];
}
const id = (uri: vscode.Uri, position: vscode.Position) => `${uri.toString()}:${position.line}:${position.character}`;
export const declarationId = (declaration: Declaration) => id(declaration.document.uri, declaration.symbol.selectionRange.start);
export const methodName = (symbol: vscode.DocumentSymbol) => symbol.name.replace(/^.*\./, "");
const locationOf = (declaration: Declaration) => new vscode.Location(declaration.document.uri, declaration.symbol.selectionRange);

export function locations(targets: readonly (vscode.Location | vscode.LocationLink)[] = []): vscode.Location[] {
    const seen = new Set<string>();
    return targets.map(target => "targetUri" in target
        ? new vscode.Location(target.targetUri, target.targetSelectionRange ?? target.targetRange) : target).filter(target => {
        const key = id(target.uri, target.range.start);
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
}

// Only inspect a receiver's header, never the body or similarly named local variables.
export function receiverRange(document: vscode.TextDocument, symbol: vscode.DocumentSymbol): vscode.Range | undefined {
    const header = document.getText(new vscode.Range(symbol.range.start, symbol.selectionRange.start));
    const match = /^func\s*\(\s*(?:[\p{L}_][\p{L}\p{N}_]*\s+)?\*?([\p{L}_][\p{L}\p{N}_]*)\s*(?:\[[^\]]*\])?\s*\)\s*$/u.exec(header);
    if (!match) return undefined;
    const offset = document.offsetAt(symbol.range.start) + header.lastIndexOf(match[1]);
    return new vscode.Range(document.positionAt(offset), document.positionAt(offset + match[1].length));
}

export function embeddedFields(declaration: Declaration): vscode.DocumentSymbol[] {
    if (declaration.symbol.kind !== vscode.SymbolKind.Struct) return [];
    return (declaration.symbol.children ?? []).filter(field => {
        if (field.kind !== vscode.SymbolKind.Field) return false;
        // gopls gives an embedded field's identifier as its selection range.
        // Reject named fields ("base Base") and allow qualified/pointer/generic embeddings.
        const text = declaration.document.getText(field.range).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "").trim();
        return /^\*?(?:[\p{L}_][\p{L}\p{N}_]*\.)?[\p{L}_][\p{L}\p{N}_]*(?:\[[\s\S]*\])?(?:\s+`[^`]*`)?$/u.test(text);
    });
}

// A short-lived semantic graph, shared by visible declarations. No workspace file scan.
// All cross-file edges come from gopls definitions/references, not name matching.
export class GoRelationshipQuery {
    private readonly documents = new Map<string, Promise<Declaration[]>>();
    private readonly types = new Map<string, Promise<TypeInfo | undefined>>();
    private limited = false;
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly stale: () => boolean) {}

    async command<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
        if (this.active >= 4) await new Promise<void>(resolve => this.queue.push(resolve));
        else this.active++;
        try {
            if (this.stale()) return undefined;
            return await vscode.commands.executeCommand<T>(command, ...args);
        } finally {
            const next = this.queue.shift();
            if (next) next(); else this.active--;
        }
    }

    declarations(uri: vscode.Uri): Promise<Declaration[]> {
        const key = uri.toString();
        let pending = this.documents.get(key);
        if (!pending) {
            if (this.stale() || uri.scheme !== "file") return Promise.resolve([]);
            if (this.documents.size >= 48) { this.limited = true; return Promise.resolve([]); }
            pending = this.readDeclarations(uri);
            this.documents.set(key, pending);
        }
        return pending;
    }

    private async readDeclarations(uri: vscode.Uri): Promise<Declaration[]> {
        const opened = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (!opened && (await vscode.workspace.fs.stat(uri)).size > 1024 * 1024) return [];
        const document = opened ?? await vscode.workspace.openTextDocument(uri);
        if (this.stale() || document.lineCount > 20000 || document.offsetAt(new vscode.Position(document.lineCount, 0)) > 1024 * 1024) return [];
        const symbols = await this.command<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
        const result: Declaration[] = [];
        for (const symbol of symbols ?? []) {
            if (!symbol.selectionRange) continue;
            if ([vscode.SymbolKind.Interface, vscode.SymbolKind.Struct, vscode.SymbolKind.Method, vscode.SymbolKind.Function].includes(symbol.kind)) {
                result.push({ document, symbol, inInterface: symbol.kind === vscode.SymbolKind.Interface });
            }
            if (symbol.kind === vscode.SymbolKind.Interface) {
                for (const child of symbol.children ?? []) {
                    if (child.kind === vscode.SymbolKind.Method && child.selectionRange) {
                        result.push({ document, symbol: child, inInterface: true });
                    }
                }
            }
        }
        return result;
    }

    private async definition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location | undefined> {
        const result = await this.command<(vscode.Location | vscode.LocationLink)[]>("vscode.executeDefinitionProvider", uri, position);
        return locations(result)[0];
    }

    private type(location: vscode.Location): Promise<TypeInfo | undefined> {
        const key = id(location.uri, location.range.start);
        let pending = this.types.get(key);
        if (!pending) {
            if (this.stale()) return Promise.resolve(undefined);
            if (this.types.size >= 32) { this.limited = true; return Promise.resolve(undefined); }
            pending = this.readType(location);
            this.types.set(key, pending);
        }
        return pending;
    }

    private async readType(location: vscode.Location): Promise<TypeInfo | undefined> {
        const declarations = await this.declarations(location.uri);
        const declaration = declarations.find(item => item.symbol.kind === vscode.SymbolKind.Struct &&
            item.symbol.selectionRange.contains(location.range.start));
        if (!declaration || this.stale()) return undefined;
        const info: TypeInfo = { ...declaration, methods: new Map(), bases: [], children: [] };
        for (const field of embeddedFields(declaration)) {
            const base = await this.definition(location.uri, field.selectionRange.start);
            if (base) info.bases.push(base);
        }
        const references = await this.command<vscode.Location[]>("vscode.executeReferenceProvider", location.uri, declaration.symbol.selectionRange.start);
        if ((references?.length ?? 0) > 200) this.limited = true;
        // Bound expensive reverse edges. Partial results only produce confirmed links.
        for (const reference of (references ?? []).slice(0, 200)) {
            if (this.stale()) break;
            for (const item of await this.declarations(reference.uri)) {
                if (item.symbol.kind === vscode.SymbolKind.Method && !item.inInterface) {
                    const receiver = receiverRange(item.document, item.symbol);
                    if (receiver?.contains(reference.range.start)) info.methods.set(methodName(item.symbol), item);
                } else if (embeddedFields(item).some(field => field.selectionRange.contains(reference.range.start))) {
                    info.children.push(locationOf(item));
                }
            }
        }
        info.children = locations(info.children);
        return info;
    }

    async relations(declaration: Declaration): Promise<Relation[]> {
        const { document, symbol, inInterface } = declaration;
        const result: Relation[] = [];
        const implementations = symbol.kind === vscode.SymbolKind.Function ? [] : locations(await this.command<(vscode.Location | vscode.LocationLink)[]>(
            "vscode.executeImplementationProvider", document.uri, symbol.selectionRange.start,
        )).filter(target => id(target.uri, target.range.start) !== declarationId(declaration));
        if (implementations.length) result.push({ kind: inInterface ? "I↓" : "I↑", targets: implementations });
        if (!inInterface && [vscode.SymbolKind.Function, vscode.SymbolKind.Method].includes(symbol.kind)) {
            const references = await this.command<vscode.Location[]>("vscode.executeReferenceProvider", document.uri, symbol.selectionRange.start);
            const calls = locations(references).filter(reference => {
                if (reference.uri.toString() !== document.uri.toString() ||
                    !symbol.range.contains(reference.range) || symbol.selectionRange.contains(reference.range.start)) return false;
                const tail = document.getText(new vscode.Range(reference.range.end,
                    document.positionAt(document.offsetAt(reference.range.end) + 256)));
                return /^\s*(?:\[[^\]]*\]\s*)?\(/.test(tail);
            });
            if (calls.length) result.push({ kind: "recursive", targets: calls });
        }
        if (symbol.kind !== vscode.SymbolKind.Method || inInterface || this.stale()) return result;
        const receiver = receiverRange(document, symbol);
        const ownerLocation = receiver && await this.definition(document.uri, receiver.start);
        const owner = ownerLocation && await this.type(ownerLocation);
        if (!owner) return result;
        const name = methodName(symbol);
        const up = await this.walk(owner.bases, name, "bases", new Set([declarationId(owner)]));
        const down = await this.walk(owner.children, name, "children", new Set([declarationId(owner)]));
        if (up.length) result.push({ kind: "O↑", targets: up, incomplete: this.limited });
        if (down.length) result.push({ kind: "O↓", targets: down, incomplete: this.limited });
        return result;
    }

    private async walk(edges: vscode.Location[], name: string, direction: "bases" | "children", seen: Set<string>): Promise<vscode.Location[]> {
        const result: vscode.Location[] = [];
        for (const edge of edges) {
            if (this.stale()) break;
            if (seen.size >= 32) { this.limited = true; break; }
            const key = id(edge.uri, edge.range.start);
            if (seen.has(key)) continue;
            seen.add(key);
            const info = await this.type(edge);
            if (!info) continue;
            const method = info.methods.get(name);
            if (method) result.push(locationOf(method));
            else result.push(...await this.walk(info[direction], name, direction, seen));
        }
        return locations(result);
    }
}
