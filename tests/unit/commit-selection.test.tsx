// @vitest-environment jsdom
import React, { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommitList } from "../../src/webviews/react/CommitList";
import type { Commit } from "../../src/types";
import { initReactDomTestEnvironment, mount } from "./utils/reactDomTestUtils";

initReactDomTestEnvironment();
const hashes = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40)];
const commits: Commit[] = hashes.map((hash, index) => ({
    hash,
    shortHash: hash.slice(0, 7),
    message: `change ${index}`,
    author: "Test",
    email: "test@example.invalid",
    date: "2026-10-14T00:00:00Z",
    parentHashes: [hashes[index + 1] ?? "e".repeat(40)],
    refs: [],
    repoRoot: "/repo",
    repoId: "repo",
}));

function setup() {
    const action = vi.fn();
    function List() {
        const [selected, setSelected] = useState<string | null>(null);
        return (
            <CommitList
                commits={commits}
                repositories={[]}
                repository={null}
                selectedHash={selected}
                currentCommitRefs={[{ repoRoot: "/repo", hash: hashes[0] }]}
                filterText=""
                hasMore={false}
                unpushedHashes={new Set(hashes)}
                selectedBranch={null}
                repoRailExpanded={false}
                onToggleRepoRail={() => {}}
                onSelectCommit={setSelected}
                onFilterText={() => {}}
                onLoadMore={() => {}}
                onCommitAction={action}
            />
        );
    }
    const { container } = mount(<List />);
    const rows = () => Array.from(container.querySelectorAll("[aria-selected]"));
    const click = (index: number, options: MouseEventInit = {}) =>
        act(() =>
            rows()[index].dispatchEvent(new MouseEvent("click", { bubbles: true, ...options })),
        );
    const menu = (index: number) => {
        act(() =>
            rows()[index].dispatchEvent(
                new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
            ),
        );
        return Array.from(document.querySelectorAll("[role=menuitem]")).find((item) =>
            item.textContent?.includes("Squash"),
        );
    };
    return { action, rows, click, menu };
}

describe("commit multi-selection", () => {
    it("selects a range with Shift and sends all hashes when squashing", () => {
        const list = setup();
        list.click(0);
        list.click(2, { shiftKey: true });
        expect(
            list.rows().filter((row) => row.getAttribute("aria-selected") === "true"),
        ).toHaveLength(3);
        const item = list.menu(1)!;
        expect(item.getAttribute("data-disabled")).toBe("false");
        act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        expect(list.action).toHaveBeenCalledWith("squashCommits", hashes[1], hashes.slice(0, 3));
    });

    it("disables nonconsecutive selection and supports modifier deselection", () => {
        const list = setup();
        list.click(0);
        list.click(2, { metaKey: true });
        expect(list.menu(0)?.getAttribute("data-disabled")).toBe("true");
        act(() =>
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
        );
        list.click(2, { ctrlKey: true });
        expect(
            list.rows().filter((row) => row.getAttribute("aria-selected") === "true"),
        ).toHaveLength(1);
        list.click(0, { metaKey: true });
        expect(
            list.rows().filter((row) => row.getAttribute("aria-selected") === "true"),
        ).toHaveLength(0);
    });

    it("disables an older range that does not end at HEAD", () => {
        const list = setup();
        list.click(1);
        list.click(2, { shiftKey: true });
        expect(list.menu(1)?.getAttribute("data-disabled")).toBe("true");
    });
});
