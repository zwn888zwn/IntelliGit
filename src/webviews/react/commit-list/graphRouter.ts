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
    const layoutOrder = Array.from(new Set(graph.rows.map((row) => row.node.layoutIndex))).sort(
        (left, right) => left - right,
    );
    const compactLayoutIndex = new Map(
        layoutOrder.map((layoutIndex, index) => [layoutIndex, index * 2]),
    );
    const nodeColumns = graph.rows.map(
        (row) => compactLayoutIndex.get(row.node.layoutIndex) ?? row.node.layoutIndex * 2,
    );
    const rowOccupied = graph.rows.map((_, rowIndex) => new Set<number>([nodeColumns[rowIndex]]));
    const edgeColumns = new Map<string, number>();
    const visibleRowsByEdge = new Map<string, number[]>();

    for (const edge of graph.edges) {
        if (edge.downRowIndex <= edge.upRowIndex) continue;
        visibleRowsByEdge.set(edge.edgeId, getVisibleRowsForEdge(edge));
    }

    const sortedEdges = [...graph.edges]
        .filter((edge) => edge.downRowIndex > edge.upRowIndex)
        .sort((left, right) => {
            const leftPreferred = preferredEdgeColumn(left, compactLayoutIndex);
            const rightPreferred = preferredEdgeColumn(right, compactLayoutIndex);
            if (leftPreferred !== rightPreferred) {
                return leftPreferred - rightPreferred;
            }
            const rightSpan = right.downRowIndex - right.upRowIndex;
            const leftSpan = left.downRowIndex - left.upRowIndex;
            if (leftSpan !== rightSpan) {
                return rightSpan - leftSpan;
            }
            if (left.upRowIndex !== right.upRowIndex) {
                return left.upRowIndex - right.upRowIndex;
            }
            return left.downRowIndex - right.downRowIndex;
        });

    for (const edge of sortedEdges) {
        const visibleRows = visibleRowsByEdge.get(edge.edgeId) ?? [];
        const preferredColumn = preferredEdgeColumn(edge, compactLayoutIndex);
        const column =
            edge.upLayoutIndex === edge.downLayoutIndex
                ? preferredColumn
                : findClosestFreeEdgeColumn(preferredColumn, visibleRows, rowOccupied);

        edgeColumns.set(edge.edgeId, column);
        for (const rowIndex of visibleRows) {
            rowOccupied[rowIndex]?.add(column);
        }
    }

    return graph.rows.map((row, rowIndex) => {
        const visibleColumns = new Set<number>([nodeColumns[rowIndex] ?? 0]);
        const rowEdgePositions = new Map<string, number>();

        for (const edge of graph.edges) {
            if (edge.downRowIndex <= edge.upRowIndex) continue;
            const visibleRows = visibleRowsByEdge.get(edge.edgeId);
            if (!visibleRows?.includes(rowIndex)) continue;
            visibleColumns.add(
                edgeColumns.get(edge.edgeId) ?? preferredEdgeColumn(edge, compactLayoutIndex),
            );
        }

        const rowDenseColumns = Array.from(visibleColumns).sort((left, right) => left - right);
        const denseColumnIndex = new Map(rowDenseColumns.map((column, index) => [column, index]));

        for (const edge of graph.edges) {
            if (edge.downRowIndex <= edge.upRowIndex) continue;
            const visibleRows = visibleRowsByEdge.get(edge.edgeId);
            if (!visibleRows?.includes(rowIndex)) continue;
            const position =
                denseColumnIndex.get(
                    edgeColumns.get(edge.edgeId) ??
                        preferredEdgeColumn(edge, compactLayoutIndex),
                ) ?? 0;
            rowEdgePositions.set(edge.edgeId, position);
        }

        return {
            nodePosition: denseColumnIndex.get(nodeColumns[rowIndex]) ?? 0,
            edgePositions: rowEdgePositions,
            maxPosition: Math.max(0, rowDenseColumns.length - 1),
        };
    });
}

function preferredEdgeColumn(
    edge: PermanentEdge,
    compactLayoutIndex: Map<number, number>,
): number {
    const upColumn = compactLayoutIndex.get(edge.upLayoutIndex) ?? edge.upLayoutIndex * 2;
    const downColumn = compactLayoutIndex.get(edge.downLayoutIndex) ?? edge.downLayoutIndex * 2;
    if (upColumn === downColumn) {
        return upColumn;
    }
    const span = edge.downRowIndex - edge.upRowIndex;
    const baseColumn = Math.max(upColumn, downColumn) - 1;
    return span <= 2 ? Math.max(1, baseColumn - 1) : baseColumn;
}

function findClosestFreeEdgeColumn(
    preferredColumn: number,
    visibleRows: number[],
    rowOccupied: Array<Set<number>>,
): number {
    if (!visibleRows.some((rowIndex) => rowOccupied[rowIndex]?.has(preferredColumn))) {
        return preferredColumn;
    }

    for (let offset = 2; offset < 128; offset += 2) {
        const inwardColumn = preferredColumn - offset;
        if (
            inwardColumn >= 1 &&
            !visibleRows.some((rowIndex) => rowOccupied[rowIndex]?.has(inwardColumn))
        ) {
            return inwardColumn;
        }

        const outwardColumn = preferredColumn + offset;
        if (!visibleRows.some((rowIndex) => rowOccupied[rowIndex]?.has(outwardColumn))) {
            return outwardColumn;
        }
    }

    return preferredColumn;
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
