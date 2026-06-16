import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GitWorktree, RepositoryContextInfo } from "../../../../types";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { ContextMenu, type MenuItem } from "../../shared/components/ContextMenu";

interface WorktreeDeleteResult {
    seq: number;
    success: boolean;
    path?: string;
    message?: string;
}

export interface WorktreeDialogItem {
    repoRoot: string;
    repositoryName: string;
    repositoryRoot: string;
    repositoryColor?: string;
    worktree: GitWorktree;
}

export interface WorktreeDialogRepository {
    root: string;
    name: string;
    color?: string;
}

interface Props {
    repository: RepositoryContextInfo | null;
    items: WorktreeDialogItem[];
    repositories?: WorktreeDialogRepository[];
    allRepositories?: boolean;
    repositoryCount?: number;
    deleteResult?: WorktreeDeleteResult | null;
    onCreate?: (repoRoot: string) => void;
    onOpen: (repoRoot: string, path: string) => void;
    onDelete: (repoRoot: string, path: string) => void;
    onClose: () => void;
}

interface RowMenuState {
    x: number;
    y: number;
    item: WorktreeDialogItem;
}

const MENU_ITEMS: MenuItem[] = [
    { label: "Open", action: "open" },
    { label: "Delete...", action: "delete" },
];

export function WorktreesDialog({
    repository,
    items,
    repositories = [],
    allRepositories = false,
    repositoryCount = 0,
    deleteResult,
    onCreate,
    onOpen,
    onDelete,
    onClose,
}: Props): React.ReactElement {
    const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
    const [confirmItem, setConfirmItem] = useState<WorktreeDialogItem | null>(null);
    const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
    const [requestedCreateRepoRoot, setRequestedCreateRepoRoot] = useState("");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        if (!deleteResult) return;
        if (deleteResult.success) {
            setConfirmItem(null);
            setPendingDeleteKey(null);
            setErrorMessage(null);
            return;
        }
        setPendingDeleteKey(null);
        setErrorMessage(deleteResult.message ?? "Failed to delete worktree.");
    }, [deleteResult]);

    const createRepositories = useMemo(() => {
        const byRoot = new Map<string, WorktreeDialogRepository>();
        for (const repo of repositories) byRoot.set(repo.root, repo);
        if (repository) {
            byRoot.set(repository.root, {
                root: repository.root,
                name: repository.name,
                color: repository.color,
            });
        }
        for (const item of items) {
            if (!byRoot.has(item.repoRoot)) {
                byRoot.set(item.repoRoot, {
                    root: item.repoRoot,
                    name: item.repositoryName,
                    color: item.repositoryColor,
                });
            }
        }
        return Array.from(byRoot.values()).sort((left, right) =>
            left.name.localeCompare(right.name),
        );
    }, [items, repositories, repository]);

    const createRepoRoot = createRepositories.some(
        (repo) => repo.root === requestedCreateRepoRoot,
    )
        ? requestedCreateRepoRoot
        : createRepositories[0]?.root ?? "";

    const sortedItems = useMemo(
        () =>
            [...items].sort((left, right) => {
                if (allRepositories) {
                    const repoCompare = left.repositoryName.localeCompare(right.repositoryName);
                    if (repoCompare !== 0) return repoCompare;
                }
                const leftCurrent = isCurrentWorktree(left.repositoryRoot, left.worktree.path)
                    ? -1
                    : 0;
                const rightCurrent = isCurrentWorktree(right.repositoryRoot, right.worktree.path)
                    ? -1
                    : 0;
                if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
                return getWorktreeName(left.worktree.path).localeCompare(
                    getWorktreeName(right.worktree.path),
                );
            }),
        [allRepositories, items],
    );
    const showRepositoryColumn = allRepositories;
    const subtitle = allRepositories
        ? repositoryCount > 0
            ? `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"}`
            : "All repositories"
        : repository?.name ?? "Repository";

    const handleMenuAction = (action: string): void => {
        if (!rowMenu) return;
        if (action === "open") {
            onOpen(rowMenu.item.repoRoot, rowMenu.item.worktree.path);
            return;
        }
        if (
            action === "delete" &&
            !isCurrentWorktree(rowMenu.item.repositoryRoot, rowMenu.item.worktree.path)
        ) {
            setConfirmItem(rowMenu.item);
            setErrorMessage(null);
        }
    };

    return createPortal(
        <div style={BACKDROP_STYLE} role="presentation" onMouseDown={onClose}>
            <section
                aria-label="Worktrees"
                onMouseDown={(event) => event.stopPropagation()}
                style={DIALOG_STYLE}
            >
                <div style={HEADER_STYLE}>
                    <div>
                        <div style={TITLE_STYLE}>Worktrees</div>
                        <div style={SUBTITLE_STYLE}>{subtitle}</div>
                    </div>
                    <div style={HEADER_ACTIONS_STYLE}>
                        {allRepositories && createRepositories.length > 1 && (
                            <select
                                aria-label="Repository for new worktree"
                                value={createRepoRoot}
                                onChange={(event) => setRequestedCreateRepoRoot(event.target.value)}
                                style={REPOSITORY_SELECT_STYLE}
                            >
                                {createRepositories.map((repo) => (
                                    <option key={repo.root} value={repo.root}>
                                        {repo.name}
                                    </option>
                                ))}
                            </select>
                        )}
                        {onCreate && createRepoRoot && (
                            <button
                                type="button"
                                onClick={() => onCreate(createRepoRoot)}
                                style={NEW_BUTTON_STYLE}
                            >
                                New Worktree...
                            </button>
                        )}
                        <button type="button" onClick={onClose} style={CLOSE_BUTTON_STYLE}>
                            Close
                        </button>
                    </div>
                </div>

                <div style={LIST_STYLE}>
                    {sortedItems.length === 0 ? (
                        <div style={EMPTY_STYLE}>No worktrees found.</div>
                    ) : (
                        sortedItems.map((item) => {
                            const { worktree } = item;
                            const current = isCurrentWorktree(item.repositoryRoot, worktree.path);
                            const rowTitle = [
                                item.repositoryName,
                                worktree.branch ?? "Detached HEAD",
                                worktree.path,
                            ].join("\n");
                            return (
                                <div
                                    key={getWorktreeKey(item)}
                                    role="row"
                                    title={rowTitle}
                                    onClick={(event) => {
                                        if (event.detail >= 2) onOpen(item.repoRoot, worktree.path);
                                    }}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        setRowMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            item,
                                        });
                                    }}
                                    style={
                                        showRepositoryColumn
                                            ? ROW_WITH_REPOSITORY_STYLE
                                            : ROW_STYLE
                                    }
                                >
                                    <span style={CURRENT_MARK_STYLE}>
                                        {current ? "Current" : ""}
                                    </span>
                                    {showRepositoryColumn && (
                                        <span style={REPOSITORY_STYLE}>
                                            <span
                                                style={{
                                                    ...REPOSITORY_SWATCH_STYLE,
                                                    background:
                                                        item.repositoryColor ??
                                                        "var(--vscode-charts-blue, #58a6ff)",
                                                }}
                                            />
                                            <span style={REPOSITORY_NAME_STYLE}>
                                                {item.repositoryName}
                                            </span>
                                        </span>
                                    )}
                                    <span style={NAME_STYLE}>{getWorktreeName(worktree.path)}</span>
                                    <span style={BRANCH_STYLE}>
                                        {worktree.branch ?? "Detached HEAD"}
                                    </span>
                                    <span style={PATH_STYLE}>{worktree.path}</span>
                                    <span style={ACTION_CELL_STYLE}>
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                onOpen(item.repoRoot, worktree.path);
                                            }}
                                            style={ROW_OPEN_BUTTON_STYLE}
                                        >
                                            Open
                                        </button>
                                        <button
                                            type="button"
                                            disabled={current}
                                            title={
                                                current
                                                    ? "Current worktree cannot be deleted"
                                                    : "Delete worktree"
                                            }
                                            onClick={(event) => {
                                                event.stopPropagation();
                                                if (!current) {
                                                    setConfirmItem(item);
                                                    setErrorMessage(null);
                                                }
                                            }}
                                            style={{
                                                ...ROW_DELETE_BUTTON_STYLE,
                                                opacity: current ? 0.42 : 1,
                                                cursor: current ? "not-allowed" : "pointer",
                                            }}
                                        >
                                            Delete...
                                        </button>
                                    </span>
                                </div>
                            );
                        })
                    )}
                </div>

                {errorMessage && <div style={ERROR_STYLE}>{errorMessage}</div>}

                {rowMenu && (
                    <ContextMenu
                        x={rowMenu.x}
                        y={rowMenu.y}
                        minWidth={190}
                        items={MENU_ITEMS.map((item) =>
                            item.action === "delete" &&
                            isCurrentWorktree(
                                rowMenu.item.repositoryRoot,
                                rowMenu.item.worktree.path,
                            )
                                ? { ...item, disabled: true }
                                : item,
                        )}
                        onSelect={handleMenuAction}
                        onClose={() => setRowMenu(null)}
                    />
                )}

                {confirmItem && (
                    <div style={CONFIRM_BACKDROP_STYLE} role="presentation">
                        <div style={CONFIRM_STYLE} role="alertdialog" aria-label="Delete Worktree">
                            <div style={CONFIRM_TITLE_STYLE}>Delete Worktree</div>
                            <div style={CONFIRM_TEXT_STYLE}>
                                Delete worktree at
                                <br />
                                `{confirmItem.worktree.path}`?
                            </div>
                            <div style={CONFIRM_BUTTON_ROW_STYLE}>
                                <button
                                    type="button"
                                    onClick={() => setConfirmItem(null)}
                                    disabled={pendingDeleteKey === getWorktreeKey(confirmItem)}
                                    style={SECONDARY_BUTTON_STYLE}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setPendingDeleteKey(getWorktreeKey(confirmItem));
                                        setErrorMessage(null);
                                        onDelete(
                                            confirmItem.repoRoot,
                                            confirmItem.worktree.path,
                                        );
                                    }}
                                    disabled={pendingDeleteKey === getWorktreeKey(confirmItem)}
                                    style={{
                                        ...PRIMARY_BUTTON_STYLE,
                                        opacity:
                                            pendingDeleteKey === getWorktreeKey(confirmItem)
                                                ? 0.65
                                                : 1,
                                    }}
                                >
                                    {pendingDeleteKey === getWorktreeKey(confirmItem)
                                        ? "Deleting..."
                                        : "Delete Worktree"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </div>,
        document.body,
    );
}

