// Entry point for the 3-way merge editor webview. Renders three columns:
// Ours (left), Result (middle), Theirs (right) with per-hunk controls.

import React, { useCallback, useEffect, useMemo, useReducer } from "react";
import { createRoot } from "react-dom/client";
import type {
    MergeEditorData,
    MergeSegment,
    CommonSegment,
    ConflictSegment,
    HunkResolution,
    InboundMessage,
    OutboundMessage,
} from "./types";
import { getVsCodeApi as getSharedVsCodeApi } from "../shared/vscodeApi";
import { PYCHARM_THEME } from "../shared/theme";

// --- VS Code API ---

function getVsCodeApi() {
    return getSharedVsCodeApi<OutboundMessage, unknown>();
}

// --- State ---

interface State {
    data: MergeEditorData | null;
    error: string | null;
    resolutions: Record<number, HunkResolution>;
}

type Action =
    | { type: "SET_DATA"; data: MergeEditorData }
    | { type: "SET_ERROR"; message: string }
    | { type: "RESOLVE_HUNK"; id: number; resolution: HunkResolution };

function reducer(state: State, action: Action): State {
    switch (action.type) {
        case "SET_DATA":
            return { ...state, data: action.data, error: null, resolutions: {} };
        case "SET_ERROR":
            return { ...state, error: action.message };
        case "RESOLVE_HUNK":
            return {
                ...state,
                resolutions: { ...state.resolutions, [action.id]: action.resolution },
            };
    }
}

// --- Helpers ---

function getResultLines(
    segment: ConflictSegment,
    resolution: HunkResolution | undefined,
): string[] {
    switch (resolution) {
        case "ours":
            return segment.oursLines;
        case "theirs":
            return segment.theirsLines;
        case "both":
            return [...segment.oursLines, ...segment.theirsLines];
        case "none":
            return [];
        default:
            // Non-conflicting changes auto-resolve to the changed side
            if (segment.changeKind === "ours-only") return segment.oursLines;
            if (segment.changeKind === "theirs-only") return segment.theirsLines;
            return segment.baseLines;
    }
}

function buildResultContent(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): string {
    const lines: string[] = [];
    for (const seg of segments) {
        if (seg.type === "common") {
            lines.push(...seg.lines);
        } else {
            lines.push(...getResultLines(seg, resolutions[seg.id]));
        }
    }
    return lines.join("\n");
}

function allResolved(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): boolean {
    return segments.every(
        (seg) =>
            seg.type === "common" ||
            seg.changeKind !== "conflict" ||
            resolutions[seg.id] !== undefined,
    );
}

function trueConflictCount(segments: MergeSegment[]): number {
    return segments.filter((seg) => seg.type === "conflict" && seg.changeKind === "conflict")
        .length;
}

function resolvedTrueConflictCount(
    segments: MergeSegment[],
    resolutions: Record<number, HunkResolution>,
): number {
    return segments.filter(
        (seg) =>
            seg.type === "conflict" &&
            seg.changeKind === "conflict" &&
            resolutions[seg.id] !== undefined,
    ).length;
}

function padLines(lines: string[], count: number): string[] {
    const padded = [...lines];
    while (padded.length < count) padded.push("");
    return padded;
}

// --- Components ---

function LineNumbers({ count, startLine }: { count: number; startLine: number }) {
    return (
        <div className="line-numbers">
            {Array.from({ length: count }, (_, i) => (
                <div key={i} className="line-number">
                    {startLine + i}
                </div>
            ))}
        </div>
    );
}

function IconArrowRight(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M5 3l5 5-5 5-.7-.7L8.6 8 4.3 3.7z" />
        </svg>
    );
}

function IconArrowLeft(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M11 3l.7.7L7.4 8l4.3 4.3-.7.7-5-5z" />
        </svg>
    );
}

function IconClose(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M4.7 4L8 7.3 11.3 4l.7.7L8.7 8l3.3 3.3-.7.7L8 8.7 4.7 12l-.7-.7L7.3 8 4 4.7z"
            />
        </svg>
    );
}

