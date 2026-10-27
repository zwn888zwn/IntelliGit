import * as fs from "fs/promises";

export interface CopilotRequestMetrics {
    startedAt: number;
    durationMs: number;
    ttftMs?: number;
    outputTokens?: number;
    model: string;
}

export interface CopilotLogSnapshot {
    request: CopilotRequestMetrics;
    turn?: {
        requestCount: number;
        outputTokens: number;
        durationMs: number;
    };
}

interface TurnMetrics {
    startedAt: number;
    requestCount: number;
    outputTokens: number;
    durationMs: number;
    hasAllOutputTokens: boolean;
}

interface LogState {
    device: number;
    inode: number;
    offset: number;
    size: number;
    mtimeMs: number;
    hasCompletedTurn?: boolean;
    turn?: TurnMetrics;
    latest?: { request: CopilotRequestMetrics; turn?: TurnMetrics };
}

function nonNegativeNumber(value: unknown): number | undefined {
    if (typeof value !== "number" && (typeof value !== "string" || value.trim() === "")) {
        return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function completedAt(request: CopilotRequestMetrics): number {
    return request.startedAt + request.durationMs;
}

function consumeLine(state: LogState, line: string): void {
    let event: Record<string, unknown>;
    try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
        event = parsed as Record<string, unknown>;
    } catch {
        return;
    }
    const startedAt = nonNegativeNumber(event.ts);
    if (startedAt === undefined) return;

    if (event.type === "turn_end") {
        state.hasCompletedTurn = true;
        return;
    }

    if (event.type === "user_message") {
        state.turn = {
            startedAt,
            requestCount: 0,
            outputTokens: 0,
            durationMs: 0,
            hasAllOutputTokens: true,
        };
        return;
    }
    if (event.type !== "llm_request" || event.status === "error") return;
    const durationMs = nonNegativeNumber(event.dur);
    if (durationMs === undefined || durationMs <= 0 || !Number.isFinite(startedAt + durationMs)) return;
    const attrs = event.attrs && typeof event.attrs === "object"
        ? event.attrs as Record<string, unknown>
        : {};
    const request: CopilotRequestMetrics = {
        startedAt,
        durationMs,
        ttftMs: nonNegativeNumber(attrs.ttft),
        outputTokens: nonNegativeNumber(attrs.outputTokens),
        model: typeof attrs.model === "string" ? attrs.model : "",
    };
    // user_message marks a user turn; turn_start/turn_end are tool iterations.
    const turn = state.turn && startedAt >= state.turn.startedAt ? state.turn : undefined;
    if (turn) {
        turn.requestCount += 1;
        turn.durationMs += durationMs;
        if (request.outputTokens === undefined) turn.hasAllOutputTokens = false;
        else turn.outputTokens += request.outputTokens;
    }
    if (!state.latest || completedAt(request) >= completedAt(state.latest.request)) {
        state.latest = { request, turn };
    }
}

/** Reads appended complete JSONL lines and retains metrics, never prompt contents. */
export class CopilotLogReader {
    private readonly files = new Map<string, LogState>();

    get hasCompletedTurnsWithoutMetrics(): boolean {
        return [...this.files.values()].some((state) => state.hasCompletedTurn && !state.latest);
    }

    async readLatest(files: readonly string[]): Promise<CopilotLogSnapshot | undefined> {
        const paths = new Set(files);
        for (const file of this.files.keys()) {
            if (!paths.has(file)) this.files.delete(file);
        }
        let latest: LogState["latest"];
        for (const file of paths) {
            await this.readFile(file);
            const candidate = this.files.get(file)?.latest;
            if (candidate && (!latest || completedAt(candidate.request) >= completedAt(latest.request))) {
                latest = candidate;
            }
        }
        if (!latest) return undefined;
        const { turn } = latest;
        return {
            request: { ...latest.request },
            turn: turn?.hasAllOutputTokens ? {
                requestCount: turn.requestCount,
                outputTokens: turn.outputTokens,
                durationMs: turn.durationMs,
            } : undefined,
        };
    }

    private async readFile(file: string): Promise<void> {
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(file, "r");
            const stat = await handle.stat();
            let state = this.files.get(file);
            if (!state || state.device !== stat.dev || state.inode !== stat.ino
                || stat.size < state.size
                || (stat.size === state.offset && state.mtimeMs !== stat.mtimeMs)) {
                state = { device: stat.dev, inode: stat.ino, offset: 0, size: stat.size, mtimeMs: stat.mtimeMs };
                this.files.set(file, state);
            }
            state.mtimeMs = stat.mtimeMs;
            state.size = stat.size;
            // Keep incomplete trailing lines on disk until a later append completes them.
            const buffer = Buffer.alloc(64 * 1024);
            let position = state.offset;
            let parts: Buffer[] = [];
            while (position < stat.size) {
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
                if (bytesRead === 0) break;
                let start = 0;
                for (let end = buffer.indexOf(10); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
                    const part = buffer.subarray(start, end);
                    const line = parts.length > 0
                        ? Buffer.concat([...parts, part]).toString("utf8")
                        : part.toString("utf8");
                    consumeLine(state, line);
                    parts = [];
                    start = end + 1;
                    state.offset = position + start;
                }
                if (start < bytesRead) parts.push(Buffer.from(buffer.subarray(start, bytesRead)));
                position += bytesRead;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") this.files.delete(file);
        } finally {
            await handle?.close();
        }
    }
}
