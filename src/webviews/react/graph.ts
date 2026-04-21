import { GRAPH_LANE_COLORS } from "./shared/tokens";

export const COLORS = GRAPH_LANE_COLORS;

export const LANE_WIDTH = 20;
export const DOT_RADIUS = 3.25;
export const ROW_HEIGHT = 28;
export const MAX_RENDER_COLUMNS = 6;
export const OVERFLOW_COLUMN = MAX_RENDER_COLUMNS - 1;
export const JUMP_ARROW_MIN_HIDDEN_COMMITS = 10;

interface GraphLane {
    column: number;
    rawColumn: number;
    color: string;
    visible: boolean;
}

interface ActiveLane {
    hash: string;
    color: string;
}

interface GraphConnection extends GraphLane {
    fromCol: number;
    toCol: number;
    rawFromCol: number;
    rawToCol: number;
    targetHash: string;
    fromVisible: boolean;
    toVisible: boolean;
}

interface RawGraphRow {
    commitHash: string;
    parentHashes: string[];
    column: number;
    color: string;
    numColumns: number;
    passThroughLanes: GraphLane[];
    connectionsDown: GraphConnection[];
}

interface HiddenLane {
    rawColumn: number;
    color: string;
}

export interface GraphJump extends GraphLane {
    targetHash: string;
    targetRowIndex: number;
}

export interface GraphRow {
    commitHash: string;
    parentHashes: string[];
    column: number;
    rawColumn: number;
    color: string;
    numColumns: number;
    passThroughLanes: GraphLane[];
    connectionsDown: GraphConnection[];
    overflowAbove: GraphLane[];
    overflowBelow: GraphLane[];
    jumpAbove: GraphJump[];
    jumpBelow: GraphJump[];
}

