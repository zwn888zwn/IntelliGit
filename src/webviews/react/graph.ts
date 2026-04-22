import { buildPermanentGraph } from "./commit-list/graphModel";
import { buildRenderRows, type CommitGraphLayoutResult } from "./commit-list/graphRouter";

export const LANE_WIDTH = 18;
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
    commits: Array<{ hash: string; parentHashes: string[]; refs?: string[] }>,
): CommitGraphLayoutResult {
    const permanentGraph = buildPermanentGraph(commits);
    return buildRenderRows(permanentGraph);
}
