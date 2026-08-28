// Renders a branch tree inside the commit graph webview panel, to the left of the graph.
// Shows HEAD, local branches grouped by prefix, and remote branches grouped by remote.
// Clicking a branch filters the graph. Right-click shows context menu with git actions.

import React, { useMemo, useState, useCallback, useEffect } from "react";
import { LuChevronRight } from "react-icons/lu";
import type {
    Branch,
    GitTag,
    GitWorktree,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeTreeIcon,
} from "../../types";
import {
    isBranchAction,
    type BranchAction,
    type BranchPopupAction,
    type CreateWorktreePayload,
    type OpenWorktreeDialogPayload,
    type WorktreePathPayload,
} from "./commitGraphTypes";
import { ContextMenu } from "./shared/components/ContextMenu";
import { getBranchMenuItems } from "./branch-column/menu";
import { buildPrefixTree, buildRemoteGroups } from "./branch-column/treeModel";
import type { TreeNode } from "./branch-column/types";
import {
    BranchTreeNodeRow,
    TrackingBadge,
} from "./branch-column/components/BranchTreeNodeRow";
import { BranchSectionHeader } from "./branch-column/components/BranchSectionHeader";
import { BranchSearchBar } from "./branch-column/components/BranchSearchBar";
import { BranchPopupOverlay } from "./branch-column/components/BranchPopupOverlay";
import { NewWorktreeDialog } from "./branch-column/components/NewWorktreeDialog";
import {
    WorktreesDialog,
    type WorktreeDialogItem,
    type WorktreeDialogRepository,
} from "./branch-column/components/WorktreesDialog";
import { RepoIcon, TagRightIcon } from "./branch-column/icons";
import { getVsCodeApi } from "./shared/vscodeApi";
import {
    BRANCH_ROW_CLASS_CSS,
    BRANCH_TREE_SCROLL_STYLE,
    HEAD_LABEL_STYLE,
    HEAD_ROW_STYLE,
    HEAD_WRAPPER_STYLE,
    MULTI_REPOSITORY_PANEL_STYLE,
    NO_MATCH_STYLE,
    PANEL_STYLE,
    REPOSITORY_BRANCH_STYLE,
    REPOSITORY_COLOR_STYLE,
    REPOSITORY_LIST_STYLE,
    REPOSITORY_NAME_LINE_STYLE,
    REPOSITORY_NAME_STYLE,
    REPOSITORY_ROW_STYLE,
    REPOSITORY_TEXT_STYLE,
    TRACKING_BADGE_STYLE,
    TRACKING_PULL_STYLE,
    TRACKING_PUSH_STYLE,
    TREE_INDENT_STEP,
    TREE_SECTION_STYLE,
} from "./branch-column/styles";

interface Props {
    branches: Branch[];
    repositoryBranches?: Record<string, Branch[]>;
    repositoryTags?: Record<string, GitTag[]>;
    repositoryWorktrees?: Record<string, GitWorktree[]>;
    repositories?: RepositoryContextInfo[];
    repository?: RepositoryContextInfo | null;
    selectedBranch: string | null;
    openPopupRequest?: { seq: number } | null;
    worktreeDialog?: OpenWorktreeDialogPayload | null;
    worktreesDialogScope?: { repoRoot?: string } | null;
    worktreeLocationSelection?: { seq: number; location: string } | null;
    worktreeCreateError?: { success: false; message: string } | null;
    worktreeDeleteResult?: { seq: number; success: true; path: string } | { seq: number; success: false; message: string } | null;
    onSelectBranch: (name: string | null, hash?: string) => void;
    onBranchAction: (
        action: BranchAction,
        branchName: string,
        repoRoot?: string,
        allRepositories?: boolean,
    ) => void;
    onBranchPopupAction?: (
        action: BranchPopupAction,
        root?: string,
        refName?: string,
        allRepositories?: boolean,
    ) => void;
    onChooseWorktreeLocation?: (currentLocation: string) => void;
    onCreateWorktree?: (payload: CreateWorktreePayload) => void;
    onOpenWorktree?: (payload: WorktreePathPayload) => void;
    onDeleteWorktree?: (payload: WorktreePathPayload) => void;
    onCloseWorktreeDialog?: () => void;
    onCloseWorktreesDialog?: () => void;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
}

interface BranchColumnPersistState {
    branchFilter: string;
    expandedSections: string[];
    expandedFolders: string[];
}

interface CommitGraphViewState {
    branchColumn?: BranchColumnPersistState;
}

