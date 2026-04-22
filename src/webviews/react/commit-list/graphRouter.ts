import type { PermanentGraphModel, PermanentEdge } from "./graphModel";

const LANE_WIDTH = 20;
const LONG_EDGE_SIZE = 30;
const LONG_EDGE_VISIBLE_PART_SIZE = 1;
const GRAPH_SIDE_PADDING = 12;

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

interface RowLanePositions {
    positions: Map<number, number>;
    visibleLaneCount: number;
}

export function buildRenderRows(graph: PermanentGraphModel): CommitGraphLayoutResult {
    const rowLaneIndexes = graph.rows.map((row) => new Set<number>([row.node.layoutIndex]));
    const arrowMarkers: ArrowMarker[] = [];

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        registerVisibleEdgeLane(rowLaneIndexes, edge);
    }

    const rowLanePositions = buildRowLanePositions(rowLaneIndexes);
    const rows: RenderRowModel[] = graph.rows.map((row, rowIndex) => ({
        commitHash: row.node.commitHash,
        parentHashes: row.node.parentHashes,
        nodePosition: getRowLanePosition(rowLanePositions, rowIndex, row.node.layoutIndex),
        nodeColor: row.node.color,
        occupiedWidth: widthForLaneCount(1),
        elements: [
            {
                type: "node",
                laneId: row.node.laneId,
                color: row.node.color,
                position: getRowLanePosition(rowLanePositions, rowIndex, row.node.layoutIndex),
            },
        ],
    }));

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        if (isLongEdge(edge)) {
            renderLongEdge(graph, rows, rowLanePositions, edge, arrowMarkers);
        } else {
            renderShortEdge(rows, rowLanePositions, edge);
        }
    }

    for (const row of rows) {
        row.occupiedWidth = calculateRowOccupiedWidth(row);
    }

    return {
        rows,
        recommendedWidth: calculateReservedWidth(rowLanePositions),
        arrowMarkers,
    };
}

function renderShortEdge(
    rows: RenderRowModel[],
    rowLanePositions: RowLanePositions[],
    edge: PermanentEdge,
): void {
    for (let rowIndex = edge.upRowIndex; rowIndex <= edge.downRowIndex; rowIndex += 1) {
        const element = edgeSegmentForRow(rowLanePositions, edge, rowIndex);
        if (!element) continue;
        rows[rowIndex].elements.push(element);
    }
}

function renderLongEdge(
    graph: PermanentGraphModel,
    rows: RenderRowModel[],
    rowLanePositions: RowLanePositions[],
    edge: PermanentEdge,
    arrowMarkers: ArrowMarker[],
): void {
    const topStubRow = edge.upRowIndex + LONG_EDGE_VISIBLE_PART_SIZE;
    const bottomStubRow = edge.downRowIndex - LONG_EDGE_VISIBLE_PART_SIZE;

    const startElement = edgeSegmentForRow(rowLanePositions, edge, edge.upRowIndex);
    if (startElement) {
        rows[edge.upRowIndex].elements.push(startElement);
    }
    const endElement = edgeSegmentForRow(rowLanePositions, edge, edge.downRowIndex);
    if (endElement) {
        rows[edge.downRowIndex].elements.push(endElement);
    }

    if (topStubRow < edge.downRowIndex) {
        const position = getRowLanePosition(rowLanePositions, topStubRow, edge.downLayoutIndex);
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
        const position = getRowLanePosition(
            rowLanePositions,
            bottomStubRow,
            edge.downLayoutIndex,
        );
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
    rowLanePositions: RowLanePositions[],
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
            fromPosition: getRowLanePosition(rowLanePositions, rowIndex, edge.upLayoutIndex),
            toPosition: getRowLanePosition(rowLanePositions, rowIndex + 1, edge.downLayoutIndex),
            fromAnchor: "center",
            toAnchor: "bottom",
        };
    }

    if (rowIndex === edge.downRowIndex) {
        return {
            type: "edge",
            edgeId: edge.edgeId,
            color: edge.color,
            fromPosition: getRowLanePosition(rowLanePositions, rowIndex, edge.downLayoutIndex),
            toPosition: getRowLanePosition(rowLanePositions, rowIndex, edge.downLayoutIndex),
            fromAnchor: "top",
            toAnchor: "center",
        };
    }

    return {
        type: "edge",
        edgeId: edge.edgeId,
        color: edge.color,
        fromPosition: getRowLanePosition(rowLanePositions, rowIndex, edge.downLayoutIndex),
        toPosition: getRowLanePosition(rowLanePositions, rowIndex + 1, edge.downLayoutIndex),
        fromAnchor: "top",
        toAnchor: "bottom",
    };
}

function isLongEdge(edge: PermanentEdge): boolean {
    return edge.downRowIndex - edge.upRowIndex >= LONG_EDGE_SIZE;
}

function registerVisibleEdgeLane(rowLaneIndexes: Set<number>[], edge: PermanentEdge): void {
    if (isLongEdge(edge)) {
        rowLaneIndexes[edge.upRowIndex]?.add(edge.downLayoutIndex);
        const topStubRow = edge.upRowIndex + LONG_EDGE_VISIBLE_PART_SIZE;
        const bottomStubRow = edge.downRowIndex - LONG_EDGE_VISIBLE_PART_SIZE;
        if (topStubRow < edge.downRowIndex) {
            rowLaneIndexes[topStubRow]?.add(edge.downLayoutIndex);
        }
        if (bottomStubRow > edge.upRowIndex) {
            rowLaneIndexes[bottomStubRow]?.add(edge.downLayoutIndex);
        }
        return;
    }

    for (let rowIndex = edge.upRowIndex; rowIndex < edge.downRowIndex; rowIndex += 1) {
        rowLaneIndexes[rowIndex]?.add(edge.downLayoutIndex);
    }
}

function buildRowLanePositions(rowLaneIndexes: Set<number>[]): RowLanePositions[] {
    return rowLaneIndexes.map((laneIndexes) => {
        const sorted = Array.from(laneIndexes).sort((left, right) => left - right);
        return {
            positions: new Map(sorted.map((layoutIndex, position) => [layoutIndex, position])),
            visibleLaneCount: sorted.length,
        };
    });
}

function getRowLanePosition(
    rowLanePositions: RowLanePositions[],
    rowIndex: number,
    layoutIndex: number,
): number {
    const row = rowLanePositions[rowIndex];
    if (!row) {
        return 0;
    }
    return row.positions.get(layoutIndex) ?? 0;
}

function calculateReservedWidth(rowLanePositions: RowLanePositions[]): number {
    if (rowLanePositions.length === 0) {
        return 40;
    }
    const maxVisibleLaneCount = Math.max(
        1,
        ...rowLanePositions.map((row) => row.visibleLaneCount),
    );
    return widthForLaneCount(maxVisibleLaneCount);
}

function widthForLaneCount(laneCount: number): number {
    return Math.max(40, laneCount * LANE_WIDTH + GRAPH_SIDE_PADDING);
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
    return widthForLaneCount(maxPosition + 1);
}
