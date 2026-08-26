// Renders the commit graph canvas alongside a scrollable commit list.
// Layout: [Graph lanes] [Commit message + inline ref badges] [Author] [Date] [Hash].
// Includes a text search filter bar. Branch filtering is handled by the sidebar.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
    HASH_COL_WIDTH,
    headerRowStyle,
    LOADING_MORE_STYLE,
    META_COL_GAP,
    ROOT_STYLE,
    SCROLL_VIEWPORT_STYLE,
} from "./commit-list/styles";

const MIN_PREFIX_LENGTH = 7;
const MAX_GRAPH_WIDTH = 240;
const PRELOAD_ROWS = 80;
const IDEA_GRAPH_TEXT_LANE_LIMIT = 6;
const IDEA_GRAPH_TEXT_GAP = 2;
const CURRENT_BRANCH_ROW_BACKGROUND =
    "color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 30%, transparent)";

function commitGraphKey(repoRoot: string, hash: string): string {
    return `${repoRoot}\u0000${hash}`;
}

interface Props {
    commits: Commit[];
    repositories: RepositoryContextInfo[];
    repository: RepositoryContextInfo | null;
    selectedHash: string | null;
    currentCommitRefs?: Array<{ repoRoot: string; hash: string }>;
    revealHash?: string | null;
    scrollToTopSignal?: number;
    filterText: string;
    hasMore: boolean;
    unpushedHashes: Set<string>;
    selectedBranch: string | null;
    repoRailExpanded: boolean;
    onToggleRepoRail: () => void;
    onSelectCommit: (hash: string) => void;
    onRevealCommit?: (hash: string) => void;
    onFilterText: (text: string) => void;
    onLoadMore: () => void | Promise<void>;
    onCommitAction: (action: CommitAction, hash: string) => void;
}

