import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
    LuArrowDown,
    LuArrowUpRight,
    LuChevronDown,
    LuChevronRight,
    LuGitCommitHorizontal,
    LuPlus,
    LuSearch,
} from "react-icons/lu";
import type { Branch, GitTag, GitWorktree, RepositoryContextInfo } from "../../../../types";
import type { BranchPopupAction } from "../../commitGraphTypes";
import { GitBranchIcon, StarIcon, TagRightIcon } from "../icons";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { buildPrefixTree, buildRemoteGroups } from "../treeModel";
import type { TreeNode } from "../types";

const CURRENT_BRANCH_ICON_TEAL = "var(--vscode-charts-green, #7fd4cf)";
const DEFAULT_BRANCH_ICON_YELLOW = "var(--vscode-charts-yellow, #f2c94c)";
const BRANCH_TREE_ICON_BLUE = "var(--vscode-charts-blue, #58a6ff)";
const POPUP_WIDTH = 380;
const SUBMENU_WIDTH = 380;
const POPUP_ROW_CSS = `
    .intelligit-branch-popup-row:hover {
        background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.08)) !important;
        color: var(--vscode-list-hoverForeground, var(--vscode-menu-foreground, #d7d7d7)) !important;
    }
    .intelligit-branch-popup-row[data-selected="true"],
    .intelligit-branch-popup-row[data-selected="true"]:hover {
        background: var(--vscode-list-activeSelectionBackground, #3467c8) !important;
        color: var(--vscode-list-activeSelectionForeground, #fff) !important;
    }
`;

interface Props {
    branches: Branch[];
    repositories: RepositoryContextInfo[];
    repository: RepositoryContextInfo | null;
    repositoryBranches: Record<string, Branch[]>;
    repositoryTags: Record<string, GitTag[]>;
    repositoryWorktrees: Record<string, GitWorktree[]>;
    onTopAction: (
        action: BranchPopupAction,
        root?: string,
        refName?: string,
        allRepositories?: boolean,
    ) => void;
    onOpenBranchMenu: (
        branch: Branch,
        repoRoot: string,
        anchor: { x: number; y: number },
        options?: { allRepositories?: boolean },
    ) => void;
    onClose: () => void;
}