function IconSpark(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 1l1.6 3.4L13 6l-3.4 1.6L8 11 6.4 7.6 3 6l3.4-1.6zM3 10l.8 1.7L5.5 13l-1.7.8L3 15l-.8-1.2L.5 13l1.7-.8zM12.5 10l.9 1.8L15 12.5l-1.6.7L12.5 15l-.8-1.8-1.7-.7 1.7-.7z"
            />
        </svg>
    );
}

function IconEye(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M8 3c3.4 0 6 3 6.7 4-.7 1-3.3 4-6.7 4S2 8 1.3 7C2 6 4.6 3 8 3zm0 1C5.5 4 3.4 6 2.5 7c.9 1 3 3 5.5 3s4.6-2 5.5-3c-.9-1-3-3-5.5-3zm0 1.5A1.5 1.5 0 1 1 8 8.5 1.5 1.5 0 0 1 8 5.5z"
            />
        </svg>
    );
}

function IconFilter(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path fill="currentColor" d="M2 3h12L9.5 8v4.2l-3 1V8z" />
        </svg>
    );
}

function IconLock(): React.ReactElement {
    return (
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
                fill="currentColor"
                d="M11 6V5a3 3 0 00-6 0v1H4v8h8V6h-1zm-4-1a2 2 0 114 0v1H7V5zm3 8H6V7h4v6z"
            />
        </svg>
    );
}

