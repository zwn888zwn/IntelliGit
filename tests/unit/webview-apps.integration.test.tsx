// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flush } from "./utils/reactDomTestUtils";

const mountedAppRoots = vi.hoisted(
    () => new Set<{ root: { unmount: () => void }; container: Element | DocumentFragment }>(),
);
const scrollIntoViewMock = vi.fn();

vi.mock("react-dom/client", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom/client")>();
    return {
        ...actual,
        createRoot: (
            container: Element | DocumentFragment,
            options?: Parameters<typeof actual.createRoot>[1],
        ) => {
            const root = actual.createRoot(container, options);
            mountedAppRoots.add({ root, container });
            return root;
        },
    };
});

interface MockVsCodeApi {
    postMessage: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    setState: ReturnType<typeof vi.fn>;
}

function createRootHost(): HTMLDivElement {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    return root;
}

function fireClick(el: Element | null): void {
    if (!el) {
        throw new Error("expected button to exist for click");
    }
    act(() => {
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
}

function fireKey(el: Element | null, key: string): void {
    if (!el) {
        throw new Error(`expected element to exist for ${key} key`);
    }
    act(() => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
}

function fireInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    act(() => {
        const prototype =
            el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
        const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (valueSetter) valueSetter.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

function installVsCodeMock(initialState: Record<string, unknown> = {}): MockVsCodeApi {
    const api: MockVsCodeApi = {
        postMessage: vi.fn(),
        getState: vi.fn(() => initialState),
        setState: vi.fn(),
    };
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
        configurable: true,
        value: vi.fn(() => api),
    });
    return api;
}

beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        value: true,
        configurable: true,
    });
    Object.defineProperty(window, "matchMedia", {
        value: vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
        configurable: true,
    });

    class ResizeObserverMock {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
        value: ResizeObserverMock,
        configurable: true,
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
        value: scrollIntoViewMock,
        configurable: true,
    });

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        return {
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            bezierCurveTo: vi.fn(),
            set lineCap(_: string) {},
            set lineWidth(_: number) {},
            set strokeStyle(_: string) {},
            set fillStyle(_: string) {},
        } as unknown as CanvasRenderingContext2D;
    });
});

afterEach(() => {
    act(() => {
        for (const entry of Array.from(mountedAppRoots)) {
            entry.root.unmount();
            mountedAppRoots.delete(entry);
        }
    });
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("CommitPanelApp integration", () => {
    it("creates a stash from the toolbar dialog", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock({ checked: [] });
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setRepositoryContext",
                        repository: {
                            repoId: ".",
                            name: "repo",
                            root: "/repo",
                            color: "#4CAF50",
                        },
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        repositories: [
                            {
                                repoId: ".",
                                name: "repo",
                                root: "/repo",
                                color: "#4CAF50",
                            },
                        ],
                        files: [
                            {
                                repoId: ".",
                                repoRoot: "/repo",
                                path: "src/a.ts",
                                status: "M",
                                staged: false,
                                additions: 1,
                                deletions: 0,
                            },
                        ],
                        stashes: [],
                        shelfFiles: [],
                        selectedShelfIndex: null,
                    },
                }),
            );
        });
        await flush();

        fireClick(document.querySelector('button[aria-label="Shelve Changes"]'));
        await flush();

        fireInput(
            document.querySelector('input[placeholder="Shelved changes"]') as HTMLInputElement,
            "111",
        );
        const checkboxes = Array.from(
            document.querySelectorAll('input[type="checkbox"]'),
        ) as HTMLInputElement[];
        fireClick(checkboxes[checkboxes.length - 1]);
        const createButtons = Array.from(document.querySelectorAll("button")).filter(
            (button) => button.textContent?.trim() === "Create Stash",
        );
        fireClick(createButtons[createButtons.length - 1]);

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "shelveSave",
            repoRoot: "/repo",
            targets: undefined,
            name: "111",
            keepIndex: true,
        });
    });

    it("handles extension messages and commit/shelf interactions", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock({ checked: [] });
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/commit-panel/CommitPanelApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        files: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                            {
                                path: "package.json",
                                status: "?",
                                staged: false,
                                additions: 0,
                                deletions: 0,
                            },
                        ],
                        stashes: [
                            {
                                index: 0,
                                message: "On main: shelf-work",
                                date: "2026-02-19T00:00:00Z",
                                hash: "stashhash",
                            },
                        ],
                        shelfFiles: [
                            {
                                path: "src/webviews/react/CommitPanelApp.tsx",
                                status: "M",
                                staged: false,
                                additions: 3,
                                deletions: 1,
                            },
                        ],
                        selectedShelfIndex: 0,
                    },
                }),
            );
        });
        await flush();

        fireClick(document.querySelector('button[aria-label="Refresh"]'));
        fireClick(document.querySelector('button[aria-label="Rollback"]'));
        fireClick(document.querySelector('button[aria-label="Group by Directory"]'));
        fireClick(document.querySelector('button[aria-label="Show Diff Preview"]'));
        fireClick(document.querySelector('button[aria-label="Expand All"]'));
        fireClick(document.querySelector('button[aria-label="Collapse All"]'));

        const checkboxes = Array.from(
            document.querySelectorAll('input[type="checkbox"]'),
        ) as HTMLInputElement[];
        if (checkboxes.length > 0) {
            fireClick(checkboxes[0]);
        }

        const textarea = document.querySelector(
            'textarea[placeholder="Commit Message"]',
        ) as HTMLTextAreaElement;
        fireInput(textarea, "feat: integration");
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Commit",
            ) ?? null,
        );

        fireClick(document.querySelector('[data-testid="amend-checkbox"]'));

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "lastCommitMessage", message: "last commit body" },
                }),
            );
        });
        await flush();
        expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toContain(
            "last commit body",
        );

        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "committed" } }));
        });
        await flush();

        fireClick(
            Array.from(document.querySelectorAll("button")).find((b) =>
                b.textContent?.includes("Stash"),
            ),
        );
        fireClick(document.querySelector('[title="On main: shelf-work"]'));
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Apply",
            ),
        );
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Pop",
            ),
        );
        fireClick(
            Array.from(document.querySelectorAll("button")).find(
                (b) => b.textContent?.trim() === "Delete",
            ),
        );

        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "refresh" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "getLastCommitMessage" });
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "shelfApply", index: 0 }),
        );
        expect(vscode.setState).toHaveBeenCalled();
    });
});