export function CommitList({
    commits,
    repositories,
    repository,
    selectedHash,
    currentCommitRefs = [],
    revealHash,
    scrollToTopSignal,
    filterText,
    hasMore,
    unpushedHashes,
    selectedBranch,
    repoRailExpanded,
    onToggleRepoRail,
    onSelectCommit,
    onRevealCommit,
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

    const graph = useMemo(() => computeGraph(commits), [commits]);
    const graphRows = graph.rows;
    const orderedCommits = useMemo(() => {
        if (!graph.orderedHashes?.length) return commits;
        const lookup = new Map(commits.map((commit) => [commit.hash, commit]));
        return graph.orderedHashes
            .map((hash) => lookup.get(hash))
            .filter((commit): commit is Commit => Boolean(commit));
    }, [commits, graph.orderedHashes]);
    const graphWidth = Math.min(graph.recommendedWidth, MAX_GRAPH_WIDTH);
    const graphScale = graphWidth / Math.max(graph.recommendedWidth, 1);
    const repoRailWidth = repoRailExpanded ? 168 : 10;
    const graphTextFloor = Math.min(
        graphWidth,
        IDEA_GRAPH_TEXT_LANE_LIMIT * LANE_WIDTH * graphScale + IDEA_GRAPH_TEXT_GAP,
    );
    const headerGraphWidth = repoRailWidth + graphTextFloor;
    const repositoryLookup = useMemo(
        () => new Map(repositories.map((item) => [item.root, item])),
        [repositories],
    );
    const commitByHash = useMemo(
        () => new Map(commits.map((commit) => [commit.hash, commit])),
        [commits],
    );
    const currentBranchCommitKeys = useMemo(() => {
        const commitByKey = new Map<string, Commit>();
        for (const commit of orderedCommits) {
            commitByKey.set(commitGraphKey(commit.repoRoot, commit.hash), commit);
            commitByKey.set(commitGraphKey(commit.repoRoot, commit.shortHash), commit);
        }
        const visited = new Set<string>();
        const reachable = new Set<string>();

        for (const currentRef of currentCommitRefs) {
            const pending = [currentRef.hash];
            while (pending.length > 0) {
                const hash = pending.pop();
                if (!hash) continue;

                const key = commitGraphKey(currentRef.repoRoot, hash);
                if (visited.has(key)) continue;
                visited.add(key);

                const commit = commitByKey.get(key);
                if (!commit) continue;

                reachable.add(commitGraphKey(commit.repoRoot, commit.hash));
                pending.push(...commit.parentHashes);
            }
        }

        return reachable;
    }, [currentCommitRefs, orderedCommits]);
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
        currentCommitRefs,
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
            if (visibleEnd < Math.max(0, orderedCommits.length - PRELOAD_ROWS)) return;
            void onLoadMore();
        },
        [hasMore, onLoadMore, orderedCommits.length],
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
                orderedCommits.length,
                Math.ceil((nextScrollTop + viewport.clientHeight) / ROW_HEIGHT) + overscan,
            );
            maybeLoadMore(nextVisibleEnd);
        },
        [maybeLoadMore, orderedCommits.length],
    );

    const visibleRange = useMemo(() => {
        if (orderedCommits.length === 0) {
            return { start: 0, end: 0 };
        }
        if (viewportHeight <= 0) {
            return { start: 0, end: Math.min(orderedCommits.length, 40) };
        }
        const overscan = 8;
        const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
        const end = Math.min(
            orderedCommits.length,
            Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan,
        );
        if (end <= start) {
            return {
                start: Math.max(0, Math.min(orderedCommits.length - 1, start)),
                end: Math.min(orderedCommits.length, Math.max(1, start + 1)),
            };
        }
        return { start, end };
    }, [orderedCommits.length, scrollTop, viewportHeight]);

    const visibleCommits = useMemo(
        () => orderedCommits.slice(visibleRange.start, visibleRange.end),
        [orderedCommits, visibleRange.end, visibleRange.start],
    );

    useEffect(() => {
        maybeLoadMore(visibleRange.end);
    }, [maybeLoadMore, visibleRange.end]);

    useLayoutEffect(() => {
        if (scrollToTopSignal === undefined) return;
        const viewport = viewportRef.current;
        if (!viewport) return;

        viewport.scrollTop = 0;
        setScrollTop(0);
    }, [scrollToTopSignal]);

    useEffect(() => {
        if (!revealHash) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        const index = orderedCommits.findIndex((commit) => commit.hash === revealHash);
        if (index < 0) return;

        const targetTop =
            index === 0
                ? 0
                : Math.max(0, index * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2);
        viewport.scrollTop = targetTop;
        setScrollTop(targetTop);
    }, [orderedCommits, revealHash]);

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
            </div>

            <div style={headerRowStyle(headerGraphWidth)}>
                <span style={{ flex: 1 }}>Commit</span>
                <span style={{ width: AUTHOR_COL_WIDTH, textAlign: "right" }}>Author</span>
                <span style={{ width: DATE_COL_WIDTH, textAlign: "right", marginLeft: META_COL_GAP }}>
                    Date
                </span>
                <span
                    style={{
                        width: HASH_COL_WIDTH,
                        textAlign: "right",
                        marginLeft: META_COL_GAP,
                        fontFamily: "var(--vscode-editor-font-family, monospace)",
                    }}
                >
                    Hash
                </span>
            </div>

            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
                <div
                    ref={viewportRef}
                    data-testid="commit-list-viewport"
                    style={SCROLL_VIEWPORT_STYLE}
                    onScroll={handleScroll}
                >
                    <div style={contentContainerStyle(orderedCommits.length + (hasMore ? 1 : 0))}>
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
                                            borderLeft: repoRailExpanded
                                                ? "none"
                                                : `4px solid ${repo?.color ?? "#666"}`,
                                            background: repoRailExpanded
                                                ? (repo?.color ?? "#666")
                                                : "transparent",
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

                        {!repository && orderedCommits.length === 0 && (
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
                                const isCurrentBranchCommit = currentBranchCommitKeys.has(
                                    commitGraphKey(commit.repoRoot, commit.hash),
                                );
                                return (
                                    <div
                                        key={`${commit.repoRoot}:${commit.hash}:${idx}`}
                                        style={{
                                            height: ROW_HEIGHT,
                                            background: isCurrentBranchCommit
                                                ? CURRENT_BRANCH_ROW_BACKGROUND
                                                : "transparent",
                                        }}
                                    >
                                        <CommitRow
                                            commit={commit}
                                            rowLeftOffset={repoRailWidth}
                                            messageIndent={Math.max(
                                                graphTextFloor,
                                                (graphRows[idx]?.occupiedWidth ?? 40) * graphScale,
                                            )}
                                            isSelected={selectedHash === commit.hash}
                                            isUnpushed={isUnpushedCommit(commit.hash)}
                                            laneColor={graphRows[idx]?.nodeColor}
                                            onSelect={onSelectCommit}
                                            onContextMenu={handleRowContextMenu}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        <div
                            style={{
                                position: "absolute",
                                left: repoRailWidth,
                                top: 0,
                                width: graphWidth,
                                height: orderedCommits.length * ROW_HEIGHT,
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
                                            title={
                                                targetCommit
                                                    ? `Jump to '${targetCommit.shortHash} ${targetCommit.message}'`
                                                    : `Load and jump to '${arrow.targetHash.slice(0, 8)}'`
                                            }
                                            onMouseEnter={() =>
                                                targetCommit
                                                    ? setJumpTooltip({
                                                          targetHash: arrow.targetHash,
                                                          left: repoRailWidth + left + buttonSize + 6,
                                                          top: top - 4,
                                                      })
                                                    : undefined
                                            }
                                            onMouseLeave={() => setJumpTooltip(null)}
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                if (targetCommit) {
                                                    handleJumpNavigate(
                                                        arrow.targetHash,
                                                        arrow.targetRowIndex,
                                                    );
                                                    return;
                                                }
                                                onRevealCommit?.(arrow.targetHash);
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
                                    top: orderedCommits.length * ROW_HEIGHT,
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
