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

interface GraphCommitLike {
    hash: string;
    parentHashes: string[];
    refs?: string[];
    date?: string;
}

interface InternalGraphNode {
    commit: GraphCommitLike;
    upNodes: number[];
    downNodes: number[];
}

interface GraphAssignments {
    layoutIndexByHash: Map<string, number>;
    colorIndexByHash: Map<string, number>;
}

const COLORS = GRAPH_LANE_COLORS;

export function orderCommitsForGraph<T extends GraphCommitLike>(commits: T[]): {
    commits: T[];
    layoutIndexByHash: Map<string, number>;
} {
    if (commits.length <= 1) {
        return {
            commits,
            layoutIndexByHash: new Map(commits.map((commit) => [commit.hash, 0])),
        };
    }

    const graphNodes = buildInternalGraph(commits);
    const layout = buildGraphAssignments(commits, graphNodes);

    return {
        commits,
        layoutIndexByHash: layout.layoutIndexByHash,
    };
}

export function buildPermanentGraph(
    commits: Array<{ hash: string; parentHashes: string[]; refs?: string[] }>,
    layoutIndexOverride?: Map<string, number>,
): PermanentGraphModel {
    const graphNodes = buildInternalGraph(commits);
    const { layoutIndexByHash, colorIndexByHash } = layoutIndexOverride
        ? {
              layoutIndexByHash: layoutIndexOverride,
              colorIndexByHash: new Map(
                  commits.map((commit) => [commit.hash, layoutIndexOverride.get(commit.hash) ?? 0]),
              ),
          }
        : buildGraphAssignments(commits, graphNodes);
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
    commits: GraphCommitLike[],
    graphNodes: InternalGraphNode[],
): GraphAssignments {
    const layoutIndexByHash = new Map<string, number>();
    const colorIndexByHash = new Map<string, number>();
    const sortedHeads = collectLayoutSeedIndexes(commits, graphNodes);
    let nextLayoutIndex = 0;
    const assignLayoutFrom = (startIndex: number): void => {
        let currentIndex: number | undefined = startIndex;
        let firstVisitInWalk = false;

        while (typeof currentIndex === "number") {
            const currentCommit = commits[currentIndex];
            const firstVisit = !layoutIndexByHash.has(currentCommit.hash);
            if (firstVisit) {
                layoutIndexByHash.set(currentCommit.hash, nextLayoutIndex);
                firstVisitInWalk = true;
            }

            const nextIndex: number | undefined = graphNodes[currentIndex].downNodes.find(
                (downIndex) => !layoutIndexByHash.has(commits[downIndex].hash),
            );
            if (typeof nextIndex !== "number") {
                if (firstVisitInWalk) {
                    nextLayoutIndex += 1;
                }
                break;
            }
            currentIndex = nextIndex;
        }
    };

    for (const rowIndex of sortedHeads) {
        if (layoutIndexByHash.has(commits[rowIndex].hash)) continue;
        assignLayoutFrom(rowIndex);
    }

    commits.forEach((commit, rowIndex) => {
        if (layoutIndexByHash.has(commit.hash)) return;
        assignLayoutFrom(rowIndex);
    });

    for (const commit of commits) {
        colorIndexByHash.set(commit.hash, layoutIndexByHash.get(commit.hash) ?? 0);
    }

    return { layoutIndexByHash, colorIndexByHash };
}

function buildInternalGraph(commits: GraphCommitLike[]): InternalGraphNode[] {
    const hashToIndex = new Map(commits.map((commit, rowIndex) => [commit.hash, rowIndex]));
    const graphNodes: InternalGraphNode[] = commits.map((commit) => ({
        commit,
        upNodes: [],
        downNodes: [],
    }));

    commits.forEach((commit, rowIndex) => {
        for (const parentHash of commit.parentHashes) {
            const parentIndex = hashToIndex.get(parentHash);
            if (typeof parentIndex !== "number") continue;
            graphNodes[rowIndex].downNodes.push(parentIndex);
            graphNodes[parentIndex].upNodes.push(rowIndex);
        }
    });

    return graphNodes;
}

function colorForLayoutIndex(layoutIndex: number): string {
    return COLORS[((layoutIndex % COLORS.length) + COLORS.length) % COLORS.length];
}

function collectLayoutSeedIndexes(
    commits: GraphCommitLike[],
    graphNodes: InternalGraphNode[],
): number[] {
    const headIndexes = graphNodes
        .map((node, rowIndex) => ({ node, rowIndex }))
        .filter(({ node }) => node.upNodes.length === 0)
        .sort(
            (left, right) =>
                compareHeadImportance(right.node.commit, left.node.commit) || left.rowIndex - right.rowIndex,
        )
        .map(({ rowIndex }) => rowIndex);

    return headIndexes;
}

function compareHeadImportance(left: GraphCommitLike, right: GraphCommitLike): number {
    const leftKey = getHeadImportanceKey(left);
    const rightKey = getHeadImportanceKey(right);
    return (
        leftKey.priority - rightKey.priority ||
        leftKey.name.localeCompare(rightKey.name) ||
        leftKey.kind - rightKey.kind
    );
}

function getHeadImportanceKey(commit: GraphCommitLike): {
    priority: number;
    name: string;
    kind: number;
} {
    const branchRefs = (commit.refs ?? [])
        .map(parseBranchRef)
        .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref))
        .sort(
            (left, right) =>
                getStableBranchPriority(left.name) - getStableBranchPriority(right.name) ||
                left.name.localeCompare(right.name) ||
                left.kind - right.kind,
        );

    if (branchRefs.length > 0) {
        const selected = branchRefs[0];
        return {
            priority: getStableBranchPriority(selected.name) + (selected.kind === 0 ? -100 : 0),
            name: selected.name,
            kind: selected.kind,
        };
    }

    if ((commit.refs?.length ?? 0) > 0) {
        return { priority: 90, name: commit.refs![0] ?? "", kind: 9 };
    }

    return { priority: 99, name: commit.hash, kind: 9 };
}

function isLocalBranchRef(ref: string): boolean {
    if (ref === "HEAD" || ref.startsWith("HEAD -> ")) return false;
    if (ref.startsWith("origin/")) return false;
    if (ref.startsWith("tag:")) return false;
    return true;
}

function hasBranchRef(commit: GraphCommitLike): boolean {
    return (commit.refs ?? []).some(
        (ref) => ref === "HEAD" || ref.startsWith("HEAD -> ") || isLocalBranchRef(ref) || ref.startsWith("origin/"),
    );
}

function parseBranchRef(ref: string): { name: string; kind: number } | null {
    if (ref.startsWith("HEAD -> ")) {
        return { name: ref.slice("HEAD -> ".length).trim(), kind: 0 };
    }
    if (isLocalBranchRef(ref)) {
        return { name: ref.trim(), kind: 1 };
    }
    if (ref.startsWith("origin/")) {
        return { name: ref.slice("origin/".length).trim(), kind: 2 };
    }
    if (ref === "HEAD") {
        return { name: "HEAD", kind: 8 };
    }
    return null;
}

function getStableBranchPriority(name: string): number {
    void name;
    return 10;
}
