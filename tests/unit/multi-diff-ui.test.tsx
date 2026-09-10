// @vitest-environment jsdom

import React, { act } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
    CommitDetail,
    RepositoryContextInfo,
    StashEntry,
    WorkingFile,
} from "../../src/types";
import theme from "../../src/webviews/react/commit-panel/theme";
import { CommitInfoPane } from "../../src/webviews/react/commit-info/CommitInfoPane";
import { FileTree } from "../../src/webviews/react/commit-panel/components/FileTree";
import { ShelfTab } from "../../src/webviews/react/commit-panel/components/ShelfTab";
import { StageTab } from "../../src/webviews/react/commit-panel/components/StageTab";
import { flush, initReactDomTestEnvironment, mount } from "./utils/reactDomTestUtils";

initReactDomTestEnvironment();

const vscode = {
    postMessage: vi.fn(),
    getState: vi.fn(() => ({})),
    setState: vi.fn(),
};

beforeAll(() => {
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => vscode),
    });
});

function renderUi(node: React.ReactElement): ReturnType<typeof mount> {
    return mount(<ChakraProvider theme={theme}>{node}</ChakraProvider>);
}

function click(element: Element | null): void {
    if (!element) throw new Error("expected element to exist for click");
    act(() => {
        element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

function input(element: HTMLInputElement, value: string): void {
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

function repository(root: string, name = root.slice(1)): RepositoryContextInfo {
    return { repoId: root, name, root, color: "#4CAF50" };
}

function workingFile(path: string, repoRoot = "/repo", staged = false): WorkingFile {
    return {
        repoId: repoRoot,
        repoRoot,
        path,
        status: "M",
        staged,
        additions: 1,
        deletions: 0,
    };
}

describe("multi-diff UI scopes", () => {
    it("opens all repository changes without selecting the repository row", () => {
        const repo = repository("/repo");
        const onOpenChanges = vi.fn();
        const onSelectRepository = vi.fn();
        renderUi(
            <FileTree
                repositories={[repo]}
                currentRepository={null}
                activeFile={null}
                files={[workingFile("src/a.ts")]}
                groupByDir={false}
                checkedPaths={new Set()}
                onToggleFile={vi.fn()}
                onToggleFolder={vi.fn()}
                onToggleSection={vi.fn()}
                isAllChecked={() => false}
                isSomeChecked={() => false}
                onSelectRepository={onSelectRepository}
                onOpenChanges={onOpenChanges}
                onFileClick={vi.fn()}
                expandAllSignal={0}
                collapseAllSignal={0}
            />,
        );

        click(document.querySelector('button[aria-label="Open All Changes"]'));

        expect(onOpenChanges).toHaveBeenCalledWith("/repo");
        expect(onSelectRepository).not.toHaveBeenCalled();
    });

    it("keeps staged and unstaged open-all actions in separate scopes", () => {
        const repo = repository("/repo");
        renderUi(
            <StageTab
                repositories={[repo]}
                files={[workingFile("src/staged.ts", "/repo", true), workingFile("src/work.ts")]}
                groupByDir={false}
            />,
        );

        const stagedButton = document.querySelector('button[aria-label="Open Staged Changes"]');
        const unstagedButton = document.querySelector('button[aria-label="Open Unstaged Changes"]');
        expect(stagedButton).not.toBeNull();
        expect(unstagedButton).not.toBeNull();

        click(stagedButton);
        click(unstagedButton);

        expect(vscode.postMessage).toHaveBeenNthCalledWith(1, {
            type: "showAllStageDiff",
            repoRoot: "/repo",
            staged: true,
        });
        expect(vscode.postMessage).toHaveBeenNthCalledWith(2, {
            type: "showAllStageDiff",
            repoRoot: "/repo",
            staged: false,
        });
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "showStageDiff" }),
        );
    });

    it("uses the stash row index for an unselected row and does not expand it", () => {
        const stashes: StashEntry[] = [
            { index: 3, message: "On main: first", date: "2026-02-19T00:00:00Z", hash: "a" },
            { index: 7, message: "On feature: second", date: "2026-02-19T00:00:00Z", hash: "b" },
        ];
        renderUi(
            <ShelfTab
                stashes={stashes}
                shelfFiles={[]}
                selectedIndex={null}
                groupByDir={false}
                onCreateStash={vi.fn()}
                repoRoot="/repo"
            />,
        );

        const buttons = Array.from(
            document.querySelectorAll('button[aria-label="Open Stash Changes"]'),
        );
        expect(buttons).toHaveLength(2);
        click(buttons[1]);

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "showAllShelfDiff",
            index: 7,
            hash: "b",
            repoRoot: "/repo",
        });
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "shelfSelect" }),
        );
        expect(document.body.textContent).not.toContain("Loading...");
    });

    it("disables stash open-all while the repository scope is unavailable", () => {
        renderUi(
            <ShelfTab
                stashes={[{ index: 4, message: "On main: work", date: "2026-02-19T00:00:00Z", hash: "a" }]}
                shelfFiles={[]}
                selectedIndex={null}
                groupByDir={false}
                onCreateStash={vi.fn()}
            />,
        );

        const button = document.querySelector(
            'button[aria-label="Open Stash Changes"]',
        ) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        click(button);
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "showAllShelfDiff" }),
        );
    });

    it("opens changed files for the current commit without collapsing the header", () => {
        const detail: CommitDetail = {
            repoId: "repo",
            repoRoot: "/repo",
            hash: "abc123",
            shortHash: "abc123",
            message: "feat: change",
            body: "",
            author: "Author",
            email: "author@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: [],
            refs: [],
            files: [{ path: "src/a.ts", status: "M", additions: 1, deletions: 0 }],
        };
        const onOpenChanges = vi.fn();
        renderUi(<CommitInfoPane detail={detail} onOpenChanges={onOpenChanges} />);

        const button = document.querySelector('button[aria-label="Open All Changes"]');
        const changedFilesHeader = document.querySelector('[role="button"][aria-expanded="true"]');
        click(button);

        expect(onOpenChanges).toHaveBeenCalledWith("abc123", "/repo");
        expect(changedFilesHeader?.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector('[title="src/a.ts"]')).not.toBeNull();

        act(() => {
            button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            button?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
        });
        expect(changedFilesHeader?.getAttribute("aria-expanded")).toBe("true");
    });

    it("opens every comparison change even when a file filter hides some files", async () => {
        vi.resetModules();
        const root = document.createElement("div");
        root.id = "root";
        document.body.appendChild(root);

        await act(async () => {
            await import("../../src/webviews/react/project-comparison/ProjectComparisonApp");
        });
        await flush();
        vscode.postMessage.mockClear();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        branchName: "feature",
                        targetLabel: "main",
                        repository: repository("/repo"),
                        files: [
                            {
                                repoId: "/repo",
                                repoRoot: "/repo",
                                path: "src/visible.ts",
                                status: "M",
                                additions: 1,
                                deletions: 0,
                            },
                            {
                                repoId: "/repo",
                                repoRoot: "/repo",
                                path: "src/hidden.ts",
                                status: "M",
                                additions: 1,
                                deletions: 0,
                            },
                        ],
                    },
                }),
            );
        });
        await flush();

        const filter = document.querySelector(
            'input[aria-label="Filter files by name or path"]',
        ) as HTMLInputElement;
        input(filter, "visible");
        await flush();
        expect(document.body.textContent).toContain("1 / 2");
        expect(document.querySelector('[title="src/hidden.ts"]')).toBeNull();

        click(document.querySelector('button[aria-label="Open All Changes"]'));
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openAllDiffs" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "refreshing", active: true } }),
            );
        });
        await flush();
        expect(
            (document.querySelector('button[aria-label="Open All Changes"]') as HTMLButtonElement)
                .disabled,
        ).toBe(true);

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "refreshing", active: false } }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        branchName: "feature",
                        targetLabel: "main",
                        repository: repository("/repo"),
                        files: [],
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("No differences");
        expect(
            (document.querySelector('button[aria-label="Open All Changes"]') as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it("shows an empty stage scope without an enabled open-all action", () => {
        renderUi(<StageTab files={[]} repositories={[repository("/repo")]} groupByDir={false} />);

        expect(document.body.textContent).toContain("No changes");
        expect(document.querySelector('button[aria-label="Open Staged Changes"]')).toBeNull();
        expect(document.querySelector('button[aria-label="Open Unstaged Changes"]')).toBeNull();
    });
});
