import React from "react";
import { LuCloudUpload, LuTag } from "react-icons/lu";
import type { Branch, ThemeFolderIconMap, ThemeTreeIcon } from "../../../../types";
import { renderHighlightedLabel } from "../highlight";
import { ChevronIcon, GitBranchIcon, StarIcon } from "../icons";
import { TreeFolderIcon } from "../../shared/components";
import { resolveFolderIcon } from "../../shared/utils";
import {
    BASE_ICON_STYLE,
    NODE_ICON_SIZE,
    NODE_LABEL_STYLE,
    ROW_STYLE,
    TRACKING_BADGE_STYLE,
    TRACKING_PULL_STYLE,
    TRACKING_PUSH_STYLE,
    TREE_INDENT_STEP,
} from "../styles";
import type { TreeNode } from "../types";

const BRANCH_TREE_ICON_BLUE = "var(--vscode-charts-blue, #58a6ff)";
const CURRENT_BRANCH_ICON_YELLOW = "var(--vscode-charts-yellow, #e2c54b)";
const DEFAULT_BRANCH_ICON_YELLOW = "var(--vscode-charts-yellow, #f2c94c)";

interface Props {
    node: TreeNode;
    remoteBranchNames?: ReadonlySet<string>;
    depth: number;
    selectedBranch: string | null;
    expandedFolders: Set<string>;
    onSelectBranch: (name: string | null, hash?: string) => void;
    onToggleFolder: (key: string) => void;
    onContextMenu: (event: React.MouseEvent, branch: Branch) => void;
    filterNeedle: string;
    prefix: string;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

export function TrackingBadge({
    branch,
    remoteBranchNames,
}: {
    branch: Branch;
    remoteBranchNames?: ReadonlySet<string>;
}): React.ReactElement | null {
    const [tooltipPos, setTooltipPos] = React.useState<{ x: number; y: number } | null>(null);
    const hasNoRemoteBranch = !branch.isRemote && !remoteBranchNames?.has(branch.name);
    if (!hasNoRemoteBranch && branch.ahead <= 0 && branch.behind <= 0) return null;

    const tooltipParts: string[] = [];
    if (branch.behind > 0) {
        tooltipParts.push(`${branch.behind} incoming commit${branch.behind === 1 ? "" : "s"}`);
    }
    if (branch.ahead > 0) {
        tooltipParts.push(`${branch.ahead} outgoing commit${branch.ahead === 1 ? "" : "s"}`);
    }
    const trackingText = tooltipParts.join(" and ");
    const tooltipText = [
        hasNoRemoteBranch ? "No remote branch with the same name. Push… to publish." : "",
        trackingText,
    ]
        .filter(Boolean)
        .join(" ");

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
            style={TRACKING_BADGE_STYLE}
            data-branch-tooltip={tooltipText}
            onPointerEnter={showTooltip}
            onPointerMove={showTooltip}
            onPointerLeave={hideTooltip}
        >
            {hasNoRemoteBranch && (
                <span
                    className="branch-unpublished"
                    aria-label="No remote branch with the same name"
                    style={{
                        color: "var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d)",
                        display: "inline-flex",
                        alignItems: "center",
                        opacity: 0.9,
                    }}
                >
                    <LuCloudUpload aria-hidden="true" size={13} />
                </span>
            )}
            {branch.ahead > 0 && (
                <span className="branch-track-push" style={TRACKING_PUSH_STYLE}>
                    {"\u2B06"}
                    {branch.ahead}
                </span>
            )}
            {branch.behind > 0 && (
                <span className="branch-track-pull" style={TRACKING_PULL_STYLE}>
                    {"\u2B07"}
                    {branch.behind}
                </span>
            )}
            {tooltipPos && (
                <span
                    style={{
                        position: "fixed",
                        left: tooltipPos.x,
                        top: tooltipPos.y,
                        transform: "translate(-50%, -100%)",
                        background: "var(--vscode-editorHoverWidget-background, #2f3646)",
                        color: "var(--vscode-editorHoverWidget-foreground, #d8dbe2)",
                        border: "1px solid var(--vscode-editorHoverWidget-border, rgba(255,255,255,0.12))",
                        borderRadius: 4,
                        fontSize: 11,
                        lineHeight: "14px",
                        padding: "3px 6px",
                        whiteSpace: "nowrap",
                        zIndex: 9999,
                        pointerEvents: "none",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
                    }}
                >
                    {tooltipText}
                </span>
            )}
        </span>
    );
}

