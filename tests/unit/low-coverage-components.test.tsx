// @vitest-environment jsdom

import React, { act, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Branch, Commit, RepositoryContextInfo } from "../../src/types";
import { BranchColumn } from "../../src/webviews/react/BranchColumn";
import { CommitList } from "../../src/webviews/react/CommitList";
import { BranchPopupOverlay } from "../../src/webviews/react/branch-column/components/BranchPopupOverlay";
import { CommitRow } from "../../src/webviews/react/commit-list/CommitRow";
import { useDragResize } from "../../src/webviews/react/commit-panel/hooks/useDragResize";
import { ContextMenu } from "../../src/webviews/react/shared/components/ContextMenu";
import { flush, initReactDomTestEnvironment, mount, unmount } from "./utils/reactDomTestUtils";

const mockVscodeApi = vi.hoisted(() => ({
    postMessage: vi.fn(),
    getState: vi.fn((): unknown => undefined),
    setState: vi.fn(),
}));

vi.mock("../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => mockVscodeApi,
}));

initReactDomTestEnvironment();

describe("low coverage components", () => {
    it("BranchPopupOverlay keeps the current repository list stable while opening repository submenus", async () => {
        const repositories: RepositoryContextInfo[] = [
            {
                repoId: "pic",
                name: "PicMath",
                root: "/repos/PicMath",
                color: "#ff5722",
            },
            {
                repoId: "ios",
                name: "IosLatex",
                root: "/repos/IosLatex",
                color: "#8bc34a",
            },
        ];
        const currentBranches: Branch[] = [
            {
                name: "pic-current",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
        ];
        const iosBranches: Branch[] = [
            {
                name: "ios-current",
                hash: "def5678",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "ios-other",
                hash: "9876def",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ];
        const onOpenBranchMenu = vi.fn();
        const { root, container } = mount(
            <BranchPopupOverlay
                branches={currentBranches}
                repositories={repositories}
                repository={repositories[0]}
                repositoryBranches={{
                    [repositories[0].root]: currentBranches,
                    [repositories[1].root]: iosBranches,
                }}
                repositoryTags={{
                    [repositories[0].root]: [],
                    [repositories[1].root]: [],
                }}
                onTopAction={vi.fn()}
                onOpenBranchMenu={onOpenBranchMenu}
                onClose={vi.fn()}
            />,
        );

        const iosRow = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.includes("IosLatex"),
        ) as HTMLElement;
        expect(iosRow).toBeTruthy();

        act(() => {
            iosRow.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        });
        await flush();
        expect(document.body.textContent).not.toContain("Recent Branches in IosLatex");

        act(() => {
            iosRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await flush();

        expect(document.body.textContent).toContain("Recent Branches in PicMath");
        expect(document.body.textContent).toContain("Recent Branches in IosLatex");
        expect(document.body.textContent).toContain("pic-current");
        expect(document.body.textContent).toContain("ios-current");
        expect(document.body.textContent).toContain("ios-other");

        const iosCurrent = Array.from(document.querySelectorAll("button")).filter(
            (button) => button.textContent?.includes("ios-current"),
        ).at(-1) as HTMLElement;
        expect(iosCurrent.getAttribute("data-selected")).toBe("true");

        const iosOther = Array.from(document.querySelectorAll("button")).filter(
            (button) => button.textContent?.includes("ios-other"),
        ).at(-1) as HTMLElement;
        act(() => {
            iosOther.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        });
        await flush();
        expect(iosCurrent.getAttribute("data-selected")).toBe("false");
        expect(iosOther.getAttribute("data-selected")).toBe("true");

        const iosBranch = Array.from(document.querySelectorAll("button")).filter(
            (button) => button.textContent?.includes("ios-current"),
        ).at(-1) as HTMLElement;
        act(() => {
            iosBranch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onOpenBranchMenu).toHaveBeenCalledWith(
            iosBranches[0],
            "/repos/IosLatex",
            expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
        );

        unmount(root, container);
    });

    it("BranchPopupOverlay recent branches prefer local branches before remote branches", async () => {
        const repository: RepositoryContextInfo = {
            repoId: "repo",
            name: "Repo",
            root: "/repos/Repo",
            color: "#ff5722",
        };
        const branches: Branch[] = [
            {
                name: "origin/recent-remote",
                hash: "r1",
                isRemote: true,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "recent-local",
                hash: "l1",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "older-local",
                hash: "l2",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
        ];

        const { root, container } = mount(
            <BranchPopupOverlay
                branches={branches}
                repositories={[repository]}
                repository={repository}
                repositoryBranches={{ [repository.root]: branches }}
                repositoryTags={{ [repository.root]: [] }}
                onTopAction={vi.fn()}
                onOpenBranchMenu={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const text = document.body.textContent ?? "";
        const recentLocalIndex = text.indexOf("recent-local");
        const olderLocalIndex = text.indexOf("older-local");
        const remoteIndex = text.indexOf("origin/recent-remote");

        expect(recentLocalIndex).toBeGreaterThan(-1);
        expect(olderLocalIndex).toBeGreaterThan(-1);
        expect(remoteIndex).toBeGreaterThan(-1);
        expect(recentLocalIndex).toBeLessThan(remoteIndex);
        expect(olderLocalIndex).toBeLessThan(remoteIndex);

        unmount(root, container);
    });

    it("BranchPopupOverlay keeps left labels prioritized over trailing gray text", () => {
        const repository: RepositoryContextInfo = {
            repoId: "repo",
            name: "Repo",
            root: "/repos/Repo",
            color: "#ff5722",
        };
        const branches: Branch[] = [
            {
                name: "wip_ios_135_zwn",
                upstream: "origin/wip_ios_135_zwn_with_a_long_remote_name",
                hash: "abc1234",
                isRemote: false,
                isCurrent: true,
                ahead: 3,
                behind: 0,
            },
        ];

        const { root, container } = mount(
            <BranchPopupOverlay
                branches={branches}
                repositories={[repository]}
                repository={repository}
                repositoryBranches={{ [repository.root]: branches }}
                repositoryTags={{ [repository.root]: [] }}
                onTopAction={vi.fn()}
                onOpenBranchMenu={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const branchRow = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.includes("wip_ios_135_zwn"),
        ) as HTMLButtonElement;
        expect(branchRow).toBeTruthy();
        expect(branchRow.title).toBe(
            "wip_ios_135_zwn\norigin/wip_ios_135_zwn_with_a_long_remote_name",
        );

        const spans = Array.from(branchRow.querySelectorAll("span"));
        const labelSpan = spans.find((span) => span.textContent?.includes("wip_ios_135_zwn")) as HTMLSpanElement;
        const upstreamSpan = spans.find((span) =>
            span.textContent?.includes("origin/wip_ios_135_zwn_with_a_long_remote_name"),
        ) as HTMLSpanElement;

        expect(labelSpan.style.flex).toBe("0 0 auto");
        expect(upstreamSpan.style.maxWidth).toBe("100%");

        unmount(root, container);
    });

    it("useDragResize updates and clamps height", () => {
        const onResize = vi.fn();
        function Harness(): React.ReactElement {
            const ref = useRef<HTMLDivElement>(null);
            const { height, onMouseDown } = useDragResize(120, 80, ref, {
                maxReservedHeight: 50,
                onResize,
            });
            return (
                <div ref={ref} data-host="1">
                    <span data-height>{height}</span>
                    <div data-handle="1" onMouseDown={onMouseDown} />
                </div>
            );
        }

        const { root, container } = mount(<Harness />);
        const host = container.querySelector("[data-host='1']") as HTMLDivElement;
        Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });

        const handle = container.querySelector("[data-handle='1']") as HTMLElement;
        act(() => {
            handle.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 300 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 200 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        expect(onResize).toHaveBeenCalled();

        act(() => {
            handle.dispatchEvent(
                new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientY: 300 }),
            );
            document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 800 }));
            document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        const heightText = container.querySelector("[data-height]")?.textContent ?? "";
        expect(Number(heightText)).toBeGreaterThanOrEqual(80);

        unmount(root, container);
    });

    it("CommitRow renders compact ref count and handles row events", () => {
        const onSelect = vi.fn();
        const onContextMenu = vi.fn();
        const commit: Commit = {
            hash: "a1b2c3d4",
            shortHash: "a1b2c3d4",
            message: "feat: row coverage",
            author: "Mahesh",
            email: "m@example.com",
            date: "2026-02-19T00:00:00Z",
            parentHashes: ["p1"],
            refs: ["HEAD -> main", "tag:v1.0.0", "origin/main", "feature/demo"],
        };

        const { root, container } = mount(
            <CommitRow
                commit={commit}
                rowLeftOffset={16}
                messageIndent={84}
                isSelected={false}
                isUnpushed={true}
                laneColor="#00ff00"
                onSelect={onSelect}
                onContextMenu={onContextMenu}
            />,
        );

        const branchCount = container.querySelector(
            'span[aria-label*="Branches (3):"][aria-label*="main"][aria-label*="origin/main"][aria-label*="feature/demo"]',
        );
        expect(branchCount).toBeTruthy();
        expect(container.textContent).toContain("v1.0.0");
        const messageCell = container.querySelector(
            'span[title*="feat: row coverage"]',
        ) as HTMLElement;
        expect(messageCell).toBeTruthy();
        const compactRefCell = container.querySelector(
            'span[title*="Branches: HEAD -> main"]',
        ) as HTMLElement;
        expect(compactRefCell?.getAttribute("title")).toContain("Branches: HEAD -> main");

        const row = container.querySelector("div") as HTMLDivElement;
        act(() => {
            row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            row.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 20,
                    clientY: 20,
                }),
            );
        });
        expect(onSelect).toHaveBeenCalledWith("a1b2c3d4");
        expect(onContextMenu).toHaveBeenCalled();

        act(() => {
            root.render(
                <CommitRow
                    commit={commit}
                    rowLeftOffset={16}
                    messageIndent={84}
                    isSelected={true}
                    isUnpushed={false}
                    laneColor="#00ff00"
                    onSelect={onSelect}
                    onContextMenu={onContextMenu}
                />,
            );
        });

        unmount(root, container);
    });

    it("ContextMenu supports keyboard activation and escape close", () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const { root, container } = mount(
            <ContextMenu
                x={6}
                y={6}
                onSelect={onSelect}
                onClose={onClose}
                items={[
                    { label: "Open", action: "open" },
                    { label: "Submenu", action: "submenu", submenu: true },
                ]}
            />,
        );

        const item = Array.from(document.querySelectorAll(".intelligit-context-item")).find((el) =>
            el.textContent?.includes("Open"),
        ) as HTMLElement;
        act(() => {
            item.dispatchEvent(
                new KeyboardEvent("keydown", {
                    bubbles: true,
                    key: "Enter",
                }),
            );
        });
        expect(onSelect).toHaveBeenCalledWith("open");

        act(() => {
            document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
        });
        expect(onClose).toHaveBeenCalled();

        unmount(root, container);
    });

    it("BranchColumn handles remote expansion, filtering, and context actions", async () => {
        const branches: Branch[] = [
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature/demo",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 1,
                behind: 0,
            },
            {
                name: "origin/feature/demo",
                hash: "a1b2c3d4",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ];
        const onBranchAction = vi.fn();
        const { root, container } = mount(
            <BranchColumn
                branches={branches}
                selectedBranch={null}
                onSelectBranch={vi.fn()}
                onBranchAction={onBranchAction}
            />,
        );
        const localHeader = Array.from(container.querySelectorAll("div")).find(
            (el) => el.textContent?.trim() === "Local",
        ) as HTMLElement;
        act(() => {
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            localHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const remoteFolderHeader = Array.from(container.querySelectorAll("div")).find(
            (el) => el.textContent?.trim() === "origin",
        ) as HTMLElement;
        act(() => {
            remoteFolderHeader.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });

        const headRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("HEAD (main)"),
        ) as HTMLElement;
        // Force the no-icon fallback path so anchor math uses rowRect.left + 20.
        Object.defineProperty(headRow, "querySelector", {
            value: () => null,
            configurable: true,
        });
        act(() => {
            headRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 10,
                    clientY: 10,
                }),
            );
        });
        const rename = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Rename"),
        ) as HTMLElement;
        act(() => {
            rename.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onBranchAction).toHaveBeenCalledWith("renameBranch", "main", undefined, undefined);

        const searchInput = container.querySelector(
            'input[placeholder="Search branches"]',
        ) as HTMLInputElement;
        act(() => {
            // React-controlled inputs in jsdom need the native value setter + input/change events.
            const valueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value",
            )?.set;
            valueSetter?.call(searchInput, "zzz-no-match");
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.dispatchEvent(new Event("change", { bubbles: true }));
        });
        await flush();
        expect(container.textContent).toContain("No matching branches");

        unmount(root, container);
    });

    it("BranchColumn persists and restores expansion/filter state", async () => {
        mockVscodeApi.getState.mockReturnValue({
            branchColumn: {
                branchFilter: "main",
                expandedSections: ["local"],
                expandedFolders: [],
            },
        });

        try {
            const branches: Branch[] = [
                {
                    name: "main",
                    hash: "feed1234",
                    isRemote: false,
                    isCurrent: true,
                    ahead: 0,
                    behind: 0,
                },
                {
                    name: "origin/main",
                    hash: "feed1234",
                    isRemote: true,
                    isCurrent: false,
                    remote: "origin",
                    ahead: 0,
                    behind: 0,
                },
            ];
            const { root, container } = mount(
                <BranchColumn
                    branches={branches}
                    selectedBranch={null}
                    onSelectBranch={vi.fn()}
                    onBranchAction={vi.fn()}
                />,
            );
            await flush();

            const searchInput = container.querySelector(
                'input[placeholder="Search branches"]',
            ) as HTMLInputElement;
            expect(searchInput.value).toBe("main");
            expect(mockVscodeApi.setState).toHaveBeenCalledWith(
                expect.objectContaining({
                    branchColumn: expect.objectContaining({
                        branchFilter: "main",
                    }),
                }),
            );

            unmount(root, container);
        } finally {
            mockVscodeApi.getState.mockReturnValue(undefined);
            mockVscodeApi.setState.mockClear();
        }
    });

    it("BranchColumn shows ahead/behind counts with push/pull colors", () => {
        const branches: Branch[] = [
            {
                name: "main",
                hash: "feed1234",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature-demo",
                hash: "a1b2c3d4",
                isRemote: false,
                isCurrent: false,
                ahead: 2,
                behind: 3,
            },
        ];
        const { root, container } = mount(
            <BranchColumn
                branches={branches}
                selectedBranch={null}
                onSelectBranch={vi.fn()}
                onBranchAction={vi.fn()}
            />,
        );

        const branchRow = Array.from(container.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.includes("feature-demo"),
        ) as HTMLElement;
        expect(branchRow).toBeTruthy();

        const push = branchRow.querySelector(".branch-track-push") as HTMLElement;
        const pull = branchRow.querySelector(".branch-track-pull") as HTMLElement;
        expect(push?.textContent).toBe("\u2B062");
        expect(pull?.textContent).toBe("\u2B073");
        expect(push?.style.color).toBe(
            "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
        );
        expect(pull?.style.color).toBe(
            "var(--vscode-gitDecoration-deletedResourceForeground, #c74e39)",
        );
        const badge = branchRow.querySelector("[data-branch-tooltip]") as HTMLElement;
        expect(badge?.getAttribute("data-branch-tooltip")).toBe(
            "3 incoming commits and 2 outgoing commits",
        );

        unmount(root, container);
    });

    it("CommitList triggers context action and load-more", () => {
        const onCommitAction = vi.fn();
        const onLoadMore = vi.fn();
        const commits: Commit[] = [
            {
                hash: "aa11bb22",
                shortHash: "aa11bb22",
                message: "feat: commit list coverage",
                author: "Mahesh",
                email: "m@example.com",
                date: "2026-02-19T00:00:00Z",
                parentHashes: ["p1"],
                refs: [],
                repoId: "repo-a",
                repoRoot: "/repo-a",
            },
        ];
        const { root, container } = mount(
            <CommitList
                commits={commits}
                repositories={[
                    {
                        root: "/repo-a",
                        name: "repo-a",
                        relativePath: "repo-a",
                        repoId: "repo-a",
                        color: "#4CAF50",
                    },
                ]}
                repository={{
                    root: "/repo-a",
                    name: "repo-a",
                    relativePath: "repo-a",
                    repoId: "repo-a",
                    color: "#4CAF50",
                }}
                selectedHash={null}
                filterText=""
                hasMore={true}
                unpushedHashes={new Set(["aa11bb22"])}
                selectedBranch="main"
                repoRailExpanded={false}
                onToggleRepoRail={vi.fn()}
                onSelectCommit={vi.fn()}
                onFilterText={vi.fn()}
                onLoadMore={onLoadMore}
                onCommitAction={onCommitAction}
            />,
        );

        const row = Array.from(container.querySelectorAll("div")).find(
            (el) =>
                (el as HTMLDivElement).style.cursor === "pointer" &&
                el.textContent?.includes("feat: commit list coverage"),
        ) as HTMLElement;
        act(() => {
            row.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        const action = Array.from(document.querySelectorAll(".intelligit-context-item")).find(
            (el) => el.textContent?.includes("Copy Revision Number"),
        ) as HTMLElement;
        act(() => {
            action.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onCommitAction).toHaveBeenCalledWith("copyRevision", "aa11bb22");

        const viewport = container.querySelector(
            '[data-testid="commit-list-viewport"]',
        ) as HTMLDivElement;
        Object.defineProperty(viewport, "clientHeight", { value: 240, configurable: true });
        Object.defineProperty(viewport, "scrollHeight", { value: 300, configurable: true });
        Object.defineProperty(viewport, "scrollTop", { value: 90, configurable: true });
        act(() => {
            viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(onLoadMore).toHaveBeenCalled();

        unmount(root, container);
    });
});
