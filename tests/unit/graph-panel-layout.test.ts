import { describe, expect, it } from "vitest";
import { fitGraphPaneWidths } from "../../src/webviews/react/commit-list/panelLayout";

describe("Git panel widths", () => {
    it("preserves room for the graph and metadata across narrow windows", () => {
        for (const width of [1850, 1400, 1150, 980, 800, 700, 600]) {
            const panes = fitGraphPaneWidths(width, 260, 330);
            expect(width - panes.branch - panes.info - 8).toBeGreaterThanOrEqual(400);
            expect(panes.branch).toBeGreaterThan(0);
            expect(panes.info).toBeGreaterThan(0);
        }
    });
    it("honors manual sizes when there is room and restores them after narrowing", () => {
        expect(fitGraphPaneWidths(1850, 300, 400)).toEqual({ branch: 300, info: 400 });
        expect(fitGraphPaneWidths(800, 300, 400).branch).toBeLessThan(300);
        expect(fitGraphPaneWidths(1850, 300, 400)).toEqual({ branch: 300, info: 400 });
        expect(fitGraphPaneWidths(0, 300, 400)).toEqual({ branch: 300, info: 400 });
    });
});