export function BranchPopupOverlay({
    branches,
    repositories,
    repository,
    repositoryBranches,
    repositoryTags,
    repositoryWorktrees,
    onTopAction,
    onOpenBranchMenu,
    onClose,
}: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const repositorySubmenuRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState("");
    const [repositorySubmenu, setRepositorySubmenu] = useState<{
        repository: RepositoryContextInfo;
        x: number;
        y: number;
    } | null>(null);
    const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
    const [expandedCommonSections, setExpandedCommonSections] = useState<Set<string>>(
        () => new Set(),
    );
    const filter = query.trim().toLowerCase();
    const hasMultipleRepositories = repositories.length > 1;
    const commonLocalBranches = useMemo(
        () =>
            buildCommonLocalBranches(repositories, repositoryBranches)
                .filter((branch) => !filter || branch.name.toLowerCase().includes(filter))
                .sort(sortBranches),
        [filter, repositories, repositoryBranches],
    );
    const commonRemoteBranches = useMemo(
        () =>
            buildCommonRemoteBranches(repositories, repositoryBranches)
                .filter((branch) => !filter || branch.name.toLowerCase().includes(filter))
                .sort(sortBranches),
        [filter, repositories, repositoryBranches],
    );
    const commonTags = useMemo(
        () =>
            buildCommonTags(repositories, repositoryTags).filter(
                (tag) => !filter || tag.name.toLowerCase().includes(filter),
            ),
        [filter, repositories, repositoryTags],
    );
    const commonLocalTree = useMemo(
        () => buildPrefixTree(commonLocalBranches),
        [commonLocalBranches],
    );
    const commonRemoteGroups = useMemo(
        () => buildRemoteGroups(commonRemoteBranches),
        [commonRemoteBranches],
    );
    const commonTagTree = useMemo(() => buildTagTree(commonTags), [commonTags]);

    const locals = useMemo(
        () =>
            branches
                .filter((branch) => !branch.isRemote)
                .filter((branch) => !filter || branch.name.toLowerCase().includes(filter))
                .sort(sortBranches),
        [branches, filter],
    );
    const remotes = useMemo(
        () =>
            branches
                .filter((branch) => branch.isRemote)
                .filter((branch) => !filter || branch.name.toLowerCase().includes(filter))
                .sort(sortBranches),
        [branches, filter],
    );
    const recent = useMemo(
        () => buildRecentBranches(branches, filter, 6),
        [branches, filter],
    );

    useEffect(() => {
        const onMouseDown = (event: MouseEvent): void => {
            const target = event.target as Node;
            if (
                ref.current &&
                !ref.current.contains(target) &&
                !repositorySubmenuRef.current?.contains(target)
            ) {
                onClose();
            }
        };
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", onMouseDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose]);

    const openBranchMenu = (event: React.MouseEvent<HTMLElement>, branch: Branch): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (!repository) return;
        onOpenBranchMenu(branch, repository.root, {
            x: Math.min(rect.right - 8, window.innerWidth - 330),
            y: rect.top + 1,
        });
    };

    const openCommonBranchMenu = (event: React.MouseEvent<HTMLElement>, branch: Branch): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenBranchMenu(
            branch,
            repository?.root ?? "",
            {
                x: Math.min(rect.right - 8, window.innerWidth - 330),
                y: rect.top + 1,
            },
            { allRepositories: true },
        );
    };

    const openRepositorySubmenu = (
        event: React.MouseEvent<HTMLElement>,
        repo: RepositoryContextInfo,
    ): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        const next = {
            repository: repo,
            x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - SUBMENU_WIDTH - 10)),
            y: Math.max(8, Math.min(rect.top - 2, window.innerHeight - 420)),
        };
        setRepositorySubmenu((previous) => {
            if (
                previous?.repository.root === next.repository.root &&
                previous.x === next.x &&
                previous.y === next.y
            ) {
                return previous;
            }
            return next;
        });
    };

    const toggleCommonSection = (key: string): void => {
        setExpandedCommonSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    return createPortal(
        <div
            ref={ref}
            role="dialog"
            aria-label="IntelliGit Branches"
            onMouseLeave={() => setActiveRowKey(null)}
            style={{
                position: "fixed",
                left: 8,
                top: 56,
                width: POPUP_WIDTH,
                maxWidth: "calc(100vw - 16px)",
                maxHeight: "min(920px, calc(100vh - 72px))",
                zIndex: 9998,
                overflow: "auto",
                borderRadius: 8,
                border: "1px solid var(--vscode-menu-border, rgba(255,255,255,0.16))",
                background: "var(--vscode-menu-background, #3a3f42)",
                color: "var(--vscode-menu-foreground, #d7d7d7)",
                boxShadow: "0 18px 42px rgba(0,0,0,0.52), 0 2px 7px rgba(0,0,0,0.45)",
                fontFamily: SYSTEM_FONT_STACK,
                fontSize: 13,
                padding: "8px 8px 10px",
            }}
        >
            <style>{POPUP_ROW_CSS}</style>
            <SearchBox value={query} onChange={setQuery} />
            <TopActionRow
                icon={<LuArrowDown size={15} />}
                label="Update Project..."
                hint="⌘T"
                onClick={() => onTopAction("updateProject", repository?.root)}
            />
            <TopActionRow
                icon={<LuGitCommitHorizontal size={15} />}
                label="Commit..."
                hint="⌘K"
                onClick={() => onTopAction("commit", repository?.root)}
            />
            <TopActionRow
                icon={<LuArrowUpRight size={15} />}
                label="Push..."
                hint="⇧⌘K"
                onClick={() => onTopAction("push", repository?.root)}
            />
            <Separator />
            <TopActionRow
                icon={<LuPlus size={17} />}
                label="New Branch..."
                hint="⌥⌘N"
                onClick={() => onTopAction("newBranch", repository?.root)}
            />
            <TopActionRow
                label="Checkout Tag or Revision..."
                alignWithIconLabel
                onClick={() => onTopAction("checkoutRevision", repository?.root)}
            />
            <TopActionRow
                icon={<GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />}
                label="Worktrees..."
                onClick={() => onTopAction("worktrees", repository?.root)}
            />

            {hasMultipleRepositories && (
                <>
                    <Separator />
                    {repositories.map((repo) => {
                        const rowKey = `repo-${repo.root}`;
                        return (
                            <RepositoryRow
                                key={repo.root}
                                repository={repo}
                                currentBranchName={
                                    repositoryBranches[repo.root]?.find(
                                        (branch) => branch.isCurrent,
                                    )?.name
                                }
                                selected={
                                    activeRowKey
                                        ? activeRowKey === rowKey
                                        : repo.root === repository?.root
                                }
                                onHover={() => setActiveRowKey(rowKey)}
                                onActivate={(event) => openRepositorySubmenu(event, repo)}
                            />
                        );
                    })}
                </>
            )}

            {(commonLocalBranches.length > 0 ||
                commonRemoteBranches.length > 0 ||
                commonTags.length > 0) && (
                <>
                    <Separator />
                    {commonLocalBranches.length > 0 && (
                        <>
                            <ExpandableSectionTitle
                                label="Common Local Branches"
                                expanded={expandedCommonSections.has("local")}
                                onToggle={() => toggleCommonSection("local")}
                            />
                            {expandedCommonSections.has("local") && (
                                <PopupTreeRows
                                    nodes={commonLocalTree}
                                    depth={1}
                                    prefix="common-local"
                                    activeRowKey={activeRowKey}
                                    expandedFolders={expandedCommonSections}
                                    onHover={setActiveRowKey}
                                    onToggleFolder={toggleCommonSection}
                                    onBranchClick={openCommonBranchMenu}
                                />
                            )}
                        </>
                    )}
                    {commonRemoteBranches.length > 0 && (
                        <>
                            <ExpandableSectionTitle
                                label="Common Remote Branches"
                                expanded={expandedCommonSections.has("remote")}
                                onToggle={() => toggleCommonSection("remote")}
                            />
                            {expandedCommonSections.has("remote") &&
                                Array.from(commonRemoteGroups.entries()).map(([remote, group]) => {
                                    const remoteKey = `common-remote/${remote}`;
                                    return (
                                        <div key={remoteKey}>
                                            <PopupFolderRow
                                                label={remote}
                                                depth={1}
                                                folderKey={remoteKey}
                                                expandedFolders={expandedCommonSections}
                                                onToggleFolder={toggleCommonSection}
                                            />
                                            {expandedCommonSections.has(remoteKey) && (
                                                <PopupTreeRows
                                                    nodes={group.tree}
                                                    depth={2}
                                                    prefix={remoteKey}
                                                    activeRowKey={activeRowKey}
                                                    expandedFolders={expandedCommonSections}
                                                    onHover={setActiveRowKey}
                                                    onToggleFolder={toggleCommonSection}
                                                    onBranchClick={openCommonBranchMenu}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                        </>
                    )}
                    {commonTags.length > 0 && (
                        <>
                            <ExpandableSectionTitle
                                label="Common Tags"
                                expanded={expandedCommonSections.has("tags")}
                                onToggle={() => toggleCommonSection("tags")}
                            />
                            {expandedCommonSections.has("tags") && (
                                <TagTreeRows
                                    nodes={commonTagTree}
                                    depth={1}
                                    prefix="common-tags"
                                    expandedFolders={expandedCommonSections}
                                    onToggleFolder={toggleCommonSection}
                                    onCheckoutTag={(tag) =>
                                        onTopAction(
                                            "checkoutRevision",
                                            undefined,
                                            tag.name,
                                            true,
                                        )
                                    }
                                />
                            )}
                        </>
                    )}
                </>
            )}

            {!hasMultipleRepositories && (
                <>
                    <Separator />
                    <SectionTitle
                        label={`Recent Branches${repository ? ` in ${repository.name}` : ""}`}
                    />
                    {recent.map((branch) => {
                        const rowKey = `recent-${branch.name}`;
                        return (
                            <BranchPopupRow
                                key={rowKey}
                                branch={branch}
                                selected={activeRowKey ? activeRowKey === rowKey : branch.isCurrent}
                                onHover={() => setActiveRowKey(rowKey)}
                                onClick={openBranchMenu}
                            />
                        );
                    })}

                    <SectionTitle
                        label={`Local Branches${repository ? ` in ${repository.name}` : ""}`}
                        collapsed
                    />
                    {locals.map((branch) => {
                        const rowKey = `local-${branch.name}`;
                        return (
                            <BranchPopupRow
                                key={rowKey}
                                branch={branch}
                                selected={activeRowKey ? activeRowKey === rowKey : branch.isCurrent}
                                onHover={() => setActiveRowKey(rowKey)}
                                onClick={openBranchMenu}
                            />
                        );
                    })}

                    {remotes.length > 0 && (
                        <>
                            <SectionTitle
                                label={`Remote Branches${repository ? ` in ${repository.name}` : ""}`}
                                collapsed
                            />
                            {remotes.map((branch) => {
                                const rowKey = `remote-${branch.name}`;
                                return (
                                    <BranchPopupRow
                                        key={rowKey}
                                        branch={branch}
                                        selected={
                                            activeRowKey
                                                ? activeRowKey === rowKey
                                                : branch.isCurrent
                                        }
                                        onHover={() => setActiveRowKey(rowKey)}
                                        onClick={openBranchMenu}
                                    />
                                );
                            })}
                        </>
                    )}
                </>
            )}
            {repositorySubmenu && (
                <RepositorySubmenu
                    ref={repositorySubmenuRef}
                    repository={repositorySubmenu.repository}
                    branches={repositoryBranches[repositorySubmenu.repository.root] ?? []}
                    tags={repositoryTags[repositorySubmenu.repository.root] ?? []}
                    worktrees={repositoryWorktrees[repositorySubmenu.repository.root] ?? []}
                    x={repositorySubmenu.x}
                    y={repositorySubmenu.y}
                    onTopAction={onTopAction}
                    onOpenBranchMenu={onOpenBranchMenu}
                />
            )}
        </div>,
        document.body,
    );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }): React.ReactElement {
    return (
        <div
            style={{
                height: 30,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 10px",
                marginBottom: 8,
                borderRadius: 4,
                border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.18))",
                background: "var(--vscode-input-background, rgba(0,0,0,0.18))",
                color: "var(--vscode-icon-foreground, #c9c9c9)",
            }}
        >
            <LuSearch size={17} />
            <input
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
                placeholder="Search for branches, actions, repositories"
                style={{
                    flex: 1,
                    minWidth: 0,
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    color: "var(--vscode-input-foreground, #d7d7d7)",
                    font: "inherit",
                }}
            />
        </div>
    );
}

function TopActionRow({
    icon,
    label,
    hint,
    alignWithIconLabel,
    onClick,
}: {
    icon?: React.ReactNode;
    label: string;
    hint?: string;
    alignWithIconLabel?: boolean;
    onClick: () => void;
}): React.ReactElement {
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected="false"
            onClick={onClick}
            style={rowButtonStyle(20)}
        >
            <span
                style={{
                    width: 22,
                    display: "inline-flex",
                    alignItems: "center",
                    opacity: icon || !alignWithIconLabel ? 1 : 0,
                }}
            >
                {icon}
            </span>
            <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
            {hint && <span style={{ opacity: 0.55 }}>{hint}</span>}
        </button>
    );
}

function RepositoryRow({
    repository,
    currentBranchName,
    selected,
    onHover,
    onActivate,
}: {
    repository: RepositoryContextInfo;
    currentBranchName?: string;
    selected: boolean;
    onHover: () => void;
    onActivate: (event: React.MouseEvent<HTMLElement>) => void;
}): React.ReactElement {
    const rowTitle = currentBranchName
        ? `${repository.name}\n${currentBranchName}`
        : repository.name;
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected={selected ? "true" : "false"}
            title={rowTitle}
            onMouseEnter={onHover}
            onClick={(event) => {
                event.preventDefault();
                onActivate(event);
            }}
            style={rowButtonStyle(20)}
        >
            <span
                style={{
                    width: 15,
                    height: 15,
                    borderRadius: 3,
                    background: repository.color,
                    flexShrink: 0,
                    marginRight: 8,
                }}
            />
            <span
                style={{
                    flex: "0 0 auto",
                    textAlign: "left",
                    fontWeight: selected ? 600 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                }}
            >
                {repository.name}
            </span>
            <span
                style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    maxWidth: "42%",
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    opacity: 0.58,
                }}
            >
                {currentBranchName}
            </span>
            <LuChevronRight size={14} style={{ opacity: 0.65, marginLeft: 8 }} />
        </button>
    );
}