describe("CommitGraphApp integration", () => {
    it("renders worktrees and sends open/delete messages", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitGraphApp");
        await flush();

        const repository = { repoId: ".", name: "repo", root: "/repo", color: "#4CAF50" };
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositoryContext", repository },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositories", repositories: [repository] },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setRepositoryWorktrees",
                        worktreesByRoot: {
                            "/repo": [
                                { path: "/repo", branch: "main", detached: false },
                                {
                                    path: "/repo-feature",
                                    branch: "feature/demo",
                                    detached: false,
                                },
                            ],
                        },
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "openWorktreesDialog", repoRoot: "/repo" },
                }),
            );
        });
        await flush();

        expect(document.body.textContent).toContain("Worktrees");
        expect(document.body.textContent).toContain("/repo-feature");
        const linkedRow = Array.from(document.querySelectorAll('[role="row"]')).find((row) =>
            row.textContent?.includes("/repo-feature"),
        ) as HTMLElement;
        expect(linkedRow).toBeTruthy();

        const linkedButtons = Array.from(linkedRow.querySelectorAll("button"));
        fireClick(linkedButtons.find((button) => button.textContent?.trim() === "Open") ?? null);
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "openWorktree",
            payload: { repoRoot: "/repo", path: "/repo-feature" },
        });

        fireClick(
            linkedButtons.find((button) => button.textContent?.trim() === "Delete...") ?? null,
        );
        await flush();
        const deleteButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Delete Worktree",
        );
        fireClick(deleteButton ?? null);
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "deleteWorktree",
            payload: { repoRoot: "/repo", path: "/repo-feature" },
        });

        const closeButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Close",
        );
        fireClick(closeButton ?? null);
        await flush();
    });

    it("renders all repository worktrees and keeps row actions repository-scoped", async () => {
        vi.resetModules();
        installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitGraphApp");
        await flush();

        const repoA = { repoId: "a", name: "repo-a", root: "/repo-a", color: "#4CAF50" };
        const repoB = { repoId: "b", name: "repo-b", root: "/repo-b", color: "#2196F3" };
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositoryContext", repository: repoA },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositories", repositories: [repoA, repoB] },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setRepositoryWorktrees",
                        worktreesByRoot: {
                            "/repo-a": [{ path: "/repo-a", branch: "main", detached: false }],
                            "/repo-b": [
                                { path: "/repo-b", branch: "main", detached: false },
                                {
                                    path: "/repo-b-feature",
                                    branch: "feature/demo",
                                    detached: false,
                                },
                            ],
                        },
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "openWorktreesDialog" },
                }),
            );
        });
        await flush();

        expect(document.body.textContent).toContain("repo-a");
        expect(document.body.textContent).toContain("repo-b");
        expect(document.body.textContent).toContain("/repo-b-feature");

        const repoSelect = document.querySelector(
            'select[aria-label="Repository for new worktree"]',
        ) as HTMLSelectElement;
        expect(repoSelect).toBeTruthy();
        const newWorktreeButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "New Worktree...",
        );
        expect(newWorktreeButton).toBeTruthy();

        const linkedRow = Array.from(document.querySelectorAll('[role="row"]')).find((row) =>
            row.textContent?.includes("/repo-b-feature"),
        ) as HTMLElement;
        expect(linkedRow).toBeTruthy();

        const closeButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Close",
        );
        fireClick(closeButton ?? null);
        await flush();
    });

    it("renders the new worktree dialog and submits a new-branch payload", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitGraphApp");
        await flush();

        const branches = [
            {
                name: "main",
                hash: "a1",
                isRemote: false,
                isCurrent: true,
                ahead: 0,
                behind: 0,
            },
            {
                name: "feature/demo",
                hash: "b2",
                isRemote: false,
                isCurrent: false,
                ahead: 0,
                behind: 0,
            },
            {
                name: "origin/main",
                hash: "c3",
                isRemote: true,
                isCurrent: false,
                remote: "origin",
                ahead: 0,
                behind: 0,
            },
        ];
        const repository = { repoId: ".", name: "repo", root: "/repo", color: "#4CAF50" };

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositoryContext", repository },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setBranches", branches },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setRepositoryBranches", branchesByRoot: { "/repo": branches } },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "openWorktreeDialog",
                        payload: {
                            repository,
                            branch: branches[0],
                            defaultLocation: "/Users/me/projects",
                            defaultProjectName: "repo-main",
                            worktrees: [{ path: "/repo", branch: "main", detached: false }],
                        },
                    },
                }),
            );
        });
        await flush();

        expect(document.body.textContent).toContain("New Worktree");
        expect(document.body.textContent).toContain("This local branch is already checked out");
        const createButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Create Worktree"),
        ) as HTMLButtonElement;
        expect(createButton.disabled).toBe(true);

        const fromBranch = document.querySelector(
            'input[aria-label="From branch"]',
        ) as HTMLInputElement;
        expect(fromBranch.getAttribute("role")).toBe("combobox");
        fireInput(fromBranch, "feature");
        await flush();
        expect(document.body.textContent).toContain("Select an existing branch");
        expect(createButton.disabled).toBe(true);
        const matchingBranch = document.querySelector(
            '#intelligit-worktree-branch-list [role="option"]',
        ) as HTMLButtonElement;
        expect(matchingBranch.textContent).toContain("feature/demo");
        expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
        fireClick(matchingBranch);
        await flush();
        expect(fromBranch.value).toBe("feature/demo");
        expect(document.body.textContent).not.toContain("Select an existing branch");
        expect(createButton.disabled).toBe(false);

        fireClick(document.querySelector('button[aria-label="Choose location"]'));
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "chooseWorktreeLocation",
            currentLocation: "/Users/me/projects",
        });

        fireClick(document.querySelector('input[aria-label="New branch"]'));
        const newBranchName = document.querySelector(
            'input[aria-label="New branch name"]',
        ) as HTMLInputElement;
        fireInput(newBranchName, "feature/demo");
        await flush();
        expect(document.body.textContent).toContain("Local branch 'feature/demo' already exists");
        expect(createButton.disabled).toBe(true);
        fireInput(newBranchName, "feature/worktree");
        await flush();

        const projectName = document.querySelector(
            'input[aria-label="Project name"]',
        ) as HTMLInputElement;
        expect(projectName.value).toBe("repo-feature-worktree");
        expect(createButton.disabled).toBe(false);
        fireClick(createButton);
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "createWorktree",
            payload: {
                repoRoot: "/repo",
                branchName: "feature/demo",
                createBranch: true,
                newBranchName: "feature/worktree",
                projectName: "repo-feature-worktree",
                location: "/Users/me/projects",
            },
        });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "worktreeCreateResult", success: false, message: "failed" },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("failed");
        expect(document.body.textContent).toContain("New Worktree");

        fireInput(newBranchName, "feature/worktree-2");
        await flush();
        expect(document.body.textContent).not.toContain("failed");
        expect(createButton.disabled).toBe(false);
    });

    it("handles host messages, filtering, branch actions, and commit actions", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitGraphApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setBranches",
                        branches: [
                            {
                                name: "main",
                                hash: "a1",
                                isRemote: false,
                                isCurrent: true,
                                ahead: 0,
                                behind: 0,
                            },
                            {
                                name: "features/right-click-context",
                                hash: "b2",
                                isRemote: false,
                                isCurrent: false,
                                ahead: 1,
                                behind: 0,
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: false,
                        hasMore: true,
                        unpushedHashes: ["aa11"],
                        commits: [
                            {
                                hash: "aa11",
                                shortHash: "aa11",
                                message: "feat: first commit",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T00:00:00Z",
                                parentHashes: ["p1"],
                                refs: ["HEAD -> main"],
                            },
                            {
                                hash: "bb22",
                                shortHash: "bb22",
                                message: "Merge pull request #4",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-18T00:00:00Z",
                                parentHashes: ["p1", "p2"],
                                refs: [],
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setSelectedBranch",
                        branch: "features/right-click-context",
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: true,
                        hasMore: false,
                        unpushedHashes: ["aa11", "cc33"],
                        commits: [
                            {
                                hash: "cc33",
                                shortHash: "cc33",
                                message: "feat: appended",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T01:00:00Z",
                                parentHashes: ["bb22"],
                                refs: [],
                            },
                        ],
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setCommitDetail",
                        detail: {
                            hash: "aa11",
                            shortHash: "aa11",
                            message: "feat: first commit",
                            body: "",
                            author: "Mahesh",
                            email: "m@example.com",
                            date: "2026-02-19T00:00:00Z",
                            parentHashes: ["p1"],
                            refs: ["HEAD -> main"],
                            files: [
                                {
                                    path: "src/feature.ts",
                                    status: "M",
                                    additions: 3,
                                    deletions: 1,
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("Branch: All branches");
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "selectCommit" }),
        );
        const initialCommitRow = Array.from(document.querySelectorAll("div")).find(
            (row) =>
                (row as HTMLDivElement).style.cursor === "pointer" &&
                row.textContent?.includes("feat: first commit"),
        ) as HTMLDivElement;
        expect(initialCommitRow.style.background).toBe("transparent");
        const viewport = document.querySelector(
            '[data-testid="commit-list-viewport"]',
        ) as HTMLDivElement | null;
        expect(viewport).toBeTruthy();
        if (viewport) {
            Object.defineProperty(viewport, "clientHeight", {
                value: 20,
                configurable: true,
            });
            Object.defineProperty(viewport, "scrollTop", {
                value: 90,
                writable: true,
                configurable: true,
            });
        }

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "revealCommit",
                        hash: "cc33",
                    },
                }),
            );
        });
        await flush();
        expect(viewport?.scrollTop).toBeGreaterThan(0);

        const changedFileRow = document.querySelector(
            '[title="src/feature.ts"]',
        ) as HTMLElement | null;
        expect(changedFileRow).toBeTruthy();
        act(() => {
            changedFileRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });

        const branchRow = Array.from(document.querySelectorAll(".branch-row")).find((row) =>
            row.textContent?.trim() === "HEAD",
        ) as HTMLElement;
        fireClick(branchRow);
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "loadCommits",
                        append: false,
                        hasMore: true,
                        unpushedHashes: ["aa11"],
                        commits: [
                            {
                                hash: "aa11",
                                shortHash: "aa11",
                                message: "feat: first commit",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T00:00:00Z",
                                parentHashes: ["p1"],
                                refs: ["HEAD -> main"],
                            },
                            {
                                hash: "bb22",
                                shortHash: "bb22",
                                message: "Merge pull request #4",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-18T00:00:00Z",
                                parentHashes: ["p1", "p2"],
                                refs: [],
                            },
                            {
                                hash: "cc33",
                                shortHash: "cc33",
                                message: "feat: appended",
                                author: "Mahesh",
                                email: "m@example.com",
                                date: "2026-02-19T01:00:00Z",
                                parentHashes: ["bb22"],
                                refs: [],
                            },
                        ],
                    },
                }),
            );
        });
        await flush();
        expect(viewport?.scrollTop).toBe(0);
        act(() => {
            branchRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 120,
                    clientY: 40,
                }),
            );
        });
        fireClick(
            Array.from(document.querySelectorAll(".intelligit-context-item")).find((item) =>
                item.textContent?.includes("Rename"),
            ) ?? null,
        );

        const commitRow = Array.from(document.querySelectorAll("div")).find(
            (row) =>
                (row as HTMLDivElement).style.cursor === "pointer" &&
                row.textContent?.includes("feat: first commit"),
        ) as HTMLElement;
        expect(commitRow).toBeTruthy();
        act(() => {
            commitRow.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: 260,
                    clientY: 90,
                }),
            );
        });
        fireClick(
            Array.from(document.querySelectorAll(".intelligit-context-item")).find((item) =>
                item.textContent?.includes("Copy Revision Number"),
            ) ?? null,
        );

        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "revealCommit", hash: "a1" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "branchAction", action: "renameBranch" }),
        );
        expect(vscode.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "openCommitFileDiff",
                commitHash: "aa11",
                filePath: "src/feature.ts",
            }),
        );

        const externalJumpArrow = document.querySelector(
            'button[title="Load and jump to \'p1\'"]',
        );
        expect(externalJumpArrow).toBeTruthy();
        fireClick(externalJumpArrow);
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "revealCommit",
            hash: "p1",
        });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setFilterText",
                        text: "",
                    },
                }),
            );
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "revealCommit",
                        hash: "cc33",
                    },
                }),
            );
        });
        await flush();
        expect((document.querySelector('input[placeholder="Text or hash"]') as HTMLInputElement).value).toBe("");
        expect(viewport?.scrollTop).toBeGreaterThan(0);
    });
});

