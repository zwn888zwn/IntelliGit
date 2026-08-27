import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Box, ChakraProvider, Flex } from "@chakra-ui/react";
import theme from "../commit-panel/theme";
import { getVsCodeApi } from "../shared/vscodeApi";
import { buildFileTree, collectDirPaths, countFiles, type TreeEntry } from "../shared/fileTree";
import { ThemeIconFontFaces, TreeFileIcon, TreeFolderIcon } from "../shared/components";
import { StatusBadge } from "../commit-panel/components/StatusBadge";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";
import { GIT_STATUS_COLORS, TEST_FILE_ROW_BACKGROUND } from "../shared/tokens";
import { getLeafName, getParentPath, isTestFilePath, resolveFolderIcon } from "../shared/utils";
import type { ProjectComparisonFile } from "../../../types";
import type {
    ProjectComparisonInbound,
    ProjectComparisonOutbound,
    ProjectComparisonState,
} from "./types";

const INDENT_BASE = 10;
const INDENT_STEP = 16;

const initialState: ProjectComparisonState = {
    branchName: "",
    targetLabel: "",
    repository: null,
    files: [],
    iconFonts: [],
    isRefreshing: false,
    error: null,
};

function App(): React.ReactElement {
    const vscode = getVsCodeApi<ProjectComparisonOutbound, Record<string, unknown>>();
    const [state, setState] = useState<ProjectComparisonState>(initialState);
    const [activePath, setActivePath] = useState<string | null>(null);

    useEffect(() => {
        const listener = (event: MessageEvent<ProjectComparisonInbound>): void => {
            const message = event.data;
            if (message.type === "update") {
                setState((prev) => ({
                    ...prev,
                    branchName: message.branchName,
                    targetLabel: message.targetLabel,
                    repository: message.repository,
                    files: message.files,
                    folderIcon: message.folderIcon,
                    folderExpandedIcon: message.folderExpandedIcon,
                    folderIconsByName: message.folderIconsByName,
                    iconFonts: message.iconFonts ?? prev.iconFonts,
                    error: null,
                }));
                return;
            }
            if (message.type === "refreshing") {
                setState((prev) => ({ ...prev, isRefreshing: message.active }));
                return;
            }
            if (message.type === "setActiveFile") {
                setActivePath(message.path);
                return;
            }
            if (message.type === "error") {
                setState((prev) => ({ ...prev, error: message.message }));
            }
        };
        window.addEventListener("message", listener);
        vscode.postMessage({ type: "ready" });
        return () => window.removeEventListener("message", listener);
    }, [vscode]);

    const openDiff = useCallback(
        (file: ProjectComparisonFile) => {
            setActivePath(file.path);
            vscode.postMessage({ type: "openDiff", path: file.path });
        },
        [vscode],
    );

    return (
        <Flex direction="column" h="100%" bg="var(--vscode-editor-background)">
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <Header
                state={state}
                onRefresh={() => vscode.postMessage({ type: "refresh" })}
            />
            {state.error && (
                <Box
                    px="10px"
                    py="6px"
                    fontSize="12px"
                    color="var(--vscode-errorForeground)"
                    borderBottom="1px solid var(--vscode-panel-border)"
                >
                    {state.error}
                </Box>
            )}
            <Box flex={1} overflow="auto" role="tree" aria-label="Project comparison files">
                {state.files.length === 0 ? (
                    <Box
                        color="var(--vscode-descriptionForeground)"
                        fontSize="12px"
                        p="10px 12px"
                        textAlign="center"
                    >
                        {state.isRefreshing ? "Loading..." : "No differences"}
                    </Box>
                ) : (
                    <ComparisonTree
                        files={state.files}
                        activePath={activePath}
                        folderIcon={state.folderIcon}
                        folderExpandedIcon={state.folderExpandedIcon}
                        folderIconsByName={state.folderIconsByName}
                        onOpenDiff={openDiff}
                    />
                )}
            </Box>
        </Flex>
    );
}