function BranchPopupRow({
    branch,
    selected,
    onHover,
    onClick,
    paddingLeft = 42,
}: {
    branch: Branch;
    selected: boolean;
    onHover: () => void;
    onClick: (event: React.MouseEvent<HTMLElement>, branch: Branch) => void;
    paddingLeft?: number;
}): React.ReactElement {
    const shortName = branch.name.replace(/^.*\//, "");
    const mainLike = shortName === "main" || shortName === "master";
    const rowTitle = branch.upstream ? `${branch.name}\n${branch.upstream}` : branch.name;
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected={selected ? "true" : "false"}
            title={rowTitle}
            onMouseEnter={onHover}
            onClick={(event) => onClick(event, branch)}
            style={rowButtonStyle(paddingLeft)}
        >
            {branch.isCurrent ? (
                <TagRightIcon color={CURRENT_BRANCH_ICON_TEAL} />
            ) : mainLike ? (
                <StarIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : (
                <GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />
            )}
            <span
                style={{
                    flex: "0 0 auto",
                    textAlign: "left",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                }}
            >
                {branch.name}
            </span>
            <span
                style={{
                    flex: "1 1 0",
                    minWidth: 0,
                    maxWidth: "100%",
                    textAlign: "right",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    opacity: 0.58,
                }}
            >
                {branch.upstream ?? ""}
            </span>
            <TrackingText branch={branch} />
            <LuChevronRight size={14} style={{ opacity: 0.65, marginLeft: 8 }} />
        </button>
    );
}

const RepositorySubmenu = React.forwardRef<
    HTMLDivElement,
    {
        repository: RepositoryContextInfo;
        branches: Branch[];
        tags: GitTag[];
        worktrees: GitWorktree[];
        x: number;
        y: number;
        onTopAction: (
            action: BranchPopupAction,
            root?: string,
            refName?: string,
            allRepositories?: boolean,
        ) => void;
        onOpenBranchMenu: (branch: Branch, repoRoot: string, anchor: { x: number; y: number }) => void;
    }
>(function RepositorySubmenu(
    { repository, branches, tags, worktrees, x, y, onTopAction, onOpenBranchMenu },
    ref,
): React.ReactElement {
    const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());
    const locals = useMemo(
        () => branches.filter((branch) => !branch.isRemote).sort(sortBranches),
        [branches],
    );
    const remotes = useMemo(
        () => branches.filter((branch) => branch.isRemote).sort(sortBranches),
        [branches],
    );
    const localTree = useMemo(() => buildPrefixTree(locals), [locals]);
    const remoteGroups = useMemo(() => buildRemoteGroups(remotes), [remotes]);
    const tagTree = useMemo(() => buildTagTree(tags), [tags]);
    const recent = useMemo(() => buildRecentBranches(branches, "", 5), [branches]);

    const openBranchMenu = (event: React.MouseEvent<HTMLElement>, branch: Branch): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenBranchMenu(branch, repository.root, {
            x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 330)),
            y: rect.top + 1,
        });
    };

    const toggleSection = (key: string): void => {
        setExpandedSections((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const toggleFolder = (key: string): void => {
        setExpandedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    return (
        <div
            ref={ref}
            role="menu"
            aria-label={`Branches in ${repository.name}`}
            onMouseLeave={() => setActiveRowKey(null)}
            style={{
                position: "fixed",
                left: x,
                top: y,
                width: SUBMENU_WIDTH,
                maxWidth: "calc(100vw - 16px)",
                maxHeight: "min(560px, calc(100vh - 16px))",
                overflow: "auto",
                zIndex: 9999,
                borderRadius: 8,
                border: "1px solid var(--vscode-menu-border, rgba(255,255,255,0.16))",
                background: "var(--vscode-menu-background, #3a3f42)",
                color: "var(--vscode-menu-foreground, #d7d7d7)",
                boxShadow: "0 18px 42px rgba(0,0,0,0.52), 0 2px 7px rgba(0,0,0,0.45)",
                fontFamily: SYSTEM_FONT_STACK,
                fontSize: 13,
                padding: "8px 8px 10px",
            }}
        >
            <TopActionRow
                icon={<LuPlus size={17} />}
                label="New Branch..."
                hint="⌥⌘N"
                onClick={() => onTopAction("newBranch", repository.root)}
            />
            <TopActionRow
                label="Checkout Tag or Revision..."
                alignWithIconLabel
                onClick={() => onTopAction("checkoutRevision", repository.root)}
            />
            <TopActionRow
                icon={<GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />}
                label={`Worktrees...${worktrees.length ? ` (${worktrees.length})` : ""}`}
                onClick={() => onTopAction("worktrees", repository.root)}
            />
            <Separator />
            <SectionTitle label={`Recent Branches in ${repository.name}`} />
            {recent.map((branch) => {
                const rowKey = `${repository.root}-recent-${branch.name}`;
                return (
                    <BranchPopupRow
                        key={rowKey}
                        branch={branch}
                        selected={activeRowKey ? activeRowKey === rowKey : branch.isCurrent}
                        onHover={() => setActiveRowKey(rowKey)}
                        onClick={openBranchMenu}
                    />
                );
            })}
            <ExpandableSectionTitle
                label={`Local Branches in ${repository.name}`}
                expanded={expandedSections.has("local")}
                onToggle={() => toggleSection("local")}
            />
            {expandedSections.has("local") && (
                <PopupTreeRows
                    nodes={localTree}
                    depth={1}
                    prefix={`submenu-local-${repository.root}`}
                    activeRowKey={activeRowKey}
                    expandedFolders={expandedFolders}
                    onHover={setActiveRowKey}
                    onToggleFolder={toggleFolder}
                    onBranchClick={openBranchMenu}
                />
            )}
            <ExpandableSectionTitle
                label={`Remote Branches in ${repository.name}`}
                expanded={expandedSections.has("remote")}
                onToggle={() => toggleSection("remote")}
            />
            {expandedSections.has("remote") &&
                Array.from(remoteGroups.entries()).map(([remote, group]) => (
                    <div key={`remote-${remote}`}>
                        <PopupFolderRow
                            label={remote}
                            depth={1}
                            folderKey={`submenu-remote-${repository.root}/${remote}`}
                            expandedFolders={expandedFolders}
                            onToggleFolder={toggleFolder}
                        />
                        {expandedFolders.has(`submenu-remote-${repository.root}/${remote}`) && (
                            <PopupTreeRows
                                nodes={group.tree}
                                depth={2}
                                prefix={`submenu-remote-${repository.root}/${remote}`}
                                activeRowKey={activeRowKey}
                                expandedFolders={expandedFolders}
                                onHover={setActiveRowKey}
                                onToggleFolder={toggleFolder}
                                onBranchClick={openBranchMenu}
                            />
                        )}
                    </div>
                ))}
            <ExpandableSectionTitle
                label={`Tags in ${repository.name}`}
                expanded={expandedSections.has("tags")}
                onToggle={() => toggleSection("tags")}
            />
            {expandedSections.has("tags") && (
                <TagTreeRows
                    nodes={tagTree}
                    depth={1}
                    prefix={`submenu-tags-${repository.root}`}
                    expandedFolders={expandedFolders}
                    onToggleFolder={toggleFolder}
                    onCheckoutTag={(tag) => onTopAction("checkoutRevision", repository.root, tag.name)}
                />
            )}
        </div>
    );
});

function TrackingText({ branch }: { branch: Branch }): React.ReactElement | null {
    if (branch.ahead <= 0 && branch.behind <= 0) return null;
    return (
        <span style={{ marginLeft: 8, minWidth: 22, color: "var(--vscode-charts-blue, #58a6ff)" }}>
            {branch.behind > 0 ? `↓${branch.behind}` : ""}
            {branch.ahead > 0 ? `↑${branch.ahead}` : ""}
        </span>
    );
}

function SectionTitle({ label, collapsed }: { label: string; collapsed?: boolean }): React.ReactElement {
    return (
        <div
            style={{
                height: 27,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 18px",
                fontWeight: 600,
                opacity: 0.82,
            }}
        >
            {collapsed ? <LuChevronRight size={15} /> : <LuChevronDown size={15} />}
            <span>{label}</span>
        </div>
    );
}

function ExpandableSectionTitle({
    label,
    expanded,
    onToggle,
}: {
    label: string;
    expanded: boolean;
    onToggle: () => void;
}): React.ReactElement {
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected="false"
            onClick={onToggle}
            style={{ ...rowButtonStyle(18), fontWeight: 600, opacity: 0.82 }}
        >
            {expanded ? <LuChevronDown size={15} /> : <LuChevronRight size={15} />}
            <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
        </button>
    );
}

function PopupTreeRows({
    nodes,
    depth,
    prefix,
    activeRowKey,
    expandedFolders,
    onHover,
    onToggleFolder,
    onBranchClick,
}: {
    nodes: TreeNode[];
    depth: number;
    prefix: string;
    activeRowKey: string | null;
    expandedFolders: Set<string>;
    onHover: (key: string) => void;
    onToggleFolder: (key: string) => void;
    onBranchClick: (event: React.MouseEvent<HTMLElement>, branch: Branch) => void;
}): React.ReactElement {
    return (
        <>
            {nodes.map((node, index) => {
                const key = `${prefix}/${node.branch?.name ?? node.label}-${index}`;
                if (!node.branch) {
                    const folderKey = `${prefix}/${node.label}`;
                    return (
                        <React.Fragment key={key}>
                            <PopupFolderRow
                                label={node.label}
                                depth={depth}
                                folderKey={folderKey}
                                expandedFolders={expandedFolders}
                                onToggleFolder={onToggleFolder}
                            />
                            {expandedFolders.has(folderKey) && (
                                <PopupTreeRows
                                    nodes={node.children}
                                    depth={depth + 1}
                                    prefix={folderKey}
                                    activeRowKey={activeRowKey}
                                    expandedFolders={expandedFolders}
                                    onHover={onHover}
                                    onToggleFolder={onToggleFolder}
                                    onBranchClick={onBranchClick}
                                />
                            )}
                        </React.Fragment>
                    );
                }
                return (
                    <BranchPopupRow
                        key={key}
                        branch={node.branch}
                        selected={activeRowKey === key}
                        onHover={() => onHover(key)}
                        onClick={onBranchClick}
                        paddingLeft={28 + depth * 18}
                    />
                );
            })}
        </>
    );
}

function PopupFolderRow({
    label,
    depth,
    folderKey,
    expandedFolders,
    onToggleFolder,
}: {
    label: string;
    depth: number;
    folderKey: string;
    expandedFolders: Set<string>;
    onToggleFolder: (key: string) => void;
}): React.ReactElement {
    const expanded = expandedFolders.has(folderKey);
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected="false"
            onClick={() => onToggleFolder(folderKey)}
            style={rowButtonStyle(28 + depth * 18)}
        >
            {expanded ? <LuChevronDown size={15} /> : <LuChevronRight size={15} />}
            <span style={{ flex: 1, textAlign: "left", fontWeight: 600 }}>{label}</span>
        </button>
    );
}