describe("CommitInfoApp integration", () => {
    it("renders detail, supports resize/toggle, and clears", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        const rootHost = createRootHost();
        void rootHost;

        await import("../../src/webviews/react/CommitInfoApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setCommitDetail",
                        detail: {
                            hash: "abc123",
                            shortHash: "abc123",
                            message: "feat: commit info",
                            body: "body line",
                            author: "Mahesh",
                            email: "m@example.com",
                            date: "2026-02-19T00:00:00Z",
                            parentHashes: ["p1"],
                            refs: ["HEAD -> main", "tag:v0.3.1"],
                            containingBranches: [
                                "HEAD",
                                "main",
                                "origin/main",
                                "origin/release/demo",
                            ],
                            files: [
                                { path: "src/a.ts", status: "M", additions: 3, deletions: 1 },
                                { path: "src/b.ts", status: "A", additions: 4, deletions: 0 },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();
        expect(document.body.textContent).toContain("feat: commit info");
        expect(document.body.textContent).toContain("2 files changed");
        expect(document.body.textContent).toContain("Branches");
        expect(document.body.textContent).toContain("Tags");
        expect(document.body.textContent).toContain("HEAD -> main");
        expect(document.body.textContent).toContain("In 4 branches:");
        expect(document.body.textContent).toContain("Show all");

        fireClick(Array.from(document.querySelectorAll("button")).find((el) => el.textContent === "Show all"));
        await flush();
        expect(document.body.textContent).toContain("origin/release/demo");
        expect(document.body.textContent).toContain("Hide");

        // Toggle "Commit Details" collapse/expand via its role="button" element
        const detailsToggle = document.querySelector('[role="button"][aria-expanded]');
        fireClick(detailsToggle);
        fireClick(detailsToggle);

        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data: { type: "clear" } }));
        });
        await flush();
        expect(document.body.textContent).toContain("No commit selected");
    });
});

