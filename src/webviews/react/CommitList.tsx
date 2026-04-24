// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LuPanelLeftClose, LuPanelLeftOpen, LuSearch, LuX } from "react-icons/lu";
import type { Commit, RepositoryContextInfo } from "../../types";
import { computeGraph, LANE_WIDTH, ROW_HEIGHT } from "./graph";
import { ContextMenu } from "./shared/components/ContextMenu";
import { getCommitMenuItems } from "./commit-list/commitMenu";
import { CommitRow } from "./commit-list/CommitRow";
import { useCommitGraphCanvas } from "./commit-list/useCommitGraphCanvas";
import { isCommitAction, type CommitAction } from "./commitGraphTypes";
import {
    AUTHOR_COL_WIDTH,
    BRANCH_SCOPE_STYLE,
    CANVAS_STYLE,
    contentContainerStyle,
    DATE_COL_WIDTH,
    FILTER_BAR_STYLE,
    FILTER_CLEAR_BUTTON_STYLE,
    FILTER_ICON_STYLE,
    FILTER_INPUT_STYLE,
    FILTER_INPUT_WRAP_STYLE,
    headerRowStyle,
    LOADING_MORE_STYLE,
    ROOT_STYLE,
    SCROLL_VIEWPORT_STYLE,
} from "./commit-list/styles";

const MIN_PREFIX_LENGTH = 7;
const MAX_GRAPH_WIDTH = 240;
const PRELOAD_ROWS = 80;

interface Props {
    commits: Commit[];
    repositories: RepositoryContextInfo[];
    repository: RepositoryContextInfo | null;
    selectedHash: string | null;
    currentHash: string | null;
    revealHash: string | null;
    filterText: string;
    hasMore: boolean;
    unpushedHashes: Set<string>;
    selectedBranch: string | null;
    repoRailExpanded: boolean;
    onToggleRepoRail: () => void;
    onSelectCommit: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void | Promise<void>;
    onCommitAction: (action: CommitAction, hash: string) => void;
}

