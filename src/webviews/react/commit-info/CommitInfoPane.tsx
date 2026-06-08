import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { Box, Flex } from "@chakra-ui/react";
import type { CommitDetail, CommitFile, ThemeFolderIconMap, ThemeTreeIcon } from "../../../types";
import { formatDateTime } from "../shared/date";
import { FileTypeIcon } from "../commit-panel/components/FileTypeIcon";
import { StatusBadge } from "../commit-panel/components/StatusBadge";
import { useDragResize } from "../commit-panel/hooks/useDragResize";
import { RefTypeIcon, TreeFolderIcon } from "../shared/components";
import { TEST_FILE_ROW_BACKGROUND } from "../shared/tokens";
import { getLeafName, isTestFilePath, resolveFolderIcon, splitCommitRefs } from "../shared/utils";
import {
    buildFileTree,
    collectDirPaths,
    countFiles,
    type TreeEntry as GenericTreeEntry,
    type TreeFolder as GenericTreeFolder,
} from "../shared/fileTree";

type TreeEntry = GenericTreeEntry<CommitFile>;
type TreeFolder = GenericTreeFolder<CommitFile>;

const INFO_INDENT_BASE = 18;
const INFO_INDENT_STEP = 14;
const INFO_GUIDE_BASE = 23;
const INFO_SECTION_GUIDE = 7;
const COMMIT_DETAILS_DEFAULT_HEIGHT = 110;
const COMMIT_DETAILS_HEIGHT_RATIO = 1 / 3;

function CommitRefRow({
    kind,
    name,
}: {
    kind: "branch" | "tag";
    name: string;
}): React.ReactElement {
    return (
        <Flex
            align="center"
            gap="6px"
            fontSize="11px"
            lineHeight="16px"
            color="var(--vscode-foreground)"
            title={name}
        >
            <Box as="span" display="inline-flex" flexShrink={0}>
                <RefTypeIcon kind={kind} size={12} />
            </Box>
            <Box
                as="span"
                maxW="300px"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
            >
                {name}
            </Box>
        </Flex>
    );
}

