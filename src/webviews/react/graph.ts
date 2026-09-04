import {
    buildPermanentGraph,
    orderCommitsForGraph,
    type PermanentEdge,
} from "./commit-list/graphModel";
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
    const knownHashes = new Set(orderedCommits.map((commit) => commit.hash));
    const externalParentEdges: PermanentEdge[] = orderedCommits.flatMap((commit, rowIndex) =>
        commit.parentHashes.flatMap((parentHash, parentIndex) => {
            if (knownHashes.has(parentHash)) {
                return [];
            }
            const sourceRow = permanentGraph.rows[rowIndex];
            if (!sourceRow) return [];
            return [
                {
                    edgeId: `${commit.hash}:${parentHash}:${parentIndex}:external-parent`,
                    laneId: sourceRow.node.laneId,
                    fromLaneId: sourceRow.node.laneId,
                    toLaneId: sourceRow.node.laneId,
                    targetHash: parentHash,
                    upRowIndex: rowIndex,
                    downRowIndex: Number.MAX_SAFE_INTEGER,
                    upLayoutIndex: sourceRow.node.layoutIndex,
                    downLayoutIndex: sourceRow.node.layoutIndex,
                    color: sourceRow.node.color,
                    isPrimary: parentIndex === 0,
                },
            ];
        }),
    );
    const result = buildRenderRows({
        ...permanentGraph,
        edges: [...permanentGraph.edges, ...externalParentEdges],
    });
    return {
        ...result,
        orderedHashes: orderedCommits.map((commit) => commit.hash),
        rows: result.rows.map((row, index) => ({
            ...row,
            repoRoot: orderedCommits[index]?.repoRoot,
        })),
    };
}