export function CommitList({
    commits,
    repositories,
    repository,
    selectedHash,
    currentHash,
    revealHash,
    filterText,
    hasMore,
    unpushedHashes,
    selectedBranch,
    repoRailExpanded,
    onToggleRepoRail,
    onSelectCommit,
    onFilterText,
    onLoadMore,
    onCommitAction,
}: Props): React.ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: Commit } | null>(
        null,
    );
    const [jumpTooltip, setJumpTooltip] = useState<{
        targetHash: string;
        left: number;
        top: number;
    } | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [loadMoreDebug, setLoadMoreDebug] = useState({ count: 0, lastVisibleEnd: 0 });

    const graph = useMemo(() => computeGraph(commits), [commits]);
    const graphRows = graph.rows;
    const graphWidth = Math.min(graph.recommendedWidth, MAX_GRAPH_WIDTH);
    const graphScale = graphWidth / Math.max(graph.recommendedWidth, 1);
    const repoRailWidth = repoRailExpanded ? 168 : 16;
    const headerGraphWidth = repoRailWidth + Math.min(graphWidth, 44);
    const repositoryLookup = useMemo(
        () => new Map(repositories.map((item) => [item.root, item])),
        [repositories],
    );
    const commitByHash = useMemo(
        () => new Map(commits.map((commit) => [commit.hash, commit])),
        [commits],
    );
    const jumpTargetCommit = jumpTooltip ? commitByHash.get(jumpTooltip.targetHash) ?? null : null;
    const visibleArrowMarkers = graph.arrowMarkers;

    const handleJumpNavigate = useCallback(
        (targetHash: string, targetRowIndex: number) => {
            const viewport = viewportRef.current;
            if (!viewport) return;
            onSelectCommit(targetHash);
            const centeredTop = Math.max(
                0,
                targetRowIndex * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2,
            );
            viewport.scrollTop = centeredTop;
            setScrollTop(centeredTop);
            setJumpTooltip(null);
        },
        [onSelectCommit],
    );

    useCommitGraphCanvas({
        canvasRef,
        viewportRef,
        rows: graphRows,
        currentHash,
        graphWidth,
        graphScale,
        graphOffset: repoRailWidth,
    });

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;

        const updateHeight = () => setViewportHeight(viewport.clientHeight);
        updateHeight();

        const observer = new ResizeObserver(updateHeight);
        observer.observe(viewport);

        return () => {
            observer.disconnect();
        };
    }, []);

    const unpushedLookup = useMemo(() => {
        const exact = new Set(unpushedHashes);
        const prefixes = new Set<string>();
        // Build prefix lookup so truncated hashes match full hashes (and vice versa).
        for (const hash of unpushedHashes) {
            const start = Math.min(MIN_PREFIX_LENGTH, hash.length);
            for (let i = start; i <= hash.length; i++) {
                prefixes.add(hash.slice(0, i));
            }
        }
        return { exact, prefixes };
    }, [unpushedHashes]);

    const isUnpushedCommit = useCallback(
        (hash: string): boolean => {
            if (unpushedLookup.prefixes.has(hash)) return true;
            const start = Math.min(MIN_PREFIX_LENGTH, hash.length);
            for (let i = start; i <= hash.length; i++) {
                if (unpushedLookup.exact.has(hash.slice(0, i))) return true;
            }
            return false;
        },
        [unpushedLookup],
    );

    const handleRowContextMenu = useCallback((event: React.MouseEvent, commit: Commit) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, commit });
    }, []);

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            if (!isCommitAction(action)) return;
            onCommitAction(action, contextMenu.commit.hash);
        },
        [contextMenu, onCommitAction],
    );

    const maybeLoadMore = useCallback(
        (visibleEnd: number) => {
            if (!hasMore) return;
            if (visibleEnd < Math.max(0, commits.length - PRELOAD_ROWS)) return;
            setLoadMoreDebug((current) => ({
                count: current.count + 1,
                lastVisibleEnd: visibleEnd,
            }));
            void onLoadMore();
        },
        [commits.length, hasMore, onLoadMore],
    );

    const handleScroll = useCallback(
        (event: React.UIEvent<HTMLDivElement>) => {
            const viewport = event.currentTarget;
            const nextScrollTop = viewport.scrollTop;
            setScrollTop(nextScrollTop);
            setJumpTooltip(null);

            if (viewport.clientHeight <= 0) return;
            const overscan = 8;
            const nextVisibleEnd = Math.min(
                commits.length,
                Math.ceil((nextScrollTop + viewport.clientHeight) / ROW_HEIGHT) + overscan,
            );
            maybeLoadMore(nextVisibleEnd);
        },
        [commits.length, maybeLoadMore],
    );

    const visibleRange = useMemo(() => {
        if (commits.length === 0) {
            return { start: 0, end: 0 };
        }
        if (viewportHeight <= 0) {
            return { start: 0, end: Math.min(commits.length, 40) };
        }
        const overscan = 8;
        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
        const end = Math.min(
            commits.length,
            Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan,
        );
        if (end <= start) {
            return {
                start: Math.max(0, Math.min(commits.length - 1, start)),
                end: Math.min(commits.length, Math.max(1, start + 1)),
            };
        }
        return { start, end };
    }, [commits.length, scrollTop, viewportHeight]);

    const visibleCommits = useMemo(
        () => commits.slice(visibleRange.start, visibleRange.end),
        [commits, visibleRange.end, visibleRange.start],
    );

    useEffect(() => {
        maybeLoadMore(visibleRange.end);
    }, [maybeLoadMore, visibleRange.end]);

    useEffect(() => {
        if (!revealHash) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        const index = commits.findIndex((commit) => commit.hash === revealHash);
        if (index < 0) return;

        const centeredTop = Math.max(0, index * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2);
        viewport.scrollTop = centeredTop;
        setScrollTop(centeredTop);
    }, [commits, revealHash]);

    return (
        <div style={ROOT_STYLE}>
            <div style={FILTER_BAR_STYLE}>
                <LuSearch size={16} style={FILTER_ICON_STYLE} />
                <div style={FILTER_INPUT_WRAP_STYLE}>
                    <input
                        type="text"
                        placeholder="Text or hash"
                        value={filterText}
                        onChange={(event) => onFilterText(event.target.value)}
                        style={FILTER_INPUT_STYLE}
                    />
                    {filterText.length > 0 && (
                        <button
                            type="button"
                            aria-label="Clear commit search"
                            title="Clear"
                            onClick={() => onFilterText("")}
                            style={FILTER_CLEAR_BUTTON_STYLE}
                        >
                            <LuX size={12} />
                        </button>
                    )}
                </div>
                <span
                    style={BRANCH_SCOPE_STYLE}
                    title={
                        repository
                            ? `Repository: ${repository.relativePath ?? repository.root}`
                            : "No repository selected"
                    }
                >
                    Repo: {repository?.relativePath ?? repository?.name ?? "No repository"}
                </span>
                <span
                    style={BRANCH_SCOPE_STYLE}
                    title={selectedBranch ? `Branch: ${selectedBranch}` : "Branch: All branches"}
                >
                    Branch: {selectedBranch ?? "All branches"}
                </span>
                <span
                    style={{
                        ...BRANCH_SCOPE_STYLE,
                        maxWidth: "none",
                        marginLeft: "auto",
                        opacity: 0.6,
                        fontFamily: "var(--vscode-editor-font-family, monospace)",
                    }}
                    title={`commits=${commits.length}, visible=${visibleCommits.length}, height=${viewportHeight}, top=${scrollTop}, start=${visibleRange.start}, end=${visibleRange.end}, hasMore=${hasMore}, loadMoreCount=${loadMoreDebug.count}, lastVisibleEnd=${loadMoreDebug.lastVisibleEnd}`}
                >
                    dbg {commits.length}/{visibleCommits.length} h{viewportHeight} y{scrollTop} m
                    {hasMore ? 1 : 0} l{loadMoreDebug.count}@{loadMoreDebug.lastVisibleEnd}
                </span>
            </div>

            <div style={headerRowStyle(headerGraphWidth)}>
                <span style={{ flex: 1 }}>Commit</span>
                <span style={{ width: AUTHOR_COL_WIDTH, textAlign: "right" }}>Author</span>
                <span style={{ width: DATE_COL_WIDTH, textAlign: "right", marginLeft: 4 }}>
                    Date
                </span>
            </div>

            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
                <div
                    ref={viewportRef}
                    data-testid="commit-list-viewport"
                    style={SCROLL_VIEWPORT_STYLE}
                    onScroll={handleScroll}
                >
                    <div style={contentContainerStyle(commits.length + (hasMore ? 1 : 0))}>
                        <canvas ref={canvasRef} style={CANVAS_STYLE} />

                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                top: 0,
                                transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)`,
                                width: repoRailWidth,
                                zIndex: 3,
                            }}
                        >
                            {visibleCommits.map((commit, offset) => {
                                const repo = repositoryLookup.get(commit.repoRoot);
                                const top = offset * ROW_HEIGHT;
                                return (
                                    <button
                                        key={`repo-rail:${commit.repoRoot}:${commit.hash}:${top}`}
                                        type="button"
                                        title={repo?.root ?? commit.repoRoot}
                                        onClick={onToggleRepoRail}
                                        style={{
                                            position: "absolute",
                                            left: 0,
                                            top,
                                            width: repoRailWidth,
                                            height: ROW_HEIGHT,
                                            border: "none",
                                            borderRight: "1px solid rgba(255,255,255,0.08)",
                                            background: repo?.color ?? "#666",
                                            color: "rgba(255,255,255,0.92)",
                                            padding: repoRailExpanded ? "0 8px" : 0,
                                            textAlign: "left",
                                            overflow: "hidden",
                                            cursor: "pointer",
                                            opacity: selectedHash === commit.hash ? 1 : 0.72,
                                        }}
                                    >
                                        {repoRailExpanded && (
                                            <span
                                                style={{
                                                    display: "block",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                    fontSize: "11px",
                                                    fontWeight: 700,
                                                }}
                                            >
                                                {repo?.name ?? commit.repoId}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>

                        {!repository && commits.length === 0 && (
                            <div
                                style={{
                                    ...LOADING_MORE_STYLE,
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: 0,
                                }}
                            >
                                No git repository found in this workspace.
                            </div>
                        )}

                        <div
                            style={{
                                position: "absolute",
                                left: 0,
                                right: 0,
                                top: 0,
                                transform: `translateY(${visibleRange.start * ROW_HEIGHT}px)`,
                                zIndex: 2,
                            }}
                        >
                            {visibleCommits.map((commit, offset) => {
                                const idx = visibleRange.start + offset;
                                return (
                                    <CommitRow
                                        key={`${commit.repoRoot}:${commit.hash}:${idx}`}
                                        commit={commit}
                                        rowLeftOffset={repoRailWidth}
                                        messageIndent={(graphRows[idx]?.occupiedWidth ?? 40) * graphScale}
                                        isSelected={selectedHash === commit.hash}
                                        isUnpushed={isUnpushedCommit(commit.hash)}
                                        laneColor={graphRows[idx]?.nodeColor}
                                        onSelect={onSelectCommit}
                                        onContextMenu={handleRowContextMenu}
                                    />
                                );
                            })}
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                left: repoRailWidth,
                                top: 0,
                                width: graphWidth,
                                height: commits.length * ROW_HEIGHT,
                                zIndex: 5,
                                pointerEvents: "none",
                            }}
                        >
                            {visibleArrowMarkers
                                .filter(
                                    (arrow) =>
                                        arrow.rowIndex >= visibleRange.start &&
                                        arrow.rowIndex < visibleRange.end,
                                )
                                .map((arrow) => {
                                    const targetCommit = commitByHash.get(arrow.targetHash);
                                    if (!targetCommit) return null;
                                    const buttonSize = 18;
                                    const left =
                                        (arrow.position * LANE_WIDTH + LANE_WIDTH / 2) * graphScale -
                                        buttonSize / 2;
                                    const top =
                                        arrow.rowIndex * ROW_HEIGHT +
                                        ROW_HEIGHT * (arrow.direction === "down" ? 0.66 : 0.34) -
                                        buttonSize / 2;
                                    return (
                                        <button
                                            key={`arrow:${arrow.direction}:${arrow.rowIndex}:${arrow.edgeId}`}
                                            type="button"
                                            title={`Jump to '${targetCommit.shortHash} ${targetCommit.message}'`}
                                            onMouseEnter={() =>
                                                setJumpTooltip({
                                                    targetHash: arrow.targetHash,
                                                    left: repoRailWidth + left + buttonSize + 6,
                                                    top: top - 4,
                                                })
                                            }
                                            onMouseLeave={() => setJumpTooltip(null)}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                handleJumpNavigate(arrow.targetHash, arrow.targetRowIndex);
                                            }}
                                            style={{
                                                position: "absolute",
                                                left,
                                                top,
                                                width: buttonSize,
                                                height: buttonSize,
                                                border: "none",
                                                padding: 0,
                                                background: "transparent",
                                                color: arrow.color,
                                                cursor: "pointer",
                                                pointerEvents: "auto",
                                            }}
                                            >
                                                <svg
                                                    width={buttonSize}
                                                    height={buttonSize}
                                                    viewBox="0 0 18 18"
                                                    fill="none"
                                                    aria-hidden="true"
                                                    style={{
                                                        transform:
                                                            arrow.direction === "up"
                                                                ? "rotate(180deg)"
                                                                : "none",
                                                    }}
                                                >
                                                    <path
                                                        d="M9 2.5V13"
                                                        stroke="currentColor"
                                                    strokeWidth="2.4"
                                                    strokeLinecap="round"
                                                />
                                                <path
                                                    d="M4.5 8.5L9 13L13.5 8.5"
                                                    stroke="currentColor"
                                                    strokeWidth="2.4"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                />
                                            </svg>
                                        </button>
                                    );
                                })}
                        </div>

                        {hasMore && (
                            <div
                                style={{
                                    ...LOADING_MORE_STYLE,
                                    position: "absolute",
                                    left: 0,
                                    right: 0,
                                    top: commits.length * ROW_HEIGHT,
                                }}
                            >
                                Loading more...
                            </div>
                        )}

                        {jumpTooltip && jumpTargetCommit && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: jumpTooltip.left,
                                    top: jumpTooltip.top,
                                    zIndex: 8,
                                    pointerEvents: "none",
                                    maxWidth: 320,
                                    padding: "4px 8px",
                                    borderRadius: 4,
                                    background: "var(--vscode-editorHoverWidget-background)",
                                    color: "var(--vscode-editorHoverWidget-foreground)",
                                    border: "1px solid var(--vscode-editorHoverWidget-border)",
                                    boxShadow: "0 4px 16px rgba(0,0,0,0.24)",
                                    fontSize: "11px",
                                    lineHeight: 1.4,
                                    whiteSpace: "normal",
                                    wordBreak: "break-word",
                                }}
                            >
                                <div
                                    style={{
                                        opacity: 0.7,
                                        fontFamily: "var(--vscode-editor-font-family, monospace)",
                                        marginBottom: 2,
                                    }}
                                >
                                    {jumpTargetCommit.shortHash}
                                </div>
                                <div>{jumpTargetCommit.message}</div>
                            </div>
                        )}
                    </div>
                </div>

                <button
                    type="button"
                    aria-label={repoRailExpanded ? "Collapse repository rail" : "Expand repository rail"}
                    title={repoRailExpanded ? "Collapse repository rail" : "Expand repository rail"}
                    onClick={onToggleRepoRail}
                    style={{
                        position: "absolute",
                        left: 0,
                        bottom: 8,
                        width: repoRailExpanded ? 22 : repoRailWidth,
                        height: 22,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: 0,
                        border: "none",
                        borderRadius: 4,
                        background: "rgba(255,255,255,0.06)",
                        color: "var(--vscode-foreground)",
                        zIndex: 4,
                        cursor: "pointer",
                    }}
                >
                    {repoRailExpanded ? <LuPanelLeftClose size={12} /> : <LuPanelLeftOpen size={12} />}
                </button>
            </div>

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={getCommitMenuItems(
                        contextMenu.commit,
                        isUnpushedCommit(contextMenu.commit.hash),
                    )}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                    minWidth={320}
                />
            )}
        </div>
    );
}
