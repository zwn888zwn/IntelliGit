import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitOps } from "../../src/git/operations";
import { computeGraph } from "../../src/webviews/react/graph";
import { buildPermanentGraph } from "../../src/webviews/react/commit-list/graphModel";
import { formatDateTime } from "../../src/webviews/react/shared/date";
import {
    FILE_TYPE_BADGES,
    GIT_STATUS_COLORS,
    GIT_STATUS_LABELS,
} from "../../src/webviews/react/shared/tokens";
import {
    getErrorMessage,
    isBranchNotFullyMergedError,
    isUntrackedPathspecError,
} from "../../src/utils/errors";
import { getChevronIconStyle } from "../../src/webviews/react/branch-column/styles";
import { contentContainerStyle, headerRowStyle } from "../../src/webviews/react/commit-list/styles";

describe("core utilities", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it("GitExecutor delegates to simple-git raw", async () => {
        const raw = vi.fn(async () => "ok");
        const simpleGit = vi.fn(() => ({ raw }));
        vi.doMock("simple-git", () => ({ default: simpleGit }));
        const { GitExecutor } = await import("../../src/git/executor");

        const executor = new GitExecutor("/tmp/repo");
        const out = await executor.run(["status", "--short"]);

        expect(out).toBe("ok");
        expect(simpleGit).toHaveBeenCalledWith("/tmp/repo", { maxConcurrentProcesses: 6 });
        expect(raw).toHaveBeenCalledWith(["status", "--short"]);
    });

    it("deleteFileWithFallback uses git rm success path", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {});
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: {
                joinPath: (root: { fsPath: string }, filePath: string) => ({
                    fsPath: `${root.fsPath}/${filePath}`,
                }),
            },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitOps: GitDeleteMock = { deleteFile: vi.fn(async () => {}) };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const ok = await deleteFileWithFallback(gitOps as GitOps, workspaceRoot, "a.txt");

        expect(ok).toBe(true);
        expect(gitOps.deleteFile).toHaveBeenCalledWith("a.txt", true);
        expect(fsDelete).not.toHaveBeenCalled();
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("deleteFileWithFallback falls back to fs delete for untracked files", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {});
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: {
                joinPath: (root: { fsPath: string }, filePath: string) => ({
                    fsPath: `${root.fsPath}/${filePath}`,
                }),
            },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitOps: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("pathspec 'a.txt' did not match any files");
            }),
        };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const ok = await deleteFileWithFallback(gitOps as GitOps, workspaceRoot, "a.txt");

        expect(ok).toBe(true);
        expect(fsDelete).toHaveBeenCalledTimes(1);
        expect(showErrorMessage).not.toHaveBeenCalled();
    });

    it("deleteFileWithFallback surfaces unexpected git or fs errors", async () => {
        const showErrorMessage = vi.fn();
        const fsDelete = vi.fn(async () => {
            throw new Error("permission denied");
        });
        vi.doMock("vscode", () => ({
            window: { showErrorMessage },
            workspace: { fs: { delete: fsDelete } },
            Uri: {
                joinPath: (_root: { fsPath: string }, filePath: string) => ({
                    fsPath: `/repo/${filePath}`,
                }),
            },
        }));
        const { deleteFileWithFallback } = await import("../../src/utils/fileOps");
        type GitDeleteMock = Pick<GitOps, "deleteFile">;

        const gitUnexpected: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("index lock");
            }),
        };
        const workspaceRoot = { fsPath: "/repo" } as unknown as Parameters<
            typeof deleteFileWithFallback
        >[1];
        const okUnexpected = await deleteFileWithFallback(
            gitUnexpected as GitOps,
            workspaceRoot,
            "a.txt",
        );
        expect(okUnexpected).toBe(false);

        const gitUntracked: GitDeleteMock = {
            deleteFile: vi.fn(async () => {
                throw new Error("pathspec did not match");
            }),
        };
        const okFsFail = await deleteFileWithFallback(
            gitUntracked as GitOps,
            workspaceRoot,
            "a.txt",
        );
        expect(okFsFail).toBe(false);
        expect(showErrorMessage).toHaveBeenCalled();
    });

    it("assertRepoRelativePath accepts valid paths and rejects traversal/absolute", async () => {
        vi.doMock("vscode", () => ({}));
        const { assertRepoRelativePath } = await import("../../src/utils/fileOps");

        // Valid relative paths
        expect(assertRepoRelativePath("src/a.ts")).toBe("src/a.ts");
        expect(assertRepoRelativePath("file.txt")).toBe("file.txt");
        expect(assertRepoRelativePath("..env")).toBe("..env");
        expect(assertRepoRelativePath("..foo/bar.ts")).toBe("..foo/bar.ts");
        expect(assertRepoRelativePath(".config/file.ts")).toBe(".config/file.ts");

        // Traversal — rejected
        expect(() => assertRepoRelativePath("../etc/passwd")).toThrow("escaping repo root");
        expect(() => assertRepoRelativePath("foo/../../etc/passwd")).toThrow("escaping repo root");
        expect(() => assertRepoRelativePath("..")).toThrow("escaping repo root");

        // Absolute — rejected
        expect(() => assertRepoRelativePath("/etc/passwd")).toThrow("non-relative");

        // Empty — rejected
        expect(() => assertRepoRelativePath("")).toThrow("non-relative");
    });

    it("buildWebviewShellHtml includes CSP, nonce, title and script URI", async () => {
        const joinPath = vi.fn(
            (_base: { path?: string }, ...parts: string[]): { path: string } => ({
                path: `/${parts.join("/")}`,
            }),
        );
        vi.doMock("vscode", () => ({
            Uri: { joinPath },
        }));
        const { buildWebviewShellHtml } = await import("../../src/views/webviewHtml");
        const extensionUri = { path: "/ext" } as unknown as Parameters<
            typeof buildWebviewShellHtml
        >[0]["extensionUri"];
        const webview = {
            cspSource: "vscode-resource:",
            asWebviewUri: (uri: { path: string }) => `webview://${uri.path}`,
        } as unknown as Parameters<typeof buildWebviewShellHtml>[0]["webview"];

        const html = buildWebviewShellHtml({
            extensionUri,
            webview,
            scriptFile: "webview-commitgraph.js",
            title: "Commit Graph",
            backgroundVar: "#123",
        });

        expect(html).toContain("<title>Commit Graph</title>");
        expect(html).toContain("Content-Security-Policy");
        expect(html).toContain("script-src 'nonce-");
        expect(html).toContain('src="webview:///dist/webview-commitgraph.js"');
        expect(html).toContain("background: #123");
    });

    it("graph compute handles linear and merge histories", () => {
        const linear = computeGraph([
            { hash: "c3", parentHashes: ["c2"] },
            { hash: "c2", parentHashes: ["c1"] },
            { hash: "c1", parentHashes: [] },
        ]);
        expect(linear.rows).toHaveLength(3);
        expect(linear.rows[0].nodePosition).toBe(0);
        expect(linear.arrowMarkers).toHaveLength(0);

        const merge = computeGraph([
            { hash: "m1", parentHashes: ["p1", "p2"] },
            { hash: "p1", parentHashes: ["base"] },
            { hash: "p2", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);
        expect(
            merge.rows[0].elements.filter((element) => element.type === "edge"),
        ).toHaveLength(2);
    });

    it("graph keeps the first-parent lane stable even when that parent is already active", () => {
        const permanent = buildPermanentGraph([
            { hash: "top", parentHashes: ["main"] },
            { hash: "merge", parentHashes: ["main", "side"] },
            { hash: "main", parentHashes: ["base"] },
            { hash: "side", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(permanent.rows[0].node.layoutIndex).toBe(0);
        expect(permanent.rows[1].node.layoutIndex).toBe(1);
        expect(permanent.rows[2].node.layoutIndex).toBe(1);
    });

    it("graph can assign a denser-ref head as the stable trunk before a lighter side head", () => {
        const permanent = buildPermanentGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            {
                hash: "merge",
                parentHashes: ["alpha-prev", "side-prev"],
                refs: ["alpha", "origin/alpha", "tag:v1"],
            },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(permanent.rows[0].node.layoutIndex).toBe(1);
        expect(permanent.rows[1].node.layoutIndex).toBe(0);
        expect(permanent.rows[3].node.layoutIndex).toBe(0);
    });

    it("graph compute forwards refs so head-priority layout can affect rendered rows", () => {
        const graph = computeGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            {
                hash: "merge",
                parentHashes: ["alpha-prev", "side-prev"],
                refs: ["alpha", "origin/alpha", "tag:v1"],
            },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[0].nodePosition).toBe(1);
        expect(graph.rows[1].nodePosition).toBe(0);
    });

    it("graph seeds layout from ref-bearing commits before plain topological heads", () => {
        const permanent = buildPermanentGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            { hash: "merge", parentHashes: ["alpha-prev", "side-prev"], refs: ["alpha"] },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(permanent.rows[1].node.layoutIndex).toBe(0);
        expect(permanent.rows[0].node.layoutIndex).toBe(1);
    });

    it("graph can keep adjacent rendered rows in one column while coloring them differently", () => {
        const graph = computeGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            { hash: "merge", parentHashes: ["alpha-prev", "side-prev"], refs: ["alpha"] },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[0].nodePosition).toBe(graph.rows[1].nodePosition);
        expect(graph.rows[0].nodeColor).not.toBe(graph.rows[1].nodeColor);
    });

    it("graph compute can render merge rows with an extra edge column", () => {
        const graph = computeGraph([
            { hash: "top", parentHashes: ["merge"], refs: ["feature/demo"] },
            {
                hash: "merge",
                parentHashes: ["alpha-prev", "side-prev"],
                refs: ["alpha", "origin/alpha", "tag:v1"],
            },
            { hash: "side-prev", parentHashes: ["side-base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "side-base", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[1].occupiedWidth).toBeGreaterThan(graph.rows[0].occupiedWidth);
        expect(graph.rows[1].elements.filter((element) => element.type === "edge").length).toBe(2);
    });

    it("graph compute keeps cross-lane edge columns stable across intermediate rows", () => {
        const graph = computeGraph([
            { hash: "feature-head", parentHashes: ["merge-2"], refs: ["feature/demo"] },
            { hash: "merge-2", parentHashes: ["feature-2", "alpha-2"] },
            { hash: "feature-2", parentHashes: ["merge-1"] },
            { hash: "merge-1", parentHashes: ["feature-1", "alpha-1"] },
            { hash: "feature-1", parentHashes: ["base"] },
            { hash: "alpha-2", parentHashes: ["alpha-1"], refs: ["alpha"] },
            { hash: "alpha-1", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        const edgeId = "merge-2:alpha-2:1";
        const intermediateSegments = graph.rows
            .flatMap((row, rowIndex) =>
                row.elements.flatMap((element) =>
                    element.type === "edge" && element.edgeId === edgeId ? [{ rowIndex, element }] : [],
                ),
            )
            .filter(({ rowIndex }) => rowIndex > 1 && rowIndex < 5);

        expect(intermediateSegments.length).toBeGreaterThan(0);
        expect(new Set(intermediateSegments.map(({ element }) => element.fromPosition)).size).toBe(1);
        expect(new Set(intermediateSegments.map(({ element }) => element.toPosition)).size).toBe(1);
    });

    it("graph compute uses dynamic recommended width for wide histories", () => {
        const wide = computeGraph([
            { hash: "merge", parentHashes: ["a", "b", "c", "d", "e", "f", "g"] },
            { hash: "a", parentHashes: ["base"] },
            { hash: "b", parentHashes: ["base"] },
            { hash: "c", parentHashes: ["base"] },
            { hash: "d", parentHashes: ["base"] },
            { hash: "e", parentHashes: ["base"] },
            { hash: "f", parentHashes: ["base"] },
            { hash: "g", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(wide.recommendedWidth).toBeGreaterThan(140);
        expect(wide.rows[0].nodePosition).toBe(0);
    });

    it("graph compute avoids reusing colors for simultaneously active lanes", () => {
        const wide = computeGraph([
            {
                hash: "merge",
                parentHashes: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"],
            },
            { hash: "a", parentHashes: ["base"] },
            { hash: "b", parentHashes: ["base"] },
            { hash: "c", parentHashes: ["base"] },
            { hash: "d", parentHashes: ["base"] },
            { hash: "e", parentHashes: ["base"] },
            { hash: "f", parentHashes: ["base"] },
            { hash: "g", parentHashes: ["base"] },
            { hash: "h", parentHashes: ["base"] },
            { hash: "i", parentHashes: ["base"] },
            { hash: "j", parentHashes: ["base"] },
            { hash: "k", parentHashes: ["base"] },
            { hash: "l", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        const mergeRowColors = new Set(
            wide.rows[0].elements
                .filter((element) => element.type === "edge")
                .map((element) => element.color),
        );
        expect(mergeRowColors.size).toBe(
            wide.rows[0].elements.filter((element) => element.type === "edge").length,
        );
    });

    it("graph compute marks arrows on both cropped long-edge endpoints", () => {
        const filtered = computeGraph([
            { hash: "merge", parentHashes: ["main-01", "side-01"] },
            ...Array.from({ length: 34 }, (_, index) => ({
                hash: `main-${String(index + 1).padStart(2, "0")}`,
                parentHashes:
                    index === 33
                        ? ["base"]
                        : [`main-${String(index + 2).padStart(2, "0")}`],
            })),
            { hash: "side-01", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(filtered.arrowMarkers.some((arrow) => arrow.direction === "down")).toBe(true);
        expect(filtered.arrowMarkers.some((arrow) => arrow.direction === "up")).toBe(true);
        expect(
            filtered.arrowMarkers.every((arrow) =>
                arrow.direction === "down"
                    ? arrow.targetRowIndex > arrow.rowIndex
                    : arrow.targetRowIndex < arrow.rowIndex,
            ),
        ).toBe(true);
    });

    it("graph compute reserves width from compressed visible lanes instead of historical layout ids", () => {
        const compacted = computeGraph([
            {
                hash: "merge",
                parentHashes: [
                    "main-01",
                    "side-01",
                    "side-02",
                    "side-03",
                    "side-04",
                    "side-05",
                    "side-06",
                    "side-07",
                    "side-08",
                ],
            },
            ...Array.from({ length: 36 }, (_, index) => ({
                hash: `main-${String(index + 1).padStart(2, "0")}`,
                parentHashes:
                    index === 35
                        ? ["base"]
                        : [`main-${String(index + 2).padStart(2, "0")}`],
            })),
            { hash: "side-01", parentHashes: ["base"] },
            { hash: "side-02", parentHashes: ["base"] },
            { hash: "side-03", parentHashes: ["base"] },
            { hash: "side-04", parentHashes: ["base"] },
            { hash: "side-05", parentHashes: ["base"] },
            { hash: "side-06", parentHashes: ["base"] },
            { hash: "side-07", parentHashes: ["base"] },
            { hash: "side-08", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(compacted.recommendedWidth).toBeLessThan(220);
        expect(compacted.recommendedWidth).toBeGreaterThan(140);
    });

    it("graph compute skips arrows for continuous long lanes", () => {
        const filtered = computeGraph([
            { hash: "top", parentHashes: ["mid"] },
            { hash: "filler-01", parentHashes: ["filler-02"] },
            { hash: "filler-02", parentHashes: ["filler-03"] },
            { hash: "filler-03", parentHashes: ["filler-04"] },
            { hash: "filler-04", parentHashes: ["filler-05"] },
            { hash: "filler-05", parentHashes: ["filler-06"] },
            { hash: "filler-06", parentHashes: ["filler-07"] },
            { hash: "filler-07", parentHashes: ["filler-08"] },
            { hash: "filler-08", parentHashes: ["filler-09"] },
            { hash: "filler-09", parentHashes: ["filler-10"] },
            { hash: "filler-10", parentHashes: ["filler-11"] },
            { hash: "filler-11", parentHashes: ["mid"] },
            { hash: "mid", parentHashes: [] },
        ]);

        expect(filtered.arrowMarkers).toHaveLength(0);
    });

    it("graph compute skips arrows when the target commit is not visible", () => {
        const partial = computeGraph([
            { hash: "head", parentHashes: ["missing-parent"] },
            { hash: "next", parentHashes: [] },
        ]);

        expect(partial.arrowMarkers).toHaveLength(0);
    });

    it("graph compute routes merge edges without fake jump markers", () => {
        const routed = computeGraph([
            { hash: "merge", parentHashes: ["a1", "b1", "c1", "d1", "e1", "f1", "g1"] },
            { hash: "a1", parentHashes: ["base"] },
            { hash: "b1", parentHashes: ["base"] },
            { hash: "c1", parentHashes: ["base"] },
            { hash: "d1", parentHashes: ["base"] },
            { hash: "e1", parentHashes: ["base"] },
            { hash: "f1", parentHashes: ["base"] },
            { hash: "g1", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        const slantedEdges = routed.rows[0].elements.filter(
            (element) =>
                element.type === "edge" && element.fromPosition !== element.toPosition,
        );
        expect(slantedEdges.length).toBeGreaterThan(0);
    });

    it("date formatting falls back safely on invalid date", () => {
        expect(formatDateTime("not-a-date")).toBe("not-a-date");
        expect(typeof formatDateTime("2026-02-19T08:00:00Z")).toBe("string");
    });

    it("error helpers classify and format errors", () => {
        expect(getErrorMessage(new Error("boom"))).toBe("boom");
        expect(getErrorMessage(42)).toBe("42");
        expect(isUntrackedPathspecError(new Error("pathspec did not match any files"))).toBe(true);
        expect(isUntrackedPathspecError({ code: "ENOENT" })).toBe(true);
        expect(isBranchNotFullyMergedError(new Error("branch is not fully merged"))).toBe(true);
    });

    it("shared style helpers and tokens expose expected values", () => {
        expect(getChevronIconStyle(true).transform).toContain("90deg");
        expect(getChevronIconStyle(false).transform).toContain("0deg");
        expect(headerRowStyle(120).paddingLeft).toBe(120);
        expect(contentContainerStyle(5).height).toBe(140);
        expect(FILE_TYPE_BADGES.json.label).toBe("JN");
        expect(GIT_STATUS_COLORS.M).toContain("--vscode-gitDecoration");
        expect(GIT_STATUS_LABELS["?"]).toBe("Unversioned");
    });

    it("vscode api getter caches acquireVsCodeApi result", async () => {
        const fakeApi = {
            postMessage: vi.fn(),
            getState: vi.fn(() => ({ x: 1 })),
            setState: vi.fn(),
        };
        const originalAcquire = (globalThis as Record<string, unknown>).acquireVsCodeApi;
        try {
            (globalThis as Record<string, unknown>).acquireVsCodeApi = vi.fn(() => fakeApi);
            const { getVsCodeApi } = await import("../../src/webviews/react/shared/vscodeApi");
            const api1 = getVsCodeApi();
            const api2 = getVsCodeApi();
            expect(api1).toBe(api2);
            const mockedAcquire = (globalThis as { acquireVsCodeApi: ReturnType<typeof vi.fn> })
                .acquireVsCodeApi;
            expect(mockedAcquire).toHaveBeenCalledTimes(1);
        } finally {
            if (typeof originalAcquire === "undefined") {
                delete (globalThis as Record<string, unknown>).acquireVsCodeApi;
            } else {
                (globalThis as Record<string, unknown>).acquireVsCodeApi = originalAcquire;
            }
        }
    });
});
