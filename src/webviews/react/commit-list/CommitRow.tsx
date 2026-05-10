import React from "react";
import { createPortal } from "react-dom";
import type { Commit } from "../../../types";
import { RefTypeIcon } from "../shared/components";
import { formatDateTime } from "../shared/date";
import { REF_BADGE_COLORS } from "../shared/tokens";
import { splitCommitRefs } from "../shared/utils";
import { AUTHOR_COL_WIDTH, DATE_COL_WIDTH, ROW_SIDE_PADDING } from "./styles";
import { ROW_HEIGHT } from "../graph";

interface Props {
    commit: Commit;
    rowLeftOffset: number;
    messageIndent: number;
    isSelected: boolean;
    isUnpushed: boolean;
    laneColor?: string;
    onSelect: (hash: string) => void;
    onContextMenu: (event: React.MouseEvent, commit: Commit) => void;
}

function getRefColors(kind: "branch" | "tag", name: string): { bg: string; fg: string } {
    if (kind === "tag") return REF_BADGE_COLORS.tag;
    if (name.includes("HEAD")) return REF_BADGE_COLORS.head;
    if (name.startsWith("origin/")) return REF_BADGE_COLORS.remote;
    return REF_BADGE_COLORS.local;
}

function RefBadge({ kind, name }: { kind: "branch" | "tag"; name: string }): React.ReactElement {
    const colors = getRefColors(kind, name);
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                maxWidth: 200,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                borderRadius: 3,
                padding: "1px 6px",
                fontSize: 10,
                lineHeight: "15px",
                color: colors.fg,
                background: colors.bg,
            }}
            title={name}
        >
            {name}
        </span>
    );
}

function normalizeBranchRefName(ref: string): string {
    return ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length).trim() : ref;
}

function BranchRefsIndicator({ branchRefs }: { branchRefs: string[] }): React.ReactElement | null {
    const displayRefs = Array.from(
        new Set(branchRefs.map(normalizeBranchRefName).filter((ref) => ref && ref !== "HEAD")),
    );
    const branchRefsCount = displayRefs.length;
    const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);
    if (branchRefsCount === 0) return null;

    const branchText = displayRefs.join(" & ");
    const tooltipText = `Branches (${branchRefsCount}):\n${displayRefs.join("\n")}`;
    const showTooltip = (event: React.PointerEvent<HTMLElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        setTooltipPos({
            x: event.clientX > 0 ? event.clientX : rect.left + rect.width / 2,
            y: rect.top - 6,
        });
    };
    const hideTooltip = (): void => setTooltipPos(null);

    return (
        <span
            style={{
                marginLeft: 6,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                minWidth: 34,
                maxWidth: 260,
                flex: "0 1 auto",
                fontSize: "11px",
                lineHeight: "16px",
                color: "var(--vscode-descriptionForeground)",
                opacity: 0.86,
            }}
            aria-label={tooltipText}
            onPointerEnter={showTooltip}
            onPointerMove={showTooltip}
            onPointerLeave={hideTooltip}
        >
            <RefTypeIcon kind="branch" size={12} />
            <span
                style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {branchText}
            </span>
            {tooltipPos &&
                createPortal(
                    <span
                        style={{
                            position: "fixed",
                            left: Math.max(8, Math.min(tooltipPos.x, window.innerWidth - 8)),
                            top: Math.max(8, tooltipPos.y),
                            transform: "translate(-50%, -100%)",
                            background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                            color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                            border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                            borderRadius: 4,
                            fontSize: 11,
                            lineHeight: "15px",
                            padding: "4px 7px",
                            maxWidth: 360,
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            zIndex: 9999,
                            pointerEvents: "none",
                            boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                        }}
                    >
                        {tooltipText}
                    </span>,
                    document.body,
                )}
        </span>
    );
}

function CommitMessageCell({
    message,
    refs,
}: {
    message: string;
    refs: string[];
}): React.ReactElement {
    const { branches: branchRefs, tags: tagRefs } = splitCommitRefs(refs);
    const visibleTagRefs = tagRefs.slice(0, 2);
    const hiddenTagCount = Math.max(0, tagRefs.length - visibleTagRefs.length);
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
            <BranchRefsIndicator branchRefs={branchRefs} />
            {visibleTagRefs.map((tagRef) => (
                <span key={`tag:${tagRef}`} style={{ marginLeft: 5, flexShrink: 0 }}>
                    <RefBadge kind="tag" name={tagRef} />
                </span>
            ))}
            {hiddenTagCount > 0 && (
                <span
                    style={{
                        marginLeft: 5,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: "10px",
                        opacity: 0.75,
                    }}
                    title={`${hiddenTagCount} more tag${hiddenTagCount === 1 ? "" : "s"}`}
                >
                    <RefTypeIcon kind="tag" size={11} tagColor={REF_BADGE_COLORS.tag.bg} />
                    {`+${hiddenTagCount}`}
                </span>
            )}
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
    onSelect,
    onContextMenu,
}: Props): React.ReactElement {
    const isMergeCommit = commit.parentHashes.length > 1;

    return (
        <div
            onClick={() => onSelect(commit.hash)}
            onContextMenu={(event) => onContextMenu(event, commit)}
            style={{
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
            }}
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
                <CommitMessageCell message={commit.message} refs={commit.refs} />
            </span>

            <span
                style={{
                    width: AUTHOR_COL_WIDTH,
                    textAlign: "right",
                    opacity: isMergeCommit ? 1 : 0.7,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    flexShrink: 0,
                    marginLeft: 4,
                }}
            >
                {commit.author}
            </span>

            <span
                style={{
                    width: DATE_COL_WIDTH,
                    textAlign: "right",
                    opacity: isMergeCommit ? 0.8 : 0.5,
                    flexShrink: 0,
                    marginLeft: 4,
                    fontSize: "11px",
                }}
            >
                {formatDateTime(commit.date)}
            </span>
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
        prev.commit.parentHashes === next.commit.parentHashes &&
        prev.isSelected === next.isSelected &&
        prev.isUnpushed === next.isUnpushed &&
        prev.laneColor === next.laneColor &&
        prev.rowLeftOffset === next.rowLeftOffset &&
        prev.messageIndent === next.messageIndent &&
        prev.onSelect === next.onSelect &&
        prev.onContextMenu === next.onContextMenu
    );
}

export const CommitRow = React.memo(CommitRowInner, areEqual);