describe("MergeEditorApp integration", () => {
    it("requests native definition navigation on modifier-click", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/merge-editor/MergeEditorApp");
        await flush();

        const lineText = "const value = helper();";
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setConflictData",
                        data: {
                            filePath: "src/navigation.ts",
                            oursLabel: "main",
                            theirsLabel: "feature",
                            segments: [{ type: "common", lines: [lineText] }],
                        },
                    },
                }),
            );
        });
        await flush();

        const content = document.querySelector(
            ".col-left .real-code-line .code-line-content",
        ) as HTMLElement;
        const helperSpan = Array.from(content.querySelectorAll("span")).find(
            (span) => span.textContent === "helper",
        ) as HTMLSpanElement;
        const helperText = helperSpan.firstChild as Text;
        Object.defineProperty(document, "caretPositionFromPoint", {
            configurable: true,
            value: vi.fn(() => ({ offsetNode: helperText, offset: 1 })),
        });

        act(() => {
            helperSpan.dispatchEvent(
                new MouseEvent("click", {
                    bubbles: true,
                    cancelable: true,
                    metaKey: true,
                    clientX: 1,
                    clientY: 1,
                }),
            );
        });

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "goToDefinition",
            pane: "left",
            lineNumber: 1,
            character: lineText.indexOf("helper") + 1,
            lineText,
        });
        Reflect.deleteProperty(document, "caretPositionFromPoint");
    });

    it("renders one-sided insertions as auto-resolved connector bands", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/merge-editor/MergeEditorApp");
        await flush();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setConflictData",
                        data: {
                            filePath: "src/non-conflicting.ts",
                            oursLabel: "main",
                            theirsLabel: "feature",
                            eol: "\n",
                            hasTrailingNewline: true,
                            segments: [
                                { type: "common", lines: ["before"] },
                                {
                                    type: "conflict",
                                    id: 0,
                                    changeKind: "theirs-only",
                                    oursLines: [],
                                    theirsLines: ["right"],
                                    baseLines: [],
                                },
                                {
                                    type: "conflict",
                                    id: 1,
                                    changeKind: "conflict",
                                    oursLines: ["ours"],
                                    theirsLines: ["theirs"],
                                    baseLines: ["base"],
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();

        expect(document.querySelectorAll(".merge-col")).toHaveLength(3);
        expect(document.querySelector(".merge-connectors")).not.toBeNull();
        expect(document.querySelector(".merge-connector.variant-insertion")).not.toBeNull();
        expect(
            document.querySelector(".segment-conflict.variant-insertion.resolved"),
        ).not.toBeNull();
        expect(document.querySelector(".segment-conflict.change-conflict.unresolved")).not.toBeNull();
        expect(document.querySelector(".col-middle")?.textContent).toContain("right");

        const applyButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Apply (0/1)"),
        ) as HTMLButtonElement;
        expect(applyButton.disabled).toBe(true);
        expect(vscode.postMessage).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: "applyResolution" }),
        );
    });

    it("allows editing the result pane and applying custom content", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/merge-editor/MergeEditorApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setConflictData",
                        data: {
                            filePath: "src/conflicted.ts",
                            oursLabel: "main",
                            theirsLabel: "feature",
                            eol: "\n",
                            hasTrailingNewline: true,
                            segments: [
                                {
                                    type: "conflict",
                                    id: 0,
                                    changeKind: "conflict",
                                    oursLines: ["ours"],
                                    theirsLines: ["theirs"],
                                    baseLines: ["base"],
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();

        const applyButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Apply (0/1)"),
        ) as HTMLButtonElement;
        expect(applyButton.disabled).toBe(true);

        const editableResult = document.querySelector(".result-editable") as HTMLDivElement;
        act(() => {
            editableResult.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();

        const resultEditor = document.querySelector(".result-edit-textarea") as HTMLTextAreaElement;
        expect(resultEditor.style.height).toBe("20px");
        const horizontalScroll = document.querySelector(
            ".merge-horizontal-scroll",
        ) as HTMLDivElement;
        const horizontalScrollInner = document.querySelector(
            ".merge-horizontal-scroll-inner",
        ) as HTMLDivElement;
        horizontalScroll.hidden = true;
        Object.defineProperties(horizontalScroll, {
            clientWidth: {
                configurable: true,
                get: () => (horizontalScroll.hidden ? 0 : 100),
            },
        });
        Object.defineProperties(horizontalScrollInner, {
            offsetWidth: {
                configurable: true,
                get: () => (horizontalScroll.hidden ? 0 : 300),
            },
        });
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(horizontalScroll.hidden).toBe(false);

        Object.defineProperties(resultEditor, {
            scrollWidth: { configurable: true, value: 300 },
            clientWidth: { configurable: true, value: 100 },
        });
        act(() => {
            horizontalScroll.scrollLeft = 45;
            horizontalScroll.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        expect(resultEditor.scrollLeft).toBe(45);

        act(() => {
            resultEditor.scrollLeft = 70;
            resultEditor.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        expect(horizontalScroll.scrollLeft).toBe(70);

        fireInput(resultEditor, "manual\nresult");
        await flush();
        expect(resultEditor.style.height).toBe("40px");
        act(() => {
            resultEditor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        await flush();

        const discardLeft = document.querySelector(
            'button[aria-label="Ignore left block"]',
        ) as HTMLButtonElement;
        fireClick(discardLeft);
        await flush();
        expect(document.querySelector(".col-left .conflict-column.dismissed")).not.toBeNull();
        expect(document.querySelector('button[aria-label="Ignore left block"]')).toBeNull();
        expect(document.querySelector(".col-middle")?.textContent).toContain("manual");

        const discardRight = document.querySelector(
            'button[aria-label="Ignore right block"]',
        ) as HTMLButtonElement;
        fireClick(discardRight);
        await flush();
        expect(document.querySelector(".col-right .conflict-column.dismissed")).not.toBeNull();
        expect(document.querySelector(".col-middle")?.textContent).toContain("manual");

        const resetManualEdit = document.querySelector(
            'button[aria-label="Reset this block to unresolved"]',
        ) as HTMLButtonElement;
        fireClick(resetManualEdit);
        await flush();
        expect(document.querySelector(".col-middle")?.textContent).toContain("base");
        expect(document.querySelector(".col-middle")?.textContent).not.toContain("manual");
        expect(document.querySelector('button[aria-label="Ignore left block"]')).not.toBeNull();
        expect(document.querySelector('button[aria-label="Ignore right block"]')).not.toBeNull();
        expect(applyButton.disabled).toBe(true);

        const restoredResult = document.querySelector(".result-editable") as HTMLDivElement;
        act(() => {
            restoredResult.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        });
        await flush();
        const restoredEditor = document.querySelector(
            ".result-edit-textarea",
        ) as HTMLTextAreaElement;
        fireInput(restoredEditor, "manual\nresult");
        await flush();
        act(() => {
            restoredEditor.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        });
        await flush();

        expect(applyButton.disabled).toBe(true);
        const markResolved = document.querySelector(
            'button[aria-label="Mark edited block as resolved"]',
        ) as HTMLButtonElement;
        fireClick(markResolved);
        await flush();

        const enabledApplyButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Apply (1/1)"),
        ) as HTMLButtonElement;
        expect(enabledApplyButton.disabled).toBe(false);
        fireClick(enabledApplyButton);

        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "applyResolution",
            content: "manual\nresult\n",
            mode: "apply",
        });
    });
});

describe("MergeConflictSessionApp integration", () => {
    it("uses host-selected conflict paths when opening the merge editor", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/merge-conflicts-session/MergeConflictSessionApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });
        vscode.postMessage.mockClear();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setSessionData",
                        data: {
                            sourceBranch: "feature",
                            targetBranch: "main",
                            selectedPath: "src/b.ts",
                            simpleConflictsResolved: false,
                            files: [
                                {
                                    path: "src/a.ts",
                                    code: "UU",
                                    ours: "Modified",
                                    theirs: "Modified",
                                    resolved: false,
                                },
                                {
                                    path: "src/b.ts",
                                    code: "UU",
                                    ours: "Modified",
                                    theirs: "Modified",
                                    resolved: false,
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();

        fireClick(
            Array.from(document.querySelectorAll("button")).find((button) =>
                button.textContent?.includes("Resolve Manually"),
            ) ?? null,
        );
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "openMerge",
            filePath: "src/b.ts",
        });

        vscode.postMessage.mockClear();
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setSessionData",
                        data: {
                            sourceBranch: "feature",
                            targetBranch: "main",
                            selectedPath: "src/a.ts",
                            simpleConflictsResolved: false,
                            files: [
                                {
                                    path: "src/a.ts",
                                    code: "UU",
                                    ours: "Modified",
                                    theirs: "Modified",
                                    resolved: false,
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();

        fireClick(
            Array.from(document.querySelectorAll("button")).find((button) =>
                button.textContent?.includes("Resolve Manually"),
            ) ?? null,
        );
        expect(vscode.postMessage).toHaveBeenCalledWith({
            type: "openMerge",
            filePath: "src/a.ts",
        });
    });

    it("shows resolved groups, conflict counts, and explicit finish controls", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/merge-conflicts-session/MergeConflictSessionApp");
        await flush();
        vscode.postMessage.mockClear();

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "setSessionData",
                        data: {
                            sourceBranch: "feature",
                            targetBranch: "main",
                            selectedPath: "src/auth.ts",
                            simpleConflictsResolved: true,
                            files: [
                                {
                                    path: "src/auth.ts",
                                    code: "UU",
                                    ours: "Modified",
                                    theirs: "Modified",
                                    resolved: false,
                                    resolvedConflictCount: 8,
                                    totalConflictCount: 9,
                                },
                                {
                                    path: "go.mod",
                                    code: "UU",
                                    ours: "Modified",
                                    theirs: "Modified",
                                    resolved: true,
                                    resolvedConflictCount: 10,
                                    totalConflictCount: 10,
                                },
                            ],
                        },
                    },
                }),
            );
        });
        await flush();

        expect(document.body.textContent).toContain(
            "18 conflicts resolved. 1 conflict in 1 file still require attention",
        );
        expect(document.body.textContent).toContain("Resolved 1 file");
        const finishButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Accept and Finish"),
        ) as HTMLButtonElement;
        const simpleButton = Array.from(document.querySelectorAll("button")).find((button) =>
            button.textContent?.includes("Resolve All Simple Conflicts"),
        ) as HTMLButtonElement;
        expect(finishButton.disabled).toBe(true);
        expect(simpleButton.disabled).toBe(true);

        fireClick(
            Array.from(document.querySelectorAll("button")).find((button) =>
                button.textContent?.includes("Close"),
            ) ?? null,
        );
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "close" });
    });
});

