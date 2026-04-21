// Main file tree component for the commit panel. Renders workspace changes
// grouped by repository, then by tracked/unversioned sections and folders.

import React, { useMemo, useCallback, useRef, useState } from "react";
import { Box, Flex } from "@chakra-ui/react";
import { SectionHeader } from "./SectionHeader";
import { FolderRow } from "./FolderRow";
import { FileRow } from "./FileRow";
import { useFileTree, collectAllDirPaths } from "../hooks/useFileTree";
import { getCheckedFileKey } from "../hooks/useCheckedFiles";
import type {
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../../types";
import type { TreeEntry } from "../types";

interface Props {
    repositories: RepositoryContextInfo[];
    currentRepository: RepositoryContextInfo | null;
    files: WorkingFile[];
    groupByDir: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    checkedPaths: Set<string>;
    onToggleFile: (file: WorkingFile) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onSelectRepository: (repoRoot: string) => void;
    onFileClick: (file: WorkingFile) => void;
    expandAllSignal: number;
    collapseAllSignal: number;
}

export function FileTree({
    repositories,
    currentRepository,
    files,
    groupByDir,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onSelectRepository,
    onFileClick,
    expandAllSignal,
    collapseAllSignal,
}: Props): React.ReactElement {
    const groupedRepositories = useMemo(
        () =>
            repositories
                .map((repository) => ({
                    repository,
                    files: files.filter((file) => file.repoRoot === repository.root),
                }))
                .filter((group) => group.files.length > 0),
        [repositories, files],
    );

    if (groupedRepositories.length === 0) {
        return (
            <Box
                color="var(--vscode-descriptionForeground)"
                fontSize="12px"
                p="8px 12px"
                textAlign="center"
            >
                No changes
            </Box>
        );
    }

    return (
        <>
            {groupedRepositories.map(({ repository, files: repoFiles }) => (
                <RepositorySection
                    key={repository.root}
                    repository={repository}
                    isCurrent={currentRepository?.root === repository.root}
                    files={repoFiles}
                    groupByDir={groupByDir}
                    folderIcon={folderIcon}
                    folderExpandedIcon={folderExpandedIcon}
                    folderIconsByName={folderIconsByName}
                    checkedPaths={checkedPaths}
                    onToggleFile={onToggleFile}
                    onToggleFolder={onToggleFolder}
                    onToggleSection={onToggleSection}
                    isAllChecked={isAllChecked}
                    isSomeChecked={isSomeChecked}
                    onSelectRepository={onSelectRepository}
                    onFileClick={onFileClick}
                    expandAllSignal={expandAllSignal}
                    collapseAllSignal={collapseAllSignal}
                />
            ))}
        </>
    );
}

interface RepositorySectionProps extends Omit<Props, "repositories" | "currentRepository"> {
    repository: RepositoryContextInfo;
    isCurrent: boolean;
}

function RepositorySection({
    repository,
    isCurrent,
    files,
    groupByDir,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onSelectRepository,
    onFileClick,
    expandAllSignal,
    collapseAllSignal,
}: RepositorySectionProps): React.ReactElement {
    const [trackedOpen, setTrackedOpen] = useState(true);
    const [unversionedOpen, setUnversionedOpen] = useState(true);
    const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
    const lastExpandSignal = useRef(0);
    const lastCollapseSignal = useRef(0);
    const seenDirsRef = useRef<Set<string>>(new Set());

    const tracked = useMemo(() => files.filter((f) => f.status !== "?"), [files]);
    const unversioned = useMemo(() => files.filter((f) => f.status === "?"), [files]);
    const trackedTree = useFileTree(tracked, groupByDir);
    const unversionedTree = useFileTree(unversioned, groupByDir);

    React.useEffect(() => {
        if (expandAllSignal === 0 || expandAllSignal === lastExpandSignal.current) return;
        lastExpandSignal.current = expandAllSignal;
        setTrackedOpen(true);
        setUnversionedOpen(true);
        const allDirs = [
            ...collectAllDirPaths(trackedTree),
            ...collectAllDirPaths(unversionedTree),
        ].map((dirPath) => `${repository.root}\u0000${dirPath}`);
        for (const dir of allDirs) {
            seenDirsRef.current.add(dir);
        }
        setExpandedDirs(new Set(allDirs));
    }, [expandAllSignal, repository.root, trackedTree, unversionedTree]);

    React.useEffect(() => {
        if (collapseAllSignal === 0 || collapseAllSignal === lastCollapseSignal.current) return;
        lastCollapseSignal.current = collapseAllSignal;
        setTrackedOpen(true);
        setUnversionedOpen(true);
        setExpandedDirs(new Set());
    }, [collapseAllSignal]);

    React.useEffect(() => {
        const allDirs = [
            ...collectAllDirPaths(trackedTree),
            ...collectAllDirPaths(unversionedTree),
        ].map((dirPath) => `${repository.root}\u0000${dirPath}`);
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
    }, [repository.root, trackedTree, unversionedTree]);

    const toggleDir = useCallback((dirPath: string) => {
        const key = `${repository.root}\u0000${dirPath}`;
        setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, [repository.root]);

    return (
        <Box borderBottom="1px solid var(--vscode-panel-border, #444)">
            <Flex
                align="center"
                gap="8px"
                px="10px"
                py="6px"
                bg={isCurrent ? "rgba(90, 143, 233, 0.12)" : "transparent"}
                borderLeft={isCurrent ? "2px solid var(--vscode-focusBorder, #5a8fe9)" : "2px solid transparent"}
                cursor="pointer"
                onClick={() => onSelectRepository(repository.root)}
                title={repository.root}
                _hover={{ bg: "var(--vscode-list-hoverBackground)" }}
            >
                <Box
                    w="10px"
                    h="10px"
                    borderRadius="2px"
                    flexShrink={0}
                    bg={repository.color}
                    boxShadow={`0 0 0 1px ${repository.color}55`}
                />
                <Box flex={1} minW={0}>
                    <Box fontSize="12px" fontWeight={700} color="var(--vscode-foreground)">
                        {repository.name}
                    </Box>
                    <Box
                        fontSize="11px"
                        color="var(--vscode-descriptionForeground)"
                        whiteSpace="nowrap"
                        overflow="hidden"
                        textOverflow="ellipsis"
                    >
                        {repository.relativePath ?? repository.root}
                    </Box>
                </Box>
                <Box fontSize="11px" color="var(--vscode-descriptionForeground)" flexShrink={0}>
                    {files.length} {files.length === 1 ? "file" : "files"}
                </Box>
            </Flex>

            {tracked.length > 0 && (
                <>
                    <SectionHeader
                        label="Changes"
                        count={tracked.length}
                        isOpen={trackedOpen}
                        isAllChecked={isAllChecked(tracked)}
                        isSomeChecked={isSomeChecked(tracked)}
                        onToggleOpen={() => setTrackedOpen((o) => !o)}
                        onToggleCheck={() => onToggleSection(tracked)}
                    />
                    {trackedOpen && (
                        <TreeEntries
                            repositoryRoot={repository.root}
                            entries={trackedTree}
                            depth={0}
                            groupByDir={groupByDir}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
                        />
                    )}
                </>
            )}

            {unversioned.length > 0 && (
                <>
                    <SectionHeader
                        label="Unversioned Files"
                        count={unversioned.length}
                        isOpen={unversionedOpen}
                        isAllChecked={isAllChecked(unversioned)}
                        isSomeChecked={isSomeChecked(unversioned)}
                        onToggleOpen={() => setUnversionedOpen((o) => !o)}
                        onToggleCheck={() => onToggleSection(unversioned)}
                    />
                    {unversionedOpen && (
                        <TreeEntries
                            repositoryRoot={repository.root}
                            entries={unversionedTree}
                            depth={0}
                            groupByDir={groupByDir}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            expandedDirs={expandedDirs}
                            checkedPaths={checkedPaths}
                            onToggleFile={onToggleFile}
                            onToggleFolder={onToggleFolder}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onToggleDir={toggleDir}
                            onFileClick={onFileClick}
                        />
                    )}
                </>
            )}
        </Box>
    );
}

interface TreeEntriesProps {
    repositoryRoot: string;
    entries: TreeEntry[];
    depth: number;
    groupByDir: boolean;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    expandedDirs: Set<string>;
    checkedPaths: Set<string>;
    onToggleFile: (file: WorkingFile) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onToggleDir: (dirPath: string) => void;
    onFileClick: (file: WorkingFile) => void;
}

function TreeEntries({
    repositoryRoot,
    entries,
    depth,
    groupByDir,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    expandedDirs,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    isAllChecked,
    isSomeChecked,
    onToggleDir,
    onFileClick,
}: TreeEntriesProps): React.ReactElement {
    return (
        <>
            {entries.map((entry) => {
                if (entry.type === "file") {
                    return (
                        <FileRow
                            key={`${entry.file.repoRoot}:${entry.file.path}:${entry.file.staged ? "staged" : "unstaged"}`}
                            file={entry.file}
                            depth={depth}
                            isChecked={checkedPaths.has(getCheckedFileKey(entry.file))}
                            groupByDir={groupByDir}
                            onToggle={onToggleFile}
                            onClick={onFileClick}
                        />
                    );
                }

                const isExpanded = expandedDirs.has(`${repositoryRoot}\u0000${entry.path}`);
                const dirFiles = entry.descendantFiles;

                return (
                    <React.Fragment key={`${repositoryRoot}:${entry.path}`}>
                        <FolderRow
                            name={entry.name}
                            dirPath={entry.path}
                            depth={depth}
                            isExpanded={isExpanded}
                            folderIcon={folderIcon}
                            folderExpandedIcon={folderExpandedIcon}
                            folderIconsByName={folderIconsByName}
                            fileCount={dirFiles.length}
                            isAllChecked={isAllChecked(dirFiles)}
                            isSomeChecked={isSomeChecked(dirFiles)}
                            onToggleExpand={onToggleDir}
                            onToggleCheck={() => onToggleFolder(dirFiles)}
                        />
                        {isExpanded && (
                            <TreeEntries
                                repositoryRoot={repositoryRoot}
                                entries={entry.children}
                                depth={depth + 1}
                                groupByDir={groupByDir}
                                folderIcon={folderIcon}
                                folderExpandedIcon={folderExpandedIcon}
                                folderIconsByName={folderIconsByName}
                                expandedDirs={expandedDirs}
                                checkedPaths={checkedPaths}
                                onToggleFile={onToggleFile}
                                onToggleFolder={onToggleFolder}
                                isAllChecked={isAllChecked}
                                isSomeChecked={isSomeChecked}
                                onToggleDir={onToggleDir}
                                onFileClick={onFileClick}
                            />
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}
