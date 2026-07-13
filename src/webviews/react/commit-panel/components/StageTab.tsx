import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Flex } from "@chakra-ui/react";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";
import type {
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../../types";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import type { TreeEntry } from "../types";
import { FileTypeIcon } from "./FileTypeIcon";
import { TreeFolderIcon } from "./TreeIcons";
import { getLeafName, getParentPath, resolveFolderIcon } from "../../shared/utils";

interface Props {
    files: WorkingFile[];
    repositories: RepositoryContextInfo[];
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
}

export function StageTab({
    files,
    repositories,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
}: Props): React.ReactElement {
    const vscode = getVsCodeApi();
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const groupedRepositories = useMemo(
        () =>
            repositories
                .map((repository) => ({
                    repository,
                    files: files.filter((file) => file.repoRoot === repository.root),
                }))
                .filter((group) => group.files.length > 0),
        [files, repositories],
    );

    const runAction = useCallback(
        (staged: boolean, targets: WorkingFile[]) => {
            vscode.postMessage({
                type: staged ? "unstageFiles" : "stageFiles",
                targets: targets.map((file) => ({ repoRoot: file.repoRoot, path: file.path })),
            });
        },
        [vscode],
    );

    if (groupedRepositories.length === 0) {
        return (
            <Box
                color="var(--vscode-descriptionForeground)"
                fontSize="12px"
                p="12px"
                textAlign="center"
            >
                No changes
            </Box>
        );
    }

    return (
        <Box flex={1} overflowY="auto" pt="2px">
            {groupedRepositories.map(({ repository, files: repoFiles }) => (
                <Box
                    key={repository.root}
                    borderBottom="1px solid var(--vscode-panel-border, #444)"
                >
                    {groupedRepositories.length > 1 && (
                        <Box
                            px="10px"
                            py="5px"
                            fontSize="12px"
                            fontWeight={700}
                            title={repository.root}
                        >
                            {repository.name}
                        </Box>
                    )}
                    {[true, false].map((staged) => {
                        const sectionFiles = repoFiles.filter((file) => file.staged === staged);
                        if (sectionFiles.length === 0) return null;
                        return (
                            <StageSection
                                key={staged ? "staged" : "unstaged"}
                                label={staged ? "Staged" : "Unstaged"}
                                files={sectionFiles}
                                staged={staged}
                                selectedKey={selectedKey}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                groupByDir={groupByDir}
                                onAction={(targets) => runAction(staged, targets)}
                                onSelect={(file) => {
                                    setSelectedKey(fileKey(file));
                                    vscode.postMessage({
                                        type: "showStageDiff",
                                        target: { repoRoot: file.repoRoot, path: file.path },
                                        staged: file.staged,
                                    });
                                }}
                            />
                        );
                    })}
                </Box>
            ))}
        </Box>
    );
}

interface StageSectionProps extends Omit<Props, "repositories"> {
    label: string;
    staged: boolean;
    selectedKey: string | null;
    onAction: (files: WorkingFile[]) => void;
    onSelect: (file: WorkingFile) => void;
}

function StageSection({
    label,
    files,
    staged,
    selectedKey,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    groupByDir,
    onAction,
    onSelect,
}: StageSectionProps): React.ReactElement {
    const tree = useFileTree(files, groupByDir);
    const [isOpen, setIsOpen] = useState(true);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

    useEffect(() => {
        setExpandedDirs(new Set(collectAllDirPaths(tree)));
    }, [tree]);

    return (
        <Box>
            <Flex align="center" minH="28px" px="8px" fontFamily={SYSTEM_FONT_STACK}>
                <Button
                    variant="unstyled"
                    minW="18px"
                    h="22px"
                    fontSize="10px"
                    opacity={0.7}
                    transform={isOpen ? "rotate(90deg)" : undefined}
                    onClick={() => setIsOpen((open) => !open)}
                    aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`}
                >
                    &#9654;
                </Button>
                <Box fontSize="12px" fontWeight={700}>
                    {label}
                </Box>
                <Box ml="4px" fontSize="11px" color="var(--vscode-descriptionForeground)">
                    {files.length} {files.length === 1 ? "file" : "files"}
                </Box>
                <Button
                    variant="toolbarGhost"
                    size="xs"
                    ml="auto"
                    h="20px"
                    px="6px"
                    fontSize="11px"
                    onClick={() => onAction(files)}
                >
                    {staged ? "Unstage All" : "Stage All"}
                </Button>
            </Flex>
            {isOpen && (
                <StageTreeEntries
                    entries={tree}
                    depth={0}
                    staged={staged}
                    selectedKey={selectedKey}
                    expandedDirs={expandedDirs}
                    folderIcon={folderIcon}
                    folderExpandedIcon={folderExpandedIcon}
                    folderIconsByName={folderIconsByName}
                    groupByDir={groupByDir}
                    onToggleDir={(dirPath) =>
                        setExpandedDirs((current) => {
                            const next = new Set(current);
                            if (next.has(dirPath)) next.delete(dirPath);
                            else next.add(dirPath);
                            return next;
                        })
                    }
                    onAction={(file) => onAction([file])}
                    onSelect={onSelect}
                />
            )}
        </Box>
    );
}

interface StageTreeEntriesProps {
    entries: TreeEntry[];
    depth: number;
    staged: boolean;
    selectedKey: string | null;
    expandedDirs: Set<string>;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    groupByDir: boolean;
    onToggleDir: (dirPath: string) => void;
    onAction: (file: WorkingFile) => void;
    onSelect: (file: WorkingFile) => void;
}

function StageTreeEntries(props: StageTreeEntriesProps): React.ReactElement {
    return (
        <>
            {props.entries.map((entry) => {
                if (entry.type === "file") {
                    const isSelected = props.selectedKey === fileKey(entry.file);
                    const parentPath = getParentPath(entry.file.path);
                    return (
                        <Flex
                            key={fileKey(entry.file)}
                            role="group"
                            align="center"
                            gap="5px"
                            minH="24px"
                            pl={`${26 + props.depth * 18}px`}
                            pr="8px"
                            cursor="pointer"
                            fontSize="12px"
                            fontFamily={SYSTEM_FONT_STACK}
                            bg={
                                isSelected
                                    ? "var(--vscode-list-activeSelectionBackground)"
                                    : undefined
                            }
                            color={
                                isSelected
                                    ? "var(--vscode-list-activeSelectionForeground)"
                                    : undefined
                            }
                            _hover={{
                                bg: isSelected
                                    ? "var(--vscode-list-activeSelectionBackground)"
                                    : "var(--vscode-list-hoverBackground)",
                            }}
                            onClick={() => props.onSelect(entry.file)}
                            title={entry.file.path}
                        >
                            <FileTypeIcon status={entry.file.status} icon={entry.file.icon} />
                            <Box overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                {getLeafName(entry.file.path)}
                            </Box>
                            {!props.groupByDir && parentPath && (
                                <Box color="var(--vscode-descriptionForeground)" fontSize="11px">
                                    {parentPath}
                                </Box>
                            )}
                            <Button
                                variant="unstyled"
                                minW="20px"
                                h="20px"
                                ml="auto"
                                fontSize="18px"
                                lineHeight="18px"
                                opacity={isSelected ? 1 : 0}
                                _groupHover={{ opacity: 1 }}
                                aria-label={`${props.staged ? "Unstage" : "Stage"} ${entry.file.path}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    props.onAction(entry.file);
                                }}
                            >
                                {props.staged ? "−" : "+"}
                            </Button>
                        </Flex>
                    );
                }

                const isExpanded = props.expandedDirs.has(entry.path);
                const resolvedIcon = resolveFolderIcon(
                    entry.path,
                    isExpanded,
                    props.folderIconsByName,
                    props.folderIcon,
                    props.folderExpandedIcon,
                );
                return (
                    <React.Fragment key={entry.path}>
                        <Flex
                            align="center"
                            gap="5px"
                            minH="24px"
                            pl={`${10 + props.depth * 18}px`}
                            pr="8px"
                            cursor="pointer"
                            fontSize="12px"
                            _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
                            onClick={() => props.onToggleDir(entry.path)}
                        >
                            <Box
                                fontSize="10px"
                                w="12px"
                                textAlign="center"
                                opacity={0.7}
                                transform={isExpanded ? "rotate(90deg)" : undefined}
                            >
                                &#9654;
                            </Box>
                            <TreeFolderIcon isExpanded={isExpanded} icon={resolvedIcon} />
                            <Box>{entry.name}</Box>
                            <Box
                                ml="3px"
                                fontSize="11px"
                                color="var(--vscode-descriptionForeground)"
                            >
                                {entry.descendantFiles.length}{" "}
                                {entry.descendantFiles.length === 1 ? "file" : "files"}
                            </Box>
                        </Flex>
                        {isExpanded && (
                            <StageTreeEntries
                                {...props}
                                entries={entry.children}
                                depth={props.depth + 1}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}

function fileKey(file: WorkingFile): string {
    return `${file.repoRoot}\u0000${file.path}\u0000${file.staged ? "staged" : "unstaged"}`;
}
