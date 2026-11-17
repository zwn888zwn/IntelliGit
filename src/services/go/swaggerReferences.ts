/** Minimal Go lexical scan: comments and string contents never become declarations. */
interface Token { text: string; start: number; kind: "comment" | "string" | "code" }
export function goTokens(source: string): Token[] {
    const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`[^`]*`|[\p{L}_][\p{L}\p{N}_]*|[^\s]/gu;
    return Array.from(source.matchAll(pattern), match => ({
        text: match[0], start: match.index!,
        kind: match[0].startsWith("//") || match[0].startsWith("/*") ? "comment"
            : /^["'`]/.test(match[0]) ? "string" : "code",
    }));
}
export function goPackageName(tokens: Token[]): string | undefined {
    const code = tokens.filter(token => token.kind === "code");
    return code[0]?.text === "package" ? code[1]?.text : undefined;
}
export interface GoImport { alias?: string; path: string; offset: number }
export function goImports(tokens: Token[]): GoImport[] {
    const code = tokens.filter(token => token.kind !== "comment");
    const result: GoImport[] = [];
    for (let i = 0; i < code.length; i++) {
        if (code[i].text !== "import") continue;
        const grouped = code[i + 1]?.text === "(";
        i += grouped ? 2 : 1;
        do {
            if (!code[i] || code[i].text === ")") break;
            if (code[i].text === ";") { i++; continue; }
            let alias: string | undefined;
            if (code[i].kind !== "string") alias = code[i++].text;
            const token = code[i];
            if (!token || token.kind !== "string") break;
            try {
                const path: string = token.text.startsWith('"') ? JSON.parse(token.text) : token.text.slice(1, -1);
                result.push({ alias, path, offset: token.start + 1 });
            } catch { /* Incomplete import while typing. */ }
            if (!grouped) break;
            i++;
        } while (i < code.length);
    }
    return result;
}
export interface SwaggerReference { qualifier?: string; name: string; start: number; end: number }
const primitives = new Set(["string", "integer", "number", "boolean", "object", "array", "file", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "bool", "byte", "rune", "any", "interface", "map"]);
export function swaggerReferenceAt(tokens: Token[], offset: number): SwaggerReference | undefined {
    const comment = tokens.find(token => token.kind === "comment" && token.start <= offset && offset <= token.start + token.text.length);
    if (!comment) return undefined;
    const prefix = /^\/\/\s*@(Success|Failure|Response)\s+\S+\s+\{[^}]+\}\s+/i.exec(comment.text)
        ?? /^\/\/\s*@Param\s+\S+\s+\S+\s+/i.exec(comment.text);
    if (!prefix) return undefined;
    const rest = comment.text.slice(prefix[0].length);
    let length = 0, depth = 0;
    for (const ch of rest) {
        if (/\s/.test(ch) && depth === 0) break;
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") depth--;
        length += ch.length;
    }
    const expression = rest.slice(0, length);
    const names = /([\p{L}_][\p{L}\p{N}_]*)(?:\.([\p{L}_][\p{L}\p{N}_]*))?/gu;
    for (const match of expression.matchAll(names)) {
        const start = comment.start + prefix[0].length + match.index!;
        const end = start + match[0].length;
        if (offset < start || offset > end) continue;
        if (/^\s*=/.test(expression.slice(match.index! + match[0].length))) return undefined;
        const name = match[2] ?? match[1];
        if (!match[2] && primitives.has(name)) return undefined;
        return { qualifier: match[2] ? match[1] : undefined, name, start, end };
    }
    return undefined;
}
