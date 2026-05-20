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
import type { Branch, RepositoryContextInfo } from "../../../../types";
import type { BranchPopupAction } from "../../commitGraphTypes";
import { GitBranchIcon, StarIcon, TagRightIcon } from "../icons";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";

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
    onTopAction: (action: BranchPopupAction, root?: string) => void;
    onOpenBranchMenu: (branch: Branch, repoRoot: string, anchor: { x: number; y: number }) => void;
    onClose: () => void;
}

export function BranchPopupOverlay({
    branches,
    repositories,
    repository,
    repositoryBranches,
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
    const filter = query.trim().toLowerCase();
    const current = branches.find((branch) => branch.isCurrent);

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
    const recent = useMemo(() => {
        const candidates =
            locals.length > 0 ? locals : branches.filter((branch) => !branch.isRemote);
        const result: Branch[] = [];
        if (current && (!filter || current.name.toLowerCase().includes(filter))) {
            result.push(current);
        }
        for (const branch of candidates) {
            if (result.some((item) => item.name === branch.name)) continue;
            result.push(branch);
            if (result.length >= 6) break;
        }
        return result;
    }, [branches, current, filter, locals]);

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

            {repositories.length > 1 && (
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

            <Separator />
            <SectionTitle label={`Recent Branches${repository ? ` in ${repository.name}` : ""}`} />
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

            <SectionTitle label={`Local Branches${repository ? ` in ${repository.name}` : ""}`} collapsed />
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
                    <SectionTitle label={`Remote Branches${repository ? ` in ${repository.name}` : ""}`} collapsed />
                    {remotes.map((branch) => {
                        const rowKey = `remote-${branch.name}`;
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
                </>
            )}
            {repositorySubmenu && (
                <RepositorySubmenu
                    ref={repositorySubmenuRef}
                    repository={repositorySubmenu.repository}
                    branches={repositoryBranches[repositorySubmenu.repository.root] ?? []}
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
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected={selected ? "true" : "false"}
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
            <span style={{ flex: 1, textAlign: "left", fontWeight: selected ? 600 : 400 }}>{repository.name}</span>
            <span style={{ opacity: 0.58 }}>{currentBranchName}</span>
            <LuChevronRight size={14} style={{ opacity: 0.65, marginLeft: 8 }} />
        </button>
    );
}

function BranchPopupRow({
    branch,
    selected,
    onHover,
    onClick,
}: {
    branch: Branch;
    selected: boolean;
    onHover: () => void;
    onClick: (event: React.MouseEvent<HTMLElement>, branch: Branch) => void;
}): React.ReactElement {
    const shortName = branch.name.replace(/^.*\//, "");
    const mainLike = shortName === "main" || shortName === "master";
    return (
        <button
            type="button"
            className="intelligit-branch-popup-row"
            data-selected={selected ? "true" : "false"}
            onMouseEnter={onHover}
            onClick={(event) => onClick(event, branch)}
            style={rowButtonStyle(42)}
        >
            {branch.isCurrent ? (
                <TagRightIcon color={CURRENT_BRANCH_ICON_TEAL} />
            ) : mainLike ? (
                <StarIcon color={DEFAULT_BRANCH_ICON_YELLOW} />
            ) : (
                <GitBranchIcon color={BRANCH_TREE_ICON_BLUE} />
            )}
            <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis" }}>
                {branch.name}
            </span>
            <span style={{ opacity: 0.58, overflow: "hidden", textOverflow: "ellipsis" }}>
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
        x: number;
        y: number;
        onTopAction: (action: BranchPopupAction, root?: string) => void;
        onOpenBranchMenu: (branch: Branch, repoRoot: string, anchor: { x: number; y: number }) => void;
    }
>(function RepositorySubmenu(
    { repository, branches, x, y, onTopAction, onOpenBranchMenu },
    ref,
): React.ReactElement {
    const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
    const current = branches.find((branch) => branch.isCurrent);
    const locals = useMemo(
        () => branches.filter((branch) => !branch.isRemote).sort(sortBranches),
        [branches],
    );
    const recent = useMemo(() => {
        const result: Branch[] = [];
        if (current) result.push(current);
        for (const branch of locals) {
            if (result.some((item) => item.name === branch.name)) continue;
            result.push(branch);
            if (result.length >= 5) break;
        }
        return result;
    }, [current, locals]);

    const openBranchMenu = (event: React.MouseEvent<HTMLElement>, branch: Branch): void => {
        const rect = event.currentTarget.getBoundingClientRect();
        onOpenBranchMenu(branch, repository.root, {
            x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 330)),
            y: rect.top + 1,
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
            <SectionTitle label={`Local Branches in ${repository.name}`} collapsed />
            <SectionTitle label={`Remote Branches in ${repository.name}`} collapsed />
            <SectionTitle label={`Tags in ${repository.name}`} collapsed />
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
