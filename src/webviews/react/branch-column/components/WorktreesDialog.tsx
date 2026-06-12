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

interface Props {
    repository: RepositoryContextInfo | null;
    worktrees: GitWorktree[];
    deleteResult?: WorktreeDeleteResult | null;
    onOpen: (path: string) => void;
    onDelete: (path: string) => void;
    onClose: () => void;
}

interface RowMenuState {
    x: number;
    y: number;
    worktree: GitWorktree;
}

const MENU_ITEMS: MenuItem[] = [
    { label: "Open", action: "open" },
    { label: "Delete...", action: "delete" },
];

export function WorktreesDialog({
    repository,
    worktrees,
    deleteResult,
    onOpen,
    onDelete,
    onClose,
}: Props): React.ReactElement {
    const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
    const [confirmPath, setConfirmPath] = useState<string | null>(null);
    const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    useEffect(() => {
        if (!deleteResult) return;
        if (deleteResult.success) {
            setConfirmPath(null);
            setPendingDeletePath(null);
            setErrorMessage(null);
            return;
        }
        setPendingDeletePath(null);
        setErrorMessage(deleteResult.message ?? "Failed to delete worktree.");
    }, [deleteResult]);

    const sortedWorktrees = useMemo(
        () =>
            [...worktrees].sort((left, right) => {
                const leftCurrent = isCurrentWorktree(repository?.root, left.path) ? -1 : 0;
                const rightCurrent = isCurrentWorktree(repository?.root, right.path) ? -1 : 0;
                if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;
                return getWorktreeName(left.path).localeCompare(getWorktreeName(right.path));
            }),
        [repository?.root, worktrees],
    );

    const handleMenuAction = (action: string): void => {
        if (!rowMenu) return;
        if (action === "open") {
            onOpen(rowMenu.worktree.path);
            return;
        }
        if (action === "delete" && !isCurrentWorktree(repository?.root, rowMenu.worktree.path)) {
            setConfirmPath(rowMenu.worktree.path);
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
                        <div style={SUBTITLE_STYLE}>{repository?.name ?? "Repository"}</div>
                    </div>
                    <button type="button" onClick={onClose} style={CLOSE_BUTTON_STYLE}>
                        Close
                    </button>
                </div>

                <div style={LIST_STYLE}>
                    {sortedWorktrees.length === 0 ? (
                        <div style={EMPTY_STYLE}>No worktrees found.</div>
                    ) : (
                        sortedWorktrees.map((worktree) => {
                            const current = isCurrentWorktree(repository?.root, worktree.path);
                            const rowTitle = `${worktree.branch ?? "Detached HEAD"}\n${worktree.path}`;
                            return (
                                <div
                                    key={worktree.path}
                                    role="row"
                                    title={rowTitle}
                                    onClick={(event) => {
                                        if (event.detail >= 2) onOpen(worktree.path);
                                    }}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        setRowMenu({
                                            x: event.clientX,
                                            y: event.clientY,
                                            worktree,
                                        });
                                    }}
                                    style={ROW_STYLE}
                                >
                                    <span style={CURRENT_MARK_STYLE}>
                                        {current ? "Current" : ""}
                                    </span>
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
                                                onOpen(worktree.path);
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
                                                    setConfirmPath(worktree.path);
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
                            isCurrentWorktree(repository?.root, rowMenu.worktree.path)
                                ? { ...item, disabled: true }
                                : item,
                        )}
                        onSelect={handleMenuAction}
                        onClose={() => setRowMenu(null)}
                    />
                )}

                {confirmPath && (
                    <div style={CONFIRM_BACKDROP_STYLE} role="presentation">
                        <div style={CONFIRM_STYLE} role="alertdialog" aria-label="Delete Worktree">
                            <div style={CONFIRM_TITLE_STYLE}>Delete Worktree</div>
                            <div style={CONFIRM_TEXT_STYLE}>
                                Delete worktree at
                                <br />
                                `{confirmPath}`?
                            </div>
                            <div style={CONFIRM_BUTTON_ROW_STYLE}>
                                <button
                                    type="button"
                                    onClick={() => setConfirmPath(null)}
                                    disabled={pendingDeletePath === confirmPath}
                                    style={SECONDARY_BUTTON_STYLE}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setPendingDeletePath(confirmPath);
                                        setErrorMessage(null);
                                        onDelete(confirmPath);
                                    }}
                                    disabled={pendingDeletePath === confirmPath}
                                    style={{
                                        ...PRIMARY_BUTTON_STYLE,
                                        opacity: pendingDeletePath === confirmPath ? 0.65 : 1,
                                    }}
                                >
                                    {pendingDeletePath === confirmPath
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
    width: "min(840px, calc(100vw - 36px))",
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

const CURRENT_MARK_STYLE: React.CSSProperties = {
    color: "var(--vscode-charts-green, #7fd4cf)",
    fontWeight: 700,
    textAlign: "center",
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
