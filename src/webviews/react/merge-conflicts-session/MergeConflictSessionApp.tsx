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
    const [files, setFiles] = useState<MergeConflictSessionFile[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [simpleConflictsResolved, setSimpleConflictsResolved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setSessionData") {
                const next = event.data.data;
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
                        {file.resolved ? "✓" : "◆"}
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
            <div className="session-header">Conflicts</div>
            <div className="session-subtitle">
                Merging branch <strong>{sourceBranch}</strong> into branch{" "}
                <strong>{targetBranch}</strong>
            </div>

            <div className="session-toolbar">
                <button
                    className="simple-btn"
                    disabled={simpleConflictsResolved || unresolvedFiles.length === 0}
                    onClick={resolveAllSimple}
                >
                    ✣ Resolve All Simple Conflicts
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
                    title="Refresh"
                    onClick={() => getVsCodeApi().postMessage({ type: "refresh" })}
                >
                    ◉
                </button>
            </div>

            <div className="table-wrap">
                {error ? <div className="error">{error}</div> : null}
                <table className="conflict-table">
                    <thead>
                        <tr>
                            <th />
                            <th>Yours ({targetBranch})</th>
                            <th>Theirs ({sourceBranch})</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="group-row unresolved-group">
                            <td colSpan={3}>
                                ⌄ ✕ Unresolved {unresolvedFiles.length} file
                                {unresolvedFiles.length === 1 ? "" : "s"}
                            </td>
                        </tr>
                        {unresolvedFiles.map(renderRow)}
                        {resolvedFiles.length > 0 ? (
                            <tr className="group-row resolved-group">
                                <td colSpan={3}>
                                    ⌄ ✓ Resolved {resolvedFiles.length} file
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
