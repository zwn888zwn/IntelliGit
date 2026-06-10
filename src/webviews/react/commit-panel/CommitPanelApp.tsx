// Entry point for the commit panel React webview. Wraps the app in
// ChakraProvider with the VS Code theme and composes all panels.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChakraProvider, Box } from "@chakra-ui/react";
import theme from "./theme";
import { TabBar } from "./components/TabBar";
import { CommitTab } from "./components/CommitTab";
import { ShelfTab } from "./components/ShelfTab";
import { StashDialog } from "./components/StashDialog";
import { useExtensionMessages } from "./hooks/useExtensionMessages";
import { getCheckedFileKey, useCheckedFiles } from "./hooks/useCheckedFiles";
import { getVsCodeApi } from "./hooks/useVsCodeApi";
import { ThemeIconFontFaces } from "../shared/components";
import type { RepositoryContextInfo } from "../../../types";

const EMPTY_REPOSITORIES: RepositoryContextInfo[] = [];

function App(): React.ReactElement {
    const [state, dispatch] = useExtensionMessages();
    const repositories = state.repositories ?? EMPTY_REPOSITORIES;
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(state.files);

    const vscode = getVsCodeApi();
    const [groupByDir, setGroupByDir] = useState<boolean>(() => {
        const saved = vscode.getState?.();
        return typeof saved?.groupByDir === "boolean" ? saved.groupByDir : true;
    });

    useEffect(() => {
        const prev = vscode.getState?.() ?? {};
        vscode.setState({ ...prev, groupByDir });
    }, [groupByDir, vscode]);

    const checkedTargets = useMemo(
        () =>
            state.files
                .filter((file) => checkedPaths.has(getCheckedFileKey(file)))
                .map((file) => ({ repoRoot: file.repoRoot, path: file.path })),
        [checkedPaths, state.files],
    );

    const [isStashDialogOpen, setIsStashDialogOpen] = useState(false);
    const [stashRepoRoot, setStashRepoRoot] = useState(state.repository?.root ?? "");
    const [stashMessage, setStashMessage] = useState("");
    const [stashKeepIndex, setStashKeepIndex] = useState(false);

    useEffect(() => {
        if (!isStashDialogOpen) {
            setStashRepoRoot(state.repository?.root ?? repositories[0]?.root ?? "");
        }
    }, [isStashDialogOpen, repositories, state.repository?.root]);

    const handleMessageChange = useCallback(
        (message: string) => {
            dispatch({ type: "SET_COMMIT_MESSAGE", message });
        },
        [dispatch],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            dispatch({ type: "SET_AMEND", isAmend });
            if (isAmend) {
                vscode.postMessage({ type: "getLastCommitMessage" });
            }
        },
        [dispatch, vscode],
    );

    const stageCheckedAndCommit = useCallback(
        (push: boolean) => {
            const msg = state.commitMessage.trim();
            const targets = state.files
                .filter((file) => checkedPaths.has(getCheckedFileKey(file)))
                .map((file) => ({ repoRoot: file.repoRoot, path: file.path }));
            vscode.postMessage({
                type: "commitSelected",
                targets,
                message: msg,
                amend: state.isAmend,
                push,
            });
        },
        [vscode, state.commitMessage, state.isAmend, checkedPaths],
    );

    const handleCommit = useCallback(() => {
        stageCheckedAndCommit(false);
    }, [stageCheckedAndCommit]);

    const handleCommitAndPush = useCallback(() => {
        stageCheckedAndCommit(true);
    }, [stageCheckedAndCommit]);

    const handleOpenStashDialog = useCallback(() => {
        setStashRepoRoot(
            checkedTargets[0]?.repoRoot ??
                state.repository?.root ??
                repositories[0]?.root ??
                "",
        );
        setStashMessage("");
        setStashKeepIndex(false);
        setIsStashDialogOpen(true);
    }, [checkedTargets, repositories, state.repository?.root]);

    const handleCreateStash = useCallback(() => {
        const scopedTargets = checkedTargets.filter((target) => target.repoRoot === stashRepoRoot);
        vscode.postMessage({
            type: "shelveSave",
            repoRoot: stashRepoRoot,
            targets: scopedTargets.length > 0 ? scopedTargets : undefined,
            name: stashMessage.trim() || "Shelved changes",
            keepIndex: stashKeepIndex,
        });
        setIsStashDialogOpen(false);
    }, [checkedTargets, stashKeepIndex, stashMessage, stashRepoRoot, vscode]);

    return (
        <Box display="flex" flexDirection="column" h="100%">
            <ThemeIconFontFaces fonts={state.iconFonts} />
            <Box flex={1} overflow="hidden" display="flex" flexDirection="column">
                <StashDialog
                    isOpen={isStashDialogOpen}
                    repositories={repositories}
                    repoRoot={stashRepoRoot}
                    message={stashMessage}
                    keepIndex={stashKeepIndex}
                    selectedCount={
                        checkedTargets.filter((target) => target.repoRoot === stashRepoRoot).length
                    }
                    onRepoRootChange={setStashRepoRoot}
                    onMessageChange={setStashMessage}
                    onKeepIndexChange={setStashKeepIndex}
                    onCancel={() => setIsStashDialogOpen(false)}
                    onCreate={handleCreateStash}
                />
                <TabBar
                    stashCount={state.stashes.length}
                    repositoryLabel={
                        state.repository?.relativePath ?? state.repository?.name ?? "No repository"
                    }
                    commitContent={
                        <CommitTab
                            files={state.files}
                            repositories={repositories}
                            currentRepository={state.repository}
                            activeFile={state.activeFile}
                            commitMessage={state.commitMessage}
                            isAmend={state.isAmend}
                            isRefreshing={state.isRefreshing}
                            checkedPaths={checkedPaths}
                            onToggleFile={toggleFile}
                            onToggleFolder={toggleFolder}
                            onToggleSection={toggleSection}
                            isAllChecked={isAllChecked}
                            isSomeChecked={isSomeChecked}
                            onMessageChange={handleMessageChange}
                            onAmendChange={handleAmendChange}
                            onCommit={handleCommit}
                            onCommitAndPush={handleCommitAndPush}
                            onCreateStash={handleOpenStashDialog}
                            folderIcon={state.folderIcon}
                            folderExpandedIcon={state.folderExpandedIcon}
                            folderIconsByName={state.folderIconsByName}
                            groupByDir={groupByDir}
                            onToggleGroupBy={() => setGroupByDir((g) => !g)}
                        />
                    }
                    shelfContent={
                        <ShelfTab
                            stashes={state.stashes}
                            shelfFiles={state.shelfFiles}
                            selectedIndex={state.selectedShelfIndex}
                            folderIcon={state.folderIcon}
                            folderExpandedIcon={state.folderExpandedIcon}
                            folderIconsByName={state.folderIconsByName}
                            groupByDir={groupByDir}
                            onCreateStash={handleOpenStashDialog}
                        />
                    }
                />
            </Box>
        </Box>
    );
}

const root = createRoot(document.getElementById("root")!);
root.render(
    <ChakraProvider theme={theme}>
        <App />
    </ChakraProvider>,
);
