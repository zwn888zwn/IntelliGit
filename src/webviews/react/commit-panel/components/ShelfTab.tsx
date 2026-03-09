// Shelf tab with selectable shelved entries, changed-file preview, and
// bottom Apply/Pop/Delete actions.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Flex, Box, Button } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import { FileTypeIcon } from "./FileTypeIcon";
import { TreeFolderIcon } from "./TreeIcons";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type { StashEntry, ThemeFolderIconMap, ThemeTreeIcon, WorkingFile } from "../../../../types";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { getLeafName, resolveFolderIcon } from "../../shared/utils";

interface Props {
    stashes: StashEntry[];
    shelfFiles: WorkingFile[];
    selectedIndex: number | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
}

type ShelfActionKind = "apply" | "pop" | "delete";

export function ShelfTab({
    stashes,
    shelfFiles,
    selectedIndex,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const tree = useFileTree(shelfFiles, groupByDir);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
    // expandedIndex tracks which stash entry the user has toggled open locally.
    // It is set optimistically on click (before files arrive from the extension host).
    // selectedIndex (prop) updates once the host responds with loaded files.
    // Collapsing only clears local state — no host message needed since no files to load.
    // The useEffect below re-syncs expandedIndex from selectedIndex on parent-driven
    // changes (e.g. after apply/pop/delete removes the selected stash).
    const [expandedIndex, setExpandedIndex] = useState<number | null>(selectedIndex);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        setExpandedIndex(selectedIndex);
        setIsLoading(false);
    }, [selectedIndex]);

    const handleStashClick = useCallback(
        (index: number) => {
            if (expandedIndex === index) {
                setExpandedIndex(null);
                setIsLoading(false);
            } else {
                setExpandedIndex(index);
                setIsLoading(true);
                vscode.postMessage({ type: "shelfSelect", index });
            }
        },
        [expandedIndex, vscode],
    );

    const handleShelfAction = useCallback(
        (index: number | null, kind: ShelfActionKind) => {
            if (index === null) return;
            switch (kind) {
                case "apply":
                    vscode.postMessage({ type: "shelfApply", index });
                    return;
                case "pop":
                    vscode.postMessage({ type: "shelfPop", index });
                    return;
                case "delete":
                    vscode.postMessage({ type: "shelfDelete", index });
                    return;
                default: {
                    const exhaustive: never = kind;
                    throw new Error(`Unhandled shelf action: ${String(exhaustive)}`);
                }
            }
        },
        [vscode],
    );

    const toggleDir = useCallback((path: string) => {
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    useEffect(() => {
        setExpandedDirs(new Set(collectAllDirPaths(tree)));
    }, [tree]);

    const [fileTreeHeight, setFileTreeHeight] = useState(150);
    const fileTreeHeightRef = useRef(fileTreeHeight);
    useEffect(() => {
        fileTreeHeightRef.current = fileTreeHeight;
    }, [fileTreeHeight]);

    const dragCleanupRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        return () => {
            dragCleanupRef.current?.();
        };
    }, []);

    const handleFileTreeDragStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startH = fileTreeHeightRef.current;

        const onMouseMove = (ev: MouseEvent) => {
            const delta = ev.clientY - startY;
            setFileTreeHeight(Math.max(60, startH + delta));
        };
        const cleanup = () => {
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            dragCleanupRef.current = null;
        };
        const onMouseUp = () => {
            cleanup();
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
        dragCleanupRef.current = cleanup;
    }, []);

    return (
        <Flex direction="column" flex={1} overflow="hidden">
            <Box flex="1 1 auto" overflowY="auto" pt="1px">
                {stashes.length === 0 ? (
                    <Box
                        color="var(--vscode-descriptionForeground)"
                        fontSize="12px"
                        p="12px"
                        textAlign="center"
                    >
                        No shelved changes
                    </Box>
                ) : (
                    stashes.map((stash) => {
                        const parsed = parseShelfMessage(stash.message);
                        const isExpanded = expandedIndex === stash.index;
                        const hasFiles = isExpanded && selectedIndex === stash.index;
                        return (
                            <React.Fragment key={stash.index}>
                                <Flex
                                    align="center"
                                    px="9px"
                                    py="2px"
                                    minH="24px"
                                    fontSize="12px"
                                    fontFamily={SYSTEM_FONT_STACK}
                                    cursor="pointer"
                                    bg={
                                        isExpanded
                                            ? "var(--vscode-list-activeSelectionBackground)"
                                            : "transparent"
                                    }
                                    color={
                                        isExpanded
                                            ? "var(--vscode-list-activeSelectionForeground)"
                                            : "var(--vscode-foreground)"
                                    }
                                    _hover={{
                                        bg: isExpanded
                                            ? "var(--vscode-list-activeSelectionBackground)"
                                            : "var(--vscode-list-hoverBackground)",
                                    }}
                                    onClick={() => handleStashClick(stash.index)}
                                    title={stash.message}
                                >
                                    <Box
                                        as="span"
                                        w="14px"
                                        textAlign="center"
                                        fontSize="10px"
                                        opacity={0.7}
                                        flexShrink={0}
                                        transform={isExpanded ? "rotate(90deg)" : undefined}
                                        transition="transform 0.15s"
                                    >
                                        &#9654;
                                    </Box>
                                    <Box
                                        as="span"
                                        flex={1}
                                        minW={0}
                                        overflow="hidden"
                                        textOverflow="ellipsis"
                                        whiteSpace="nowrap"
                                    >
                                        {parsed.title}
                                    </Box>
                                    {parsed.branch && (
                                        <Box
                                            as="span"
                                            ml="10px"
                                            display="inline-flex"
                                            alignItems="center"
                                            fontSize="10.5px"
                                            gap="4px"
                                            color="var(--vscode-gitDecoration-modifiedResourceForeground, #d8ca64)"
                                            flexShrink={0}
                                        >
                                            <Box
                                                as="svg"
                                                w="12px"
                                                h="12px"
                                                viewBox="0 0 16 16"
                                                opacity={0.95}
                                            >
                                                <path
                                                    fill="currentColor"
                                                    d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6.5a.5.5 0 0 1-.5.5H9.25a1.75 1.75 0 0 0-1.75 1.75v.872a2.25 2.25 0 1 1-1.5 0V4.372a2.25 2.25 0 1 1 1.5 0v3.256A3.25 3.25 0 0 1 9.25 6.5H12V5.372a2.25 2.25 0 0 1-2.5-2.122zM4.25 3.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5zM4.25 14a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5z"
                                                />
                                            </Box>
                                            {parsed.branch}
                                        </Box>
                                    )}
                                </Flex>
                                {isExpanded && !hasFiles && isLoading && (
                                    <Box
                                        pl="28px"
                                        py="4px"
                                        fontSize="12px"
                                        color="var(--vscode-descriptionForeground)"
                                    >
                                        Loading...
                                    </Box>
                                )}
                                {hasFiles && (
                                    <>
                                        <Box h={`${fileTreeHeight}px`} overflowY="auto">
                                            {shelfFiles.length > 0 ? (
                                                <ShelfFileTree
                                                    entries={tree}
                                                    expandedDirs={expandedDirs}
                                                    folderIcon={folderIcon}
                                                    folderExpandedIcon={folderExpandedIcon}
                                                    folderIconsByName={folderIconsByName}
                                                    onToggleDir={toggleDir}
                                                    onFileClick={(path) =>
                                                        vscode.postMessage({
                                                            type: "showShelfDiff",
                                                            index: stash.index,
                                                            path,
                                                        })
                                                    }
                                                    depth={1}
                                                />
                                            ) : (
                                                <Box
                                                    pl="28px"
                                                    py="2px"
                                                    fontSize="12px"
                                                    color="var(--vscode-descriptionForeground)"
                                                >
                                                    No files in this shelved change.
                                                </Box>
                                            )}
                                        </Box>
                                        <Box
                                            h="4px"
                                            flexShrink={0}
                                            cursor="row-resize"
                                            bg="var(--vscode-panel-border)"
                                            onMouseDown={handleFileTreeDragStart}
                                            _hover={{
                                                bg: "var(--vscode-focusBorder, #007acc)",
                                            }}
                                        />
                                    </>
                                )}
                            </React.Fragment>
                        );
                    })
                )}
            </Box>

            <Flex
                align="center"
                gap="8px"
                px="8px"
                py="8px"
                borderTop="1px solid var(--vscode-panel-border)"
            >
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "apply")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="86px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Apply
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "pop")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="68px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Pop
                </Button>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleShelfAction(selectedIndex, "delete")}
                    isDisabled={selectedIndex === null}
                    fontSize="12px"
                    h="28px"
                    minW="78px"
                    px="12px"
                    bg="rgba(255,255,255,0.07)"
                    borderColor="rgba(184, 194, 214, 0.5)"
                >
                    Delete
                </Button>
            </Flex>
        </Flex>
    );
}