function HighlightedLine({ line }: { line: string }): React.ReactElement {
    if (!line) return <>{`\u00A0`}</>;
    if (line.trimStart().startsWith("//")) {
        return <span className="tok-comment">{line}</span>;
    }

    const tokenRegex =
        /("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`)|\b(import|from|const|let|var|class|interface|type|function|return|if|else|for|while|switch|case|break|continue|new|export|default|private|public|protected|readonly|static|async|await)\b|\b(true|false|null|undefined)\b|\b\d+(\.\d+)?\b/g;
    const nodes: React.ReactNode[] = [];
    let last = 0;
    let idx = 0;

    for (const match of line.matchAll(tokenRegex)) {
        const start = match.index ?? 0;
        if (start > last) {
            nodes.push(<span key={`txt-${idx++}`}>{line.slice(last, start)}</span>);
        }
        const token = match[0];
        let className: string;
        if (match[1]) className = "tok-string";
        else if (match[5]) className = "tok-keyword";
        else if (match[6]) className = "tok-constant";
        else className = "tok-number";
        nodes.push(
            <span key={`tok-${idx++}`} className={className}>
                {token}
            </span>,
        );
        last = start + token.length;
    }
    if (last < line.length) {
        nodes.push(<span key={`txt-${idx++}`}>{line.slice(last)}</span>);
    }
    return <>{nodes}</>;
}

function CodeBlock({
    lines,
    startLine,
    lineCount,
    className,
}: {
    lines: string[];
    startLine: number;
    lineCount: number;
    className?: string;
}) {
    const padded = padLines(lines, lineCount);

    return (
        <div className={`code-block ${className ?? ""}`}>
            <LineNumbers count={lineCount} startLine={startLine} />
            <div className="code-lines">
                {padded.map((line, i) => (
                    <div key={i} className="code-line">
                        <HighlightedLine line={line} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function CommonSection({
    segment,
    startLine,
    lineCount,
}: {
    segment: CommonSegment;
    startLine: number;
    lineCount: number;
}) {
    return (
        <div className="segment segment-common">
            <div className="column column-left">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
            <div className="column column-middle result-column">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
            <div className="column column-right">
                <CodeBlock lines={segment.lines} startLine={startLine} lineCount={lineCount} />
            </div>
        </div>
    );
}

function ConflictSection({
    segment,
    resolution,
    startLine,
    lineCount,
    onResolve,
}: {
    segment: ConflictSegment;
    resolution: HunkResolution | undefined;
    startLine: number;
    lineCount: number;
    onResolve: (id: number, resolution: HunkResolution) => void;
}) {
    const resultLines = getResultLines(segment, resolution);

    const isOurs = resolution === "ours";
    const isTheirs = resolution === "theirs";

    return (
        <div
            className={`segment segment-conflict change-${segment.changeKind} ${resolution ? "resolved" : "unresolved"}`}
        >
            <div className="hunk-columns">
                <div className={`column column-left conflict-column ${isOurs ? "accepted" : ""}`}>
                    <CodeBlock
                        lines={segment.oursLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className="conflict-ours"
                    />
                    <div className="conflict-actions-left">
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "theirs")}
                            title="Ignore"
                        >
                            <IconClose />
                        </button>
                        <button
                            className={`action-btn accept-btn ${isOurs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, isOurs ? "none" : "ours")}
                            title="Accept"
                        >
                            <IconArrowRight />
                        </button>
                    </div>
                </div>

                <div className="column column-middle conflict-column result-column">
                    <CodeBlock
                        lines={resultLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className={`conflict-result ${resolution ? "resolved" : "unresolved"}`}
                    />
                </div>

                <div
                    className={`column column-right conflict-column ${isTheirs ? "accepted" : ""}`}
                >
                    <div className="conflict-actions-right">
                        <button
                            className={`action-btn accept-btn ${isTheirs ? "active" : ""}`}
                            onClick={() => onResolve(segment.id, isTheirs ? "none" : "theirs")}
                            title="Accept"
                        >
                            <IconArrowLeft />
                        </button>
                        <button
                            className="action-btn discard-btn"
                            onClick={() => onResolve(segment.id, "ours")}
                            title="Ignore"
                        >
                            <IconClose />
                        </button>
                    </div>
                    <CodeBlock
                        lines={segment.theirsLines}
                        startLine={startLine}
                        lineCount={lineCount}
                        className="conflict-theirs"
                    />
                </div>
            </div>
        </div>
    );
}

function App() {
    const [state, dispatch] = useReducer(reducer, { data: null, error: null, resolutions: {} });
    const segments = state.data?.segments ?? [];

    const renderedSegments = useMemo(() => {
        let lineCursor = 1;
        return segments.map((segment, index) => {
            const lineCount =
                segment.type === "common"
                    ? Math.max(segment.lines.length, 1)
                    : Math.max(
                          segment.oursLines.length,
                          getResultLines(segment, state.resolutions[segment.id]).length,
                          segment.theirsLines.length,
                          1,
                      );
            const startLine = lineCursor;
            lineCursor += lineCount;
            return { segment, index, startLine, lineCount };
        });
    }, [segments, state.resolutions]);

    useEffect(() => {
        const vscode = getVsCodeApi();
        const handler = (event: MessageEvent<InboundMessage>) => {
            if (event.data.type === "setConflictData") {
                dispatch({ type: "SET_DATA", data: event.data.data });
            } else if (event.data.type === "loadError") {
                dispatch({ type: "SET_ERROR", message: event.data.message });
            }
        };
        window.addEventListener("message", handler);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", handler);
    }, []);

    const handleResolve = useCallback((id: number, resolution: HunkResolution) => {
        dispatch({ type: "RESOLVE_HUNK", id, resolution });
    }, []);

    const handleApply = useCallback(() => {
        if (!state.data) return;
        const content = buildResultContent(state.data.segments, state.resolutions);
        getVsCodeApi().postMessage({ type: "applyResolution", content });
    }, [state.data, state.resolutions]);

    const handleAcceptAllYours = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            }
        }
    }, [state.data]);

    const handleAcceptAllTheirs = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleApplyNonConflicting = useCallback(() => {
        if (!state.data) return;
        for (const seg of state.data.segments) {
            if (seg.type === "conflict" && seg.changeKind === "ours-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "ours" });
            } else if (seg.type === "conflict" && seg.changeKind === "theirs-only") {
                dispatch({ type: "RESOLVE_HUNK", id: seg.id, resolution: "theirs" });
            }
        }
    }, [state.data]);

    const handleBulkAcceptYours = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptYours" });
    }, []);

    const handleBulkAcceptTheirs = useCallback(() => {
        getVsCodeApi().postMessage({ type: "acceptTheirs" });
    }, []);

    const handleRetry = useCallback(() => {
        dispatch({ type: "SET_ERROR", message: "" });
        getVsCodeApi().postMessage({ type: "ready" });
    }, []);

    const handleClose = useCallback(() => {
        getVsCodeApi().postMessage({ type: "close" });
    }, []);

    if (state.error) {
        return (
            <div className="loading">
                <div className="error-message">Failed to load conflict data: {state.error}</div>
                <button className="retry-btn" onClick={handleRetry}>
                    Retry
                </button>
            </div>
        );
    }

    if (!state.data) {
        return <div className="loading">Loading conflict data...</div>;
    }

    const total = trueConflictCount(segments);
    const resolved = resolvedTrueConflictCount(segments, state.resolutions);
    const unresolved = total - resolved;
    const canApply = allResolved(segments, state.resolutions);
    const changeCount = segments.length;

    return (
        <div className="merge-editor">
            <div className="merge-toolbar">
                <div className="toolbar-left">
                    <button className="toolbar-btn subtle" onClick={handleApplyNonConflicting}>
                        <span className="toolbar-icon">
                            <IconSpark />
                        </span>
                        Apply non-conflicting changes
                    </button>
                    <div className="toolbar-separator" />
                    <button className="toolbar-btn subtle">
                        <span className="toolbar-icon">
                            <IconFilter />
                        </span>
                        Do not ignore
                    </button>
                    <button className="toolbar-btn subtle">
                        <span className="toolbar-icon">
                            <IconEye />
                        </span>
                        Highlight words
                    </button>
                </div>
                <div className="toolbar-right">
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllYours}
                        title="Accept all yours"
                    >
                        <span className="toolbar-icon">
                            <IconArrowRight />
                        </span>
                        Accept All Yours
                    </button>
                    <button
                        className="toolbar-btn"
                        onClick={handleAcceptAllTheirs}
                        title="Accept all theirs"
                    >
                        <span className="toolbar-icon">
                            <IconArrowLeft />
                        </span>
                        Accept All Theirs
                    </button>
                </div>
            </div>

            <div className="merge-header">
                <div className="merge-title">
                    <span className="file-path">{state.data.filePath}</span>
                    <span className="conflict-counter">
                        {resolved}/{total} conflicts resolved
                    </span>
                </div>
                <div className="merge-stats">
                    {changeCount} change{changeCount === 1 ? "" : "s"}, {unresolved} conflict
                    {unresolved === 1 ? "" : "s"}
                </div>
            </div>

            <div className="pane-meta-row">
                <div className="pane-meta">
                    <span className="pane-meta-label">
                        <span className="toolbar-icon" style={{ marginRight: "6px" }}>
                            <IconLock />
                        </span>
                        Changes from {state.data.oursLabel}
                    </span>
                    <span className="show-details">Show Details</span>
                </div>
                <div className="pane-meta pane-meta-center">
                    <span>Result {state.data.filePath}</span>
                </div>
                <div className="pane-meta pane-meta-right">
                    <span className="pane-meta-label">
                        <span className="toolbar-icon" style={{ marginRight: "6px" }}>
                            <IconLock />
                        </span>
                        Changes from {state.data.theirsLabel}
                    </span>
                    <span className="show-details">Show Details</span>
                </div>
            </div>

            <div className="merge-content">
                {renderedSegments.map(({ segment, index, startLine, lineCount }) =>
                    segment.type === "common" ? (
                        <CommonSection
                            key={index}
                            segment={segment}
                            startLine={startLine}
                            lineCount={lineCount}
                        />
                    ) : (
                        <ConflictSection
                            key={index}
                            segment={segment}
                            resolution={state.resolutions[segment.id]}
                            startLine={startLine}
                            lineCount={lineCount}
                            onResolve={handleResolve}
                        />
                    ),
                )}
            </div>

            <div className="merge-footer">
                <div className="footer-left">
                    <button className="footer-btn secondary" onClick={handleBulkAcceptYours}>
                        Accept Left
                    </button>
                    <button className="footer-btn secondary" onClick={handleBulkAcceptTheirs}>
                        Accept Right
                    </button>
                </div>
                <div className="footer-right">
                    <button className="footer-btn secondary" onClick={handleClose}>
                        Cancel
                    </button>
                    <button
                        className={`footer-btn primary ${canApply ? "" : "disabled"}`}
                        onClick={handleApply}
                        disabled={!canApply}
                    >
                        Apply ({resolved}/{total})
                    </button>
                </div>
            </div>
        </div>
    );
}

// --- Styles ---

const STYLES = `
.merge-editor {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
}

.loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100vh;
    color: var(--vscode-descriptionForeground);
}
.error-message {
    color: var(--vscode-errorForeground, #f48771);
    max-width: 500px;
    text-align: center;
}
.retry-btn {
    padding: 4px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
}
.retry-btn:hover {
    background: var(--vscode-button-hoverBackground);
}

.merge-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground));
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.toolbar-left,
.toolbar-right {
    display: flex;
    align-items: center;
    gap: 4px;
}
.toolbar-separator {
    width: 1px;
    height: 14px;
    background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border, #444));
    margin: 0 4px;
}
.toolbar-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 12px;
    height: 12px;
    color: var(--vscode-icon-foreground, currentColor);
}
.toolbar-btn {
    height: 24px;
    padding: 0 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 12px;
    line-height: 24px;
    cursor: pointer;
    opacity: 0.9;
}
.toolbar-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1));
    opacity: 1;
}
.toolbar-btn.subtle {
    /* No difference in PyCharm, all top buttons are subtle */
}
.toolbar-btn.subtle:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1));
}

