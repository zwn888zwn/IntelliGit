import { GRAPH_LANE_COLORS } from "../shared/tokens";

export interface PermanentLaneRef {
    laneId: string;
    rawOrder: number;
    color: string;
    hash: string;
}

export interface PermanentEdge {
    edgeId: string;
    laneId: string;
    fromLaneId: string;
    toLaneId: string;
    targetHash: string;
    upRowIndex: number;
    downRowIndex: number;
    upLayoutIndex: number;
    downLayoutIndex: number;
    color: string;
    isPrimary: boolean;
}

export interface PermanentNode {
    commitHash: string;
    parentHashes: string[];
    laneId: string;
    layoutIndex: number;
    color: string;
}

export interface PermanentRow {
    rowIndex: number;
    node: PermanentNode;
    topLanes: PermanentLaneRef[];
    edges: PermanentEdge[];
}

export interface PermanentGraphModel {
    rows: PermanentRow[];
    laneColors: Map<string, string>;
    edges: PermanentEdge[];
    maxLayoutIndex: number;
}

const COLORS = GRAPH_LANE_COLORS;

export function buildPermanentGraph(
    commits: Array<{ hash: string; parentHashes: string[]; refs?: string[] }>,
): PermanentGraphModel {
    const { layoutIndexByHash, colorIndexByHash } = buildGraphAssignments(commits);
    const laneColors = new Map<string, string>();
    const rows: PermanentRow[] = commits.map((commit, rowIndex) => {
        const layoutIndex = layoutIndexByHash.get(commit.hash) ?? 0;
        const laneId = `lane-${layoutIndex}`;
        const color = colorForLayoutIndex(colorIndexByHash.get(commit.hash) ?? layoutIndex);
        laneColors.set(laneId, color);
        return {
            rowIndex,
            node: {
                commitHash: commit.hash,
                parentHashes: commit.parentHashes,
                laneId,
                layoutIndex,
                color,
            },
            topLanes: [],
            edges: [],
        };
    });

    const hashToRow = new Map(rows.map((row) => [row.node.commitHash, row]));
    const edges: PermanentEdge[] = commits.flatMap((commit, rowIndex) => {
        const currentRow = rows[rowIndex];
        return commit.parentHashes.flatMap((parentHash, parentIndex) => {
            const targetRow = hashToRow.get(parentHash);
            if (!targetRow) return [];
            const laneId = `lane-${targetRow.node.layoutIndex}`;
            const color = parentIndex === 0 ? currentRow.node.color : targetRow.node.color;
            return [
                {
                    edgeId: `${commit.hash}:${parentHash}:${parentIndex}`,
                    laneId,
                    fromLaneId: currentRow.node.laneId,
                    toLaneId: targetRow.node.laneId,
                    targetHash: parentHash,
                    upRowIndex: rowIndex,
                    downRowIndex: targetRow.rowIndex,
                    upLayoutIndex: currentRow.node.layoutIndex,
                    downLayoutIndex: targetRow.node.layoutIndex,
                    color,
                    isPrimary: parentIndex === 0,
                },
            ];
        });
    });

    const edgesByRow = new Map<number, PermanentEdge[]>();
    for (const edge of edges) {
        const rowEdges = edgesByRow.get(edge.upRowIndex) ?? [];
        rowEdges.push(edge);
        edgesByRow.set(edge.upRowIndex, rowEdges);
    }

    const normalizedRows = rows.map((row) => ({
        ...row,
        edges: edgesByRow.get(row.rowIndex) ?? [],
    }));

    return {
        rows: normalizedRows,
        laneColors,
        edges,
        maxLayoutIndex: Math.max(-1, ...normalizedRows.map((row) => row.node.layoutIndex)),
    };
}

