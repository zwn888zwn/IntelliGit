import { buildPermanentGraph, orderCommitsForGraph } from "./commit-list/graphModel";
import { buildRenderRows, type CommitGraphLayoutResult } from "./commit-list/graphRouter";

export const LANE_WIDTH = 16;
export const DOT_RADIUS = 3.25;
export const ROW_HEIGHT = 28;

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
        repoRoot?: string;
        date?: string;
    }>,
): CommitGraphLayoutResult {
    const { commits: orderedCommits, layoutIndexByHash } = orderCommitsForGraph(commits);
    const permanentGraph = buildPermanentGraph(orderedCommits, layoutIndexByHash);
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
