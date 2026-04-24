import type { PermanentGraphModel, PermanentEdge } from "./graphModel";

const LANE_WIDTH = 14;
const LONG_EDGE_SIZE = 30;
const LONG_EDGE_VISIBLE_PART_SIZE = 1;
const GRAPH_SIDE_PADDING = 6;

export type EdgeAnchor = "top" | "center" | "bottom";

export interface NodePrintElement {
    type: "node";
    laneId: string;
    color: string;
    position: number;
}

export interface EdgePrintElement {
    type: "edge";
    edgeId: string;
    color: string;
    fromPosition: number;
    toPosition: number;
    fromAnchor: EdgeAnchor;
    toAnchor: EdgeAnchor;
}

export interface TerminalEdgePrintElement {
    type: "terminal";
    edgeId: string;
    color: string;
    position: number;
    direction: "up" | "down";
    targetHash: string;
    targetRowIndex: number;
}

export type PrintElement = NodePrintElement | EdgePrintElement | TerminalEdgePrintElement;

export interface ArrowMarker {
    edgeId: string;
    rowIndex: number;
    position: number;
    direction: "up" | "down";
    targetHash: string;
    targetRowIndex: number;
    color: string;
}

export interface RenderRowModel {
    commitHash: string;
    parentHashes: string[];
    nodePosition: number;
    nodeColor: string;
    occupiedWidth: number;
    elements: PrintElement[];
}

export interface CommitGraphLayoutResult {
    rows: RenderRowModel[];
    recommendedWidth: number;
    arrowMarkers: ArrowMarker[];
}

interface RowRenderPositions {
    nodePosition: number;
    edgePositions: Map<string, number>;
    maxPosition: number;
}

interface ActiveLane {
    hash: string;
}

export function buildRenderRows(graph: PermanentGraphModel): CommitGraphLayoutResult {
    const rowRenderPositions = buildRowRenderPositions(graph);
    const rows: RenderRowModel[] = graph.rows.map((row, rowIndex) => ({
        commitHash: row.node.commitHash,
        parentHashes: row.node.parentHashes,
        nodePosition: rowRenderPositions[rowIndex]?.nodePosition ?? 0,
        nodeColor: row.node.color,
        occupiedWidth: widthForVisibleCount(1),
        elements: [
            {
                type: "node",
                laneId: row.node.laneId,
                color: row.node.color,
                position: rowRenderPositions[rowIndex]?.nodePosition ?? 0,
            },
        ],
    }));
    const arrowMarkers: ArrowMarker[] = [];

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        if (isLongEdge(edge)) {
            renderLongEdge(graph, rows, rowRenderPositions, edge, arrowMarkers);
        } else {
            renderShortEdge(rows, rowRenderPositions, edge);
        }
    }

    for (const row of rows) {
        row.occupiedWidth = calculateRowOccupiedWidth(row);
    }

    return {
        rows,
        recommendedWidth: calculateReservedWidth(rowRenderPositions),
        arrowMarkers,
    };
}

function renderShortEdge(
    rows: RenderRowModel[],
    rowRenderPositions: RowRenderPositions[],
    edge: PermanentEdge,
): void {
    for (let rowIndex = edge.upRowIndex; rowIndex <= edge.downRowIndex; rowIndex += 1) {
        const element = edgeSegmentForRow(rowRenderPositions, edge, rowIndex);
        if (!element) continue;
        rows[rowIndex].elements.push(element);
    }
}

