import { describe, expect, it, vi, beforeEach } from "vitest";
import type { GitOps } from "../../src/git/operations";
import { computeGraph } from "../../src/webviews/react/graph";
import {
    buildPermanentGraph,
    orderCommitsForGraph,
} from "../../src/webviews/react/commit-list/graphModel";
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
        expect(raw).toHaveBeenCalledWith([
            "-c",
            "core.quotepath=false",
            "status",
            "--short",
        ]);
    });

    it("decodes git quoted UTF-8 paths", async () => {
        const { decodeGitQuotedPath } = await import("../../src/git/pathEncoding");

        expect(
            decodeGitQuotedPath('"docs/\\346\\226\\260\\346\\226\\207\\344\\273\\266.txt"'),
        ).toBe("docs/新文件.txt");
        expect(decodeGitQuotedPath('"docs/name with spaces.txt"')).toBe(
            "docs/name with spaces.txt",
        );
        expect(decodeGitQuotedPath("docs/plain.txt")).toBe("docs/plain.txt");
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
        expect(
            assertRepoRelativePath('"docs/\\346\\226\\260\\346\\226\\207\\344\\273\\266.txt"'),
        ).toBe("docs/新文件.txt");

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

    it("graph layout keeps the true head path on one layout through the merge base", () => {
        const permanent = buildPermanentGraph([
            { hash: "top", parentHashes: ["main"] },
            { hash: "merge", parentHashes: ["main", "side"] },
            { hash: "main", parentHashes: ["base"] },
            { hash: "side", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(permanent.rows[0].node.layoutIndex).toBe(permanent.rows[2].node.layoutIndex);
        expect(permanent.rows[2].node.layoutIndex).toBe(permanent.rows[4].node.layoutIndex);
        expect(permanent.rows[1].node.layoutIndex).toBe(permanent.rows[3].node.layoutIndex);
        expect(permanent.rows[0].node.layoutIndex).not.toBe(permanent.rows[1].node.layoutIndex);
    });

    it("graph layout can keep the alpha merge path unified even when refs sit on a non-head commit", () => {
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

        expect(permanent.rows[1].node.layoutIndex).toBe(permanent.rows[3].node.layoutIndex);
        expect(permanent.rows[2].node.layoutIndex).not.toBe(permanent.rows[1].node.layoutIndex);
    });

    it("graph compute can pin the merge row node to the mainline column", () => {
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

        expect(graph.rows[0].nodePosition).toBe(0);
        expect(graph.rows[1].nodePosition).toBe(0);
    });

    it("graph layout can demote integration branches to the left of topic remotes", () => {
        const graph = computeGraph([
            {
                hash: "current-head",
                parentHashes: ["master-tip"],
                refs: ["HEAD -> wip_ios_137", "origin/wip_ios_137"],
                graphRefs: [
                    { name: "wip_ios_137", type: "head" },
                    { name: "origin/wip_ios_137", type: "remote", tracked: true },
                ],
            },
            {
                hash: "topic-head",
                parentHashes: ["topic-base"],
                refs: ["origin/wip_jack_doc"],
                graphRefs: [{ name: "origin/wip_jack_doc", type: "remote" }],
            },
            {
                hash: "alpha-tip",
                parentHashes: ["alpha-prev", "side-tip"],
                refs: ["origin/alpha"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "side-tip",
                parentHashes: ["side-base"],
                refs: ["origin/wip_ios_135"],
                graphRefs: [{ name: "origin/wip_ios_135", type: "remote", tracked: true }],
            },
            {
                hash: "master-tip",
                parentHashes: ["master-prev"],
                refs: ["origin/master", "master"],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "topic-base", parentHashes: ["base"] },
            { hash: "side-base", parentHashes: ["base"] },
            { hash: "master-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[2].commitHash).toBe("alpha-tip");
        expect(graph.rows[1].commitHash).toBe("topic-head");
        expect(graph.rows[3].commitHash).toBe("side-tip");
        expect(graph.rows[3].nodePosition).toBe(graph.rows[2].nodePosition + 1);
    });

    it("graph layout keeps non-head branch refs in IDEA-style layout order", () => {
        const commits = [
            {
                hash: "current-head",
                parentHashes: ["master-tip"],
                refs: ["HEAD -> wip_ios_137", "origin/wip_ios_137"],
                graphRefs: [
                    { name: "wip_ios_137", type: "head" },
                    { name: "origin/wip_ios_137", type: "remote", tracked: true },
                ],
            },
            {
                hash: "topic-head",
                parentHashes: ["topic-base"],
                refs: ["origin/wip_jack_doc"],
                graphRefs: [{ name: "origin/wip_jack_doc", type: "remote" }],
            },
            {
                hash: "alpha-tip",
                parentHashes: ["alpha-prev", "side-tip"],
                refs: ["origin/alpha"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "side-tip",
                parentHashes: ["side-prev"],
                refs: ["origin/wip_ios_135_zwn"],
                graphRefs: [{ name: "origin/wip_ios_135_zwn", type: "remote", tracked: true }],
            },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "side-prev", parentHashes: ["base"] },
            {
                hash: "master-tip",
                parentHashes: ["master-prev"],
                refs: ["origin/master", "master"],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
            { hash: "master-prev", parentHashes: ["base"] },
            { hash: "topic-base", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ];

        const { layoutIndexByHash } = orderCommitsForGraph(commits);
        const alphaLayout = layoutIndexByHash.get("alpha-tip") ?? -1;
        const sideLayout = layoutIndexByHash.get("side-tip") ?? -1;
        const masterLayout = layoutIndexByHash.get("master-tip") ?? -1;
        const topicLayout = layoutIndexByHash.get("topic-head") ?? -1;

        const currentLayout = layoutIndexByHash.get("current-head") ?? -1;

        expect(masterLayout).toBeLessThan(alphaLayout);
        expect(alphaLayout).toBeLessThan(sideLayout);
        expect(sideLayout).toBeLessThan(currentLayout);
        expect(currentLayout).toBeLessThan(topicLayout);
    });

    it("graph colors can stay unified along the alpha mainline", () => {
        const permanent = buildPermanentGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            { hash: "merge", parentHashes: ["alpha-prev", "side-prev"], refs: ["alpha"] },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(permanent.rows[1].node.layoutIndex).toBe(permanent.rows[3].node.layoutIndex);
        expect(permanent.rows[1].node.color).toBe(permanent.rows[3].node.color);
    });

    it("graph keeps the incoming branch to the right of the alpha mainline", () => {
        const graph = computeGraph([
            { hash: "side-head", parentHashes: ["merge"], refs: ["feature/demo"] },
            { hash: "merge", parentHashes: ["alpha-prev", "side-prev"], refs: ["alpha"] },
            { hash: "side-prev", parentHashes: ["base"] },
            { hash: "alpha-prev", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[0].nodePosition).toBe(0);
        expect(graph.rows[1].nodePosition).toBe(0);
        expect(graph.rows[2].nodePosition).toBeGreaterThan(graph.rows[1].nodePosition);
    });

    it("graph keeps merge side branch nodes adjacent with topo-ordered commits", () => {
        const longEventTail = Array.from({ length: 31 }, (_, index) => ({
            hash: `event-tail-${index}`,
            parentHashes: [index === 30 ? "event-base" : `event-tail-${index + 1}`],
        }));
        const graph = computeGraph([
            {
                hash: "current-head",
                parentHashes: ["current-prev"],
                refs: ["HEAD -> wip_ios_137_zwn", "origin/wip_ios_137_zwn"],
                graphRefs: [
                    { name: "wip_ios_137_zwn", type: "head" },
                    { name: "wip_ios_137_zwn", type: "local" },
                    { name: "origin/wip_ios_137_zwn", type: "remote", tracked: true },
                ],
            },
            { hash: "current-prev", parentHashes: ["current-base"] },
            { hash: "current-base", parentHashes: ["master"] },
            {
                hash: "event-head",
                parentHashes: ["event-prev"],
                refs: ["origin/wip_event_362373"],
                graphRefs: [{ name: "origin/wip_event_362373", type: "remote" }],
            },
            { hash: "event-prev", parentHashes: ["event-merge"] },
            { hash: "event-merge", parentHashes: ["event-base", "alpha-merge"] },
            {
                hash: "alpha-merge",
                parentHashes: ["alpha-prev", "side-tip"],
                refs: ["origin/alpha"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "side-tip",
                parentHashes: ["side-prev"],
                refs: ["origin/wip_ios_135_zwn"],
                graphRefs: [{ name: "origin/wip_ios_135_zwn", type: "remote", tracked: true }],
            },
            { hash: "alpha-prev", parentHashes: ["side-prev"] },
            { hash: "side-prev", parentHashes: ["master"] },
            ...longEventTail,
            { hash: "event-base", parentHashes: ["master"] },
            {
                hash: "master",
                parentHashes: [],
                refs: ["origin/master", "master"],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
        ]);

        const alphaRow = graph.rows.find((row) => row.commitHash === "alpha-merge");
        const sideRow = graph.rows.find((row) => row.commitHash === "side-tip");

        expect(Math.abs((sideRow?.nodePosition ?? -1) - (alphaRow?.nodePosition ?? -1))).toBeLessThanOrEqual(1);
    });

    it("graph routes reciprocal top merges with IDEA print columns", () => {
        const graph = computeGraph([
            {
                hash: "alpha-top",
                parentHashes: ["alpha-event-merge", "ios-merge"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "ios-merge",
                parentHashes: ["ios-fix", "alpha-event-merge"],
                graphRefs: [
                    { name: "wip_ios_137_zwn", type: "head" },
                    { name: "wip_ios_137_zwn", type: "local" },
                    { name: "origin/wip_ios_137_zwn", type: "remote", tracked: true },
                ],
            },
            { hash: "ios-fix", parentHashes: ["ios-skin"] },
            {
                hash: "alpha-event-merge",
                parentHashes: ["alpha-prev", "event-head"],
                graphRefs: [{ name: "alpha", type: "local" }],
            },
            {
                hash: "event-head",
                parentHashes: ["event-prev"],
                graphRefs: [{ name: "origin/wip_event_362373", type: "remote" }],
            },
            { hash: "ios-skin", parentHashes: ["ios-base"] },
            { hash: "event-prev", parentHashes: ["event-base"] },
            { hash: "ios-base", parentHashes: ["master"] },
            { hash: "alpha-prev", parentHashes: ["master"] },
            { hash: "event-base", parentHashes: ["master"] },
            {
                hash: "master",
                parentHashes: [],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
        ]);

        expect(graph.rows.find((row) => row.commitHash === "alpha-top")?.nodePosition).toBe(0);
        expect(graph.rows.find((row) => row.commitHash === "ios-merge")?.nodePosition).toBe(1);
        expect(graph.rows.find((row) => row.commitHash === "ios-fix")?.nodePosition).toBe(2);
        expect(graph.rows.find((row) => row.commitHash === "alpha-event-merge")?.nodePosition).toBe(0);
        expect(graph.rows.find((row) => row.commitHash === "event-head")?.nodePosition).toBe(1);
        expect(graph.rows.find((row) => row.commitHash === "ios-skin")?.nodePosition).toBe(2);
    });

    it("graph keeps merge-introduced side branches adjacent to the mainline", () => {
        const graph = computeGraph([
            {
                hash: "alpha-top",
                parentHashes: ["alpha-merge", "event-head"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "event-head",
                parentHashes: ["event-1"],
                graphRefs: [{ name: "origin/wip_event_362373", type: "remote" }],
            },
            {
                hash: "current-head",
                parentHashes: ["current-1"],
                graphRefs: [
                    { name: "wip_ios_137_zwn", type: "head" },
                    { name: "wip_ios_137_zwn", type: "local" },
                    { name: "origin/wip_ios_137_zwn", type: "remote", tracked: true },
                ],
            },
            { hash: "event-1", parentHashes: ["event-2"] },
            { hash: "event-2", parentHashes: ["event-3"] },
            { hash: "event-3", parentHashes: ["event-merge"] },
            { hash: "event-merge", parentHashes: ["event-base", "alpha-merge"] },
            { hash: "event-base", parentHashes: ["master"] },
            { hash: "current-1", parentHashes: ["current-base"] },
            { hash: "current-base", parentHashes: ["master"] },
            {
                hash: "doc-head",
                parentHashes: ["doc-base"],
                graphRefs: [{ name: "origin/wip_jack_doc", type: "remote" }],
            },
            { hash: "alpha-merge", parentHashes: ["alpha-prev", "ios-135-head"] },
            {
                hash: "ios-135-head",
                parentHashes: ["ios-135-prev"],
                graphRefs: [{ name: "origin/wip_ios_135_zwn", type: "remote", tracked: true }],
            },
            { hash: "alpha-prev", parentHashes: ["alpha-base"] },
            { hash: "ios-135-prev", parentHashes: ["master"] },
            { hash: "doc-base", parentHashes: ["master"] },
            {
                hash: "master",
                parentHashes: [],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
            { hash: "alpha-base", parentHashes: ["master"] },
        ]);

        expect(graph.rows.find((row) => row.commitHash === "alpha-merge")?.nodePosition).toBe(0);
        expect(graph.rows.find((row) => row.commitHash === "ios-135-head")?.nodePosition).toBe(1);
        expect(graph.rows.find((row) => row.commitHash === "master")?.nodePosition).toBe(0);
    });

    it("graph keeps inactive secondary merge parents after primary continuations", () => {
        const graph = computeGraph([
            {
                hash: "alpha-top",
                parentHashes: ["alpha-next"],
                graphRefs: [{ name: "origin/alpha", type: "remote", tracked: true }],
            },
            {
                hash: "topic-merge",
                parentHashes: ["topic-next", "ad-head"],
                graphRefs: [{ name: "origin/wip_zwn_sta_260529", type: "remote", tracked: true }],
            },
            {
                hash: "doc-head",
                parentHashes: ["doc-next"],
                graphRefs: [{ name: "origin/wip_jack_doc", type: "remote" }],
            },
            { hash: "alpha-next", parentHashes: ["alpha-base"] },
            { hash: "topic-next", parentHashes: ["topic-base"] },
            {
                hash: "ad-head",
                parentHashes: ["master-next"],
                graphRefs: [{ name: "origin/wip_ad_banner_260601", type: "remote" }],
            },
            { hash: "doc-next", parentHashes: ["doc-base"] },
            { hash: "topic-base", parentHashes: ["master-base"] },
            { hash: "doc-base", parentHashes: ["alpha-base"] },
            { hash: "master-next", parentHashes: ["master-base"] },
            { hash: "alpha-base", parentHashes: ["master-base"] },
            {
                hash: "master-base",
                parentHashes: [],
                graphRefs: [
                    { name: "origin/master", type: "remote", tracked: true },
                    { name: "master", type: "local" },
                ],
            },
        ]);

        const mergeRow = graph.rows.find((row) => row.commitHash === "topic-merge");
        const primaryEdge = mergeRow?.elements.find(
            (element) => element.type === "edge" && element.edgeId === "topic-merge:topic-next:0",
        );
        const secondaryEdge = mergeRow?.elements.find(
            (element) => element.type === "edge" && element.edgeId === "topic-merge:ad-head:1",
        );

        expect(primaryEdge?.type).toBe("edge");
        expect(secondaryEdge?.type).toBe("edge");
        expect(primaryEdge && primaryEdge.type === "edge" ? primaryEdge.toPosition : -1).toBeLessThan(
            secondaryEdge && secondaryEdge.type === "edge" ? secondaryEdge.toPosition : -1,
        );
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

        expect(graph.rows[1].elements.filter((element) => element.type === "edge").length).toBeGreaterThanOrEqual(2);
    });

    it("graph compute can bring a newly encountered mainline back to the left edge", () => {
        const graph = computeGraph([
            { hash: "top-merge", parentHashes: ["alpha-bridge", "side-1"], refs: ["feature/top"] },
            { hash: "merge-2", parentHashes: ["alpha-next", "side-2"], refs: ["alpha"] },
            { hash: "side-1", parentHashes: ["side-2"] },
            { hash: "side-2", parentHashes: ["base"] },
            { hash: "alpha-bridge", parentHashes: ["alpha-next"] },
            { hash: "alpha-next", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[5].nodePosition).toBe(0);
        expect(graph.rows[2].nodePosition).toBeGreaterThan(graph.rows[5].nodePosition);
    });

    it("graph compute keeps cross-lane edge transitions local between adjacent rows", () => {
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
        expect(
            intermediateSegments.every(
                ({ element }) => Math.abs(element.toPosition - element.fromPosition) <= 1,
            ),
        ).toBe(true);
    });

    it("graph compute compresses rows to nearby visible columns even when other rows are wider", () => {
        const graph = computeGraph([
            { hash: "top-left", parentHashes: ["left-1"], refs: ["feature/left"] },
            { hash: "top-right", parentHashes: ["right-1"], refs: ["feature/right"] },
            { hash: "left-1", parentHashes: ["merge"] },
            { hash: "right-1", parentHashes: ["merge"] },
            { hash: "merge", parentHashes: ["base", "side"] },
            { hash: "side", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[0].nodePosition).toBe(0);
        expect(graph.rows[1].nodePosition).toBe(1);
        expect(graph.recommendedWidth).toBeGreaterThanOrEqual(graph.rows[0].occupiedWidth);
    });

    it("graph compute keeps each row's visible slots densely packed", () => {
        const commits = [
            { hash: "top", parentHashes: ["top-base"] },
            { hash: "topic-head", parentHashes: ["topic-base"] },
            { hash: "merge-0", parentHashes: ["main-0", "side-0"] },
            { hash: "side-0", parentHashes: ["side-1"] },
            { hash: "main-0", parentHashes: ["main-1"] },
            { hash: "side-1", parentHashes: ["side-2"] },
            { hash: "main-1", parentHashes: ["main-2"] },
            { hash: "side-2", parentHashes: ["base"] },
            { hash: "main-2", parentHashes: ["base"] },
            { hash: "top-base", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ];

        for (let index = 0; index < 32; index += 1) {
            commits.push({
                hash: `filler-${index}`,
                parentHashes: [index === 31 ? "topic-base" : `filler-${index + 1}`],
            });
        }
        commits.push({ hash: "topic-base", parentHashes: ["base"] });

        const graph = computeGraph(commits);
        for (const row of graph.rows.slice(0, 9)) {
            const uniquePositions = [
                ...new Set(
                    row.elements.flatMap((element) => {
                        switch (element.type) {
                            case "edge":
                                return [element.fromPosition, element.toPosition];
                            case "terminal":
                                return [element.position];
                            case "node":
                                return [element.position];
                        }
                    }),
                ),
            ].sort((left, right) => left - right);

            expect(uniquePositions).toEqual(
                Array.from({ length: uniquePositions.length }, (_item, index) => index),
            );
        }
    });

    it("graph compute keeps merge rows locally compact instead of preserving global gaps", () => {
        const graph = computeGraph([
            { hash: "top", parentHashes: ["merge-outer"] },
            { hash: "merge-outer", parentHashes: ["left-2", "right-2"] },
            { hash: "left-2", parentHashes: ["merge-inner"] },
            { hash: "right-2", parentHashes: ["right-1"] },
            { hash: "merge-inner", parentHashes: ["left-1", "mid-1"] },
            { hash: "left-1", parentHashes: ["base"] },
            { hash: "mid-1", parentHashes: ["base"] },
            { hash: "right-1", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        expect(graph.rows[1].occupiedWidth).toBeLessThanOrEqual(graph.recommendedWidth);
        expect(graph.rows[4].occupiedWidth).toBeLessThanOrEqual(graph.recommendedWidth);
    });

    it("graph compute keeps short parent edges continuous by reserving endpoint columns", () => {
        const graph = computeGraph([
            { hash: "head", parentHashes: ["merge"] },
            { hash: "merge", parentHashes: ["main", "side"] },
            { hash: "main", parentHashes: ["base"] },
            { hash: "side", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        const directEdge = graph.rows.flatMap((row) => row.elements).find(
            (element) =>
                element.type === "edge" &&
                element.edgeId === "merge:side:1" &&
                element.toAnchor === "nextCenter",
        );

        expect(directEdge && directEdge.type === "edge").toBe(true);
        expect(directEdge && directEdge.type === "edge" && directEdge.toAnchor).toBe("nextCenter");
        expect(graph.rows[1].elements.filter((element) => element.type === "edge").length).toBeGreaterThanOrEqual(2);
    });

    it("graph compute bends short cross-column edges at row centers", () => {
        const graph = computeGraph([
            { hash: "head", parentHashes: ["merge"] },
            { hash: "merge", parentHashes: ["main-2", "side-2"], refs: ["alpha"] },
            { hash: "main-2", parentHashes: ["main-1"] },
            { hash: "side-2", parentHashes: ["side-1"] },
            { hash: "main-1", parentHashes: ["base"] },
            { hash: "side-1", parentHashes: ["base"] },
            { hash: "base", parentHashes: [] },
        ]);

        const turningSegment = graph.rows[2].elements.find(
            (element) => element.type === "edge" && element.edgeId === "merge:side-2:1",
        );

        expect(turningSegment && turningSegment.type === "edge" && turningSegment.fromAnchor).toBe(
            "center",
        );
        expect(turningSegment && turningSegment.type === "edge" && turningSegment.toAnchor).toBe(
            "nextCenter",
        );
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

        expect(wide.recommendedWidth).toBeGreaterThan(90);
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
        expect(mergeRowColors.size).toBeGreaterThanOrEqual(10);
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

        expect(compacted.recommendedWidth).toBeLessThan(240);
        expect(compacted.recommendedWidth).toBeGreaterThan(130);
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

    it("date formatting matches commit list relative labels", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-04-24T12:00:00"));

            expect(formatDateTime("2026-04-24T11:34:00")).toBe("26 minutes ago");
            expect(formatDateTime("2026-04-24T10:59:00")).toBe("1 hour ago");
            expect(formatDateTime("2026-04-23T21:34:00")).toBe("Yesterday 21:34");
            expect(formatDateTime("2026-04-22T18:26:00")).toBe("2026/4/22 18:26");
        } finally {
            vi.useRealTimers();
        }
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
        expect(contentContainerStyle(5).height).toBe(120);
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