interface TagTreeNode {
    label: string;
    tag?: GitTag;
    children: TagTreeNode[];
}

function TagTreeRows({
    nodes,
    depth,
    prefix,
    expandedFolders,
    onToggleFolder,
    onCheckoutTag,
}: {
    nodes: TagTreeNode[];
    depth: number;
    prefix: string;
    expandedFolders: Set<string>;
    onToggleFolder: (key: string) => void;
    onCheckoutTag: (tag: GitTag) => void;
}): React.ReactElement {
    return (
        <>
            {nodes.map((node, index) => {
                const key = `${prefix}/${node.tag?.name ?? node.label}-${index}`;
                if (!node.tag) {
                    return (
                        <React.Fragment key={key}>
                            <PopupFolderRow
                                label={node.label}
                                depth={depth}
                                folderKey={key}
                                expandedFolders={expandedFolders}
                                onToggleFolder={onToggleFolder}
                            />
                            {expandedFolders.has(key) && (
                                <TagTreeRows
                                    nodes={node.children}
                                    depth={depth + 1}
                                    prefix={key}
                                    expandedFolders={expandedFolders}
                                    onToggleFolder={onToggleFolder}
                                    onCheckoutTag={onCheckoutTag}
                                />
                            )}
                        </React.Fragment>
                    );
                }
                return (
                    <button
                        key={key}
                        type="button"
                        className="intelligit-branch-popup-row"
                        data-selected="false"
                        onClick={() => onCheckoutTag(node.tag!)}
                        style={rowButtonStyle(28 + depth * 18)}
                    >
                        <TagRightIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
                        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {node.label}
                        </span>
                        <span style={{ opacity: 0.58 }}>{node.tag.hash}</span>
                    </button>
                );
            })}
        </>
    );
}