function Header({
    state,
    onRefresh,
}: {
    state: ProjectComparisonState;
    onRefresh: () => void;
}): React.ReactElement {
    const repoLabel = state.repository?.relativePath ?? state.repository?.name ?? "";
    return (
        <Flex
            align="center"
            gap="8px"
            px="10px"
            py="7px"
            minH="34px"
            borderBottom="1px solid var(--vscode-panel-border)"
            fontFamily={SYSTEM_FONT_STACK}
        >
            <Box flex={1} minW={0} overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                <Box as="span" fontWeight={600}>
                    {state.branchName || "Branch"} {"\u2194"} {state.targetLabel || "Current"}
                </Box>
                {repoLabel && (
                    <Box
                        as="span"
                        ml="8px"
                        color="var(--vscode-descriptionForeground)"
                        fontSize="12px"
                    >
                        {repoLabel}
                    </Box>
                )}
            </Box>
            <Box
                as="button"
                type="button"
                aria-label="Refresh"
                title="Refresh"
                onClick={onRefresh}
                disabled={state.isRefreshing}
                w="26px"
                h="24px"
                border="0"
                borderRadius="3px"
                bg="transparent"
                color="var(--vscode-icon-foreground)"
                cursor={state.isRefreshing ? "default" : "pointer"}
                opacity={state.isRefreshing ? 0.55 : 1}
                _hover={{ bg: "var(--vscode-toolbar-hoverBackground)" }}
            >
                &#8635;
            </Box>
        </Flex>
    );
}

function ComparisonTree({
    files,
    activePath,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onOpenDiff,
}: {
    files: ProjectComparisonFile[];
    activePath: string | null;
    folderIcon?: ProjectComparisonState["folderIcon"];
    folderExpandedIcon?: ProjectComparisonState["folderExpandedIcon"];
    folderIconsByName?: ProjectComparisonState["folderIconsByName"];
    onOpenDiff: (file: ProjectComparisonFile) => void;
}): React.ReactElement {
    const tree = useMemo(() => buildFileTree(files), [files]);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const seenDirsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        const allDirs = collectDirPaths(tree);
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            let changed = false;
            for (const dir of allDirs) {
                if (!seenDirsRef.current.has(dir)) {
                    seenDirsRef.current.add(dir);
                    next.add(dir);
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [tree]);

    useEffect(() => {
        if (!activePath) return;
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            const parts = activePath.split("/");
            for (let i = 1; i < parts.length; i++) {
                next.add(parts.slice(0, i).join("/"));
            }
            return next;
        });
    }, [activePath]);

    const toggleDir = useCallback((dirPath: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(dirPath)) next.delete(dirPath);
            else next.add(dirPath);
            return next;
        });
    }, []);

    return (
        <Box py="4px">
            {tree.map((entry) => (
                <TreeEntryRow
                    key={entry.type === "folder" ? `d:${entry.path}` : `f:${entry.file.path}`}
                    entry={entry}
                    depth={0}
                    activePath={activePath}
                    expandedDirs={expandedDirs}
                    folderIcon={folderIcon}
                    folderExpandedIcon={folderExpandedIcon}
                    folderIconsByName={folderIconsByName}
                    onToggleDir={toggleDir}
                    onOpenDiff={onOpenDiff}
                />
            ))}
        </Box>
    );
}