function renderLongEdge(
    graph: PermanentGraphModel,
    rows: RenderRowModel[],
    rowRenderPositions: RowRenderPositions[],
    edge: PermanentEdge,
    arrowMarkers: ArrowMarker[],
): void {
    const topStubRow = edge.upRowIndex + LONG_EDGE_VISIBLE_PART_SIZE;
    const bottomStubRow = edge.downRowIndex - LONG_EDGE_VISIBLE_PART_SIZE;

    const startElement = edgeSegmentForRow(rowRenderPositions, edge, edge.upRowIndex);
    if (startElement) {
        rows[edge.upRowIndex].elements.push(startElement);
    }
    const endElement = edgeSegmentForRow(rowRenderPositions, edge, edge.downRowIndex);
    if (endElement) {
        rows[edge.downRowIndex].elements.push(endElement);
    }

    if (topStubRow < edge.downRowIndex) {
        const position = getEdgePosition(rowRenderPositions, topStubRow, edge.edgeId);
        rows[topStubRow].elements.push({
            type: "terminal",
            edgeId: edge.edgeId,
            color: edge.color,
            position,
            direction: "down",
            targetHash: edge.targetHash,
            targetRowIndex: edge.downRowIndex,
        });
        arrowMarkers.push({
            edgeId: edge.edgeId,
            rowIndex: topStubRow,
            position,
            direction: "down",
            targetHash: edge.targetHash,
            targetRowIndex: edge.downRowIndex,
            color: edge.color,
        });
    }

    if (bottomStubRow > edge.upRowIndex) {
        const sourceRow = graph.rows[edge.upRowIndex];
        const position = getEdgePosition(rowRenderPositions, bottomStubRow, edge.edgeId);
        rows[bottomStubRow].elements.push({
            type: "terminal",
            edgeId: edge.edgeId,
            color: edge.color,
            position,
            direction: "up",
            targetHash: sourceRow.node.commitHash,
            targetRowIndex: edge.upRowIndex,
        });
        arrowMarkers.push({
            edgeId: edge.edgeId,
            rowIndex: bottomStubRow,
            position,
            direction: "up",
            targetHash: sourceRow.node.commitHash,
            targetRowIndex: edge.upRowIndex,
            color: edge.color,
        });
    }
}

function edgeSegmentForRow(
    rowRenderPositions: RowRenderPositions[],
    edge: PermanentEdge,
    rowIndex: number,
): EdgePrintElement | null {
    if (rowIndex < edge.upRowIndex || rowIndex > edge.downRowIndex) {
        return null;
    }

    if (rowIndex === edge.upRowIndex) {
        return {
            type: "edge",
            edgeId: edge.edgeId,
            color: edge.color,
            fromPosition: getNodePosition(rowRenderPositions, rowIndex),
            toPosition: getEdgePosition(rowRenderPositions, rowIndex + 1, edge.edgeId),
            fromAnchor: "center",
            toAnchor: "bottom",
        };
    }

    if (rowIndex === edge.downRowIndex) {
        return {
            type: "edge",
            edgeId: edge.edgeId,
            color: edge.color,
            fromPosition: getEdgePosition(rowRenderPositions, rowIndex, edge.edgeId),
            toPosition: getNodePosition(rowRenderPositions, rowIndex),
            fromAnchor: "top",
            toAnchor: "center",
        };
    }

    return {
        type: "edge",
        edgeId: edge.edgeId,
        color: edge.color,
        fromPosition: getEdgePosition(rowRenderPositions, rowIndex, edge.edgeId),
        toPosition: getEdgePosition(rowRenderPositions, rowIndex + 1, edge.edgeId),
        fromAnchor: "top",
        toAnchor: "bottom",
    };
}