export function computeGraph(commits: Array<{ hash: string; parentHashes: string[] }>): GraphRow[] {
    const lanes: (ActiveLane | null)[] = [];
    const rawRows: RawGraphRow[] = [];
    let nextColorIndex = 0;
    let generatedColorIndex = 0;

    function findFree(): number {
        const i = lanes.indexOf(null);
        if (i >= 0) return i;
        lanes.push(null);
        return lanes.length - 1;
    }
    function allocateColor(extraAvoidColors: Iterable<string> = []): string {
        const usedColors = new Set<string>(extraAvoidColors);
        for (const lane of lanes) {
            if (lane) usedColors.add(lane.color);
        }
        for (let i = 0; i < COLORS.length; i++) {
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
    function findLaneIndex(hash: string): number {
        return lanes.findIndex((lane) => lane?.hash === hash);
    }

    for (const commit of commits) {
        const reservedColors = new Set<string>();
        let col = findLaneIndex(commit.hash);
        if (col === -1) {
            col = findFree();
            lanes[col] = { hash: commit.hash, color: allocateColor(reservedColors) };
        }
        const currentLane = lanes[col];
        const currentColor = currentLane?.color ?? allocateColor(reservedColors);
        reservedColors.add(currentColor);

        const passThroughLanes: GraphLane[] = [];
        for (let i = 0; i < lanes.length; i++) {
            const lane = lanes[i];
            if (i !== col && lane !== null) {
                passThroughLanes.push({
                    column: i,
                    rawColumn: i,
                    color: lane.color,
                    visible: true,
                });
            }
        }

        lanes[col] = null;

        const connectionsDown: GraphConnection[] = [];

        for (let p = 0; p < commit.parentHashes.length; p++) {
            const ph = commit.parentHashes[p];
            const pCol = findLaneIndex(ph);

            if (pCol >= 0) {
                const parentLane = lanes[pCol];
                const parentColor = parentLane?.color ?? currentColor;
                reservedColors.add(parentColor);
                connectionsDown.push({
                    column: pCol,
                    rawColumn: pCol,
                    fromCol: col,
                    toCol: pCol,
                    rawFromCol: col,
                    rawToCol: pCol,
                    targetHash: ph,
                    color: parentColor,
                    visible: true,
                    fromVisible: true,
                    toVisible: true,
                });
            } else if (p === 0) {
                lanes[col] = { hash: ph, color: currentColor };
                connectionsDown.push({
                    column: col,
                    rawColumn: col,
                    fromCol: col,
                    toCol: col,
                    rawFromCol: col,
                    rawToCol: col,
                    targetHash: ph,
                    color: currentColor,
                    visible: true,
                    fromVisible: true,
                    toVisible: true,
                });
            } else {
                const nc = findFree();
                const branchColor = allocateColor(reservedColors);
                reservedColors.add(branchColor);
                lanes[nc] = { hash: ph, color: branchColor };
                connectionsDown.push({
                    column: nc,
                    rawColumn: nc,
                    fromCol: col,
                    toCol: nc,
                    rawFromCol: col,
                    rawToCol: nc,
                    targetHash: ph,
                    color: branchColor,
                    visible: true,
                    fromVisible: true,
                    toVisible: true,
                });
            }
        }

        while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

        rawRows.push({
            commitHash: commit.hash,
            parentHashes: commit.parentHashes,
            column: col,
            color: currentColor,
            numColumns: Math.max(lanes.length, col + 1),
            passThroughLanes,
            connectionsDown,
        });
    }

    const overflowStart = OVERFLOW_COLUMN;
    const hiddenLanes = (row: RawGraphRow): HiddenLane[] => {
        const hidden = new Map<number, HiddenLane>();
        const track = (column: number, color: string) => {
            if (column < overflowStart || hidden.has(column)) return;
            hidden.set(column, { rawColumn: column, color });
        };
        track(row.column, row.color);
        for (const lane of row.passThroughLanes) track(lane.column, lane.color);
        for (const connection of row.connectionsDown) {
            track(connection.fromCol, connection.color);
            track(connection.toCol, connection.color);
        }
        return Array.from(hidden.values()).sort((a, b) => a.rawColumn - b.rawColumn);
    };
    const dedupeLanes = (lanesToRender: GraphLane[]): GraphLane[] => {
        const deduped = new Map<number, GraphLane>();
        for (const lane of lanesToRender) {
            if (!deduped.has(lane.rawColumn)) {
                deduped.set(lane.rawColumn, lane);
            }
        }
        return Array.from(deduped.values()).sort((a, b) => a.column - b.column);
    };
    const dedupeConnections = (connections: GraphConnection[]): GraphConnection[] => {
        const deduped = new Map<string, GraphConnection>();
        for (const connection of connections) {
            const key = `${connection.rawFromCol}:${connection.rawToCol}:${connection.fromCol}:${connection.toCol}`;
            if (!deduped.has(key)) {
                deduped.set(key, connection);
            }
        }
        return Array.from(deduped.values());
    };
    const rows: GraphRow[] = [];
    let previousVisibleColumns: number[] = [];

    for (let index = 0; index < rawRows.length; index++) {
        const row = rawRows[index];
        const previousHidden = index > 0 ? hiddenLanes(rawRows[index - 1]) : [];
        const currentHidden = hiddenLanes(row);
        const nextHidden = index < rawRows.length - 1 ? hiddenLanes(rawRows[index + 1]) : [];
        const previousHiddenColumns = new Set(previousHidden.map((lane) => lane.rawColumn));
        const nextHiddenColumns = new Set(nextHidden.map((lane) => lane.rawColumn));
        const toOverflowLane = (lane: HiddenLane): GraphLane => ({
            column: OVERFLOW_COLUMN,
            rawColumn: lane.rawColumn,
            color: lane.color,
            visible: false,
        });

        const allColumns = new Set<number>();
        allColumns.add(row.column);
        for (const lane of row.passThroughLanes) allColumns.add(lane.rawColumn);
        for (const connection of row.connectionsDown) {
            allColumns.add(connection.rawFromCol);
            allColumns.add(connection.rawToCol);
        }

        const hasOverflow = allColumns.size > MAX_RENDER_COLUMNS;
        const visibleCapacity = hasOverflow ? OVERFLOW_COLUMN : MAX_RENDER_COLUMNS;
        const required = Array.from(
            new Set([row.column, ...row.connectionsDown.map((connection) => connection.rawToCol)]),
        );
        const requiredSorted = [
            row.column,
            ...required
                .filter((column) => column !== row.column)
                .sort((a, b) => Math.abs(a - row.column) - Math.abs(b - row.column) || a - b),
        ];
        const carried = previousVisibleColumns.filter(
            (column) => allColumns.has(column) && !requiredSorted.includes(column),
        );
        const passThroughCandidates = row.passThroughLanes
            .map((lane) => lane.rawColumn)
            .filter(
                (column, idx, values) =>
                    values.indexOf(column) === idx &&
                    !requiredSorted.includes(column) &&
                    !carried.includes(column),
            )
            .sort((a, b) => Math.abs(a - row.column) - Math.abs(b - row.column) || a - b);
        const prioritized = [...requiredSorted, ...carried, ...passThroughCandidates];
        const selectedRawColumns = prioritized.slice(0, visibleCapacity);
        const selectedColumnSet = new Set(selectedRawColumns);
        previousVisibleColumns = selectedRawColumns;

        const sortedVisibleColumns = [...selectedRawColumns].sort((a, b) => a - b);
        const displayColumnByRaw = new Map<number, number>();
        sortedVisibleColumns.forEach((rawColumn, displayColumn) => {
            displayColumnByRaw.set(rawColumn, displayColumn);
        });
        const mapRawColumn = (rawColumn: number): number =>
            displayColumnByRaw.get(rawColumn) ?? OVERFLOW_COLUMN;
        const laneToDisplay = (lane: GraphLane): GraphLane => ({
            column: mapRawColumn(lane.rawColumn),
            rawColumn: lane.rawColumn,
            color: lane.color,
            visible: selectedColumnSet.has(lane.rawColumn),
        });

        rows.push({
            commitHash: row.commitHash,
            parentHashes: row.parentHashes,
            column: mapRawColumn(row.column),
            rawColumn: row.column,
            color: row.color,
            numColumns: hasOverflow ? MAX_RENDER_COLUMNS : Math.max(sortedVisibleColumns.length, 1),
            passThroughLanes: dedupeLanes(
                row.passThroughLanes.map(laneToDisplay),
            ),
            connectionsDown: dedupeConnections(
                row.connectionsDown.map((connection) => ({
                    fromCol: mapRawColumn(connection.rawFromCol),
                    toCol: mapRawColumn(connection.rawToCol),
                    column: mapRawColumn(connection.rawToCol),
                    rawColumn: connection.rawToCol,
                    rawFromCol: connection.rawFromCol,
                    rawToCol: connection.rawToCol,
                    targetHash: connection.targetHash,
                    color: connection.color,
                    visible: selectedColumnSet.has(connection.rawToCol),
                    fromVisible: selectedColumnSet.has(connection.rawFromCol),
                    toVisible: selectedColumnSet.has(connection.rawToCol),
                })),
            ),
            overflowAbove: currentHidden
                .filter((lane) => !previousHiddenColumns.has(lane.rawColumn))
                .map(toOverflowLane),
            overflowBelow: currentHidden
                .filter((lane) => !nextHiddenColumns.has(lane.rawColumn))
                .map(toOverflowLane),
            jumpAbove: [],
            jumpBelow: [],
        });
    }

    const rowTouchesLane = (row: GraphRow, rawColumn: number): boolean =>
        row.rawColumn === rawColumn ||
        row.passThroughLanes.some((lane) => lane.rawColumn === rawColumn && lane.visible) ||
        row.connectionsDown.some(
            (connection) =>
                (connection.rawFromCol === rawColumn && connection.fromVisible) ||
                (connection.rawToCol === rawColumn && connection.toVisible),
        );
    const laneVisibleBetween = (
        rawColumn: number,
        startExclusive: number,
        endExclusive: number,
    ): boolean => {
        for (let index = startExclusive + 1; index < endExclusive; index++) {
            if (!rowTouchesLane(rows[index], rawColumn)) {
                return false;
            }
        }
        return true;
    };
    const dedupeJumpLanes = (lanesToRender: GraphJump[]): GraphJump[] => {
        const deduped = new Map<number, GraphJump>();
        for (const lane of lanesToRender) {
            if (!deduped.has(lane.rawColumn)) {
                deduped.set(lane.rawColumn, lane);
            }
        }
        return Array.from(deduped.values()).sort(
            (a, b) => a.column - b.column || a.rawColumn - b.rawColumn,
        );
    };
    const hashToRowIndex = new Map<string, number>();
    rows.forEach((row, index) => {
        hashToRowIndex.set(row.commitHash, index);
    });
    const childRowsByParent = new Map<string, number[]>();
    rows.forEach((row, index) => {
        for (const parentHash of row.parentHashes) {
            const childRows = childRowsByParent.get(parentHash) ?? [];
            childRows.push(index);
            childRowsByParent.set(parentHash, childRows);
        }
    });

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const jumpAbove = new Map<number, GraphJump>();
        const jumpBelow = new Map<number, GraphJump>();
        const addJump = (target: Map<number, GraphJump>, lane: GraphJump) => {
            if (!target.has(lane.rawColumn)) {
                target.set(lane.rawColumn, lane);
            }
        };

        for (const connection of row.connectionsDown) {
            const targetIndex = hashToRowIndex.get(connection.targetHash);
            if (targetIndex === undefined || targetIndex <= index + 1) continue;
            const hiddenCommitCount = targetIndex - index - 1;
            if (hiddenCommitCount <= JUMP_ARROW_MIN_HIDDEN_COMMITS) continue;
            if (laneVisibleBetween(connection.rawToCol, index, targetIndex)) continue;
            addJump(jumpBelow, {
                column: connection.toCol,
                rawColumn: connection.rawToCol,
                color: connection.color,
                visible: true,
                targetHash: connection.targetHash,
                targetRowIndex: targetIndex,
            });
        }
        const childRows = childRowsByParent.get(row.commitHash) ?? [];
        const incomingChildIndex = [...childRows]
            .reverse()
            .find((candidateIndex) => candidateIndex < index);
        if (incomingChildIndex !== undefined) {
            const hiddenCommitCount = index - incomingChildIndex - 1;
            if (
                hiddenCommitCount > JUMP_ARROW_MIN_HIDDEN_COMMITS &&
                !laneVisibleBetween(row.rawColumn, incomingChildIndex, index)
            ) {
                addJump(jumpAbove, {
                    column: row.column,
                    rawColumn: row.rawColumn,
                    color: row.color,
                    visible: true,
                    targetHash: rows[incomingChildIndex].commitHash,
                    targetRowIndex: incomingChildIndex,
                });
            }
        }
        row.jumpAbove = dedupeJumpLanes([...jumpAbove.values()]);
        row.jumpBelow = dedupeJumpLanes([...jumpBelow.values()]);
    }

    return rows;
}
