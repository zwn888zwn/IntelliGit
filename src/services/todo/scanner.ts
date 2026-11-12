import * as fs from "fs/promises";
import * as path from "path";
import type { GitExecutor } from "../../git/executor";

export interface TodoMatch { line: number; column: number; endColumn: number; tag: string; text: string }
export interface TodoFile { path: string; matches: TodoMatch[] }
export const TODO_FILE_LIMIT = 1024 * 1024;
const slashLanguages = new Set(['.go','.js','.jsx','.ts','.tsx','.mjs','.cjs','.java','.kt','.kts','.rs','.c','.cc','.cpp','.h','.hpp','.cs','.swift','.php','.dart','.scala','.vue','.svelte']);
const hashLanguages = new Set(['.py','.sh','.bash','.zsh','.yaml','.yml','.toml','.rb','.r','.pl']);

function supported(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    return slashLanguages.has(ext) || hashLanguages.has(ext) || ['.html','.xml','.sql','.css'].includes(ext);
}

/** Scan comment text, keeping strings (including Go raw strings) out of the results. */
export function findTodos(content: string, filePath: string): TodoMatch[] {
    const ext = path.extname(filePath).toLowerCase();
    const slash = slashLanguages.has(ext), hash = hashLanguages.has(ext);
    const html = ['.html','.xml','.vue','.svelte'].includes(ext);
    const sql = ext === '.sql';
    if (!slash && !hash && !html && !sql && ext !== '.css') return [];
    let quote = '', block = '', escaped = false;
    const result: TodoMatch[] = [];
    const capture = (line: string, row: number, start: number, end: number) => {
        const comment = line.slice(start, end);
        for (const match of comment.matchAll(/\b(TODO|FIXME)\b/g)) {
            const column = start + match.index!;
            result.push({ line: row, column, endColumn: Math.min(end, column + 500), tag: match[1], text: line.slice(column, end).trim().slice(0, 500) });
        }
    };
    const lines = content.split(/\r?\n/);
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
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
                if (line[i] === '\\' && quote !== '`') { escaped = true; i++; continue; }
                if (line.startsWith(quote, i)) { i += quote.length; quote = ''; } else i++;
                continue;
            }
            if ((slash && line.startsWith('//',i)) || (hash && line[i] === '#') || (sql && line.startsWith('--',i))) {
                capture(line,row,i,line.length); break;
            }
            if ((slash || sql || ext === '.css') && line.startsWith('/*',i)) { block = '*/'; i += 2; continue; }
            if (html && line.startsWith('<!--',i)) { block = '-->'; i += 4; continue; }
            if (line[i] === '"' || line[i] === "'" || (slash && line[i] === '`')) {
                quote = hash && line.slice(i,i+3) === line[i].repeat(3) ? line[i].repeat(3) : line[i];
                i += quote.length; continue;
            }
            i++;
        }
        if (quote.length === 1 && quote !== '`' && !escaped) quote = '';
        escaped = false;
        if (result.length >= 5000) break;
    }
    return result;
}

export function inDirectory(file: string, directory: string): boolean {
    return !directory || file === directory || file.startsWith(directory.replace(/\/$/,'') + '/');
}

export async function readTodoFile(root: string, file: string): Promise<string | undefined> {
    const absolute = path.resolve(root,file);
    const relative = path.relative(root,absolute);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return undefined;
    try {
        // Avoid traversing symlinked directories outside the project.
        const actual = await fs.realpath(absolute);
        const actualRelative = path.relative(await fs.realpath(root),actual);
        if (actualRelative.startsWith('..' + path.sep) || path.isAbsolute(actualRelative)) return undefined;
        const handle = await fs.open(actual,'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > TODO_FILE_LIMIT) return undefined;
            const buffer = Buffer.alloc(Math.min(stat.size + 1, TODO_FILE_LIMIT + 1));
            const { bytesRead } = await handle.read(buffer,0,buffer.length,0);
            if (bytesRead > TODO_FILE_LIMIT || buffer.subarray(0,bytesRead).includes(0)) return undefined;
            return buffer.subarray(0,bytesRead).toString('utf8');
        } finally { await handle.close(); }
    } catch { return undefined; }
}

export async function scanTodos(root: string, executor: GitExecutor, snapshots: Map<string,string>, signal: AbortSignal,
    include: (file: string) => boolean = () => true) {
    const output = await executor.runWithInput(['ls-files','--cached','--others','--exclude-standard','-z'],'',signal);
    const paths = [...new Set(output.split('\0').filter(Boolean))]
        .filter(file => supported(file) && include(file) && !/(^|\/)(node_modules|vendor|dist|build|\.git|\.venv)\//.test(file));
    const files: TodoFile[] = [];
    let cursor = 0, count = 0;
    const limit = Math.min(paths.length,30000);
    await Promise.all(Array.from({length:4},async()=>{
        while (!signal.aborted && cursor < limit && count < 5000) {
            const file = paths[cursor++];
            const content = snapshots.get(file) ?? await readTodoFile(root,file);
            if (content === undefined || content.length > TODO_FILE_LIMIT || signal.aborted) continue;
            const matches = findTodos(content,file).slice(0,5000-count);
            if (matches.length) { files.push({path:file,matches}); count += matches.length; }
        }
    }));
    return { files: files.sort((a,b)=>a.path.localeCompare(b.path)), paths: paths.slice(0, limit), limited: cursor < paths.length || count >= 5000 };
}