function getWorktreeName(worktreePath: string): string {
    const trimmed = worktreePath.replace(/[\\/]+$/g, "");
    const parts = trimmed.split(/[\\/]+/);
    return parts[parts.length - 1] || trimmed || "worktree";
}

function getWorktreeKey(item: WorktreeDialogItem): string {
    return `${item.repoRoot}:${item.worktree.path}`;
}

function isCurrentWorktree(repoRoot: string | undefined, worktreePath: string): boolean {
    if (!repoRoot) return false;
    return normalizePath(repoRoot) === normalizePath(worktreePath);
}

function normalizePath(value: string): string {
    return value.replace(/[\\/]+$/g, "");
}

const BACKDROP_STYLE: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 10000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.28)",
    fontFamily: SYSTEM_FONT_STACK,
};

const DIALOG_STYLE: React.CSSProperties = {
    width: "min(960px, calc(100vw - 36px))",
    maxHeight: "min(460px, calc(100vh - 40px))",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    overflow: "hidden",
    background: "var(--vscode-editorWidget-background, #2b2d30)",
    color: "var(--vscode-foreground, #d7d7d7)",
    border: "1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.14))",
    borderRadius: 10,
    boxShadow: "0 24px 72px rgba(0,0,0,0.54), 0 2px 8px rgba(0,0,0,0.36)",
};

