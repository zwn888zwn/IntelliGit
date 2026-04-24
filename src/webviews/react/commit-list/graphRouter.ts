import type { PermanentGraphModel, PermanentEdge } from "./graphModel";

const LANE_WIDTH = 18;
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

interface RowRenderPositions {
    nodePosition: number;
    edgePositions: Map<string, number>;
    maxPosition: number;
}

type VisibleGraphElement =
    | { type: "node"; rowIndex: number; layoutIndex: number }
    | { type: "edge"; edge: PermanentEdge };

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

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        visibleRowsByEdge.set(edge.edgeId, getVisibleRowsForEdge(edge));
    }

    return graph.rows.map((row, rowIndex) => {
        const visibleElements: VisibleGraphElement[] = [
            { type: "node", rowIndex, layoutIndex: row.node.layoutIndex },
        ];
        const rowEdgePositions = new Map<string, number>();

        for (const edge of graph.edges) {
            if (edge.downRowIndex <= edge.upRowIndex) continue;
            const visibleRows = visibleRowsByEdge.get(edge.edgeId);
            if (!visibleRows?.includes(rowIndex)) continue;
            visibleElements.push({ type: "edge", edge });
        }

        visibleElements.sort(compareVisibleElements);

        let nodePosition = 0;
        visibleElements.forEach((element, position) => {
            if (element.type === "node") {
                nodePosition = position;
            } else {
                rowEdgePositions.set(element.edge.edgeId, position);
            }
        });

        return {
            nodePosition,
            edgePositions: rowEdgePositions,
            maxPosition: Math.max(0, visibleElements.length - 1),
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

function compareVisibleElements(left: VisibleGraphElement, right: VisibleGraphElement): number {
    if (left.type === "node" && right.type === "node") {
        return left.layoutIndex - right.layoutIndex;
    }

    if (left.type === "edge" && right.type === "node") {
        return compareEdgeToNode(left.edge, right);
    }

    if (left.type === "node" && right.type === "edge") {
        return -compareEdgeToNode(right.edge, left);
    }

    if (left.type === "edge" && right.type === "edge") {
        return compareEdges(left.edge, right.edge);
    }

    return 0;
}

function compareEdges(left: PermanentEdge, right: PermanentEdge): number {
    if (left.upRowIndex === right.upRowIndex) {
        if (left.downRowIndex < right.downRowIndex) {
            return -compareEdgeToNode(right, {
                type: "node",
                rowIndex: left.downRowIndex,
                layoutIndex: left.downLayoutIndex,
            });
        }
        return compareEdgeToNode(left, {
            type: "node",
            rowIndex: right.downRowIndex,
            layoutIndex: right.downLayoutIndex,
        });
    }

    if (left.upRowIndex < right.upRowIndex) {
        return compareEdgeToNode(left, {
            type: "node",
            rowIndex: right.upRowIndex,
            layoutIndex: right.upLayoutIndex,
        });
    }

    return -compareEdgeToNode(right, {
        type: "node",
        rowIndex: left.upRowIndex,
        layoutIndex: left.upLayoutIndex,
    });
}

function compareEdgeToNode(
    edge: PermanentEdge,
    node: Extract<VisibleGraphElement, { type: "node" }>,
): number {
    const maxLayoutIndex = Math.max(edge.upLayoutIndex, edge.downLayoutIndex);
    if (maxLayoutIndex !== node.layoutIndex) {
        return maxLayoutIndex - node.layoutIndex;
    }
    return edge.upRowIndex - node.rowIndex;
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
