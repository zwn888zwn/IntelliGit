import { buildPermanentGraph, orderCommitsForGraph } from "./commit-list/graphModel";
import { buildRenderRows, type CommitGraphLayoutResult } from "./commit-list/graphRouter";
import type { GraphRefInfo } from "../../types";

export const LANE_WIDTH = 16;
export const DOT_RADIUS = 3.25;
export const ROW_HEIGHT = 24;

export type {
    ArrowMarker,
    CommitGraphLayoutResult,
    EdgeAnchor,
    EdgePrintElement,
    NodePrintElement,
    PrintElement,
    RenderRowModel,
    TerminalEdgePrintElement,
} from "./commit-list/graphRouter";

export function computeGraph(
    commits: Array<{
        hash: string;
        parentHashes: string[];
        refs?: string[];
        graphRefs?: GraphRefInfo[];
        repoRoot?: string;
        date?: string;
    }>,
): CommitGraphLayoutResult {
    const { commits: orderedCommits, layoutIndexByHash, headRows } = orderCommitsForGraph(commits);
    const permanentGraph = buildPermanentGraph(orderedCommits, layoutIndexByHash, headRows);
    const result = buildRenderRows(permanentGraph);
    return {
        ...result,
        orderedHashes: orderedCommits.map((commit) => commit.hash),
        rows: result.rows.map((row, index) => ({
            ...row,
            repoRoot: orderedCommits[index]?.repoRoot,
        })),
    };
}