function Separator(): React.ReactElement {
    return (
        <div
            style={{
                height: 1,
                margin: "8px 0",
                background: "var(--vscode-menu-separatorBackground, rgba(255,255,255,0.12))",
            }}
        />
    );
}

function rowButtonStyle(paddingLeft: number): React.CSSProperties {
    return {
        width: "100%",
        minHeight: 31,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: `4px 14px 4px ${paddingLeft}px`,
        border: "none",
        borderRadius: 4,
        background: "transparent",
        color: "var(--vscode-menu-foreground, #d7d7d7)",
        cursor: "pointer",
        font: "inherit",
        lineHeight: "20px",
        whiteSpace: "nowrap",
        overflow: "hidden",
    };
}

function sortBranches(a: Branch, b: Branch): number {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.name.localeCompare(b.name);
}

function buildRecentBranches(branches: Branch[], filter: string, limit: number): Branch[] {
    const normalizedFilter = filter.trim().toLowerCase();
    const matchesFilter = (branch: Branch) =>
        !normalizedFilter || branch.name.toLowerCase().includes(normalizedFilter);
    const locals = branches.filter((branch) => !branch.isRemote && matchesFilter(branch));
    const remotes = branches.filter((branch) => branch.isRemote && matchesFilter(branch));
    return [...locals, ...remotes].slice(0, limit);
}

