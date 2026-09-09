import React from "react";
import { createPortal } from "react-dom";
import { LuTag } from "react-icons/lu";
import type { Commit } from "../../../types";
import { formatDateTime } from "../shared/date";
import { REF_BADGE_COLORS } from "../shared/tokens";
import { splitCommitRefs } from "../shared/utils";
import {
    AUTHOR_COL_WIDTH,
    DATE_COL_WIDTH,
    HASH_COL_WIDTH,
    META_COL_GAP,
    ROW_SIDE_PADDING,
} from "./styles";
import { ROW_HEIGHT } from "../graph";

interface Props {
    commit: Commit;
    rowLeftOffset: number;
    messageIndent: number;
    isSelected: boolean;
    isUnpushed: boolean;
    laneColor?: string;
    showAuthor?: boolean;
    showDate?: boolean;
    showHash?: boolean;
    onSelect: (hash: string) => void;
    onContextMenu: (event: React.MouseEvent, commit: Commit) => void;
}

function normalizeBranchRefName(ref: string): string {
    return ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length).trim() : ref;
}

function BranchRefsIndicator({
    branchRefs,
    tagRefs,
    graphRefs,
}: {
    branchRefs: string[];
    tagRefs: string[];
    graphRefs?: Commit["graphRefs"];
}): React.ReactElement | null {
    const displayRefs = Array.from(
        new Set(branchRefs.map(normalizeBranchRefName).filter((ref) => ref && ref !== "HEAD")),
    );
    const groups = [
        {
            kind: "head",
            label: "HEAD",
            color: "var(--vscode-charts-yellow, #e2c54b)",
            names: branchRefs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD -> "))
                ? ["HEAD"]
                : [],
        },
        {
            kind: "local",
            label: "Local branches",
            color: "var(--vscode-charts-green, #73c991)",
            names: displayRefs.filter(
                (name) =>
                    graphRefs?.some((ref) => ref.name === name && ref.type === "local") ||
                    !(graphRefs?.some((ref) => ref.name === name && ref.type === "remote") ||
                        name.startsWith("origin/")),
            ),
        },
        {
            kind: "remote",
            label: "Remote branches",
            color: "var(--vscode-charts-purple, #b180d7)",
            names: displayRefs.filter(
                (name) =>
                    !graphRefs?.some((ref) => ref.name === name && ref.type === "local") &&
                    (graphRefs?.some((ref) => ref.name === name && ref.type === "remote") ||
                        name.startsWith("origin/")),
            ),
        },
        { kind: "tag", label: "Tags", color: REF_BADGE_COLORS.tag.bg, names: tagRefs },
    ].filter((group) => group.names.length > 0);
    const [tooltipPos, setTooltipPos] = React.useState<{
        x: number;
        top: number;
        bottom: number;
    } | null>(null);
    const [tooltipLayout, setTooltipLayout] = React.useState({ left: 8, top: 8, maxHeight: 0 });
    const tooltipRef = React.useRef<HTMLDivElement>(null);
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout>>();
    const tooltipText = `Branches (${displayRefs.length}):\n${displayRefs.join("\n")}\n${groups
        .map((group) => `${group.label}: ${group.names.join(", ")}`)
        .join("\n")}`;

    React.useLayoutEffect(() => {
        if (!tooltipPos || !tooltipRef.current) return;
        const rect = tooltipRef.current.getBoundingClientRect();
        const contentHeight = Math.max(rect.height, tooltipRef.current.scrollHeight + 2);
        const below = Math.max(0, window.innerHeight - tooltipPos.bottom - 14);
        const above = Math.max(0, tooltipPos.top - 14);
        const placeBelow = contentHeight <= below || below >= above;
        const maxHeight = Math.max(1, placeBelow ? below : above);
        const height = Math.min(contentHeight, maxHeight);
        setTooltipLayout({
            left: Math.max(
                8,
                Math.min(tooltipPos.x - rect.width / 2, window.innerWidth - rect.width - 8),
            ),
            top: Math.max(8, placeBelow ? tooltipPos.bottom + 6 : tooltipPos.top - height - 6),
            maxHeight,
        });
    }, [tooltipPos, tooltipText]);

    React.useEffect(() => () => clearTimeout(closeTimerRef.current), []);

    const keepTooltip = (): void => clearTimeout(closeTimerRef.current);
    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        keepTooltip();
        const rect = event.currentTarget.getBoundingClientRect();
        setTooltipLayout({ left: 8, top: 8, maxHeight: 0 });
        setTooltipPos({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    };
    const hideTooltip = (): void => {
        keepTooltip();
        closeTimerRef.current = setTimeout(() => setTooltipPos(null), 100);
    };
    if (groups.length === 0) return null;

    return (
        <span
            style={{
                marginLeft: 6,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                minWidth: branchRefs.length > 0 ? 34 : 13,
                maxWidth: 260,
                flex: "0 1 auto",
                fontSize: "11px",
                lineHeight: "16px",
                color: "var(--vscode-descriptionForeground)",
            }}
            aria-label={tooltipText}
            onPointerEnter={showTooltip}
            onPointerLeave={hideTooltip}
        >
            <span style={{ display: "inline-flex", flexShrink: 0 }}>
                {groups.slice().reverse().map((group, groupIndex) => (
                    <span
                        key={group.kind}
                        data-ref-kind={group.kind}
                        aria-label={group.label}
                        style={{ display: "inline-flex" }}
                    >
                        {group.names.map((name, index) => (
                            <span
                                key={name}
                                style={{
                                    display: "inline-flex",
                                    width:
                                        groupIndex === groups.length - 1 && index === group.names.length - 1
                                            ? 13
                                            : 6,
                                    overflow: "visible",
                                }}
                            >
                                <LuTag
                                    size={13}
                                    color={group.color}
                                    style={{
                                        flexShrink: 0,
                                        transform: "scaleX(-1)",
                                        fill: "var(--commit-ref-background)",
                                    }}
                                />
                            </span>
                        ))}
                    </span>
                ))}
            </span>
            <span
                style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {displayRefs.join(" & ") || (branchRefs.includes("HEAD") ? "HEAD" : "")}
            </span>
            {tooltipPos &&
                createPortal(
                    <div
                        ref={tooltipRef}
                        role="tooltip"
                        onPointerEnter={keepTooltip}
                        onPointerLeave={hideTooltip}
                        onClick={(event) => event.stopPropagation()}
                        onContextMenu={(event) => event.stopPropagation()}
                        style={{
                            position: "fixed",
                            left: tooltipLayout.left,
                            top: tooltipLayout.top,
                            maxHeight: tooltipLayout.maxHeight || Math.max(1, window.innerHeight - 16),
                            boxSizing: "border-box",
                            width: "max-content",
                            maxWidth: "min(360px, calc(100vw - 16px))",
                            overflowY: "auto",
                            background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                            color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                            border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                            borderRadius: 4,
                            fontSize: 12,
                            lineHeight: "18px",
                            padding: "6px 8px",
                            overflowWrap: "anywhere",
                            zIndex: 9999,
                            boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                        }}
                    >
                        {groups.map((group) => (
                            <div
                                key={group.kind}
                                data-ref-kind={group.kind}
                                aria-label={group.label}
                                style={{ display: "flex", alignItems: "flex-start", gap: 6 }}
                            >
                                <span
                                    style={{
                                        display: "inline-flex",
                                        flexShrink: 0,
                                        paddingTop: 2,
                                        width:
                                            14 + 7 * (Math.max(...groups.map((item) => item.names.length)) - 1),
                                    }}
                                >
                                    {group.names.map((name, index) => (
                                        <span
                                            key={name}
                                            style={{
                                                display: "inline-flex",
                                                width: index === group.names.length - 1 ? 14 : 7,
                                                overflow: "visible",
                                            }}
                                        >
                                            <LuTag
                                                size={14}
                                                color={group.color}
                                                style={{
                                                    flexShrink: 0,
                                                    transform: "scaleX(-1)",
                                                    fill: "var(--vscode-editorHoverWidget-background, #2f3646)",
                                                }}
                                            />
                                        </span>
                                    ))}
                                </span>
                                <span style={{ minWidth: 0, whiteSpace: "pre-wrap" }}>
                                    {group.names.join("\n")}
                                </span>
                            </div>
                        ))}
                    </div>,
                    document.body,
                )}
        </span>
    );
}

function CommitMessageCell({
    message,
    refs,
    graphRefs,
}: {
    message: string;
    refs: string[];
    graphRefs?: Commit["graphRefs"];
}): React.ReactElement {
    const { branches: branchRefs, tags: tagRefs } = splitCommitRefs(refs);
    const refSummaryLines: string[] = [];
    if (branchRefs.length > 0) refSummaryLines.push(`Branches: ${branchRefs.join(" • ")}`);
    if (tagRefs.length > 0) refSummaryLines.push(`Tags: ${tagRefs.join(" • ")}`);
    const messageTooltipText =
        refSummaryLines.length > 0 ? `${message}\n\n${refSummaryLines.join("\n")}` : message;

    return (
        <span
            style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                overflow: "hidden",
            }}
        >
            <span
                style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                    flex: "0 1 auto",
                }}
                title={messageTooltipText}
            >
                {message}
            </span>
            <BranchRefsIndicator branchRefs={branchRefs} tagRefs={tagRefs} graphRefs={graphRefs} />
        </span>
    );
}

