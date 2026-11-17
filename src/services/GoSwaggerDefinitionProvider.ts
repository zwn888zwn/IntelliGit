import * as vscode from "vscode";
import { goImports, goPackageName, goTokens, swaggerReferenceAt, type GoImport } from "./go/swaggerReferences";

const MAX_BYTES = 1024 * 1024;
const MAX_PACKAGE_FILES = 512;
/** Resolve only Swagger type positions; leave ordinary Go navigation to gopls. */
export class GoSwaggerDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.LocationLink[]> {
        if (token.isCancellationRequested || document.languageId !== "go" || document.uri.scheme !== "file") return [];
        // Most definition requests are ordinary code; avoid scanning their document.
        if (!/^\s*\/\/\s*@(Param|Success|Failure|Response)\b/i.test(document.lineAt(position.line).text)) return [];
        if (document.offsetAt(new vscode.Position(document.lineCount, 0)) > MAX_BYTES) return [];
        const tokens = goTokens(document.getText());
        const reference = swaggerReferenceAt(tokens, document.offsetAt(position));
        if (!reference) return [];
        const version = document.version;
        const cancelled = () => token.isCancellationRequested || document.version !== version;
        const origin = new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end));
        try {
            let files: vscode.Uri[] = [];
            if (reference.qualifier) {
                const imports = goImports(tokens).filter(item => !item.alias || item.alias === "_" || item.alias === reference.qualifier);
                // Likely paths first; actual package declarations still decide the match.
                imports.sort((a, b) => Number(this.likely(b, reference.qualifier!)) - Number(this.likely(a, reference.qualifier!)));
                for (const item of imports) {
                    if (cancelled()) return [];
                    // This position is an import string, so our provider does not recurse.
                    const definitions = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
                        "vscode.executeDefinitionProvider", document.uri, document.positionAt(item.offset),
                    );
                    const targets = [...new Map((definitions ?? []).map(target => {
                        const uri = "targetUri" in target ? target.targetUri : target.uri;
                        return [uri.toString(), uri] as const;
                    })).values()].filter(uri => uri.scheme === "file" && uri.path.endsWith(".go"));
                    if (!targets.length || cancelled()) continue;
                    if (item.alias && item.alias !== "_") { files = targets; break; }
                    const source = await this.readSource(targets[0]);
                    const packageName = source && goPackageName(goTokens(source));
                    if (packageName === reference.qualifier) { files = targets; break; }
                }
            } else {
                // Unqualified names resolve only in this package, not across the workspace.
                const directory = vscode.Uri.joinPath(document.uri, "..");
                const entries = await vscode.workspace.fs.readDirectory(directory);
                files = entries.filter(([name, kind]) => kind === vscode.FileType.File && name.endsWith(".go") && !name.endsWith("_test.go"))
                    .map(([name]) => vscode.Uri.joinPath(directory, name));
            }
            if (cancelled() || files.length > MAX_PACKAGE_FILES) return [];
            const links: vscode.LocationLink[] = [];
            let bytes = 0;
            for (const uri of files) {
                if (cancelled()) return [];
                const source = await this.readSource(uri);
                if (!source) continue;
                bytes += source.length;
                if (bytes > 16 * MAX_BYTES) return [];
                if (!source.includes(reference.name)) continue;
                if (!reference.qualifier && goPackageName(goTokens(source)) !== goPackageName(tokens)) continue;
                const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri);
                if (cancelled()) return [];
                for (const symbol of symbols ?? []) {
                    if (symbol.name !== reference.name || !symbol.selectionRange) continue;
                    if (![vscode.SymbolKind.Struct, vscode.SymbolKind.Interface, vscode.SymbolKind.Class].includes(symbol.kind)) continue;
                    links.push({ originSelectionRange: origin, targetUri: uri, targetRange: symbol.range, targetSelectionRange: symbol.selectionRange });
                }
            }
            return links;
        } catch {
            // gopls may be starting, the import unresolved, or a file removed while hovering.
            return [];
        }
    }

    private likely(item: GoImport, qualifier: string): boolean {
        return item.alias === qualifier || item.path.split("/").at(-1) === qualifier;
    }

    private async readSource(uri: vscode.Uri): Promise<string | undefined> {
        const opened = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (opened) return opened.offsetAt(new vscode.Position(opened.lineCount, 0)) <= MAX_BYTES ? opened.getText() : undefined;
        if ((await vscode.workspace.fs.stat(uri)).size > MAX_BYTES) return undefined;
        return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    }
}