function buildGraphAssignments(
    commits: Array<{ hash: string; parentHashes: string[]; refs?: string[] }>,
): { layoutIndexByHash: Map<string, number>; colorIndexByHash: Map<string, number> } {
    const layoutIndexByHash = new Map<string, number>();
    const colorIndexByHash = new Map<string, number>();
    const visibleHashes = new Set(commits.map((commit) => commit.hash));
    const rowIndexByHash = new Map(commits.map((commit, rowIndex) => [commit.hash, rowIndex]));
    const referencedAsParent = new Set<string>();

    for (const commit of commits) {
        for (const parentHash of commit.parentHashes) {
            if (visibleHashes.has(parentHash)) {
                referencedAsParent.add(parentHash);
            }
        }
    }

    const heads = commits
        .map((commit, rowIndex) => ({ commit, rowIndex }))
        .filter(({ commit }) => !referencedAsParent.has(commit.hash))
        .sort((left, right) => {
            const scoreDelta = getHeadScore(right.commit) - getHeadScore(left.commit);
            if (scoreDelta !== 0) return scoreDelta;
            return left.rowIndex - right.rowIndex;
        });

    let nextLayoutIndex = 0;

    const assignLayoutFrom = (startHash: string): void => {
        let currentHash: string | undefined = startHash;
        while (currentHash && !layoutIndexByHash.has(currentHash)) {
            layoutIndexByHash.set(currentHash, nextLayoutIndex);
            const rowIndex = rowIndexByHash.get(currentHash);
            if (typeof rowIndex !== "number") break;
            const currentCommit = commits[rowIndex];
            currentHash = currentCommit.parentHashes.find(
                (parentHash) =>
                    visibleHashes.has(parentHash) && !layoutIndexByHash.has(parentHash),
            );
        }
        nextLayoutIndex += 1;
    };

    for (const { commit } of heads) {
        if (layoutIndexByHash.has(commit.hash)) continue;
        assignLayoutFrom(commit.hash);
    }

    const branchSeeds = commits
        .map((commit, rowIndex) => ({ commit, rowIndex }))
        .filter(({ commit }) => (commit.refs?.length ?? 0) > 0)
        .sort((left, right) => {
            const scoreDelta = getHeadScore(right.commit) - getHeadScore(left.commit);
            if (scoreDelta !== 0) return scoreDelta;
            return left.rowIndex - right.rowIndex;
        });

    for (const { commit } of branchSeeds) {
        if (layoutIndexByHash.has(commit.hash)) continue;
        assignLayoutFrom(commit.hash);
    }

    for (const commit of commits) {
        if (layoutIndexByHash.has(commit.hash)) continue;
        assignLayoutFrom(commit.hash);
    }

    let nextColorIndex = 0;
    const colorSeeds = commits
        .map((commit, rowIndex) => ({ commit, rowIndex }))
        .filter(({ commit }) => (commit.refs?.length ?? 0) > 0)
        .sort((left, right) => {
            const scoreDelta = getHeadScore(right.commit) - getHeadScore(left.commit);
            if (scoreDelta !== 0) return scoreDelta;
            return left.rowIndex - right.rowIndex;
        });

    const assignColorFrom = (startHash: string): void => {
        const colorIndex = nextColorIndex;
        nextColorIndex += 1;
        let currentHash: string | undefined = startHash;
        while (currentHash && !colorIndexByHash.has(currentHash)) {
            colorIndexByHash.set(currentHash, colorIndex);
            const rowIndex = rowIndexByHash.get(currentHash);
            if (typeof rowIndex !== "number") break;
            const currentCommit = commits[rowIndex];
            currentHash = currentCommit.parentHashes.find(
                (parentHash) => visibleHashes.has(parentHash) && !colorIndexByHash.has(parentHash),
            );
        }
    };

    for (const { commit } of [...colorSeeds, ...heads]) {
        if (colorIndexByHash.has(commit.hash)) continue;
        assignColorFrom(commit.hash);
    }

    for (const commit of commits) {
        if (colorIndexByHash.has(commit.hash)) continue;
        assignColorFrom(commit.hash);
    }

    return { layoutIndexByHash, colorIndexByHash };
}

function getHeadScore(commit: { refs?: string[] }): number {
    return commit.refs?.length ?? 0;
}

function colorForLayoutIndex(layoutIndex: number): string {
    return COLORS[((layoutIndex % COLORS.length) + COLORS.length) % COLORS.length];
}