export function CommitInfoPane({
    detail,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onOpenDiff,
}: {
    detail: CommitDetail | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onOpenDiff?: (commitHash: string, filePath: string, repoRoot: string) => void;
}): React.ReactElement {
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
    const [filesCollapsed, setFilesCollapsed] = useState(false);
    const [detailCollapsed, setDetailCollapsed] = useState(false);
    const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
    const [showContainingBranches, setShowContainingBranches] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const { height: bottomHeight, onMouseDown: onResizeStart } = useDragResize(
        COMMIT_DETAILS_DEFAULT_HEIGHT,
        70,
        containerRef,
        {
            maxReservedHeight: 80,
            resolveInitialHeight: (containerHeight) =>
                Math.floor(containerHeight * COMMIT_DETAILS_HEIGHT_RATIO),
            onResize: () => setDetailCollapsed(false),
        },
    );

    const tree = useMemo(() => buildFileTree(detail?.files ?? []), [detail?.files]);
    const { branches: branchRefs, tags: tagRefs } = useMemo(
        () => splitCommitRefs(detail?.refs ?? []),
        [detail?.refs],
    );
    const containingBranches = detail?.containingBranches ?? [];
    const containingBranchPreview = containingBranches.slice(0, 2);
    const hasHiddenContainingBranches = containingBranchPreview.length < containingBranches.length;

    useEffect(() => {
        if (!detail) {
            setExpandedDirs(new Set());
            setSelectedFilePath(null);
            setShowContainingBranches(false);
            return;
        }
        setExpandedDirs(new Set(collectDirPaths(tree)));
        setSelectedFilePath(null);
        setShowContainingBranches(false);
    }, [detail?.hash, tree]);

    if (!detail) {
        return (
            <Box
                p="8px 12px"
                color="var(--vscode-descriptionForeground)"
                fontFamily={SYSTEM_FONT_STACK}
                fontSize="13px"
                h="100%"
                overflow="auto"
            >
                No commit selected
            </Box>
        );
    }

    return (
        <Flex ref={containerRef} direction="column" h="100%" overflow="hidden">
            <Box
                px="8px"
                py="4px"
                fontWeight={600}
                fontSize="12px"
                color="var(--vscode-descriptionForeground)"
                borderBottom="1px solid var(--vscode-panel-border)"
                cursor="pointer"
                tabIndex={0}
                role="button"
                aria-expanded={!filesCollapsed}
                onClick={() => setFilesCollapsed((v) => !v)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setFilesCollapsed((v) => !v);
                    }
                }}
            >
                {filesCollapsed ? "\u25B6" : "\u25BC"} Changed Files
            </Box>
            {!filesCollapsed && (
                <Box flex="1 1 auto" overflowY="auto" minH="40px" py="4px">
                    <TreeRows
                        entries={tree}
                        depth={0}
                        commitHash={detail.hash}
                        commitShortHash={detail.shortHash}
                        repoRoot={detail.repoRoot}
                        expandedDirs={expandedDirs}
                        folderIcon={folderIcon}
                        folderExpandedIcon={folderExpandedIcon}
                        folderIconsByName={folderIconsByName}
                        selectedFilePath={selectedFilePath}
                        onSelectFile={setSelectedFilePath}
                        onToggleDir={(dir) =>
                            setExpandedDirs((prev) => {
                                const next = new Set(prev);
                                if (next.has(dir)) next.delete(dir);
                                else next.add(dir);
                                return next;
                            })
                        }
                        onOpenDiff={onOpenDiff}
                    />
                </Box>
            )}

            {!filesCollapsed && !detailCollapsed && (
                <Box
                    flex="0 0 5px"
                    cursor="row-resize"
                    bg="var(--vscode-panel-border, #444)"
                    position="relative"
                    _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                    onMouseDown={onResizeStart}
                    _after={{
                        content: '""',
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: "translate(-50%, -50%)",
                        w: "30px",
                        h: "2px",
                        bg: "var(--vscode-descriptionForeground)",
                        opacity: 0.4,
                        borderRadius: "1px",
                    }}
                />
            )}

            <Box
                flexShrink={filesCollapsed ? 1 : 0}
                flexGrow={filesCollapsed ? 1 : 0}
                minH={filesCollapsed ? 0 : undefined}
                h={filesCollapsed ? undefined : detailCollapsed ? "30px" : `${bottomHeight}px`}
                overflow="hidden"
            >
                <Box
                    px="8px"
                    py="4px"
                    fontWeight={600}
                    fontSize="12px"
                    color="var(--vscode-descriptionForeground)"
                    cursor="pointer"
                    tabIndex={0}
                    role="button"
                    aria-expanded={!detailCollapsed}
                    onClick={() => setDetailCollapsed((v) => !v)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setDetailCollapsed((v) => !v);
                        }
                    }}
                >
                    {detailCollapsed ? "\u25B6" : "\u25BC"} Commit Details
                </Box>
                {!detailCollapsed && (
                    <Box px="12px" py="6px" overflowY="auto" h={`calc(100% - 28px)`}>
                        <Box fontWeight={600} whiteSpace="pre-wrap" lineHeight="1.4" mb="6px">
                            {detail.message}
                        </Box>
                        {detail.body && (
                            <Box
                                color="var(--vscode-descriptionForeground)"
                                whiteSpace="pre-wrap"
                                lineHeight="1.4"
                                mb="6px"
                            >
                                {detail.body}
                            </Box>
                        )}
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                        >
                            <span
                                style={{
                                    fontFamily: "var(--vscode-editor-font-family, monospace)",
                                    color: "var(--vscode-textLink-foreground)",
                                }}
                            >
                                {detail.shortHash}
                            </span>{" "}
                            by {detail.author}
                        </Box>
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                        >
                            {detail.email} on {formatDateTime(detail.date)}
                        </Box>
                        {(branchRefs.length > 0 || tagRefs.length > 0) && (
                            <Box mt="14px">
                                {branchRefs.length > 0 && (
                                    <Box mb={tagRefs.length > 0 ? "10px" : "0"}>
                                        <Box
                                            color="var(--vscode-descriptionForeground)"
                                            fontSize="11px"
                                            mb="4px"
                                            opacity={0.85}
                                        >
                                            Branches
                                        </Box>
                                        <Flex direction="column" gap="3px">
                                            {branchRefs.map((ref) => (
                                                <CommitRefRow key={ref} kind="branch" name={ref} />
                                            ))}
                                        </Flex>
                                    </Box>
                                )}
                                {tagRefs.length > 0 && (
                                    <Box>
                                        <Box
                                            color="var(--vscode-descriptionForeground)"
                                            fontSize="11px"
                                            mb="4px"
                                            opacity={0.85}
                                        >
                                            Tags
                                        </Box>
                                        <Flex direction="column" gap="3px">
                                            {tagRefs.map((tag) => (
                                                <CommitRefRow
                                                    key={`tag:${tag}`}
                                                    kind="tag"
                                                    name={tag}
                                                />
                                            ))}
                                        </Flex>
                                    </Box>
                                )}
                            </Box>
                        )}
                        {containingBranches.length > 0 && (
                            <Box mt="14px">
                                <Flex
                                    align="center"
                                    gap="4px"
                                    wrap="wrap"
                                    color="var(--vscode-descriptionForeground)"
                                    fontSize="12px"
                                    lineHeight="1.5"
                                >
                                    <Box as="span">
                                        In {containingBranches.length} branch
                                        {containingBranches.length !== 1 ? "es" : ""}:
                                    </Box>
                                    {!showContainingBranches && (
                                        <Box as="span" color="var(--vscode-foreground)">
                                            {containingBranchPreview.join(", ")}
                                        </Box>
                                    )}
                                    {hasHiddenContainingBranches && (
                                        <Box
                                            as="button"
                                            type="button"
                                            color="var(--vscode-textLink-foreground)"
                                            _hover={{ textDecoration: "underline" }}
                                            onClick={() =>
                                                setShowContainingBranches((value) => !value)
                                            }
                                        >
                                            {showContainingBranches ? "Hide" : "Show all"}
                                        </Box>
                                    )}
                                </Flex>
                                {showContainingBranches && (
                                    <Box
                                        mt="4px"
                                        color="var(--vscode-foreground)"
                                        fontSize="12px"
                                        lineHeight="1.45"
                                    >
                                        {containingBranches.map((branch) => (
                                            <Box key={`contains:${branch}`}>{branch}</Box>
                                        ))}
                                    </Box>
                                )}
                            </Box>
                        )}
                        <Box
                            color="var(--vscode-descriptionForeground)"
                            fontSize="12px"
                            lineHeight="1.5"
                            mt="4px"
                        >
                            {detail.files.length} file{detail.files.length !== 1 ? "s" : ""} changed
                        </Box>
                    </Box>
                )}
            </Box>
        </Flex>
    );
}

