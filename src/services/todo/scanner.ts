import * as fs from "fs/promises";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import { setImmediate as yieldToEditor } from "timers/promises";
import type { GitExecutor } from "../../git/executor";

export interface TodoMatch { line: number; column: number; endColumn: number; tag: string; text: string }
export interface TodoFile { path: string; matches: TodoMatch[] }
export const TODO_FILE_LIMIT = 1024 * 1024;
const slashLanguages = new Set(['.go','.js','.jsx','.ts','.tsx','.mjs','.cjs','.java','.kt','.kts','.rs','.c','.cc','.cpp','.h','.hpp','.cs','.swift','.php','.dart','.scala','.vue','.svelte']);
const hashLanguages = new Set(['.py','.sh','.bash','.zsh','.yaml','.yml','.toml','.rb','.r','.pl','.gd','.gdscript']);

function supported(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return slashLanguages.has(ext) || hashLanguages.has(ext) || ['.html','.xml','.sql','.css','.handlebars','.hbs'].includes(ext);
}

/** A bounded, incremental comment lexer; state survives file-read chunks. */
function createTodoScanner(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    const template = ['.handlebars', '.hbs'].includes(ext);
    const slash = slashLanguages.has(ext) || template, hash = hashLanguages.has(ext) || template;
    const html = ['.html','.xml','.vue','.svelte'].includes(ext) || template;
    const sql = ext === '.sql';
    let quote = '', block = '', escaped = false;
    const result: TodoMatch[] = [];
    const capture = (line: string, row: number, start: number, end: number) => {
        for (const match of line.slice(start,end).matchAll(/\b(TODO|FIXME)\b/gi)) {
            const column = start + match.index!;
            result.push({ line: row, column, endColumn: Math.min(end, column + 500),
                tag: match[1].toUpperCase(), text: line.slice(column,end).trim().slice(0,500) });
            if (result.length >= 5000) break;
        }
    };
    return {
        result,
        line(line: string, row: number) {
        let i = 0;
        while (i < line.length) {
            if (block) {
                const end = line.indexOf(block, i);
                capture(line, row, i, end < 0 ? line.length : end);
                if (end < 0) break;
                i = end + block.length; block = ''; continue;
            }
            if (quote) {
                if (escaped) { escaped = false; i++; continue; }
                if (line[i] === '\\' && !(quote === '`' && ext === '.go')) { escaped = true; i++; continue; }
                if (line.startsWith(quote, i)) { i += quote.length; quote = ''; } else i++;
                continue;
            }
            if ((slash && line.startsWith('//',i)) || (hash && line[i] === '#') || (sql && line.startsWith('--',i))) {
                capture(line,row,i,line.length); break;
            }
            if ((slash || sql || ext === '.css') && line.startsWith('/*',i)) { block = '*/'; i += 2; continue; }
            if (template && line.startsWith('{{!--',i)) { block = '--}}'; i += 6; continue; }
            if (template && line.startsWith('{{!',i)) { block = '}}'; i += 3; continue; }
            if (html && line.startsWith('<!--',i)) { block = '-->'; i += 4; continue; }
            if (line[i] === '"' || line[i] === "'" || (slash && line[i] === '`')) {
                quote = hash && line.slice(i,i+3) === line[i].repeat(3) ? line[i].repeat(3) : line[i];
                i += quote.length; continue;
            }
            i++;
        }
        if (quote.length === 1 && quote !== '`' && !escaped) quote = '';
        escaped = false;
        },
    };
}

export function findTodos(content: string, filePath: string): TodoMatch[] {
    if (!supported(filePath)) return [];
    const scanner = createTodoScanner(filePath);
    const lines = content.split(/\r?\n/);
    for (let row = 0; row < lines.length && scanner.result.length < 5000; row++) scanner.line(lines[row],row);
    return scanner.result;
}

const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_LINE_CHARACTERS = 512 * 1024;
export interface SkippedTodoFile { path: string; reason: string }