function buildCommonLocalBranches(
    repositories: RepositoryContextInfo[],
    branchesByRoot: Record<string, Branch[]>,
): Branch[] {
    return buildCommonBranches(repositories, branchesByRoot, false);
}

function buildCommonRemoteBranches(
    repositories: RepositoryContextInfo[],
    branchesByRoot: Record<string, Branch[]>,
): Branch[] {
    return buildCommonBranches(repositories, branchesByRoot, true);
}

function buildCommonBranches(
    repositories: RepositoryContextInfo[],
    branchesByRoot: Record<string, Branch[]>,
    isRemote: boolean,
): Branch[] {
    if (repositories.length < 2) return [];
    const localByRoot = repositories.map((repo) =>
        (branchesByRoot[repo.root] ?? []).filter((branch) => branch.isRemote === isRemote),
    );
    if (localByRoot.some((branches) => branches.length === 0)) return [];

    const commonNames = new Set(localByRoot[0].map((branch) => branch.name));
    for (const branches of localByRoot.slice(1)) {
        const names = new Set(branches.map((branch) => branch.name));
        for (const name of Array.from(commonNames)) {
            if (!names.has(name)) commonNames.delete(name);
        }
    }

    return Array.from(commonNames)
        .map((name) => {
            const branches = localByRoot.map((items) => items.find((branch) => branch.name === name)!);
            return {
                ...branches[0],
                isCurrent: branches.every((branch) => branch.isCurrent),
                ahead: branches.reduce((sum, branch) => sum + Math.max(0, branch.ahead), 0),
                behind: branches.reduce((sum, branch) => sum + Math.max(0, branch.behind), 0),
            };
        })
        .sort(sortBranches);
}