const HEADER_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 18px 10px",
    borderBottom: "1px solid var(--vscode-panel-border, rgba(255,255,255,0.1))",
};

const HEADER_ACTIONS_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8,
    minWidth: 0,
};

const TITLE_STYLE: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 650,
};

const SUBTITLE_STYLE: React.CSSProperties = {
    marginTop: 2,
    fontSize: 12,
    color: "var(--vscode-descriptionForeground, #8d929b)",
};

const LIST_STYLE: React.CSSProperties = {
    overflow: "auto",
    padding: "8px 12px 12px",
};

const ROW_STYLE: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns:
        "56px minmax(100px, 150px) minmax(120px, 170px) minmax(180px, 1fr) 132px",
    alignItems: "center",
    minHeight: 32,
    gap: 10,
    padding: "4px 8px",
    borderRadius: 5,
    cursor: "default",
};

const ROW_WITH_REPOSITORY_STYLE: React.CSSProperties = {
    ...ROW_STYLE,
    gridTemplateColumns: [
        "56px",
        "minmax(100px, 150px)",
        "minmax(100px, 140px)",
        "minmax(120px, 160px)",
        "minmax(180px, 1fr)",
        "132px",
    ].join(" "),
};

const CURRENT_MARK_STYLE: React.CSSProperties = {
    color: "var(--vscode-charts-green, #7fd4cf)",
    fontWeight: 700,
    textAlign: "center",
};

const REPOSITORY_STYLE: React.CSSProperties = {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 7,
    overflow: "hidden",
};

const REPOSITORY_SWATCH_STYLE: React.CSSProperties = {
    width: 10,
    height: 10,
    borderRadius: 2,
    flexShrink: 0,
};

const REPOSITORY_NAME_STYLE: React.CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
};

const NAME_STYLE: React.CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 600,
};

const BRANCH_STYLE: React.CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--vscode-foreground, #d7d7d7)",
};

const PATH_STYLE: React.CSSProperties = {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--vscode-descriptionForeground, #8d929b)",
};

const ACTION_CELL_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 6,
};