async function* sourceLines(root: string, file: string, signal?: AbortSignal): AsyncGenerator<string> {
    const relative = path.relative(root,path.resolve(root,file));
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('文件不在项目内');
    const actual = await fs.realpath(path.resolve(root,file));
    const actualRelative = path.relative(await fs.realpath(root),actual);
    if (actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative)) throw new Error('链接指向项目外部');
    const handle = await fs.open(actual,'r');
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('不是普通文件');
        if (stat.size > MAX_SCAN_BYTES) throw new Error('文件超过 16 MiB');
        const decoder = new StringDecoder('utf8');
        const buffer = Buffer.alloc(64 * 1024);
        let pending = '', total = 0, rows = 0;
        while (!signal?.aborted) {
            const { bytesRead } = await handle.read(buffer,0,buffer.length,null);
            total += bytesRead;
            if (total > MAX_SCAN_BYTES) throw new Error('文件超过 16 MiB');
            if (buffer.subarray(0,bytesRead).includes(0)) throw new Error('二进制文件');
            pending += bytesRead ? decoder.write(buffer.subarray(0,bytesRead)) : decoder.end();
            let start = 0, end: number;
            while ((end = pending.indexOf('\n',start)) >= 0) {
                if (end - start > MAX_LINE_CHARACTERS) throw new Error('单行超过 512 KiB');
                if (signal?.aborted) return;
                yield pending.slice(start,end).replace(/\r$/, '');
                start = end + 1;
                if (++rows % 256 === 0) await yieldToEditor();
            }
            pending = pending.slice(start);
            if (pending.length > MAX_LINE_CHARACTERS) throw new Error('单行超过 512 KiB');
            if (!bytesRead) { if (pending) yield pending; break; }
            await yieldToEditor();
        }
    } finally { await handle.close(); }
}

export async function readTodoPreview(root: string, file: string, start: number, end: number, signal?: AbortSignal): Promise<string[]> {
    const lines: string[] = [];
    let row = 0;
    for await (const line of sourceLines(root,file,signal)) {
        if (row >= start) lines.push(line.slice(0,2000));
        if (++row > end) break;
    }
    return lines;
}

export async function scanTodos(root: string, executor: GitExecutor, snapshots: Map<string,string>, signal: AbortSignal,
    include: (file: string) => boolean = () => true) {
    const output = await executor.runWithInput(['ls-files','--cached','--others','--exclude-standard','-z'],'',signal);
    const paths = [...new Set(output.split('\0').filter(Boolean))]
        .filter(file => supported(file) && include(file) && !/(^|\/)(node_modules|vendor|dist|build|\.git|\.venv)\//.test(file));
    const files: TodoFile[] = [];
    const skipped: SkippedTodoFile[] = [];
    let cursor = 0, count = 0;
    const limit = Math.min(paths.length,30000);
    await Promise.all(Array.from({length:4},async()=>{
        while (!signal.aborted && cursor < limit && count < 5000) {
            const file = paths[cursor++];
            let matches: TodoMatch[];
            try {
                const content = snapshots.get(file);
                if (content !== undefined) {
                    if (content.length > TODO_FILE_LIMIT) throw new Error('未保存内容超过 1 MiB');
                    matches = findTodos(content,file);
                } else {
                    const scanner = createTodoScanner(file);
                    let row = 0;
                    for await (const line of sourceLines(root,file,signal)) {
                        scanner.line(line,row++);
                        if (scanner.result.length >= 5000) break;
                    }
                    matches = scanner.result;
                }
            } catch (error) {
                if (!signal.aborted) skipped.push({path:file,reason:error instanceof Error?error.message:String(error)});
                continue;
            }
            if (signal.aborted) return;
            matches = matches.slice(0,5000-count);
            if (matches.length) { files.push({path:file,matches}); count += matches.length; }
        }
    }));
    return { files: files.sort((a,b)=>a.path.localeCompare(b.path)), paths: paths.slice(0, limit), skipped, limited: cursor < paths.length || count >= 5000 };
}