function parseShelfMessage(message: string): { title: string; branch: string | null } {
    const trimmed = message.trim();
    const match = trimmed.match(/^On\s+([^:]+):\s*(.*)$/i);
    if (!match) return { title: trimmed || "Shelved changes", branch: null };
    return {
        title: match[2]?.trim() || "Shelved changes",
        branch: match[1]?.trim() || null,
    };
}

function ShelfFileTree({
    entries,
    expandedDirs,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    onToggleDir,
    onFileClick,
    depth = 0,
}: {
    entries: TreeEntry[];
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    onToggleDir: (path: string) => void;
    onFileClick: (path: string) => void;
    depth?: number;
}): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    const fileName = getLeafName(entry.file.path);
                    return (
                        <Flex
                            key={entry.file.path}
                            align="center"
                            pl={`${10 + depth * 16}px`}
                            pr="8px"
                            minH="20px"
                            gap="4px"
                            fontSize="12px"
                            fontFamily={SYSTEM_FONT_STACK}
                            cursor="pointer"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => onFileClick(entry.file.path)}
                            title={entry.file.path}
                        >
                            <Box as="span" w="11px" />
                            <FileTypeIcon status={entry.file.status} icon={entry.file.icon} />
                            <Box
                                as="span"
                                flex={1}
                                minW={0}
                                whiteSpace="nowrap"
                                overflow="hidden"
                                textOverflow="ellipsis"
                            >
                                {fileName}
                            </Box>
                        </Flex>
                    );
                }

                const isExpanded = expandedDirs.has(entry.path);
                const fileCount = entry.descendantFiles.length;
                const resolvedIcon = resolveFolderIcon(
                    entry.path || entry.name,
                    isExpanded,
                    folderIconsByName,
                    folderIcon,
                    folderExpandedIcon,
                );
                return (
                    <React.Fragment key={entry.path}>
                        <Flex
                            align="center"
                            pl={`${10 + depth * 16}px`}
                            pr="8px"
                            minH="20px"
                            gap="4px"
                            fontSize="12px"
                            fontFamily={SYSTEM_FONT_STACK}
                            cursor="pointer"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => onToggleDir(entry.path)}
                        >
                            <Box
                                as="span"
                                w="11px"
                                textAlign="center"
                                opacity={0.7}
                                transform={isExpanded ? "rotate(90deg)" : undefined}
                            >
                                &#9654;
                            </Box>
                            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
                            <Box
                                as="span"
                                flex={1}
                                minW={0}
                                whiteSpace="nowrap"
                                overflow="hidden"
                                textOverflow="ellipsis"
                            >
                                {entry.name}
                            </Box>
                            <Box
                                as="span"
                                fontSize="11px"
                                color="var(--vscode-descriptionForeground)"
                                flexShrink={0}
                            >
                                {fileCount} {fileCount === 1 ? "file" : "files"}
                            </Box>
                        </Flex>
                        {isExpanded && (
                            <ShelfFileTree
                                entries={entry.children}
                                expandedDirs={expandedDirs}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                                depth={depth + 1}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