.merge-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    flex-shrink: 0;
}
.merge-title {
    display: flex;
    align-items: center;
    gap: 12px;
}
.file-path {
    font-weight: 600;
    font-size: 15px;
    color: var(--vscode-foreground);
}
.conflict-counter {
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
}
.merge-stats {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
}

.pane-meta-row {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    background: var(--vscode-editorGroupHeader-tabsBackground);
}
.pane-meta {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.pane-meta-label {
    display: flex;
    align-items: center;
}
.pane-meta-center {
    justify-content: center;
    color: var(--vscode-foreground);
}
.pane-meta-right {
    border-right: none;
}
.show-details {
    color: var(--vscode-textLink-foreground, #4ea1ff);
    cursor: pointer;
}
.show-details:hover {
    text-decoration: underline;
}

.merge-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    line-height: 22px;
    background: var(--vscode-editor-background);
}

.segment {
    display: flex;
}
.column {
    flex: 1;
    min-width: 0;
    /* overflow: hidden; Removed to allow action buttons to float outside */
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}
.column-right {
    border-right: none;
}
.code-block {
    display: grid;
    grid-template-columns: 46px 1fr;
    overflow: hidden; /* Added overflow hidden just to code block instead of column */
}
.line-numbers {
    background: var(--vscode-editorGutter-background, var(--vscode-sideBar-background, transparent));
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    color: var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground));
}
.line-number {
    padding: 0 8px 0 4px;
    text-align: right;
    min-height: 22px;
    line-height: 22px;
    font-size: 11px;
    opacity: 0.92;
}
.code-lines {
    min-width: 0;
}
.code-line {
    padding: 0 10px;
    white-space: pre;
    line-height: 22px;
    min-height: 22px;
    overflow: hidden;
    text-overflow: ellipsis;
}