const DEFAULT_EXPANDED_SECTIONS = ["local", "remote"];
const CURRENT_BRANCH_ICON_TEAL = "#7fd4cf";
const ALL_REPOSITORIES_BRANCH_ACTIONS = new Set<string>([
    "checkout",
    "checkoutAndRebase",
    "rebaseCurrentOnto",
    "mergeIntoCurrent",
]);

function readPersistedBranchColumnState(): BranchColumnPersistState | null {
    try {
        const api = getVsCodeApi<unknown, CommitGraphViewState>();
        return api.getState()?.branchColumn ?? null;
    } catch {
        return null;
    }
}

function persistBranchColumnState(state: BranchColumnPersistState): void {
    try {
        const api = getVsCodeApi<unknown, CommitGraphViewState>();
        const prev = api.getState() ?? {};
        api.setState({
            ...prev,
            branchColumn: state,
        });
    } catch {
        // Ignore persistence errors and keep runtime interaction unaffected.
    }
}

function toggleSetKey(
    setState: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string,
): void {
    setState((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
    });
}

function expandSetKeys(
    setState: React.Dispatch<React.SetStateAction<Set<string>>>,
    keys: Set<string>,
): void {
    if (keys.size === 0) return;
    setState((prev) => {
        const next = new Set(prev);
        for (const key of keys) next.add(key);
        return next.size === prev.size ? prev : next;
    });
}

function collectMatchingFolderKeys(
    nodes: TreeNode[],
    prefix: string,
    keys: Set<string>,
    branchName?: string,
): boolean {
    let containsMatch = false;
    for (const node of nodes) {
        if (node.branch) {
            if (!branchName || node.branch.name === branchName) containsMatch = true;
            continue;
        }
        const folderKey = `${prefix}/${node.label}`;
        if (collectMatchingFolderKeys(node.children, folderKey, keys, branchName)) {
            keys.add(folderKey);
            containsMatch = true;
        }
    }
    return containsMatch;
}

function getIconAnchorX(row: HTMLElement): number {
    const rowRect = row.getBoundingClientRect();
    const firstIcon = row.querySelector("[data-branch-icon], svg, img");
    return firstIcon ? firstIcon.getBoundingClientRect().right + 2 : rowRect.left + 20;
}

function computeAnchorPosition(
    row: HTMLElement,
    minimumX: number,
): { anchorX: number; anchorY: number } {
    const rowRect = row.getBoundingClientRect();
    const anchorX = Math.max(getIconAnchorX(row), minimumX);
    const anchorY = rowRect.top + 1;
    return { anchorX, anchorY };
}

export function getAllRepositoriesBranchMenuItems(branch: Branch, currentBranchName: string) {
    const allowedActions = branch.isRemote
        ? ALL_REPOSITORIES_BRANCH_ACTIONS
        : new Set([...ALL_REPOSITORIES_BRANCH_ACTIONS, "updateBranch", "pushBranch"]);
    const items = getBranchMenuItems(branch, currentBranchName).filter(
        (item) => item.separator || allowedActions.has(item.action),
    );
    return items.filter((item, index) => {
        if (!item.separator) return true;
        const previous = items[index - 1];
        const next = items[index + 1];
        return !!previous && !!next && !previous.separator && !next.separator;
    });
}

