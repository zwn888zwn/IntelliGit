import "../shared/initTooltips";
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
    const commitFiles = useMemo(() => {
        const byPath = new Map<string, (typeof state.files)[number]>();
        for (const file of state.files) {
            const key = getCheckedFileKey(file);
            const current = byPath.get(key);
            // An externally staged addition is still a new file after another edit.
            if (current?.status === "A" && file.status === "M") continue;
            if (!current || !file.staged) byPath.set(key, file);
        }
        return Array.from(byPath.values());
    }, [state.files]);
    const { checkedPaths, toggleFile, toggleFolder, toggleSection, isAllChecked, isSomeChecked } =
        useCheckedFiles(repositories.length ? commitFiles : undefined);

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
            commitFiles
                .filter((file) => checkedPaths.has(getCheckedFileKey(file)))
                .map((file) => ({ repoRoot: file.repoRoot, path: file.path })),
        [checkedPaths, commitFiles],
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

    const mergingRoot = state.mergingRoots?.find(root => checkedTargets.length
        ? checkedTargets.some(target => target.repoRoot === root) : state.repository?.root === root);
    const amendRoot = checkedTargets[0]?.repoRoot ?? state.repository?.root;
    const canAmend = !!amendRoot && state.amendableRoots.includes(amendRoot)
        && checkedTargets.every(target => target.repoRoot === amendRoot);

    useEffect(() => {
        if (state.isAmend && !canAmend) dispatch({ type: "SET_AMEND", isAmend: false });
    }, [state.isAmend, canAmend, dispatch]);

    const isAmend = state.isAmend && canAmend;
    const commitMessage = isAmend && amendRoot
        ? state.amendMessages[amendRoot] ?? "" : state.commitMessage;

    useEffect(() => {
        if (isAmend && amendRoot) {
            vscode.postMessage({ type: "getLastCommitMessage", repoRoot: amendRoot });
        }
    }, [isAmend, amendRoot, vscode]);

    const handleMessageChange = useCallback(
        (message: string) => {
            if (isAmend && amendRoot) {
                dispatch({ type: "SET_AMEND_MESSAGE", repoRoot: amendRoot, message });
            } else {
                dispatch({ type: "SET_COMMIT_MESSAGE", message });
            }
        },
        [dispatch, isAmend, amendRoot],
    );

    const handleAmendChange = useCallback(
        (isAmend: boolean) => {
            dispatch({ type: "SET_AMEND", isAmend });
        },
        [dispatch],
    );

    const commitCheckedFiles = useCallback(
        (push: boolean) => {
            vscode.postMessage({
                type: "commitSelected",
                targets: checkedTargets,
                message: commitMessage.trim(),
                amend: isAmend,
                push,
            });
        },
        [vscode, commitMessage, isAmend, checkedTargets],
    );

    const handleCommit = useCallback(() => {
        commitCheckedFiles(false);
    }, [commitCheckedFiles]);

    const handleCommitAndPush = useCallback(() => {
        commitCheckedFiles(true);
    }, [commitCheckedFiles]);

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
                    commitContent={
                        <CommitTab
                            files={commitFiles}
                            repositories={repositories}
                            currentRepository={state.repository}
                            activeFile={state.activeFile}
                            commitMessage={commitMessage}
                            isAmend={isAmend}
                            canAmend={canAmend}
                            mergingRoots={state.mergingRoots}
                            onOpenMerge={mergingRoot ? () => vscode.postMessage({ type: "openMergeSession", repoRoot: mergingRoot }) : undefined}
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
                            onOpenChanges={(repoRoot) =>
                                vscode.postMessage({ type: "showAllDiffs", repoRoot })
                            }
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
                            repoRoot={state.repository?.root}
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