function TreeEntryRow({
    entry,
    depth,
    activePath,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onOpenDiff,
}: {
    entry: TreeEntry<ProjectComparisonFile>;
    depth: number;
    activePath: string | null;
    expandedDirs: Set<string>;
    folderIcon?: ProjectComparisonState["folderIcon"];
    folderExpandedIcon?: ProjectComparisonState["folderExpandedIcon"];
    folderIconsByName?: ProjectComparisonState["folderIconsByName"];
    onToggleDir: (dirPath: string) => void;
    onOpenDiff: (file: ProjectComparisonFile) => void;
}): React.ReactElement {
    if (entry.type === "file") {
        return (
            <ComparisonFileRow
                file={entry.file}
                depth={depth}
                isActive={activePath === entry.file.path}
                onOpenDiff={onOpenDiff}
            />
        );
    }

    const isExpanded = expandedDirs.has(entry.path);
    const resolvedIcon = resolveFolderIcon(
        entry.path || entry.name,
        isExpanded,
        folderIconsByName,
        folderIcon,
        folderExpandedIcon,
    );
    const fileCount = countFiles(entry.children);
    return (
        <>
            <Flex
                align="center"
                gap="4px"
                minH="22px"
                lineHeight="22px"
                pl={`${INDENT_BASE + depth * INDENT_STEP}px`}
                pr="6px"
                fontSize="13px"
                fontFamily={SYSTEM_FONT_STACK}
                cursor="pointer"
                role="treeitem"
                aria-expanded={isExpanded}
                aria-level={depth + 1}
                tabIndex={0}
                whiteSpace="nowrap"
                title={entry.path}
                _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                onClick={() => onToggleDir(entry.path)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onToggleDir(entry.path);
                        return;
                    }
                    if (event.key === "ArrowRight") {
                        event.preventDefault();
                        if (!isExpanded) onToggleDir(entry.path);
                        return;
                    }
                    if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        if (isExpanded) onToggleDir(entry.path);
                    }
                }}
            >
                <Box
                    as="span"
                    fontSize="11px"
                    w="14px"
                    textAlign="center"
                    flexShrink={0}
                    opacity={0.7}
                    transform={isExpanded ? "rotate(90deg)" : undefined}
                    transition="transform 0.15s ease"
                >
                    &#9654;
                </Box>
                <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
                <Box as="span" flex={1} minW={0} overflow="hidden" textOverflow="ellipsis">
                    {entry.name}
                </Box>
                <Box
                    as="span"
                    ml="6px"
                    flexShrink={0}
                    fontSize="11px"
                    color="var(--vscode-descriptionForeground)"
                >
                    {fileCount} {fileCount === 1 ? "file" : "files"}
                </Box>
            </Flex>
            {isExpanded &&
                entry.children.map((child) => (
                    <TreeEntryRow
                        key={child.type === "folder" ? `d:${child.path}` : `f:${child.file.path}`}
                        entry={child}
                        depth={depth + 1}
                        activePath={activePath}
                        expandedDirs={expandedDirs}
                        folderIcon={folderIcon}
                        folderExpandedIcon={folderExpandedIcon}
                        folderIconsByName={folderIconsByName}
                        onToggleDir={onToggleDir}
                        onOpenDiff={onOpenDiff}
                    />
                ))}
        </>
    );
}

function ComparisonFileRow({
    file,
    depth,
    isActive,
    onOpenDiff,
}: {
    file: ProjectComparisonFile;
    depth: number;
    isActive: boolean;
    onOpenDiff: (file: ProjectComparisonFile) => void;
}): React.ReactElement {
    const rowRef = useRef<HTMLDivElement>(null);
    const fileName = getLeafName(file.path);
    const dir = getParentPath(file.path);
    const statusColor = GIT_STATUS_COLORS[file.status] ?? "var(--vscode-foreground)";
    const rowBackground = isTestFilePath(file.path) ? TEST_FILE_ROW_BACKGROUND : undefined;

    useEffect(() => {
        if (!isActive || typeof rowRef.current?.scrollIntoView !== "function") return;
        rowRef.current.scrollIntoView({ block: "nearest" });
    }, [isActive]);

    return (
        <Flex
            ref={rowRef}
            align="center"
            gap="4px"
            minH="22px"
            lineHeight="22px"
            pl={`${INDENT_BASE + depth * INDENT_STEP}px`}
            pr="6px"
            fontSize="13px"
            fontFamily={SYSTEM_FONT_STACK}
            cursor="pointer"
            role="treeitem"
            aria-selected={isActive}
            aria-level={depth + 1}
            tabIndex={0}
            bg={isActive ? "var(--vscode-list-activeSelectionBackground)" : rowBackground}
            color={isActive ? "var(--vscode-list-activeSelectionForeground)" : undefined}
            title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} -> ${file.path}` : file.path}
            _hover={{
                bg: isActive
                    ? "var(--vscode-list-activeSelectionBackground)"
                    : "var(--vscode-list-hoverBackground)",
            }}
            onClick={() => onOpenDiff(file)}
            onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenDiff(file);
            }}
        >
            <Box as="span" w="14px" flexShrink={0} />
            <TreeFileIcon status={file.status} icon={file.icon} />
            <Box
                as="span"
                flex={1}
                minW={0}
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                color={statusColor}
                textDecoration={file.status === "D" ? "line-through" : undefined}
            >
                {fileName}
            </Box>
            {depth === 0 && dir && (
                <Box as="span" color="var(--vscode-descriptionForeground)" fontSize="11px" ml="3px">
                    {dir}
                </Box>
            )}
            {(file.additions > 0 || file.deletions > 0) && (
                <Box as="span" ml="auto" fontSize="11px" flexShrink={0}>
                    {file.additions > 0 && (
                        <Box
                            as="span"
                            color="var(--vscode-gitDecoration-addedResourceForeground, #2ea043)"
                            mr="3px"
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
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