export function BranchColumn({
    branches,
    repositoryBranches = {},
    repositoryTags = {},
    repositoryWorktrees = {},
    repositories = [],
    repository = null,
    selectedBranch,
    openPopupRequest,
    worktreeDialog,
    worktreesDialogScope,
    worktreeLocationSelection,
    worktreeCreateError,
    worktreeDeleteResult,
    onSelectBranch,
    onBranchAction,
    onBranchPopupAction = () => {},
    onChooseWorktreeLocation = () => {},
    onCreateWorktree = () => {},
    onOpenWorktree = () => {},
    onDeleteWorktree = () => {},
    onCloseWorktreeDialog = () => {},
    onCloseWorktreesDialog = () => {},
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
}: Props): React.ReactElement {
    const [persistedState] = useState(readPersistedBranchColumnState);
    const [branchFilter, setBranchFilter] = useState(() => persistedState?.branchFilter ?? "");
    const [expandedSections, setExpandedSections] = useState<Set<string>>(
        () =>
            new Set(
                Array.isArray(persistedState?.expandedSections)
                    ? persistedState.expandedSections
                    : DEFAULT_EXPANDED_SECTIONS,
            ),
    );
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
        () => new Set(persistedState?.expandedFolders ?? []),
    );
    const [contextMenu, setContextMenu] = useState<{
        x: number;
        y: number;
        branch: Branch;
        repoRoot?: string;
        allRepositories?: boolean;
    } | null>(null);
    const [branchPopupOpen, setBranchPopupOpen] = useState(false);

    const hasMultipleRepositories = repositories.length > 1;
    const filterNeedle = branchFilter.trim().toLowerCase();
    const actualCurrent = useMemo(() => branches.find((b) => b.isCurrent), [branches]);

    const filteredBranches = useMemo(() => {
        if (!filterNeedle) return branches;
        return branches.filter((branch) => branch.name.toLowerCase().includes(filterNeedle));
    }, [branches, filterNeedle]);

    const current = useMemo(() => {
        if (!actualCurrent) return undefined;
        if (!filterNeedle) return actualCurrent;
        return actualCurrent.name.toLowerCase().includes(filterNeedle) ? actualCurrent : undefined;
    }, [actualCurrent, filterNeedle]);

    const locals = useMemo(() => filteredBranches.filter((b) => !b.isRemote), [filteredBranches]);
    const remotes = useMemo(() => filteredBranches.filter((b) => b.isRemote), [filteredBranches]);
    const localTree = useMemo(() => buildPrefixTree(locals), [locals]);
    const remoteGroups = useMemo(() => buildRemoteGroups(remotes), [remotes]);

    useEffect(() => {
        if (!filterNeedle && !selectedBranch) return;

        const foldersToExpand = new Set<string>();
        const sectionsToExpand = new Set<string>();
        const targetBranch = filterNeedle ? undefined : (selectedBranch ?? undefined);

        if (collectMatchingFolderKeys(localTree, "local", foldersToExpand, targetBranch)) {
            sectionsToExpand.add("local");
        }
        for (const [remote, group] of remoteGroups) {
            if (
                collectMatchingFolderKeys(
                    group.tree,
                    `remote/${remote}`,
                    foldersToExpand,
                    targetBranch,
                )
            ) {
                foldersToExpand.add(`remote-${remote}`);
                sectionsToExpand.add("remote");
            }
        }

        expandSetKeys(setExpandedSections, sectionsToExpand);
        expandSetKeys(setExpandedFolders, foldersToExpand);
    }, [filterNeedle, localTree, remoteGroups, selectedBranch]);

    const toggleSection = useCallback(
        (key: string) => {
            toggleSetKey(setExpandedSections, key);
        },
        [setExpandedSections],
    );
    const toggleFolder = useCallback(
        (key: string) => {
            toggleSetKey(setExpandedFolders, key);
        },
        [setExpandedFolders],
    );

    const currentRepositoryRoot = repository?.root;
    const handleBranchContextMenu = useCallback(
        (event: React.MouseEvent, branch: Branch) => {
            event.preventDefault();
            event.stopPropagation();
            const row = event.currentTarget as HTMLElement;
            const { anchorX, anchorY } = computeAnchorPosition(row, event.clientX + 2);
            setContextMenu({ x: anchorX, y: anchorY, branch, repoRoot: currentRepositoryRoot });
        },
        [currentRepositoryRoot],
    );

    const handleRepositoryContextMenu = useCallback(
        (event: React.MouseEvent, repoRoot: string, branch: Branch) => {
            event.preventDefault();
            event.stopPropagation();
            const row = event.currentTarget as HTMLElement;
            const { anchorX, anchorY } = computeAnchorPosition(row, event.clientX + 2);
            setContextMenu({ x: anchorX, y: anchorY, branch, repoRoot });
        },
        [],
    );

    const openBranchContextMenuFromRow = useCallback(
        (row: HTMLElement, branch: Branch): void => {
            const rowRect = row.getBoundingClientRect();
            const { anchorX, anchorY } = computeAnchorPosition(row, rowRect.left + 22);
            setContextMenu({ x: anchorX, y: anchorY, branch, repoRoot: currentRepositoryRoot });
        },
        [currentRepositoryRoot],
    );

    const handleContextMenuAction = useCallback(
        (action: string) => {
            if (!contextMenu) return;
            if (!isBranchAction(action)) return;
            onBranchAction(
                action,
                contextMenu.branch.name,
                contextMenu.repoRoot,
                contextMenu.allRepositories,
            );
        },
        [contextMenu, onBranchAction],
    );

    const closeContextMenu = useCallback(() => setContextMenu(null), []);

    useEffect(() => {
        persistBranchColumnState({
            branchFilter,
            expandedSections: Array.from(expandedSections),
            expandedFolders: Array.from(expandedFolders),
        });
    }, [branchFilter, expandedSections, expandedFolders]);

    useEffect(() => {
        if (!openPopupRequest) return;
        setBranchPopupOpen(true);
    }, [openPopupRequest]);

    const worktreesDialogRepository = useMemo(() => {
        const repoRoot = worktreesDialogScope?.repoRoot;
        if (!repoRoot) return null;
        return (
            repositories.find((repo) => repo.root === repoRoot) ??
            (repository?.root === repoRoot ? repository : null)
        );
    }, [repositories, repository, worktreesDialogScope?.repoRoot]);

    const worktreesDialogItems = useMemo<WorktreeDialogItem[]>(() => {
        if (!worktreesDialogScope) return [];
        const repoRoots = worktreesDialogScope.repoRoot
            ? [worktreesDialogScope.repoRoot]
            : repositories.map((repo) => repo.root);
        return repoRoots.flatMap((repoRoot) => {
            const repoInfo =
                repositories.find((repo) => repo.root === repoRoot) ??
                (repository?.root === repoRoot ? repository : null);
            return (repositoryWorktrees[repoRoot] ?? []).map((worktree) => ({
                repoRoot,
                repositoryName: repoInfo?.name ?? getPathName(repoRoot),
                repositoryRoot: repoInfo?.root ?? repoRoot,
                repositoryColor: repoInfo?.color,
                worktree,
            }));
        });
    }, [repositories, repository, repositoryWorktrees, worktreesDialogScope]);

    const worktreesDialogRepositories = useMemo<WorktreeDialogRepository[]>(() => {
        if (!worktreesDialogScope) return [];
        const repoRoots = worktreesDialogScope.repoRoot
            ? [worktreesDialogScope.repoRoot]
            : repositories.map((repo) => repo.root);
        return repoRoots.map((repoRoot) => {
            const repoInfo =
                repositories.find((repo) => repo.root === repoRoot) ??
                (repository?.root === repoRoot ? repository : null);
            return {
                root: repoRoot,
                name: repoInfo?.name ?? getPathName(repoRoot),
                color: repoInfo?.color,
            };
        });
    }, [repositories, repository, worktreesDialogScope]);

    return (
        <div style={hasMultipleRepositories ? MULTI_REPOSITORY_PANEL_STYLE : PANEL_STYLE}>
            <style>{BRANCH_ROW_CLASS_CSS}</style>

            <BranchSearchBar
                value={branchFilter}
                onChange={setBranchFilter}
                onClear={() => setBranchFilter("")}
            />

            {hasMultipleRepositories && (
                <div aria-label="Repositories" style={REPOSITORY_LIST_STYLE}>
                    {repositories.map((repo) => {
                        const currentBranch = repositoryBranches[repo.root]?.find(
                            (branch) => branch.isCurrent,
                        );
                        const currentBranchName = currentBranch?.name;
                        const selected = repo.root === repository?.root;
                        return (
                            <button
                                key={repo.root}
                                type="button"
                                className="repository-row"
                                data-selected={selected ? "true" : "false"}
                                aria-label={`Switch to repository ${repo.name}`}
                                aria-expanded={selected}
                                onClick={() => {
                                    if (!selected)
                                        onBranchPopupAction("switchRepository", repo.root);
                                }}
                                onContextMenu={(event) => {
                                    if (currentBranch)
                                        handleRepositoryContextMenu(
                                            event,
                                            repo.root,
                                            currentBranch,
                                        );
                                }}
                                style={REPOSITORY_ROW_STYLE}
                            >
                                <span
                                    aria-hidden="true"
                                    data-branch-icon="repository"
                                    style={{ ...REPOSITORY_COLOR_STYLE, background: repo.color }}
                                />
                                <span style={REPOSITORY_TEXT_STYLE}>
                                    <span style={REPOSITORY_NAME_LINE_STYLE}>
                                        <span style={REPOSITORY_NAME_STYLE}>{repo.name}</span>
                                        {currentBranch &&
                                            (currentBranch.ahead > 0 || currentBranch.behind > 0) && (
                                                <span style={TRACKING_BADGE_STYLE}>
                                                    {currentBranch.ahead > 0 && (
                                                        <span
                                                            className="branch-track-push"
                                                            aria-label={`${currentBranch.ahead} outgoing commits`}
                                                            title={`${currentBranch.ahead} outgoing commits`}
                                                            style={TRACKING_PUSH_STYLE}
                                                        >
                                                            {"\u2B06"}
                                                            {currentBranch.ahead}
                                                        </span>
                                                    )}
                                                    {currentBranch.behind > 0 && (
                                                        <span
                                                            className="branch-track-pull"
                                                            aria-label={`${currentBranch.behind} incoming commits`}
                                                            title={`${currentBranch.behind} incoming commits`}
                                                            style={TRACKING_PULL_STYLE}
                                                        >
                                                            {"\u2B07"}
                                                            {currentBranch.behind}
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                    </span>
                                    <span style={REPOSITORY_BRANCH_STYLE}>{currentBranchName}</span>
                                </span>
                                <LuChevronRight
                                    aria-hidden="true"
                                    size={14}
                                    style={{
                                        flexShrink: 0,
                                        opacity: 0.65,
                                        transform: selected
                                            ? "rotate(90deg)"
                                            : "rotate(0deg)",
                                        transition: "transform 0.1s",
                                    }}
                                />
                            </button>
                        );
                    })}
                </div>
            )}

            {(!hasMultipleRepositories || !!repository) && (
                <div style={hasMultipleRepositories ? BRANCH_TREE_SCROLL_STYLE : undefined}>
                    {current && (
                        <div style={HEAD_WRAPPER_STYLE}>
                            <div
                                className="branch-row"
                                role="button"
                                tabIndex={0}
                                onClick={() => onSelectBranch(current.name, current.hash)}
                                onContextMenu={(event) => handleBranchContextMenu(event, current)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        if (event.key === " ") event.preventDefault();
                                        onSelectBranch(current.name, current.hash);
                                        return;
                                    }
                                    if (
                                        event.key === "ContextMenu" ||
                                        (event.shiftKey && event.key === "F10")
                                    ) {
                                        event.preventDefault();
                                        openBranchContextMenuFromRow(
                                            event.currentTarget as HTMLElement,
                                            current,
                                        );
                                    }
                                }}
                                style={HEAD_ROW_STYLE}
                            >
                                <TagRightIcon color={CURRENT_BRANCH_ICON_TEAL} />
                                <span style={HEAD_LABEL_STYLE}>HEAD</span>
                                <TrackingBadge branch={current} />
                            </div>
                        </div>
                    )}

                    <BranchSectionHeader
                        label="Local"
                        expanded={expandedSections.has("local")}
                        onToggle={() => toggleSection("local")}
                    />
                    {expandedSections.has("local") && (
                        <div style={TREE_SECTION_STYLE}>
                            {localTree.map((node, index) => (
                                <BranchTreeNodeRow
                                    key={`local-${node.branch?.name ?? node.label}-${index}`}
                                    node={node}
                                    depth={0}
                                    selectedBranch={selectedBranch}
                                    expandedFolders={expandedFolders}
                                    onSelectBranch={onSelectBranch}
                                    onToggleFolder={toggleFolder}
                                    onContextMenu={handleBranchContextMenu}
                                    filterNeedle={filterNeedle}
                                    prefix="local"
                                    folderIcon={folderIcon}
                                    folderExpandedIcon={folderExpandedIcon}
                                    folderIconsByName={folderIconsByName}
                                />
                            ))}
                        </div>
                    )}

                    <BranchSectionHeader
                        label="Remote"
                        expanded={expandedSections.has("remote")}
                        onToggle={() => toggleSection("remote")}
                    />
                    {expandedSections.has("remote") && (
                        <div style={TREE_SECTION_STYLE}>
                            {Array.from(remoteGroups.entries()).map(([remote, group]) => {
                                const remoteKey = `remote-${remote}`;
                                const isExpanded = expandedFolders.has(remoteKey);
                                return (
                                    <div key={remote}>
                                        <div style={{ paddingLeft: TREE_INDENT_STEP }}>
                                            <BranchSectionHeader
                                                label={remote}
                                                expanded={isExpanded}
                                                onToggle={() => toggleFolder(remoteKey)}
                                                leadingIcon={<RepoIcon />}
                                            />
                                        </div>
                                        {isExpanded &&
                                            group.tree.map((node, index) => (
                                                <BranchTreeNodeRow
                                                    key={`remote-${remote}-${node.branch?.name ?? node.label}-${index}`}
                                                    node={node}
                                                    depth={1}
                                                    selectedBranch={selectedBranch}
                                                    expandedFolders={expandedFolders}
                                                    onSelectBranch={onSelectBranch}
                                                    onToggleFolder={toggleFolder}
                                                    onContextMenu={handleBranchContextMenu}
                                                    filterNeedle={filterNeedle}
                                                    prefix={`remote/${remote}`}
                                                    folderIcon={folderIcon}
                                                    folderExpandedIcon={folderExpandedIcon}
                                                    folderIconsByName={folderIconsByName}
                                                />
                                            ))}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {filterNeedle && locals.length === 0 && remotes.length === 0 && !current && (
                        <div style={NO_MATCH_STYLE}>No matching branches</div>
                    )}
                </div>
            )}

            {contextMenu && (
                <ContextMenu
                    x={contextMenu.x}
                    y={contextMenu.y}
                    items={
                        contextMenu.allRepositories
                            ? getAllRepositoriesBranchMenuItems(
                                  contextMenu.branch,
                                  actualCurrent?.name ?? "HEAD",
                              )
                            : getBranchMenuItems(
                                  contextMenu.branch,
                                  (contextMenu.repoRoot
                                      ? repositoryBranches[contextMenu.repoRoot]?.find(
                                            (branch) => branch.isCurrent,
                                        )?.name
                                      : undefined) ??
                                      actualCurrent?.name ??
                                      "HEAD",
                                  {
                                      checkedOutWorktree: getCheckedOutWorktree(
                                          contextMenu.branch,
                                          repositoryWorktrees[
                                              contextMenu.repoRoot ?? repository?.root ?? ""
                                          ] ?? [],
                                      ),
                                  },
                              )
                    }
                    minWidth={310}
                    onSelect={handleContextMenuAction}
                    onClose={closeContextMenu}
                />
            )}

            {branchPopupOpen && (
                <BranchPopupOverlay
                    branches={branches}
                    repositories={repositories}
                    repository={repository}
                    repositoryBranches={repositoryBranches}
                    repositoryTags={repositoryTags}
                    repositoryWorktrees={repositoryWorktrees}
                    onTopAction={(action, root, refName, allRepositories) => {
                        setBranchPopupOpen(false);
                        onBranchPopupAction(action, root, refName, allRepositories);
                    }}
                    onOpenBranchMenu={(branch, repoRoot, anchor, options) => {
                        setContextMenu({
                            branch,
                            repoRoot,
                            allRepositories: options?.allRepositories,
                            x: anchor.x,
                            y: anchor.y,
                        });
                    }}
                    onClose={() => setBranchPopupOpen(false)}
                />
            )}

            {worktreeDialog && (
                <NewWorktreeDialog
                    repository={worktreeDialog.repository}
                    branches={
                        repositoryBranches[worktreeDialog.repository.root] ??
                        (repository?.root === worktreeDialog.repository.root ? branches : [])
                    }
                    initialBranch={worktreeDialog.branch}
                    defaultLocation={worktreeDialog.defaultLocation}
                    defaultProjectName={worktreeDialog.defaultProjectName}
                    worktrees={worktreeDialog.worktrees}
                    locationSelection={worktreeLocationSelection}
                    createError={worktreeCreateError}
                    onChooseLocation={onChooseWorktreeLocation}
                    onCreate={onCreateWorktree}
                    onClose={onCloseWorktreeDialog}
                />
            )}

            {worktreesDialogScope && (
                <WorktreesDialog
                    repository={worktreesDialogRepository}
                    items={worktreesDialogItems}
                    repositories={worktreesDialogRepositories}
                    allRepositories={!worktreesDialogScope.repoRoot}
                    repositoryCount={repositories.length}
                    deleteResult={worktreeDeleteResult}
                    onCreate={(repoRoot) => onBranchPopupAction("newWorktree", repoRoot)}
                    onOpen={(repoRoot, path) => onOpenWorktree({ repoRoot, path })}
                    onDelete={(repoRoot, path) => onDeleteWorktree({ repoRoot, path })}
                    onClose={onCloseWorktreesDialog}
                />
            )}
        </div>
    );
}

function getCheckedOutWorktree(branch: Branch, worktrees: GitWorktree[]): GitWorktree | null {
    if (branch.isRemote) return null;
    return worktrees.find((worktree) => worktree.branch === branch.name) ?? null;
}

function getPathName(value: string): string {
    const trimmed = value.replace(/[\\/]+$/g, "");
    const parts = trimmed.split(/[\\/]+/);
    return parts[parts.length - 1] || trimmed || "Repository";
}