export function BranchTreeNodeRow({
    node,
    remoteBranchNames,
    depth,
    selectedBranch,
    expandedFolders,
    onSelectBranch,
    onToggleFolder,
    onContextMenu,
    filterNeedle,
    prefix,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
}: Props): React.ReactElement {
    const handleActivateKey = (
        event: React.KeyboardEvent<HTMLDivElement>,
        action: () => void,
    ): void => {
        if (event.key === "Enter" || event.key === " ") {
            if (event.key === " ") event.preventDefault();
            action();
        }
    };

    const isFolder = node.children.length > 0 && !node.branch;
    const folderKey = `${prefix}/${node.label}`;
    const isExpanded = expandedFolders.has(folderKey);
    const rowStyle = { ...ROW_STYLE, paddingLeft: depth * TREE_INDENT_STEP };

    if (isFolder) {
        const resolvedFolderIcon = resolveFolderIcon(
            node.label,
            isExpanded,
            folderIconsByName,
            folderIcon,
            folderExpandedIcon,
        );
        return (
            <>
                <div
                    className="branch-row"
                    onClick={() => onToggleFolder(folderKey)}
                    onKeyDown={(event) => handleActivateKey(event, () => onToggleFolder(folderKey))}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    style={rowStyle}
                >
                    <ChevronIcon expanded={isExpanded} />
                    <span
                        data-branch-icon="folder"
                        style={{ display: "inline-flex", marginRight: 4, flexShrink: 0 }}
                    >
                        <TreeFolderIcon isExpanded={isExpanded} icon={resolvedFolderIcon} />
                    </span>
                    <span>{renderHighlightedLabel(node.label, filterNeedle)}</span>
                </div>
                {isExpanded &&
                    node.children.map((child, index) => (
                        <BranchTreeNodeRow
                            key={`${folderKey}/${child.branch?.name ?? child.label}-${index}`}
                            node={child}
                            remoteBranchNames={remoteBranchNames}
                            depth={depth + 1}
                            selectedBranch={selectedBranch}
                            expandedFolders={expandedFolders}
                            onSelectBranch={onSelectBranch}
                            onToggleFolder={onToggleFolder}
                            onContextMenu={onContextMenu}
                            filterNeedle={filterNeedle}
                            prefix={folderKey}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                        />
                    ))}
            </>
        );
    }

    const isCurrent = node.branch?.isCurrent;
    const shortName = node.branch?.name.replace(/^.*\//, "") ?? "";
    const isMainLike = !!node.branch && (shortName === "main" || shortName === "master");
    const isSelected = selectedBranch === node.fullName;
    const handleSelectBranch = (): void => {
        if (!node.fullName) return;
        onSelectBranch(node.fullName, node.branch?.hash);
    };

    return (
        <div
            className={`branch-row${isSelected ? " selected" : ""}`}
            onClick={handleSelectBranch}
            onKeyDown={(event) => handleActivateKey(event, handleSelectBranch)}
            onContextMenu={(event) => {
                if (node.branch) onContextMenu(event, node.branch);
            }}
            role="button"
            tabIndex={0}
            style={rowStyle}
        >
            <span style={{ display: "inline-block", width: 14, marginRight: 4, flexShrink: 0 }} />
            {isCurrent ? (
                <LuTag
                    size={NODE_ICON_SIZE}
                    color={CURRENT_BRANCH_ICON_YELLOW}
                    style={{ ...BASE_ICON_STYLE, transform: "scaleX(-1)" }}
                    aria-hidden="true"
                    focusable="false"
                />
            ) : isMainLike ? (
                <StarIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : (
                <GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />
            )}
            <span style={NODE_LABEL_STYLE}>{renderHighlightedLabel(node.label, filterNeedle)}</span>
            {node.branch && (
                <TrackingBadge branch={node.branch} remoteBranchNames={remoteBranchNames} />
            )}
        </div>
    );
}