describe("ProjectComparisonApp integration", () => {
    const repository = {
        repoId: ".",
        name: "IntelliGit",
        root: "/workspace/IntelliGit",
        relativePath: "packages/IntelliGit",
        color: "#4CAF50",
    };
    const files = [
        {
            repoId: ".",
            repoRoot: repository.root,
            path: "src/a.ts",
            status: "M",
            additions: 2,
            deletions: 1,
        },
        {
            repoId: ".",
            repoRoot: repository.root,
            path: "src/nested/b.ts",
            status: "A",
            additions: 4,
            deletions: 0,
        },
    ];

    function sendUpdate(updatedFiles: typeof files): void {
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        type: "update",
                        branchName: "feature/tree-ux",
                        targetLabel: "main",
                        repository,
                        files: updatedFiles,
                    },
                }),
            );
        });
    }

    it("renders comparison context and supports keyboard tree interaction", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/project-comparison/ProjectComparisonApp");
        await flush();
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "ready" });

        sendUpdate(files);
        await flush();

        expect(document.body.textContent).toContain("feature/tree-ux ↔ main");
        expect(document.body.textContent).toContain("packages/IntelliGit");

        let srcFolder = document.querySelector('[role="treeitem"][title="src"]');
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("true");
        expect(srcFolder?.getAttribute("aria-level")).toBe("1");
        expect((srcFolder as HTMLElement).tabIndex).toBe(0);

        fireKey(srcFolder, "Enter");
        await flush();
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("false");
        expect(document.querySelector('[role="treeitem"][title="src/a.ts"]')).toBeNull();

        const docsFile = {
            repoId: ".",
            repoRoot: repository.root,
            path: "docs/readme.md",
            status: "A" as const,
            additions: 1,
            deletions: 0,
        };
        sendUpdate([...files.map((file) => ({ ...file })), docsFile]);
        await flush();

        srcFolder = document.querySelector('[role="treeitem"][title="src"]');
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("false");
        expect(document.querySelector('[role="treeitem"][title="src/a.ts"]')).toBeNull();
        expect(
            document.querySelector('[role="treeitem"][title="docs"]')?.getAttribute(
                "aria-expanded",
            ),
        ).toBe("true");
        expect(document.querySelector('[role="treeitem"][title="docs/readme.md"]')).not.toBeNull();

        fireKey(srcFolder, "ArrowRight");
        await flush();
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("true");

        fireKey(srcFolder, "ArrowLeft");
        await flush();
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("false");

        fireKey(srcFolder, " ");
        await flush();
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("true");

        const fileRow = document.querySelector('[role="treeitem"][title="src/a.ts"]');
        expect(fileRow?.getAttribute("aria-level")).toBe("2");
        expect((fileRow as HTMLElement).tabIndex).toBe(0);

        vscode.postMessage.mockClear();
        fireKey(fileRow, "Enter");
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openDiff", path: "src/a.ts" });

        vscode.postMessage.mockClear();
        fireKey(fileRow, " ");
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "openDiff", path: "src/a.ts" });
    });

    it("reopens and scrolls to the active file while refresh is disabled", async () => {
        vi.resetModules();
        const vscode = installVsCodeMock();
        createRootHost();

        await import("../../src/webviews/react/project-comparison/ProjectComparisonApp");
        await flush();
        sendUpdate(files);
        await flush();

        let srcFolder = document.querySelector('[role="treeitem"][title="src"]');
        fireKey(srcFolder, "ArrowLeft");
        await flush();
        expect(document.querySelector('[role="treeitem"][title="src/nested/b.ts"]')).toBeNull();

        scrollIntoViewMock.mockClear();
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", {
                    data: { type: "setActiveFile", path: "src/nested/b.ts" },
                }),
            );
        });
        await flush();

        srcFolder = document.querySelector('[role="treeitem"][title="src"]');
        const nestedFolder = document.querySelector(
            '[role="treeitem"][title="src/nested"]',
        );
        const activeFile = document.querySelector(
            '[role="treeitem"][title="src/nested/b.ts"]',
        );
        expect(srcFolder?.getAttribute("aria-expanded")).toBe("true");
        expect(nestedFolder?.getAttribute("aria-expanded")).toBe("true");
        expect(activeFile?.getAttribute("aria-selected")).toBe("true");
        expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "nearest" });

        const refreshButton = document.querySelector(
            'button[aria-label="Refresh"]',
        ) as HTMLButtonElement;
        vscode.postMessage.mockClear();
        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "refreshing", active: true } }),
            );
        });
        await flush();
        expect(refreshButton.disabled).toBe(true);
        act(() => refreshButton.click());
        expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "refresh" });

        act(() => {
            window.dispatchEvent(
                new MessageEvent("message", { data: { type: "refreshing", active: false } }),
            );
        });
        await flush();
        expect(refreshButton.disabled).toBe(false);
        act(() => refreshButton.click());
        expect(vscode.postMessage).toHaveBeenCalledWith({ type: "refresh" });
    });
});