const REPOSITORY_SELECT_STYLE: React.CSSProperties = {
    minWidth: 130,
    maxWidth: 210,
    height: 30,
    borderRadius: 5,
    padding: "0 8px",
    border: "1px solid var(--vscode-input-border, rgba(255,255,255,0.18))",
    background: "var(--vscode-input-background, #2f3136)",
    color: "var(--vscode-input-foreground, #d7d7d7)",
    fontSize: 12,
    fontFamily: SYSTEM_FONT_STACK,
    outline: "none",
};

const ROW_BUTTON_BASE_STYLE: React.CSSProperties = {
    height: 24,
    borderRadius: 5,
    padding: "0 8px",
    border: "1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.18))",
    fontSize: 12,
    fontFamily: SYSTEM_FONT_STACK,
};

const ROW_OPEN_BUTTON_STYLE: React.CSSProperties = {
    ...ROW_BUTTON_BASE_STYLE,
    color: "var(--vscode-button-foreground, #fff)",
    background: "var(--vscode-button-background, #3478f6)",
    borderColor: "var(--vscode-button-background, #3478f6)",
    cursor: "pointer",
};

const NEW_BUTTON_STYLE: React.CSSProperties = {
    height: 30,
    borderRadius: 5,
    padding: "0 10px",
    border: "1px solid var(--vscode-button-background, #3478f6)",
    background: "var(--vscode-button-background, #3478f6)",
    color: "var(--vscode-button-foreground, #fff)",
    fontSize: 12,
    fontFamily: SYSTEM_FONT_STACK,
    cursor: "pointer",
    whiteSpace: "nowrap",
};

const ROW_DELETE_BUTTON_STYLE: React.CSSProperties = {
    ...ROW_BUTTON_BASE_STYLE,
    color: "var(--vscode-button-secondaryForeground, #d7d7d7)",
    background: "var(--vscode-button-secondaryBackground, transparent)",
};

const EMPTY_STYLE: React.CSSProperties = {
    padding: "28px 12px",
    textAlign: "center",
    color: "var(--vscode-descriptionForeground, #8d929b)",
};

const ERROR_STYLE: React.CSSProperties = {
    padding: "0 18px 12px",
    color: "var(--vscode-errorForeground, #f48771)",
    fontSize: 12,
};

const CLOSE_BUTTON_STYLE: React.CSSProperties = {
    height: 30,
    borderRadius: 6,
    padding: "0 12px",
    border: "1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.18))",
    color: "var(--vscode-button-secondaryForeground, #d7d7d7)",
    background: "var(--vscode-button-secondaryBackground, transparent)",
    cursor: "pointer",
    fontFamily: SYSTEM_FONT_STACK,
};

const CONFIRM_BACKDROP_STYLE: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.32)",
};

const CONFIRM_STYLE: React.CSSProperties = {
    width: "min(420px, calc(100% - 40px))",
    background: "var(--vscode-editorWidget-background, #2b2d30)",
    color: "var(--vscode-foreground, #d7d7d7)",
    border: "1px solid var(--vscode-editorWidget-border, rgba(255,255,255,0.14))",
    borderRadius: 10,
    padding: "20px 24px 18px",
    boxShadow: "0 18px 42px rgba(0,0,0,0.48)",
};

const CONFIRM_TITLE_STYLE: React.CSSProperties = {
    fontSize: 17,
    fontWeight: 650,
    marginBottom: 10,
};

const CONFIRM_TEXT_STYLE: React.CSSProperties = {
    fontSize: 14,
    lineHeight: "20px",
};

const CONFIRM_BUTTON_ROW_STYLE: React.CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 12,
    marginTop: 22,
};

const BUTTON_BASE_STYLE: React.CSSProperties = {
    minWidth: 132,
    height: 34,
    borderRadius: 6,
    padding: "0 14px",
    fontSize: 14,
    fontWeight: 600,
    fontFamily: SYSTEM_FONT_STACK,
};

const SECONDARY_BUTTON_STYLE: React.CSSProperties = {
    ...BUTTON_BASE_STYLE,
    border: "1px solid var(--vscode-button-secondaryBorder, rgba(255,255,255,0.18))",
    color: "var(--vscode-button-secondaryForeground, #d7d7d7)",
    background: "var(--vscode-button-secondaryBackground, transparent)",
    cursor: "pointer",
};

const PRIMARY_BUTTON_STYLE: React.CSSProperties = {
    ...BUTTON_BASE_STYLE,
    border: "1px solid var(--vscode-button-background, #3478f6)",
    color: "var(--vscode-button-foreground, #fff)",
    background: "var(--vscode-button-background, #3478f6)",
    cursor: "pointer",
};
