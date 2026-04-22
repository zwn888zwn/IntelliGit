import React from "react";
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

function CommitMessageCell({
    message,
    refs,
}: {
    message: string;
    refs: string[];
}): React.ReactElement {
    const { branches: branchRefs, tags: tagRefs } = splitCommitRefs(refs);
    const branchRefsCount = branchRefs.length;
    const visibleTagRefs = tagRefs.slice(0, 2);
    const hiddenTagCount = Math.max(0, tagRefs.length - visibleTagRefs.length);
    const refSummaryLines: string[] = [];
    if (branchRefs.length > 0) refSummaryLines.push(`Branches: ${branchRefs.join(" • ")}`);
    if (tagRefs.length > 0) refSummaryLines.push(`Tags: ${tagRefs.join(" • ")}`);
    const tooltipText =
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
            title={tooltipText}
        >
            <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 }}
                title={message}
            >
                {message}
            </span>
            {branchRefsCount > 0 && (
                <span
                    style={{
                        marginLeft: 6,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        flexShrink: 0,
                        fontSize: "11px",
                        opacity: 0.85,
                        color: "var(--vscode-charts-blue, #6eb3ff)",
                    }}
                    title={`${branchRefsCount} branch label${branchRefsCount === 1 ? "" : "s"}`}
                >
                    <RefTypeIcon kind="branch" size={12} />
                    {branchRefsCount}
                </span>
            )}
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
                    ? "var(--vscode-list-activeSelectionBackground)"
                    : "transparent",
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
