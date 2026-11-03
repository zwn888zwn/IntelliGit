import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export interface HistoryRange { start: number; end: number }
export interface SelectionHistoryEntry {
    hash: string;
    author: string;
    date: string;
    subject: string;
    before: string;
    after: string;
    beforeLine: number;
    afterLine: number;
}
export interface SelectionHistorySnapshot {
    head: string;
    filePath: string;
    range: HistoryRange;
    mapped: boolean;
}

function readGit(root: string, args: string[], diffExit = false): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("git", ["-c", "core.quotepath=false", ...args], {
            cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000,
        }, (error, stdout) => {
            if (error && !(diffExit && error.code === 1)) reject(error);
            else resolve(stdout);
        });
    });
}

/** Translate current-buffer boundaries into HEAD, refusing ambiguous partial replacements. */
export function mapSelectionToHead(range: HistoryRange, patch: string): HistoryRange {
    let start = range.start;
    let end = range.end;
    for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        const delta = oldCount - newCount;
        if (newCount === 0) {
            if (newStart < range.start) start += delta;
            if (newStart < range.end) end += delta;
            continue;
        }
        const newEnd = newStart + newCount - 1;
        if (newEnd < range.start) { start += delta; end += delta; continue; }
        if (newStart > range.end) continue;
        if (oldCount > 0 && (range.start > newStart || range.end < newEnd)) {
            throw new Error("所选范围只覆盖了部分未提交修改，无法准确定位历史。请选中完整函数（包含未改动的首尾行）后重试。");
        }
        if (range.start >= newStart) start = oldCount === 0 ? oldStart + 1 : oldStart;
        if (range.end >= newEnd) end += delta;
        else end = oldCount === 0 ? oldStart : oldStart + oldCount - 1;
    }
    if (end < start) throw new Error("所选代码尚未提交，没有 Git 历史。");
    return { start, end };
}

export async function prepareSelectionHistory(
    root: string, filePath: string, content: string, range: HistoryRange,
): Promise<SelectionHistorySnapshot> {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start) {
        throw new Error("无效的代码选择范围。");
    }
    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..") || /[\0\r\n]/.test(filePath)) {
        throw new Error("文件不在当前仓库内。");
    }
    const head = (await readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
    let base: string;
    try {
        base = await readGit(root, ["show", `${head}:${filePath}`]);
    } catch {
        throw new Error("此路径在 HEAD 中不存在，新增或尚未提交的重命名文件暂时没有可查询的历史。");
    }
    // EOL normalization is only for line mapping; the document itself is never saved or changed.
    const normalized = content.replace(/\r\n/g, "\n");
    base = base.replace(/\r\n/g, "\n");
    if (base === normalized) return { head, filePath, range, mapped: false };
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-selection-"));
    try {
        const before = path.join(temporary, "before");
        const after = path.join(temporary, "after");
        await Promise.all([fs.writeFile(before, base), fs.writeFile(after, normalized)]);
        const patch = await readGit(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv",
            "--text", "--no-color", "--unified=0", "--", before, after], true);
        return { head, filePath, range: mapSelectionToHead(range, patch), mapped: true };
    } finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}

/** Git -L follows the selected range backwards; unrelated edits in the file are omitted. */
export async function readSelectionHistory(
    root: string, snapshot: SelectionHistorySnapshot, limit = 100,
): Promise<{ entries: SelectionHistoryEntry[]; hasMore: boolean }> {
    const { start, end } = snapshot.range;
    const output = await readGit(root, ["log", "--no-color", "--no-ext-diff", "--no-textconv",
        `--max-count=${limit + 1}`, "--format=%x00%H%x00%an%x00%aI%x00%s%x00",
        `-L${start},${end}:${snapshot.filePath}`, snapshot.head]);
    const entries = parseSelectionHistory(output);
    return { entries: entries.slice(0, limit), hasMore: entries.length > limit };
}

export function parseSelectionHistory(output: string): SelectionHistoryEntry[] {
    const headers = [...output.matchAll(/\0([a-f0-9]{40,64})\0([^\0]*)\0([^\0]*)\0([^\0]*)\0/g)];
    return headers.map((header, index) => {
        const patch = output.slice(header.index! + header[0].length, headers[index + 1]?.index);
        const before: string[] = [];
        const after: string[] = [];
        let beforeLine = 0;
        let afterLine = 0;
        let inHunk = false;
        for (const line of patch.split("\n")) {
            const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
            if (hunk) {
                if (inHunk) { before.push(""); after.push(""); }
                if (!beforeLine && !afterLine) { beforeLine = Number(hunk[1]); afterLine = Number(hunk[2]); }
                inHunk = true;
            } else if (inHunk) {
                if (line.startsWith(" ")) { before.push(line.slice(1)); after.push(line.slice(1)); }
                else if (line.startsWith("-")) before.push(line.slice(1));
                else if (line.startsWith("+")) after.push(line.slice(1));
                else if (line && !line.startsWith("\\")) inHunk = false;
            }
        }
        return { hash: header[1], author: header[2], date: header[3], subject: header[4],
            before: before.join("\n"), after: after.join("\n"), beforeLine, afterLine };
    }).filter((entry) => entry.beforeLine || entry.afterLine);
}