function buildRowRenderPositions(graph: PermanentGraphModel): RowRenderPositions[] {
    const visibleRowsByEdge = new Map<string, number[]>();
    const edgeByTargetRow = new Map<number, PermanentEdge[]>();

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        visibleRowsByEdge.set(edge.edgeId, getVisibleRowsForEdge(edge));
        const rowEdges = edgeByTargetRow.get(edge.upRowIndex) ?? [];
        rowEdges.push(edge);
        edgeByTargetRow.set(edge.upRowIndex, rowEdges);
    }

    const activeLanes: ActiveLane[] = [];
    return graph.rows.map((row, rowIndex) => {
        let nodePosition = activeLanes.findIndex((lane) => lane.hash === row.node.commitHash);
        if (nodePosition < 0) {
            nodePosition = activeLanes.length;
            activeLanes.push({ hash: row.node.commitHash });
        }

        const rawEdgePositions = new Map<string, number>();
        const visiblePositions = new Set<number>([nodePosition]);

        for (const edge of graph.edges) {
            if (edge.downRowIndex <= edge.upRowIndex) continue;
            const visibleRows = visibleRowsByEdge.get(edge.edgeId);
            if (!visibleRows?.includes(rowIndex)) continue;
            const edgePosition = activeLanes.findIndex((lane) => lane.hash === edge.targetHash);
            if (edgePosition >= 0) {
                rawEdgePositions.set(edge.edgeId, edgePosition);
                visiblePositions.add(edgePosition);
            }
        }

        const densePositions = new Map(
            [...visiblePositions]
                .sort((left, right) => left - right)
                .map((position, index) => [position, index]),
        );
        const denseNodePosition = densePositions.get(nodePosition) ?? 0;
        const rowEdgePositions = new Map<string, number>();
        for (const [edgeId, edgePosition] of rawEdgePositions) {
            rowEdgePositions.set(edgeId, densePositions.get(edgePosition) ?? denseNodePosition);
        }

        const rowEdges = edgeByTargetRow.get(rowIndex) ?? [];
        const firstParentEdge = rowEdges.find((edge) => edge.isPrimary);
        if (firstParentEdge) {
            const existingFirstParentIndex = activeLanes.findIndex(
                (lane, index) => index !== nodePosition && lane.hash === firstParentEdge.targetHash,
            );
            if (existingFirstParentIndex >= 0) {
                activeLanes.splice(nodePosition, 1);
            } else {
                activeLanes[nodePosition] = { hash: firstParentEdge.targetHash };
            }
        } else {
            activeLanes.splice(nodePosition, 1);
        }

        let insertPosition = Math.min(
            firstParentEdge ? nodePosition + 1 : nodePosition,
            activeLanes.length,
        );
        for (const edge of rowEdges.filter((item) => !item.isPrimary)) {
            if (activeLanes.some((lane) => lane.hash === edge.targetHash)) continue;
            activeLanes.splice(insertPosition, 0, { hash: edge.targetHash });
            insertPosition += 1;
        }

        return {
            nodePosition: denseNodePosition,
            edgePositions: rowEdgePositions,
            maxPosition: Math.max(0, visiblePositions.size - 1),
        };
    });
}

function getVisibleRowsForEdge(edge: PermanentEdge): number[] {
    if (!isLongEdge(edge)) {
        return Array.from(
            { length: Math.max(0, edge.downRowIndex - edge.upRowIndex - 1) },
            (_, index) => edge.upRowIndex + index + 1,
        );
    }

    const rows = new Set<number>();
    const topStubRow = edge.upRowIndex + LONG_EDGE_VISIBLE_PART_SIZE;
    const bottomStubRow = edge.downRowIndex - LONG_EDGE_VISIBLE_PART_SIZE;
    if (topStubRow < edge.downRowIndex) {
        rows.add(topStubRow);
    }
    if (bottomStubRow > edge.upRowIndex) {
        rows.add(bottomStubRow);
    }
    return [...rows].sort((left, right) => left - right);
}

function getNodePosition(rowRenderPositions: RowRenderPositions[], rowIndex: number): number {
    return rowRenderPositions[rowIndex]?.nodePosition ?? 0;
}

function getEdgePosition(
    rowRenderPositions: RowRenderPositions[],
    rowIndex: number,
    edgeId: string,
): number {
    const row = rowRenderPositions[rowIndex];
    if (!row) return 0;
    return row.edgePositions.get(edgeId) ?? row.nodePosition;
}

function isLongEdge(edge: PermanentEdge): boolean {
    return edge.downRowIndex - edge.upRowIndex >= LONG_EDGE_SIZE;
}

function calculateReservedWidth(rowRenderPositions: RowRenderPositions[]): number {
    if (rowRenderPositions.length === 0) {
        return 40;
    }
    const maxPosition = Math.max(0, ...rowRenderPositions.map((row) => row.maxPosition));
    return widthForVisibleCount(maxPosition + 1);
}

function widthForVisibleCount(visibleCount: number): number {
    return Math.max(40, visibleCount * LANE_WIDTH + GRAPH_SIDE_PADDING);
}

function calculateRowOccupiedWidth(row: RenderRowModel): number {
    let maxPosition = row.nodePosition;
    for (const element of row.elements) {
        switch (element.type) {
            case "node":
                maxPosition = Math.max(maxPosition, element.position);
                break;
            case "terminal":
                maxPosition = Math.max(maxPosition, element.position);
                break;
            case "edge":
                maxPosition = Math.max(maxPosition, element.fromPosition, element.toPosition);
                break;
        }
    }
    return widthForVisibleCount(maxPosition + 1);
}