function buildCommonTags(
    repositories: RepositoryContextInfo[],
    tagsByRoot: Record<string, GitTag[]>,
): GitTag[] {
    if (repositories.length < 2) return [];
    const tagsByRepository = repositories.map((repo) => tagsByRoot[repo.root] ?? []);
    if (tagsByRepository.some((tags) => tags.length === 0)) return [];

    const commonNames = new Set(tagsByRepository[0].map((tag) => tag.name));
    for (const tags of tagsByRepository.slice(1)) {
        const names = new Set(tags.map((tag) => tag.name));
        for (const name of Array.from(commonNames)) {
            if (!names.has(name)) commonNames.delete(name);
        }
    }

    return Array.from(commonNames)
        .map((name) => tagsByRepository[0].find((tag) => tag.name === name)!)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function buildTagTree(tags: GitTag[]): TagTreeNode[] {
    const root: TagTreeNode[] = [];
    for (const tag of [...tags].sort((a, b) => a.name.localeCompare(b.name))) {
        const parts = tag.name.split("/");
        let current = root;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLeaf = i === parts.length - 1;
            if (isLeaf) {
                current.push({ label: part, tag, children: [] });
                continue;
            }
            let folder = current.find((node) => node.label === part && !node.tag);
            if (!folder) {
                folder = { label: part, children: [] };
                current.push(folder);
            }
            current = folder.children;
        }
    }
    return root;
}
