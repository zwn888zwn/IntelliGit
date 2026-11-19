import { LuGitMerge, LuGitBranch, LuArrowRight, LuFileCode2, LuCheck, LuRefreshCw, LuWandSparkles, LuChevronDown } from "react-icons/lu";
import "../shared/initTooltips";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import type { InboundMessage, MergeConflictSessionFile, OutboundMessage } from "./types";
import "./merge-conflicts-session.css";

function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

function directoryName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx <= 0) return ".";
    return filePath.slice(0, idx);
}

function fileName(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    if (idx < 0) return filePath;
    return filePath.slice(idx + 1);
}

function App() {
    const [sourceBranch, setSourceBranch] = useState("incoming branch");
    const [targetBranch, setTargetBranch] = useState("current branch");
    const [rebase, setRebase] = useState(false);
    const [replayedCommit, setReplayedCommit] = useState<string>();
    const [files, setFiles] = useState<MergeConflictSessionFile[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [simpleConflictsResolved, setSimpleConflictsResolved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setSessionData") {
                const next = event.data.data;
                setRebase(Boolean(next.rebase));
                setReplayedCommit(next.replayedCommit);
                setSourceBranch(next.sourceBranch);
                setTargetBranch(next.targetBranch);
                setFiles(next.files);
                setSimpleConflictsResolved(next.simpleConflictsResolved);
                setError(null);
                setSelectedPath((prev) => {
                    if (
                        next.selectedPath &&
                        next.files.some(
                            (file) => file.path === next.selectedPath && !file.resolved,
                        )
                    ) {
                        return next.selectedPath;
                    }
                    return prev && next.files.some((file) => file.path === prev && !file.resolved)
                        ? prev
                        : (next.files.find((file) => !file.resolved)?.path ?? null);
                });
                return;
            }
            if (event.data.type === "loadError") {
                setError(event.data.message);
            }
        };

        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    const unresolvedFiles = useMemo(() => files.filter((file) => !file.resolved), [files]);
    const resolvedFiles = useMemo(() => files.filter((file) => file.resolved), [files]);
    const selectedFile = useMemo(
        () => unresolvedFiles.find((file) => file.path === selectedPath) ?? null,
        [unresolvedFiles, selectedPath],
    );
    const conflictSummary = useMemo(
        () =>
            files.reduce(
                (summary, file) => {
                    const total = file.totalConflictCount ?? 0;
                    const resolved = file.resolved ? total : (file.resolvedConflictCount ?? 0);
                    summary.resolved += resolved;
                    summary.unresolved += Math.max(0, total - resolved);
                    return summary;
                },
                { resolved: 0, unresolved: 0 },
            ),
        [files],
    );

    const openMerge = useCallback((filePath: string) => {
        getVsCodeApi().postMessage({ type: "openMerge", filePath });
    }, []);

    const resolveAllSimple = useCallback(() => {
        getVsCodeApi().postMessage({ type: "resolveAllSimple" });
    }, []);

    const close = useCallback(() => {
        getVsCodeApi().postMessage({ type: "close" });
    }, []);

    const acceptAndFinish = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptAndFinish" });
    }, []);

    const upstreamLabel = sourceBranch === "incoming branch" ? "Upstream" : `Upstream (${sourceBranch})`;
    const localLabel = replayedCommit ? `Local commit (${replayedCommit})` : "Local commit";

    const renderRow = (file: MergeConflictSessionFile) => {
        const selected = selectedPath === file.path;
        const showCount = simpleConflictsResolved && file.totalConflictCount !== undefined;
        return (
            <tr
                key={file.path}
                className={`row ${file.resolved ? "resolved-file" : "unresolved-file"}${selected ? " selected" : ""}`}
                tabIndex={0}
                aria-selected={selected}
                onClick={() => !file.resolved && setSelectedPath(file.path)}
                onDoubleClick={() => !file.resolved && openMerge(file.path)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (!file.resolved) setSelectedPath(file.path);
                    }
                    if (event.key === "Enter" && !file.resolved) {
                        openMerge(file.path);
                    }
                }}
            >
                <td className="name-cell" title={file.path}>
                    <span className="file-icon" aria-hidden="true">
                        {file.resolved ? <LuCheck size={15} /> : <LuFileCode2 size={15} />}
                    </span>
                    <span className="file-name">{fileName(file.path)}</span>
                    {showCount ? (
                        <span className={file.resolved ? "count resolved" : "count"}>
                            {file.resolvedConflictCount}/{file.totalConflictCount}
                        </span>
                    ) : null}
                    <span className="file-path">{directoryName(file.path)}</span>
                </td>
                <td>{file.ours}</td>
                <td>{file.theirs}</td>
            </tr>
        );
    };

    return (
        <div className="session-root">
            <div className="session-header"><LuGitMerge size={20} aria-hidden="true" />{rebase ? "Rebase conflicts" : "Merge conflicts"}</div>
            {!rebase && <div className="session-subtitle">
                <span title={sourceBranch}><LuGitBranch size={14} aria-hidden="true" />{sourceBranch}</span>
                <LuArrowRight size={16} aria-label="into" />
                <span title={targetBranch}><LuGitBranch size={14} aria-hidden="true" />{targetBranch}</span>
            </div>}

            <div className="session-toolbar">
                <button
                    className="simple-btn"
                    disabled={simpleConflictsResolved || unresolvedFiles.length === 0}
                    onClick={resolveAllSimple}
                >
                    <LuWandSparkles size={15} aria-hidden="true" />Resolve All Simple Conflicts
                </button>
                {simpleConflictsResolved ? (
                    <div className="resolution-summary">
                        {conflictSummary.resolved} conflicts resolved. {conflictSummary.unresolved}{" "}
                        conflict{conflictSummary.unresolved === 1 ? "" : "s"} in{" "}
                        {unresolvedFiles.length} file
                        {unresolvedFiles.length === 1 ? "" : "s"} still require attention
                    </div>
                ) : null}
                <button
                    className="view-btn"
                    aria-label="Refresh"
                    title="Refresh"
                    onClick={() => getVsCodeApi().postMessage({ type: "refresh" })}
                >
                    <LuRefreshCw size={16} aria-hidden="true" />
                </button>
            </div>

            <div className="table-wrap">
                {error ? <div className="error">{error}</div> : null}
                <table className="conflict-table">
                    <thead>
                        <tr>
                            <th>File</th>
                            <th>{rebase ? upstreamLabel : `Yours (${targetBranch})`}</th>
                            <th>{rebase ? localLabel : `Theirs (${sourceBranch})`}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="group-row unresolved-group">
                            <td colSpan={3}>
                                <LuChevronDown size={13} aria-hidden="true" /> Unresolved {unresolvedFiles.length} file
                                {unresolvedFiles.length === 1 ? "" : "s"}
                            </td>
                        </tr>
                        {unresolvedFiles.map(renderRow)}
                        {resolvedFiles.length > 0 ? (
                            <tr className="group-row resolved-group">
                                <td colSpan={3}>
                                    <LuCheck size={13} aria-hidden="true" /> Resolved {resolvedFiles.length} file
                                    {resolvedFiles.length === 1 ? "" : "s"}
                                </td>
                            </tr>
                        ) : null}
                        {resolvedFiles.map(renderRow)}
                    </tbody>
                </table>
            </div>

            <div className="session-footer">
                <span />
                <div className="footer-actions">
                    {rebase && selectedFile && !selectedFile.resolved && <>
                        <button className="action-btn" onClick={() => getVsCodeApi().postMessage({ type: "keepUpstream", filePath: selectedFile.path, replayedCommit })}>Keep upstream version</button>
                        <button className="action-btn" onClick={() => getVsCodeApi().postMessage({ type: "keepLocalCommit", filePath: selectedFile.path, replayedCommit })}>Keep local commit version</button>
                    </>}
                    <button className="close-btn" onClick={close}>
                        Close
                    </button>
                    <button
                        className="action-btn"
                        disabled={unresolvedFiles.length > 0}
                        onClick={acceptAndFinish}
                    >
                        Accept and Finish
                    </button>
                    <button
                        className="action-btn primary"
                        disabled={!selectedFile}
                        onClick={() => selectedFile && openMerge(selectedFile.path)}
                    >
                        Resolve Manually
                    </button>
                </div>
            </div>
        </div>
    );
}

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
