import fs from "fs/promises";
import * as path from "path";

const DAY_MS = 24 * 60 * 60 * 1000;

interface SessionFiles {
    directory: string;
    bytes: number;
    modifiedAt: number;
    fingerprint: string;
    safeToDelete: boolean;
}

export interface CopilotLogCleanupOptions {
    now?: number;
    retentionDays?: number;
    maxTotalBytes?: number;
    clearOld?: boolean;
}

export interface CopilotLogCleanupResult {
    deletedSessions: number;
    freedBytes: number;
    remainingBytes: number;
    protectedBytes: number;
}

/** Includes sidecar files, but never follows symbolic links. */
async function inspectSession(directory: string): Promise<SessionFiles | undefined> {
    try {
        const main = await fs.lstat(path.join(directory, "main.jsonl"));
        if (!main.isFile() || main.isSymbolicLink()) return undefined;
        let bytes = 0;
        let modifiedAt = 0;
        let safeToDelete = true;
        const fingerprints: string[] = [];
        const visit = async (entryPath: string): Promise<void> => {
            const stat = await fs.lstat(entryPath);
            modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
            fingerprints.push(`${entryPath}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
            if (stat.isSymbolicLink()) {
                safeToDelete = false;
            } else if (stat.isDirectory()) {
                const names = await fs.readdir(entryPath);
                for (const name of names.sort()) await visit(path.join(entryPath, name));
            } else if (stat.isFile()) {
                bytes += stat.size;
            } else {
                safeToDelete = false;
            }
        };
        await visit(directory);
        return { directory, bytes, modifiedAt, fingerprint: fingerprints.join("\n"), safeToDelete };
    } catch {
        // Missing or unreadable sessions are never candidates for deletion.
        return undefined;
    }
}

/**
 * Removes historical debug-log session directories only. Recently written logs
 * and the newest session in each root are protected, so the size is a target,
 * not a hard cap on active logs.
 */
export async function cleanupCopilotLogs(
    roots: readonly string[],
    options: CopilotLogCleanupOptions = {},
): Promise<CopilotLogCleanupResult> {
    const now = typeof options.now === "number" && Number.isFinite(options.now) ? options.now : Date.now();
    const retentionDays = typeof options.retentionDays === "number" && Number.isFinite(options.retentionDays)
        ? Math.max(1, options.retentionDays) : 7;
    const maxTotalBytes = typeof options.maxTotalBytes === "number" && Number.isFinite(options.maxTotalBytes)
        ? Math.max(0, options.maxTotalBytes) : 100 * 1024 * 1024;
    const result: CopilotLogCleanupResult = {
        deletedSessions: 0, freedBytes: 0, remainingBytes: 0, protectedBytes: 0,
    };
    const candidates: SessionFiles[] = [];
    const seenRoots = new Set<string>();
    const seenRootIds = new Set<string>();

    for (const root of roots) {
        try {
            const rootStat = await fs.lstat(root);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) continue;
            const canonicalRoot = await fs.realpath(root);
            const rootId = rootStat.ino ? `${rootStat.dev}:${rootStat.ino}` : undefined;
            if (seenRoots.has(canonicalRoot) || (rootId && seenRootIds.has(rootId))) continue;
            seenRoots.add(canonicalRoot);
            if (rootId) seenRootIds.add(rootId);
            const sessions: SessionFiles[] = [];
            for (const entry of await fs.readdir(root, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                const session = await inspectSession(path.join(root, entry.name));
                if (session) sessions.push(session);
            }
            sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);
            for (const [index, session] of sessions.entries()) {
                result.remainingBytes += session.bytes;
                if (index === 0 || !session.safeToDelete || session.modifiedAt >= now - DAY_MS) {
                    result.protectedBytes += session.bytes;
                } else {
                    candidates.push(session);
                }
            }
        } catch {
            // A missing or inaccessible Copilot storage root is normal.
        }
    }

    candidates.sort((a, b) => a.modifiedAt - b.modifiedAt);
    for (const session of candidates) {
        const expired = session.modifiedAt < now - retentionDays * DAY_MS;
        if (!options.clearOld && !expired && result.remainingBytes <= maxTotalBytes) continue;
        // Re-scan just before deletion: an old session may have resumed since
        // discovery, or a sidecar file may have been added by another window.
        const current = await inspectSession(session.directory);
        if (!current || !current.safeToDelete || current.fingerprint !== session.fingerprint) {
            if (current) {
                result.remainingBytes += current.bytes - session.bytes;
                result.protectedBytes += current.bytes;
            }
            continue;
        }
        try {
            await fs.rm(session.directory, { recursive: true });
            result.deletedSessions += 1;
            result.freedBytes += session.bytes;
            result.remainingBytes -= session.bytes;
        } catch {
            // Keep other history eligible if one session cannot be removed.
        }
    }
    return result;
}
