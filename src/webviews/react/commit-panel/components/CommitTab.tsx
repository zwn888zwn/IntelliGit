// The main Commit tab: toolbar + file tree + drag handle + commit area.
// Composes all commit-related sub-components into the commit workflow.

import React, { useRef, useState, useCallback } from "react";
import { Flex, Box } from "@chakra-ui/react";
import { Toolbar } from "./Toolbar";
import { FileTree } from "./FileTree";
import { CommitArea } from "./CommitArea";
import { useDragResize } from "../hooks/useDragResize";
import { getVsCodeApi } from "../hooks/useVsCodeApi";
import type {
    RepoPathRef,
    RepositoryContextInfo,
    ThemeFolderIconMap,
    ThemeTreeIcon,
    WorkingFile,
} from "../../../../types";
import { getCheckedFileKey } from "../hooks/useCheckedFiles";

interface Props {
    files: WorkingFile[];
    repositories: RepositoryContextInfo[];
    currentRepository: RepositoryContextInfo | null;
    folderIcon?: ThemeTreeIcon;
    folderExpandedIcon?: ThemeTreeIcon;
    folderIconsByName?: ThemeFolderIconMap;
    commitMessage: string;
    isAmend: boolean;
    isRefreshing: boolean;
    checkedPaths: Set<string>;
    onToggleFile: (file: WorkingFile) => void;
    onToggleFolder: (files: WorkingFile[]) => void;
    onToggleSection: (files: WorkingFile[]) => void;
    isAllChecked: (files: WorkingFile[]) => boolean;
    isSomeChecked: (files: WorkingFile[]) => boolean;
    onMessageChange: (message: string) => void;
    onAmendChange: (isAmend: boolean) => void;
    onCommit: () => void;
    onCommitAndPush: () => void;
    groupByDir: boolean;
    onToggleGroupBy: () => void;
}

export function CommitTab({
    files,
    repositories,
    currentRepository,
    folderIcon,
    folderExpandedIcon,
    folderIconsByName,
    commitMessage,
    isAmend,
    isRefreshing,
    checkedPaths,
    onToggleFile,
    onToggleFolder,
    onToggleSection,
    isAllChecked,
    isSomeChecked,
    onMessageChange,
    onAmendChange,
    onCommit,
    onCommitAndPush,
    groupByDir,
    onToggleGroupBy,
}: Props): React.ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const { height: bottomHeight, onMouseDown: onDragMouseDown } = useDragResize(
        140,
        80,
        containerRef,
    );
    const vscode = getVsCodeApi();
    const [expandAllSignal, setExpandAllSignal] = useState(0);
    const [collapseAllSignal, setCollapseAllSignal] = useState(0);

    const handleRefresh = useCallback(() => {
        vscode.postMessage({ type: "refresh" });
    }, [vscode]);

    const handleRollback = useCallback(() => {
        const targets = files
            .filter((file) => checkedPaths.has(getCheckedFileKey(file)))
            .map<RepoPathRef>((file) => ({ repoRoot: file.repoRoot, path: file.path }));
        vscode.postMessage({ type: "rollback", targets });
    }, [vscode, checkedPaths, files]);

    const handleShelve = useCallback(() => {
        const selected = files
            .filter((file) => checkedPaths.has(getCheckedFileKey(file)))
            .map<RepoPathRef>((file) => ({ repoRoot: file.repoRoot, path: file.path }));
        vscode.postMessage({
            type: "shelveSave",
            targets: selected.length > 0 ? selected : undefined,
        });
    }, [vscode, checkedPaths, files]);

    const handleShowDiff = useCallback(() => {
        const selected = files.filter((file) => checkedPaths.has(getCheckedFileKey(file)));
        if (selected.length > 0) {
            vscode.postMessage({
                type: "showDiff",
                target: { repoRoot: selected[0].repoRoot, path: selected[0].path },
            });
        }
    }, [vscode, checkedPaths, files]);

    const handleFileClick = useCallback(
        (file: WorkingFile) => {
            vscode.postMessage({
                type: "showDiff",
                target: { repoRoot: file.repoRoot, path: file.path },
            });
        },
        [vscode],
    );

    return (
        <Flex ref={containerRef} direction="column" flex={1} overflow="hidden">
            <Toolbar
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing}
                onRollback={handleRollback}
                onToggleGroupBy={onToggleGroupBy}
                onShelve={handleShelve}
                onShowDiff={handleShowDiff}
                onExpandAll={() => setExpandAllSignal((s) => s + 1)}
                onCollapseAll={() => setCollapseAllSignal((s) => s + 1)}
            />

            <Box flex="1 1 auto" overflowY="auto" minH="40px">
                <FileTree
                    repositories={repositories}
                    currentRepository={currentRepository}
                    files={files}
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
                    onSelectRepository={(repoRoot) =>
                        vscode.postMessage({ type: "setCurrentRepository", repoRoot })
                    }
                    onFileClick={handleFileClick}
                    expandAllSignal={expandAllSignal}
                    collapseAllSignal={collapseAllSignal}
                />
            </Box>

            {/* Drag handle */}
            <Box
                flex="0 0 4px"
                cursor="row-resize"
                bg="var(--vscode-panel-border, #444)"
                position="relative"
                _hover={{ bg: "var(--vscode-focusBorder, #007acc)" }}
                onMouseDown={onDragMouseDown}
                _after={{
                    content: '""',
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: "translate(-50%, -50%)",
                    w: "26px",
                    h: "2px",
                    bg: "var(--vscode-descriptionForeground)",
                    opacity: 0.35,
                    borderRadius: "1px",
                }}
            />

            {/* Bottom area */}
            <Box
                flexShrink={0}
                h={`${bottomHeight}px`}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                <CommitArea
                    commitMessage={commitMessage}
                    isAmend={isAmend}
                    onMessageChange={onMessageChange}
                    onAmendChange={onAmendChange}
                    onCommit={onCommit}
                    onCommitAndPush={onCommitAndPush}
                />
            </Box>
        </Flex>
    );
}
