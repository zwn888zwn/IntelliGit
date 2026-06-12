// React app for the bottom-panel commit graph webview.
// Layout: [BranchColumn (resizable)] | [drag-handle] | [CommitList + search bar] | [drag-handle] | [CommitInfoPane].
// Branch filtering from the inline branch tree posts back to the extension host.

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { BranchColumn } from "./BranchColumn";
import { CommitList } from "./CommitList";
import type {
    Branch,
    Commit,
    CommitDetail,
    GitTag,
    GitWorktree,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeIconFont,
    ThemeTreeIcon,
} from "../../types";
import type {
    BranchAction,
    BranchPopupAction,
    CommitAction,
    CommitGraphOutbound,
    CommitGraphInbound,
    CreateWorktreePayload,
    OpenWorktreeDialogPayload,
    WorktreePathPayload,
} from "./commitGraphTypes";
import { getVsCodeApi } from "./shared/vscodeApi";
import theme from "./commit-panel/theme";
import { CommitInfoPane } from "./commit-info/CommitInfoPane";
import { ThemeIconFontFaces } from "./shared/components";

const vscode = getVsCodeApi<CommitGraphOutbound, unknown>();
const MIN_BRANCH_WIDTH = 80;
const MAX_BRANCH_WIDTH = 500;
const DEFAULT_BRANCH_WIDTH = 260;
const MIN_INFO_WIDTH = 250;
const MAX_INFO_WIDTH = 760;
const DEFAULT_INFO_WIDTH = 330;

function useColumnDrag(
    width: number,
    setWidth: React.Dispatch<React.SetStateAction<number>>,
    min: number,
    max: number,
    invert: boolean,
): (e: React.MouseEvent) => void {
    const draggingRef = useRef(false);
    const moveRef = useRef<((ev: MouseEvent) => void) | null>(null);
    const upRef = useRef<(() => void) | null>(null);
    const widthRef = useRef(width);
    widthRef.current = width;

    useEffect(() => {
        return () => {
            if (draggingRef.current) {
                if (moveRef.current) document.removeEventListener("mousemove", moveRef.current);
                if (upRef.current) document.removeEventListener("mouseup", upRef.current);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                draggingRef.current = false;
            }
        };
    }, []);

    return useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            draggingRef.current = true;
            const startX = e.clientX;
            const startWidth = widthRef.current;

            const onMouseMove = (ev: MouseEvent) => {
                if (!draggingRef.current) return;
                const delta = invert ? startX - ev.clientX : ev.clientX - startX;
                setWidth(Math.max(min, Math.min(max, startWidth + delta)));
            };

            const onMouseUp = () => {
                draggingRef.current = false;
                moveRef.current = null;
                upRef.current = null;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            moveRef.current = onMouseMove;
            upRef.current = onMouseUp;
            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        [setWidth, min, max, invert],
    );
}

