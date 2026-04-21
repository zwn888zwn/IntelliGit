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

type PendingPermanentEdge = Omit<PermanentEdge, "downRowIndex" | "downLayoutIndex">;

interface ActiveLane {
    laneId: string;
    hash: string;
    color: string;
    layoutIndex: number;
}

const COLORS = GRAPH_LANE_COLORS;

export function buildPermanentGraph(
    commits: Array<{ hash: string; parentHashes: string[] }>,
): PermanentGraphModel {
    const lanes: Array<ActiveLane | null> = [];
    const laneColors = new Map<string, string>();
    const rows: PermanentRow[] = [];
    const pendingEdges: Array<Omit<PermanentEdge, "downRowIndex" | "downLayoutIndex">> = [];
    let nextLaneId = 0;
    let nextLayoutIndex = 0;
    let nextColorIndex = 0;
    let generatedColorIndex = 0;

    function makeLaneId(): string {
        const laneId = `lane-${nextLaneId}`;
        nextLaneId += 1;
        return laneId;
    }

    function findFreeColumn(): number {
        const freeIndex = lanes.indexOf(null);
        if (freeIndex >= 0) return freeIndex;
        lanes.push(null);
        return lanes.length - 1;
    }

    function findLaneIndex(hash: string): number {
        return lanes.findIndex((lane) => lane?.hash === hash);
    }

    function snapshotActiveLanes(): PermanentLaneRef[] {
        const activeLanes: PermanentLaneRef[] = [];
        for (let rawOrder = 0; rawOrder < lanes.length; rawOrder += 1) {
            const lane = lanes[rawOrder];
            if (!lane) continue;
            activeLanes.push({
                laneId: lane.laneId,
                rawOrder: lane.layoutIndex,
                color: lane.color,
                hash: lane.hash,
            });
        }
        return activeLanes;
    }

    function allocateColor(extraAvoidColors: Iterable<string> = []): string {
        const usedColors = new Set<string>(extraAvoidColors);
        for (const lane of lanes) {
            if (lane) usedColors.add(lane.color);
        }
        for (let i = 0; i < COLORS.length; i += 1) {
            const color = COLORS[(nextColorIndex + i) % COLORS.length];
            if (!usedColors.has(color)) {
                nextColorIndex = (nextColorIndex + i + 1) % COLORS.length;
                return color;
            }
        }
        for (;;) {
            const hue = Math.round((generatedColorIndex * 137.508) % 360);
            generatedColorIndex += 1;
            const color = `hsl(${hue} 62% 58%)`;
            if (!usedColors.has(color)) {
                return color;
            }
        }
    }

    for (const commit of commits) {
        const reservedColors = new Set<string>();
        let currentRawOrder = findLaneIndex(commit.hash);
        if (currentRawOrder === -1) {
            currentRawOrder = findFreeColumn();
            const laneId = makeLaneId();
            const color = allocateColor(reservedColors);
            lanes[currentRawOrder] = {
                laneId,
                hash: commit.hash,
                color,
                layoutIndex: nextLayoutIndex,
            };
            nextLayoutIndex += 1;
            laneColors.set(laneId, color);
        }

        const currentLane = lanes[currentRawOrder];
        if (!currentLane) continue;

        reservedColors.add(currentLane.color);
        const topLanes = snapshotActiveLanes();
        const edges: PendingPermanentEdge[] = [];

        lanes[currentRawOrder] = null;

        for (let parentIndex = 0; parentIndex < commit.parentHashes.length; parentIndex += 1) {
            const parentHash = commit.parentHashes[parentIndex];
            const existingRawOrder = findLaneIndex(parentHash);

            if (existingRawOrder >= 0) {
                const existingLane = lanes[existingRawOrder];
                if (!existingLane) continue;
                reservedColors.add(existingLane.color);
                edges.push({
                    edgeId: `${commit.hash}:${parentHash}:${parentIndex}`,
                    laneId: existingLane.laneId,
                    fromLaneId: currentLane.laneId,
                    toLaneId: existingLane.laneId,
                    targetHash: parentHash,
                    upRowIndex: rows.length,
                    upLayoutIndex: currentLane.layoutIndex,
                    color: existingLane.color,
                    isPrimary: parentIndex === 0,
                });
                continue;
            }

            if (parentIndex === 0) {
                lanes[currentRawOrder] = {
                    laneId: currentLane.laneId,
                    hash: parentHash,
                    color: currentLane.color,
                    layoutIndex: currentLane.layoutIndex,
                };
                edges.push({
                    edgeId: `${commit.hash}:${parentHash}:${parentIndex}`,
                    laneId: currentLane.laneId,
                    fromLaneId: currentLane.laneId,
                    toLaneId: currentLane.laneId,
                    targetHash: parentHash,
                    upRowIndex: rows.length,
                    upLayoutIndex: currentLane.layoutIndex,
                    color: currentLane.color,
                    isPrimary: true,
                });
                continue;
            }

            const rawOrder = findFreeColumn();
            const laneId = makeLaneId();
            const color = allocateColor(reservedColors);
            reservedColors.add(color);
            lanes[rawOrder] = {
                laneId,
                hash: parentHash,
                color,
                layoutIndex: nextLayoutIndex,
            };
            nextLayoutIndex += 1;
            laneColors.set(laneId, color);
            edges.push({
                edgeId: `${commit.hash}:${parentHash}:${parentIndex}`,
                laneId,
                fromLaneId: currentLane.laneId,
                toLaneId: laneId,
                targetHash: parentHash,
                upRowIndex: rows.length,
                upLayoutIndex: currentLane.layoutIndex,
                color,
                isPrimary: false,
            });
        }

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
            lanes.pop();
        }

        rows.push({
            rowIndex: rows.length,
            node: {
                commitHash: commit.hash,
                parentHashes: commit.parentHashes,
                laneId: currentLane.laneId,
                layoutIndex: currentLane.layoutIndex,
                color: currentLane.color,
            },
            topLanes,
            edges: [],
        });
        pendingEdges.push(...edges);
    }

    const hashToRow = new Map(rows.map((row) => [row.node.commitHash, row]));
    const edges: PermanentEdge[] = pendingEdges.flatMap((edge) => {
        const targetRow = hashToRow.get(edge.targetHash);
        if (!targetRow) return [];
        return [
            {
                ...edge,
                downRowIndex: targetRow.rowIndex,
                downLayoutIndex: targetRow.node.layoutIndex,
            },
        ];
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
