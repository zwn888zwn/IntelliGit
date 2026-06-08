import type { PermanentGraphModel, PermanentEdge } from "./graphModel";

const LANE_WIDTH = 16;
const LONG_EDGE_SIZE = 30;
const LONG_EDGE_VISIBLE_PART_SIZE = 1;
const GRAPH_SIDE_PADDING = 6;

export type EdgeAnchor = "top" | "center" | "bottom" | "nextCenter";

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
    repoRoot?: string;
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
    orderedHashes?: string[];
}

interface RowRenderPositions {
    nodePosition: number;
    edgePositions: Map<string, number>;
    maxPosition: number;
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

    if (!isLongEdge(edge) && rowIndex >= edge.downRowIndex) {
        return null;
    }

    if (!isLongEdge(edge)) {
        return {
            type: "edge",
            edgeId: edge.edgeId,
            color: edge.color,
            fromPosition:
                rowIndex === edge.upRowIndex
                    ? getNodePosition(rowRenderPositions, rowIndex)
                    : getEdgePosition(rowRenderPositions, rowIndex, edge.edgeId),
            toPosition:
                rowIndex + 1 === edge.downRowIndex
                    ? getNodePosition(rowRenderPositions, edge.downRowIndex)
                    : getEdgePosition(rowRenderPositions, rowIndex + 1, edge.edgeId),
            fromAnchor: "center",
            toAnchor: "nextCenter",
        };
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
    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        visibleRowsByEdge.set(edge.edgeId, getVisibleRowsForEdge(edge));
    }

    return graph.rows.map((row, rowIndex) => {
        const rowElements = getSortedVisibleElementsInRow(graph, visibleRowsByEdge, rowIndex);
        const nodePosition = rowElements.findIndex((element) => element.type === "node");
        const rowEdgePositions = new Map<string, number>(
            rowElements.flatMap((element, position) =>
                element.type === "edge" ? [[element.edge.edgeId, position]] : [],
            ),
        );

        return {
            nodePosition: nodePosition >= 0 ? nodePosition : 0,
            edgePositions: rowEdgePositions,
            maxPosition: Math.max(0, rowElements.length - 1),
        };
    });
}

type RowGraphElement =
    | { type: "node"; rowIndex: number }
    | { type: "edge"; edge: PermanentEdge };

function getSortedVisibleElementsInRow(
    graph: PermanentGraphModel,
    visibleRowsByEdge: Map<string, number[]>,
    rowIndex: number,
): RowGraphElement[] {
    const elements: RowGraphElement[] = [
        {
            type: "node",
            rowIndex,
        },
    ];
    for (const edge of graph.edges) {
        if (visibleRowsByEdge.get(edge.edgeId)?.includes(rowIndex)) {
            elements.push({ type: "edge", edge });
        }
    }
    return elements.sort((left, right) => compareGraphElementsByLayoutIndex(left, right, graph));
}

function compareGraphElementsByLayoutIndex(
    left: RowGraphElement,
    right: RowGraphElement,
    graph: PermanentGraphModel,
): number {
    if (left.type === "edge" && right.type === "edge") {
        return compareEdgesByLayoutIndex(left.edge, right.edge, graph);
    }
    if (left.type === "edge" && right.type === "node") {
        return compareEdgeToNodeByLayoutIndex(left.edge, right.rowIndex, graph);
    }
    if (left.type === "node" && right.type === "edge") {
        return -compareEdgeToNodeByLayoutIndex(right.edge, left.rowIndex, graph);
    }
    return 0;
}

function compareEdgesByLayoutIndex(
    left: PermanentEdge,
    right: PermanentEdge,
    graph: PermanentGraphModel,
): number {
    if (left.upRowIndex === right.upRowIndex) {
        if (left.downRowIndex < right.downRowIndex) {
            return -compareEdgeToNodeByLayoutIndex(right, left.downRowIndex, graph);
        }
        return compareEdgeToNodeByLayoutIndex(left, right.downRowIndex, graph);
    }
    if (left.upRowIndex < right.upRowIndex) {
        return compareEdgeToNodeByLayoutIndex(left, right.upRowIndex, graph);
    }
    return -compareEdgeToNodeByLayoutIndex(right, left.upRowIndex, graph);
}

function compareEdgeToNodeByLayoutIndex(
    edge: PermanentEdge,
    rowIndex: number,
    graph: PermanentGraphModel,
): number {
    const edgeLayoutIndex = Math.max(edge.upLayoutIndex, edge.downLayoutIndex);
    const nodeLayoutIndex = graph.rows[rowIndex]?.node.layoutIndex ?? 0;
    if (edgeLayoutIndex !== nodeLayoutIndex) {
        return edgeLayoutIndex - nodeLayoutIndex;
    }
    return edge.upRowIndex - rowIndex;
}

function getVisibleRowsForEdge(edge: PermanentEdge): number[] {
    const rows = new Set<number>();

    if (!isLongEdge(edge)) {
        for (let rowIndex = edge.upRowIndex + 1; rowIndex < edge.downRowIndex; rowIndex += 1) {
            rows.add(rowIndex);
        }
        return [...rows].sort((left, right) => left - right);
    }

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