function CommitRowInner({
    commit,
    rowLeftOffset,
    messageIndent,
    isSelected,
    isUnpushed,
    laneColor,
    showAuthor = true,
    showDate = true,
    showHash = true,
    onSelect,
    onContextMenu,
}: Props): React.ReactElement {
    const isMergeCommit = commit.parentHashes.length > 1;

    return (
        <div
            onClick={() => onSelect(commit.hash)}
            onContextMenu={(event) => onContextMenu(event, commit)}
            style={{
                "--commit-ref-background": isSelected
                    ? "color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 36%, var(--vscode-editor-background, #222))"
                    : "var(--vscode-editor-background, #222)",
                height: ROW_HEIGHT,
                width: `calc(100% - ${rowLeftOffset}px)`,
                minWidth: 0,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                marginLeft: rowLeftOffset,
                paddingRight: ROW_SIDE_PADDING,
                cursor: "pointer",
                fontSize: "12px",
                whiteSpace: "nowrap",
                borderLeft: isUnpushed
                    ? `2px solid ${laneColor ?? "#4CAF50"}`
                    : "2px solid transparent",
                background: isSelected
                    ? "color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 36%, transparent)"
                    : "transparent",
                borderRadius: isSelected ? 4 : 0,
                color: isSelected
                    ? "var(--vscode-list-activeSelectionForeground)"
                    : isMergeCommit
                      ? "var(--vscode-disabledForeground)"
                      : "inherit",
            } as React.CSSProperties}
        >
            <span
                style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    paddingLeft: messageIndent,
                    paddingRight: 6,
                    boxSizing: "border-box",
                }}
            >
                <CommitMessageCell
                    message={commit.message}
                    refs={commit.refs}
                    graphRefs={commit.graphRefs}
                />
            </span>

            {showAuthor && (
                <span
                    style={{
                        width: AUTHOR_COL_WIDTH,
                        textAlign: "right",
                        opacity: isMergeCommit ? 1 : 0.7,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flexShrink: 0,
                        marginLeft: META_COL_GAP,
                    }}
                >
                    {commit.author}
                </span>
            )}

            {showDate && (
                <span
                    style={{
                        width: DATE_COL_WIDTH,
                        textAlign: "right",
                        opacity: isMergeCommit ? 0.8 : 0.5,
                        flexShrink: 0,
                        marginLeft: META_COL_GAP,
                        fontSize: "11px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                    }}
                >
                    {formatDateTime(commit.date)}
                </span>
            )}

            {showHash && (
                <span
                    style={{
                        width: HASH_COL_WIDTH,
                        textAlign: "right",
                        opacity: isMergeCommit ? 0.78 : 0.62,
                        flexShrink: 0,
                        marginLeft: META_COL_GAP,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        fontFamily: "var(--vscode-editor-font-family, monospace)",
                        fontSize: "11px",
                    }}
                    title={commit.hash}
                >
                    {commit.shortHash || commit.hash.slice(0, 8)}
                </span>
            )}
        </div>
    );
}

function areEqual(prev: Props, next: Props): boolean {
    return (
        prev.commit.hash === next.commit.hash &&
        prev.commit.message === next.commit.message &&
        prev.commit.author === next.commit.author &&
        prev.commit.date === next.commit.date &&
        prev.commit.refs === next.commit.refs &&
        prev.commit.graphRefs === next.commit.graphRefs &&
        prev.commit.parentHashes === next.commit.parentHashes &&
        prev.isSelected === next.isSelected &&
        prev.isUnpushed === next.isUnpushed &&
        prev.laneColor === next.laneColor &&
        prev.showAuthor === next.showAuthor &&
        prev.showDate === next.showDate &&
        prev.showHash === next.showHash &&
        prev.rowLeftOffset === next.rowLeftOffset &&
        prev.messageIndent === next.messageIndent &&
        prev.onSelect === next.onSelect &&
        prev.onContextMenu === next.onContextMenu
    );
}

export const CommitRow = React.memo(CommitRowInner, areEqual);