function TreeRows({
    entries,
    depth,
    commitHash,
    commitShortHash,
    repoRoot,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    selectedFilePath,
    onSelectFile,
    onToggleDir,
    onOpenDiff,
}: {
    entries: TreeEntry[];
    depth: number;
    commitHash: string;
    commitShortHash: string;
    repoRoot: string;
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    selectedFilePath: string | null;
    onSelectFile: (path: string) => void;
    onToggleDir: (path: string) => void;
    onOpenDiff?: (commitHash: string, filePath: string, repoRoot: string) => void;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return (
                        <CommitFileRow
                            key={entry.file.path}
                            file={entry.file}
                            depth={depth}
                            commitHash={commitHash}
                            commitShortHash={commitShortHash}
                            repoRoot={repoRoot}
                            isSelected={selectedFilePath === entry.file.path}
                            onSelectFile={onSelectFile}
                            onOpenDiff={onOpenDiff}
                        />
                    );
                }
                const isExpanded = expandedDirs.has(entry.path);
                const fileCount = countFiles(entry.children);
                return (
                    <React.Fragment key={entry.path}>
                        <CommitFolderRow
                            folder={entry}
                            depth={depth}
                            isExpanded={isExpanded}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            fileCount={fileCount}
                            onToggle={() => onToggleDir(entry.path)}
                        />
                        {isExpanded && (
                            <TreeRows
                                entries={entry.children}
                                depth={depth + 1}
                                commitHash={commitHash}
                                commitShortHash={commitShortHash}
                                repoRoot={repoRoot}
                                expandedDirs={expandedDirs}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                selectedFilePath={selectedFilePath}
                                onSelectFile={onSelectFile}
                                onToggleDir={onToggleDir}
                                onOpenDiff={onOpenDiff}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}

function CommitFolderRow({
    folder,
    depth,
    isExpanded,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    fileCount,
    onToggle,
}: {
    folder: TreeFolder;
    depth: number;
    isExpanded: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    fileCount: number;
    onToggle: () => void;
}): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    const resolvedIcon = resolveFolderIcon(
        folder.path || folder.name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );
    return (
        <Flex
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            onClick={onToggle}
            title={folder.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <Box
                as="span"
                fontSize="11px"
                w="14px"
                textAlign="center"
                flexShrink={0}
                opacity={0.7}
                transform={isExpanded ? "rotate(90deg)" : undefined}
                transition="transform 0.15s ease"
                display="inline-block"
            >
                &#9654;
            </Box>
            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
            <Box as="span" flex={1} opacity={0.85}>
                {folder.name}
            </Box>
            <Box as="span" ml="auto" fontSize="11px" color="var(--vscode-descriptionForeground)">
                {fileCount} file{fileCount !== 1 ? "s" : ""}
            </Box>
        </Flex>
    );
}

const CommitFileRow = React.memo(function CommitFileRow({
    file,
    depth,
    commitHash,
    commitShortHash,
    repoRoot,
    isSelected,
    onSelectFile,
    onOpenDiff,
}: {
    file: CommitFile;
    depth: number;
    commitHash: string;
    commitShortHash: string;
    repoRoot: string;
    isSelected: boolean;
    onSelectFile: (path: string) => void;
    onOpenDiff?: (commitHash: string, filePath: string, repoRoot: string) => void;
}): React.ReactElement {
    const padLeft = INFO_INDENT_BASE + depth * INFO_INDENT_STEP;
    const fileName = getLeafName(file.path);
    const rowBackground = isTestFilePath(file.path) ? TEST_FILE_ROW_BACKGROUND : undefined;
    const rowRef = useRef<HTMLDivElement>(null);

    const openDiff = useCallback(() => {
        onOpenDiff?.(commitHash, file.path, repoRoot);
    }, [onOpenDiff, commitHash, file.path, repoRoot]);

    const selectFile = useCallback(() => {
        onSelectFile(file.path);
    }, [file.path, onSelectFile]);

    useEffect(() => {
        const el = rowRef.current;
        if (!el) return;
        const handleDblClick = () => openDiff();
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                selectFile();
                openDiff();
            }
        };
        el.addEventListener("dblclick", handleDblClick);
        el.addEventListener("keydown", handleKeyDown);
        return () => {
            el.removeEventListener("dblclick", handleDblClick);
            el.removeEventListener("keydown", handleKeyDown);
        };
    }, [openDiff, selectFile]);

    const vscodeContext = useMemo(
        () =>
            JSON.stringify({
                webviewSection: "commitInfoFile",
                filePath: file.path,
                commitHash,
                commitShortHash,
                repoRoot,
                preventDefaultContextMenuItems: true,
            }),
        [file.path, commitHash, commitShortHash, repoRoot],
    );

    return (
        <Flex
            ref={rowRef}
            align="center"
            gap="4px"
            pl={`${padLeft}px`}
            pr="6px"
            lineHeight="22px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            position="relative"
            tabIndex={0}
            role="treeitem"
            aria-selected={isSelected}
            bg={isSelected ? "var(--vscode-list-activeSelectionBackground)" : rowBackground}
            color={isSelected ? "var(--vscode-list-activeSelectionForeground)" : undefined}
            _hover={{
                bg: isSelected
                    ? "var(--vscode-list-activeSelectionBackground)"
                    : "var(--vscode-list-hoverBackground)",
            }}
            onClick={selectFile}
            onFocus={selectFile}
            data-vscode-context={vscodeContext}
            title={file.path}
        >
            <InfoIndentGuides treeDepth={depth} />
            <Box as="span" w="14px" flexShrink={0} />
            <FileTypeIcon status={file.status} icon={file.icon} />
            <Box as="span" flex={1} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {fileName}
            </Box>
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #2ea043)"
                            mr="4px"
                        >
                            +{file.additions}
                        </Box>
                    )}
                    {file.deletions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-deletedResourceForeground, #f85149)"
                        >
                            -{file.deletions}
                        </Box>
                    )}
                </Box>
            )}
            <StatusBadge status={file.status} />
        </Flex>
    );
});

function InfoIndentGuides({ treeDepth }: { treeDepth: number }): React.ReactElement {
    return (
        <>
            <Box
                as="span"
                position="absolute"
                top={0}
                bottom={0}
                w="1px"
                bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                left={`${INFO_SECTION_GUIDE}px`}
            />
            {Array.from({ length: treeDepth }, (_, i) => (
                <Box
                    key={i}
                    as="span"
                    position="absolute"
                    top={0}
                    bottom={0}
                    w="1px"
                    bg="var(--vscode-tree-indentGuidesStroke, rgba(255, 255, 255, 0.12))"
                    left={`${INFO_GUIDE_BASE + i * INFO_INDENT_STEP}px`}
                />
            ))}
        </>
    );
}
