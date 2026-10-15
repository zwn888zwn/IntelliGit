// @vitest-environment jsdom
import React, { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommitRow } from "../../src/webviews/react/commit-list/CommitRow";
import { CommitList } from "../../src/webviews/react/CommitList";
import { ROW_HEIGHT } from "../../src/webviews/react/graph";
import type { Commit, PipelineStatus } from "../../src/types";
import { initReactDomTestEnvironment, mount, unmount } from "./utils/reactDomTestUtils";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../../src/webviews/react/shared/vscodeApi", () => ({ getVsCodeApi: () => ({ postMessage }) }));
initReactDomTestEnvironment();

const commit: Commit = {
    hash: "a".repeat(40), shortHash: "aaaaaaa", repoRoot: "/repo", repoId: "repo",
    message: "Commit", author: "Test", email: "test@example.test", date: "2026-10-14T00:00:00Z",
    parentHashes: [], refs: [],
};
const props = { commit, rowLeftOffset: 0, messageIndent: 0, isSelected: false,
    isUnpushed: false, showPipeline: true, onSelect: vi.fn(), onContextMenu: vi.fn() };

describe("pipeline indicator", () => {
    it("reports only visible rows plus eight neighbors instead of all 500 loaded commits", () => {
        const commits = Array.from({ length: 500 }, (_, index) => ({
            ...commit,
            hash: index.toString(16).padStart(40, "0"),
            parentHashes: index < 499 ? [(index + 1).toString(16).padStart(40, "0")] : [],
        }));
        const report = vi.fn();
        const { container, root } = mount(<CommitList
            commits={commits} repositories={[]} repository={null} selectedHash={null}
            filterText="" hasMore={false} unpushedHashes={new Set()} selectedBranch={null}
            repoRailExpanded={false} onToggleRepoRail={() => {}} onSelectCommit={() => {}}
            onFilterText={() => {}} onLoadMore={() => {}} onCommitAction={() => {}}
            onPipelineCommitsChange={report}
        />);
        expect(report).toHaveBeenLastCalledWith([]);
        const viewport = container.querySelector('[data-testid="commit-list-viewport"]') as HTMLDivElement;
        Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 10 * ROW_HEIGHT });
        act(() => window.dispatchEvent(new Event("resize")));
        expect(report.mock.calls.at(-1)?.[0]).toEqual(commits.slice(0, 18).map(({ repoRoot, hash }) => ({ repoRoot, hash })));

        act(() => {
            viewport.scrollTop = 100 * ROW_HEIGHT;
            viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(report.mock.calls.at(-1)?.[0]).toEqual(commits.slice(92, 118).map(({ repoRoot, hash }) => ({ repoRoot, hash })));
        Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 0 });
        act(() => window.dispatchEvent(new Event("resize")));
        expect(report).toHaveBeenLastCalledWith([]);
        report.mockClear();
        unmount(root, container);
        expect(report).toHaveBeenLastCalledWith([]);
    });

    it("updates a memoized row when only CI status changes", () => {
        const { container, root } = mount(<CommitRow {...props} pipeline={{ state: "running", title: "CI running" }} />);
        expect(container.querySelector(".intelligit-pipeline-running")).not.toBeNull();
        act(() => root.render(<CommitRow {...props} pipeline={{ state: "failed", title: "CI failed" }} />));
        expect(container.querySelector("button")?.getAttribute("aria-label")).toBe("CI failed");
        expect(container.querySelector(".intelligit-pipeline-running")).toBeNull();
    });

    it("opens the host-owned pipeline link without selecting the commit", () => {
        const pipeline: PipelineStatus = { state: "success", title: "CI passed", url: "https://gitlab.example.test/pipeline/1" };
        const { container } = mount(<CommitRow {...props} pipeline={pipeline} />);
        act(() => container.querySelector("button")!.click());
        expect(postMessage).toHaveBeenCalledWith({ type: "openPipeline", repoRoot: "/repo", hash: commit.hash });
        expect(props.onSelect).not.toHaveBeenCalled();
    });

    it("does not invent a success indicator when CI is missing or unavailable", () => {
        const { container, root } = mount(<CommitRow {...props} />);
        expect(container.querySelector("button")).toBeNull();
        act(() => root.render(<CommitRow {...props} pipeline={{ state: "unknown", title: "Check token" }} />));
        act(() => container.querySelector("button")!.click());
        expect(container.querySelector("button")?.getAttribute("aria-disabled")).toBe("true");
        expect(postMessage).not.toHaveBeenCalled();
    });
});