.segment-common .code-line {
    color: var(--vscode-editor-foreground);
}
.segment-conflict {
    display: block;
    margin: 1px 0 2px;
    border-top: 1px solid var(--vscode-merge-border, var(--vscode-panel-border, transparent));
    border-bottom: 1px solid var(--vscode-merge-border, var(--vscode-panel-border, transparent));
}

.conflict-column {
    position: relative;
}
.hunk-columns {
    display: flex;
}
.conflict-actions-left {
    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    gap: 0;
    z-index: 10;
}
.conflict-actions-right {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    gap: 0;
    z-index: 10;
}
.action-btn {
    width: 20px;
    height: 20px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    color: var(--vscode-foreground);
    opacity: 0.95;
}
.action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.1));
    opacity: 1;
}
.accept-btn.active {
    border-color: var(--vscode-focusBorder, #4ea1ff);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground, #ffffff);
}
.discard-btn:hover {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-errorForeground, #f48771);
}

/* True conflicts — deep red */
.change-conflict .conflict-ours .code-line,
.change-conflict .conflict-theirs .code-line {
    background: ${PYCHARM_THEME.mergeEditor.conflictBlockBg};
    color: var(--vscode-editor-foreground);
}
.change-conflict .conflict-result.unresolved .code-line {
    background: ${PYCHARM_THEME.mergeEditor.conflictResultBg};
    color: var(--vscode-editor-foreground);
}

/* One-side-only changes — muted blue */
.change-ours-only .conflict-ours .code-line {
    background: ${PYCHARM_THEME.mergeEditor.nonConflictBlockBg};
    color: var(--vscode-editor-foreground);
}
.change-ours-only .conflict-theirs .code-line,
.change-theirs-only .conflict-ours .code-line {
    color: var(--vscode-editor-foreground);
}
.change-theirs-only .conflict-theirs .code-line {
    background: ${PYCHARM_THEME.mergeEditor.nonConflictBlockBg};
    color: var(--vscode-editor-foreground);
}
.change-ours-only .conflict-result.unresolved .code-line,
.change-theirs-only .conflict-result.unresolved .code-line {
    background: ${PYCHARM_THEME.mergeEditor.nonConflictResultBg};
    color: var(--vscode-editor-foreground);
}

/* Resolved result — green for all types */
.conflict-result.resolved .code-line {
    background: ${PYCHARM_THEME.mergeEditor.addedResultBg};
    color: var(--vscode-editor-foreground);
}

.result-column {
    border-left: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
}

.change-conflict .column-left.accepted .conflict-ours .code-line {
    background: ${PYCHARM_THEME.mergeEditor.conflictBlockBg};
}
.change-conflict .column-right.accepted .conflict-theirs .code-line {
    background: ${PYCHARM_THEME.mergeEditor.conflictBlockBg};
}
.change-ours-only .column-left.accepted .conflict-ours .code-line {
    background: ${PYCHARM_THEME.mergeEditor.nonConflictBlockBg};
}
.change-theirs-only .column-right.accepted .conflict-theirs .code-line {
    background: ${PYCHARM_THEME.mergeEditor.nonConflictBlockBg};
}

.merge-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 32px;
    padding: 4px 10px;
    background: var(--vscode-editorGroupHeader-tabsBackground);
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    flex-shrink: 0;
}
.footer-left, .footer-right {
    display: flex;
    gap: 6px;
}
.footer-btn {
    min-height: 22px;
    padding: 0 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    line-height: 20px;
}
.footer-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.footer-btn.primary:hover {
    background: var(--vscode-button-hoverBackground);
}
.footer-btn.primary.disabled {
    opacity: 0.55;
    cursor: not-allowed;
}
.footer-btn.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}
.footer-btn.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}

.tok-comment {
    color: var(--vscode-editorLineNumber-foreground, #6e7681);
    font-style: italic;
}
.tok-keyword {
    color: var(--vscode-symbolIcon-keywordForeground, #c586c0);
}
.tok-string {
    color: var(--vscode-symbolIcon-stringForeground, #ce9178);
}
.tok-number {
    color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
}
.tok-constant {
    color: var(--vscode-symbolIcon-constantForeground, #4fc1ff);
}
`;

// --- Mount ---

const style = document.createElement("style");
style.textContent = STYLES;
document.head.appendChild(style);

const container = document.getElementById("root");
if (container) {
    createRoot(container).render(<App />);
}