function App(): React.ReactElement {
    const [commits, setCommits] = useState<Commit[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [repositoryBranches, setRepositoryBranches] = useState<Record<string, Branch[]>>({});
    const [repositoryTags, setRepositoryTags] = useState<Record<string, GitTag[]>>({});
    const [repositoryWorktrees, setRepositoryWorktrees] = useState<Record<string, GitWorktree[]>>({});
    const [repositories, setRepositories] = useState<RepositoryContextInfo[]>([]);
    const [repository, setRepository] = useState<RepositoryContextInfo | null>(null);
    const [selectedHash, setSelectedHash] = useState<string | null>(null);
    const [revealHash, setRevealHash] = useState<string | null>(null);
    const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [filterText, setFilterText] = useState("");
    const [selectedDetail, setSelectedDetail] = useState<CommitDetail | null>(null);
    const [branchFolderIcon, setBranchFolderIcon] = useState<ThemeTreeIcon | undefined>(undefined);
    const [branchFolderExpandedIcon, setBranchFolderExpandedIcon] = useState<
        ThemeTreeIcon | undefined
    >(undefined);
    const [commitFolderIcon, setCommitFolderIcon] = useState<ThemeTreeIcon | undefined>(undefined);
    const [commitFolderExpandedIcon, setCommitFolderExpandedIcon] = useState<
        ThemeTreeIcon | undefined
    >(undefined);
    const [commitFolderIconsByName, setCommitFolderIconsByName] = useState<
        ThemeFolderIconMap | undefined
    >(undefined);
    const [branchFolderIconsByName, setBranchFolderIconsByName] = useState<
        ThemeFolderIconMap | undefined
    >(undefined);
    const [branchPopupRequest, setBranchPopupRequest] = useState<{ seq: number } | null>(null);
    const [worktreeDialog, setWorktreeDialog] = useState<OpenWorktreeDialogPayload | null>(null);
    const [worktreesDialogRepoRoot, setWorktreesDialogRepoRoot] = useState<string | null>(null);
    const [worktreeLocationSelection, setWorktreeLocationSelection] = useState<{
        seq: number;
        location: string;
    } | null>(null);
    const [worktreeCreateError, setWorktreeCreateError] = useState<{
        success: false;
        message: string;
    } | null>(null);
    const [worktreeDeleteResult, setWorktreeDeleteResult] = useState<
        | { seq: number; success: true; path: string }
        | { seq: number; success: false; message: string }
        | null
    >(null);
    const [iconFonts, setIconFonts] = useState<ThemeIconFont[]>([]);
    const [branchWidth, setBranchWidth] = useState(() => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.branchWidth;
            return typeof w === "number" ? w : DEFAULT_BRANCH_WIDTH;
        } catch {
            return DEFAULT_BRANCH_WIDTH;
        }
    });
    const [infoWidth, setInfoWidth] = useState(() => {
        try {
            const w = (vscode.getState() as Record<string, unknown> | undefined)?.infoWidth;
            return typeof w === "number" ? w : DEFAULT_INFO_WIDTH;
        } catch {
            return DEFAULT_INFO_WIDTH;
        }
    });
    const [repoRailExpanded, setRepoRailExpanded] = useState(() => {
        try {
            const value = (vscode.getState() as Record<string, unknown> | undefined)?.repoRailExpanded;
            return typeof value === "boolean" ? value : false;
        } catch {
            return false;
        }
    });
    const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set());
    const loadingMore = useRef(false);
    const onDividerMouseDown = useColumnDrag(
        branchWidth,
        setBranchWidth,
        MIN_BRANCH_WIDTH,
        MAX_BRANCH_WIDTH,
        false,
    );
    const onInfoDividerMouseDown = useColumnDrag(
        infoWidth,
        setInfoWidth,
        MIN_INFO_WIDTH,
        MAX_INFO_WIDTH,
        true,
    );
    const currentCommitRefs = useMemo(() => {
        const refsByRepo = new Map<string, string>();
        for (const commit of commits) {
            if (commit.refs.some((ref) => ref === "HEAD" || ref.startsWith("HEAD ->"))) {
                refsByRepo.set(commit.repoRoot, commit.hash);
            }
        }
        const currentBranch = branches.find((branch) => branch.isCurrent);
        if (currentBranch && repository?.root) {
            refsByRepo.set(repository.root, currentBranch.hash);
        }
        return Array.from(refsByRepo, ([repoRoot, hash]) => ({ repoRoot, hash }));
    }, [branches, commits, repository?.root]);

    useEffect(() => {
        vscode.postMessage({ type: "ready" });

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            switch (data.type) {
                case "loadCommits":
                    loadingMore.current = false;
                    if (data.append) {
                        setCommits((prev) => [...prev, ...data.commits]);
                    } else {
                        setCommits(data.commits);
                        if (data.commits.length > 0) {
                            setSelectedHash(data.commits[0].hash);
                            vscode.postMessage({
                                type: "selectCommit",
                                hash: data.commits[0].hash,
                                repoRoot: data.commits[0].repoRoot,
                            });
                        }
                    }
                    setHasMore(data.hasMore);
                    setUnpushedHashes(new Set(data.unpushedHashes ?? []));
                    break;
                case "setBranches":
                    setBranches(data.branches);
                    setBranchFolderIcon(data.folderIcon);
                    setBranchFolderExpandedIcon(data.folderExpandedIcon);
                    setBranchFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    break;
                case "setRepositoryContext":
                    setRepository(data.repository);
                    break;
                case "setRepositories":
                    setRepositories(data.repositories);
                    break;
                case "setRepositoryBranches":
                    setRepositoryBranches(data.branchesByRoot);
                    break;
                case "setRepositoryTags":
                    setRepositoryTags(data.tagsByRoot);
                    break;
                case "setRepositoryWorktrees":
                    setRepositoryWorktrees(data.worktreesByRoot);
                    break;
                case "setSelectedBranch":
                    setSelectedBranch(data.branch ?? null);
                    break;
                case "setFilterText":
                    setFilterText(data.text);
                    break;
                case "openBranchPopup":
                    setBranchPopupRequest((prev) => ({ seq: (prev?.seq ?? 0) + 1 }));
                    break;
                case "openWorktreesDialog":
                    setWorktreesDialogRepoRoot(data.repoRoot);
                    setWorktreeDeleteResult(null);
                    break;
                case "openWorktreeDialog":
                    setWorktreeDialog(data.payload);
                    setWorktreeLocationSelection(null);
                    setWorktreeCreateError(null);
                    break;
                case "worktreeLocationSelected":
                    setWorktreeLocationSelection((prev) => ({
                        seq: (prev?.seq ?? 0) + 1,
                        location: data.location,
                    }));
                    break;
                case "worktreeCreateResult":
                    if (data.success) {
                        setWorktreeDialog(null);
                        setWorktreeCreateError(null);
                    } else {
                        setWorktreeCreateError(data);
                    }
                    break;
                case "worktreeDeleteResult":
                    setWorktreeDeleteResult((prev) =>
                        data.success
                            ? {
                                  seq: (prev?.seq ?? 0) + 1,
                                  success: true,
                                  path: data.path,
                              }
                            : {
                                  seq: (prev?.seq ?? 0) + 1,
                                  success: false,
                                  message: data.message,
                              },
                    );
                    break;
                case "setCommitDetail":
                    setSelectedDetail(data.detail);
                    setCommitFolderIcon(data.folderIcon);
                    setCommitFolderExpandedIcon(data.folderExpandedIcon);
                    setCommitFolderIconsByName(data.folderIconsByName);
                    if (data.iconFonts) setIconFonts(data.iconFonts);
                    break;
                case "clearCommitDetail":
                    setSelectedDetail(null);
                    setCommitFolderIcon(undefined);
                    setCommitFolderExpandedIcon(undefined);
                    setCommitFolderIconsByName(undefined);
                    break;
                case "revealCommit":
                    setSelectedHash(data.hash);
                    setRevealHash(data.hash);
                    break;
                case "loadError":
                    if (!loadingMore.current) {
                        setCommits([]);
                    }
                    loadingMore.current = false;
                    setHasMore(false);
                    console.error("[IntelliGit] Load error:", data.message);
                    break;
                case "error":
                    console.error("[IntelliGit] Extension error:", data);
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
    }, []);

    useEffect(() => {
        try {
            const prev = (vscode.getState() ?? {}) as Record<string, unknown>;
            vscode.setState({ ...prev, branchWidth, infoWidth, repoRailExpanded });
        } catch {
            /* ignore persistence errors */
        }
    }, [branchWidth, infoWidth, repoRailExpanded]);

    const handleSelectCommit = useCallback((hash: string) => {
        const selectedCommit = commits.find((commit) => commit.hash === hash) ?? null;
        if (!selectedCommit) return;
        setSelectedHash(hash);
        setRevealHash(null);
        vscode.postMessage({ type: "selectCommit", hash, repoRoot: selectedCommit.repoRoot });
    }, [commits]);

    const handleRevealCommit = useCallback((hash: string) => {
        setSelectedHash(hash);
        setRevealHash(hash);
        vscode.postMessage({ type: "revealCommit", hash });
    }, []);

    const handleFilterText = useCallback((text: string) => {
        setFilterText(text);
        if (text.length >= 3 || text.length === 0) {
            loadingMore.current = false;
            vscode.postMessage({ type: "filterText", text });
        }
    }, []);

    const handleLoadMore = useCallback(() => {
        if (loadingMore.current) return;
        loadingMore.current = true;
        vscode.postMessage({ type: "loadMore" });
    }, []);

    const handleSelectBranch = useCallback((name: string | null) => {
        setSelectedBranch(name);
        loadingMore.current = false;
        vscode.postMessage({ type: "filterBranch", branch: name });
    }, []);

    const handleBranchAction = useCallback((
        action: BranchAction,
        branchName: string,
        repoRoot?: string,
        allRepositories?: boolean,
    ) => {
        vscode.postMessage({ type: "branchAction", action, branchName, repoRoot, allRepositories });
    }, []);

    const handleBranchPopupAction = useCallback(
        (action: BranchPopupAction, root?: string, refName?: string, allRepositories?: boolean) => {
            vscode.postMessage({
                type: "branchPopupAction",
                action,
                root,
                refName,
                allRepositories,
            });
        },
        [],
    );

    const handleChooseWorktreeLocation = useCallback((currentLocation: string) => {
        vscode.postMessage({ type: "chooseWorktreeLocation", currentLocation });
    }, []);

    const handleCreateWorktree = useCallback((payload: CreateWorktreePayload) => {
        setWorktreeCreateError(null);
        vscode.postMessage({ type: "createWorktree", payload });
    }, []);

    const handleOpenWorktree = useCallback((payload: WorktreePathPayload) => {
        vscode.postMessage({ type: "openWorktree", payload });
    }, []);

    const handleDeleteWorktree = useCallback((payload: WorktreePathPayload) => {
        vscode.postMessage({ type: "deleteWorktree", payload });
    }, []);

    const handleCommitAction = useCallback((action: CommitAction, hash: string) => {
        const commit = commits.find((item) => item.hash === hash);
        if (!commit) return;
        vscode.postMessage({ type: "commitAction", action, hash, repoRoot: commit.repoRoot });
    }, [commits]);

    const handleOpenDiff = useCallback((commitHash: string, filePath: string, repoRoot: string) => {
        vscode.postMessage({
            type: "openCommitFileDiff",
            commitHash,
            filePath,
            repoRoot,
        });
    }, []);

    return (
        <>
            <ThemeIconFontFaces fonts={iconFonts} />
            <div style={{ display: "flex", height: "100%", overflow: "hidden", minHeight: 0 }}>
                {/* Branch column */}
                <div style={{ width: branchWidth, flexShrink: 0, overflow: "hidden" }}>
                    <BranchColumn
                        branches={branches}
                        repositoryBranches={repositoryBranches}
                        repositoryTags={repositoryTags}
                        repositoryWorktrees={repositoryWorktrees}
                        repositories={repositories}
                        repository={repository}
                        selectedBranch={selectedBranch}
                        openPopupRequest={branchPopupRequest}
                        worktreeDialog={worktreeDialog}
                        worktreesDialogRepoRoot={worktreesDialogRepoRoot}
                        worktreeLocationSelection={worktreeLocationSelection}
                        worktreeCreateError={worktreeCreateError}
                        worktreeDeleteResult={worktreeDeleteResult}
                        onSelectBranch={handleSelectBranch}
                        onBranchAction={handleBranchAction}
                        onBranchPopupAction={handleBranchPopupAction}
                        onChooseWorktreeLocation={handleChooseWorktreeLocation}
                        onCreateWorktree={handleCreateWorktree}
                        onOpenWorktree={handleOpenWorktree}
                        onDeleteWorktree={handleDeleteWorktree}
                        onCloseWorktreeDialog={() => {
                            setWorktreeDialog(null);
                            setWorktreeCreateError(null);
                        }}
                        onCloseWorktreesDialog={() => {
                            setWorktreesDialogRepoRoot(null);
                            setWorktreeDeleteResult(null);
                        }}
                        folderIcon={branchFolderIcon}
                        folderExpandedIcon={branchFolderExpandedIcon}
                        folderIconsByName={branchFolderIconsByName}
                    />
                </div>

                {/* Resizable divider */}
                <div
                    data-testid="commit-graph-divider"
                    onMouseDown={onDividerMouseDown}
                    style={{
                        width: 4,
                        flexShrink: 0,
                        cursor: "col-resize",
                        background: "var(--vscode-panel-border)",
                    }}
                />

                {/* Commit graph + files/details in one unified panel */}
                <div
                    style={{ flex: 1, overflow: "hidden", display: "flex", minWidth: 0, minHeight: 0 }}
                >
                    <div style={{ flex: 1, overflow: "hidden", minWidth: 0, minHeight: 0 }}>
                        <CommitList
                            commits={commits}
                            repositories={repositories}
                            repository={repository}
                            selectedHash={selectedHash}
                            currentCommitRefs={currentCommitRefs}
                            revealHash={revealHash}
                            filterText={filterText}
                            hasMore={hasMore}
                            unpushedHashes={unpushedHashes}
                            selectedBranch={selectedBranch}
                            repoRailExpanded={repoRailExpanded}
                            onToggleRepoRail={() => setRepoRailExpanded((value) => !value)}
                            onSelectCommit={handleSelectCommit}
                            onRevealCommit={handleRevealCommit}
                            onFilterText={handleFilterText}
                            onLoadMore={handleLoadMore}
                            onCommitAction={handleCommitAction}
                        />
                    </div>
                    <div
                        data-testid="commit-info-divider"
                        onMouseDown={onInfoDividerMouseDown}
                        style={{
                            width: 4,
                            flexShrink: 0,
                            cursor: "col-resize",
                            background: "var(--vscode-panel-border)",
                        }}
                    />
                    <div
                        style={{
                            width: infoWidth,
                            flexShrink: 0,
                            overflow: "hidden",
                            minHeight: 0,
                        }}
                    >
                        <CommitInfoPane
                            detail={selectedDetail}
                            folderIcon={commitFolderIcon}
                            folderExpandedIcon={commitFolderExpandedIcon}
                            folderIconsByName={commitFolderIconsByName}
                            onOpenDiff={handleOpenDiff}
                        />
                    </div>
                </div>
            </div>
        </>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
