import type { GraphRefInfo } from "../../../types";

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
    graphRefs?: GraphRefInfo[];
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
    commits: Array<{ hash: string; parentHashes: string[]; refs?: string[]; graphRefs?: GraphRefInfo[] }>,
    layoutIndexOverride?: Map<string, number>,
): PermanentGraphModel {
    const graphNodes = buildInternalGraph(commits);
    const { layoutIndexByHash } = layoutIndexOverride
        ? {
              layoutIndexByHash: layoutIndexOverride,
          }
        : buildGraphAssignments(commits, graphNodes);
    const colorIndexByHash = buildColorAssignments(commits, layoutIndexByHash);
    const laneColors = new Map<string, string>();
    const rows: PermanentRow[] = commits.map((commit, rowIndex) => {
        const layoutIndex = layoutIndexByHash.get(commit.hash) ?? 0;
        const laneId = `lane-${layoutIndex}`;
        const color = colorForColorId(colorIndexByHash.get(commit.hash) ?? layoutIndex);
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
            const color =
                currentRow.node.layoutIndex >= targetRow.node.layoutIndex
                    ? currentRow.node.color
                    : targetRow.node.color;
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

function buildColorAssignments(
    commits: GraphCommitLike[],
    layoutIndexByHash: Map<string, number>,
): Map<string, number> {
    const headByLayoutIndex = new Map<number, GraphCommitLike>();
    for (const commit of commits) {
        const layoutIndex = layoutIndexByHash.get(commit.hash) ?? 0;
        if (!headByLayoutIndex.has(layoutIndex)) {
            headByLayoutIndex.set(layoutIndex, commit);
        }
    }

    return new Map(
        commits.map((commit) => {
            const layoutIndex = layoutIndexByHash.get(commit.hash) ?? 0;
            const head = headByLayoutIndex.get(layoutIndex) ?? commit;
            return [commit.hash, getHeadColorId(head, layoutIndex)];
        }),
    );
}

function getHeadColorId(commit: GraphCommitLike, fallbackLayoutIndex: number): number {
    const firstRef = getOrderedGraphRefs(commit).find((ref) => ref.type !== "other");
    if (!firstRef) {
        return fallbackLayoutIndex;
    }
    return javaStringHash(firstRef.name);
}

function javaStringHash(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
    }
    return hash;
}

function colorForColorId(colorId: number): string {
    if (colorId === 0) {
        return "#000000";
    }

    const red = rangeFix((Math.imul(colorId, 200) + 30) | 0);
    const green = rangeFix((Math.imul(colorId, 130) + 50) | 0);
    const blue = rangeFix((Math.imul(colorId, 90) + 100) | 0);
    const [hue] = rgbToHsv(red, green, blue);
    const [nextRed, nextGreen, nextBlue] = hsvToRgb(hue, 0.4, 0.65);
    return `#${toHex(nextRed)}${toHex(nextGreen)}${toHex(nextBlue)}`;
}

function rangeFix(value: number): number {
    return Math.abs(value % 100) + 70;
}

function rgbToHsv(red: number, green: number, blue: number): [number, number, number] {
    const normalizedRed = red / 255;
    const normalizedGreen = green / 255;
    const normalizedBlue = blue / 255;
    const max = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
    const min = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
        if (max === normalizedRed) {
            hue = (normalizedGreen - normalizedBlue) / delta + (normalizedGreen < normalizedBlue ? 6 : 0);
        } else if (max === normalizedGreen) {
            hue = (normalizedBlue - normalizedRed) / delta + 2;
        } else {
            hue = (normalizedRed - normalizedGreen) / delta + 4;
        }
        hue /= 6;
    }

    return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
    const index = Math.floor(hue * 6);
    const fraction = hue * 6 - index;
    const primary = brightness * (1 - saturation);
    const secondary = brightness * (1 - fraction * saturation);
    const tertiary = brightness * (1 - (1 - fraction) * saturation);

    switch (index % 6) {
        case 0:
            return toRgbTuple(brightness, tertiary, primary);
        case 1:
            return toRgbTuple(secondary, brightness, primary);
        case 2:
            return toRgbTuple(primary, brightness, tertiary);
        case 3:
            return toRgbTuple(primary, secondary, brightness);
        case 4:
            return toRgbTuple(tertiary, primary, brightness);
        default:
            return toRgbTuple(brightness, primary, secondary);
    }
}

function toRgbTuple(red: number, green: number, blue: number): [number, number, number] {
    return [red, green, blue].map((component) => Math.round(component * 255)) as [
        number,
        number,
        number,
    ];
}

function toHex(value: number): string {
    return value.toString(16).padStart(2, "0");
}

function collectLayoutSeedIndexes(
    commits: GraphCommitLike[],
    graphNodes: InternalGraphNode[],
): number[] {
    const headIndexes = graphNodes
        .map((node, rowIndex) => ({ node, rowIndex }))
        .filter(({ node }) => node.upNodes.length === 0 || hasBranchLayoutRef(node.commit))
        .sort(
            (left, right) =>
                compareHeadImportance(left.node.commit, right.node.commit) || left.rowIndex - right.rowIndex,
        )
        .map(({ rowIndex }) => rowIndex);

    return headIndexes;
}

function hasBranchLayoutRef(commit: GraphCommitLike): boolean {
    const refs = getOrderedGraphRefs(commit);
    return refs.some((ref) => ref.type === "head" || ref.type === "local" || ref.type === "remote");
}

function compareHeadImportance(left: GraphCommitLike, right: GraphCommitLike): number {
    const leftRef = getBestLayoutGraphRef(left);
    const rightRef = getBestLayoutGraphRef(right);
    if (!leftRef && !rightRef) return 0;
    if (!leftRef) return 1;
    if (!rightRef) return -1;
    const byRef = compareGraphRefsForLayout(leftRef, rightRef);
    if (byRef !== 0) return byRef;
    return left.hash.localeCompare(right.hash);
}

function getBestLayoutGraphRef(commit: GraphCommitLike): GraphRefInfo | undefined {
    return getParsedGraphRefs(commit).sort(compareGraphRefsForLayout)[0];
}

function getOrderedGraphRefs(commit: GraphCommitLike): GraphRefInfo[] {
    return getParsedGraphRefs(commit).sort(compareGraphRefs);
}

function getParsedGraphRefs(commit: GraphCommitLike): GraphRefInfo[] {
    return commit.graphRefs?.length
        ? [...commit.graphRefs]
        : (commit.refs ?? [])
              .map(parseGraphRef)
              .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
}

function compareGraphRefs(left: GraphRefInfo, right: GraphRefInfo): number {
    return (
        getGraphRefLabelTypePriority(left) - getGraphRefLabelTypePriority(right) ||
        compareReferenceNames(left.name, right.name)
    );
}

function compareGraphRefsForLayout(left: GraphRefInfo, right: GraphRefInfo): number {
    return (
        getGraphRefLayoutTypePriority(left) - getGraphRefLayoutTypePriority(right) ||
        compareReferenceNames(left.name, right.name)
    );
}

function getGraphRefLayoutTypePriority(ref: GraphRefInfo): number {
    switch (ref.type) {
        case "remote":
            return isOriginMainBranch(ref.name) ? 0 : 1;
        case "local":
            return isMainBranch(ref.name) ? 2 : 3;
        case "tag":
            return 4;
        case "head":
            return 6;
        default:
            return 7;
    }
}

function getGraphRefLabelTypePriority(ref: GraphRefInfo): number {
    switch (ref.type) {
        case "head":
            return 0;
        case "local":
            return isMainBranch(ref.name) ? 2 : 4;
        case "remote":
            return isOriginMainBranch(ref.name) ? 3 : 5;
        case "tag":
            return 6;
        default:
            return 7;
    }
}

function compareReferenceNames(left: string, right: string): number {
    const ignoreCaseResult = naturalCompare(left, right, true);
    return ignoreCaseResult !== 0 ? ignoreCaseResult : naturalCompare(left, right, false);
}

function naturalCompare(left: string, right: string, ignoreCase: boolean): number {
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
        const leftChar = left[leftIndex];
        const rightChar = right[rightIndex];
        if ((isDigitOrSpace(leftChar) || leftChar === " ") && (isDigitOrSpace(rightChar) || rightChar === " ")) {
            const leftStart = skipChar(left, skipChar(left, leftIndex, " "), "0");
            const rightStart = skipChar(right, skipChar(right, rightIndex, " "), "0");
            const leftEnd = skipDigits(left, leftStart);
            const rightEnd = skipDigits(right, rightStart);
            const lengthDiff = leftEnd - leftStart - (rightEnd - rightStart);
            if (lengthDiff !== 0) return lengthDiff;
            const numberDiff = compareCharRange(left, right, leftStart, rightStart, leftEnd);
            if (numberDiff !== 0) return numberDiff;
            const fullLengthDiff = leftEnd - leftIndex - (rightEnd - rightIndex);
            if (fullLengthDiff !== 0) return fullLengthDiff;
            const leadingDiff = compareCharRange(left, right, leftIndex, rightIndex, leftStart);
            if (leadingDiff !== 0) return leadingDiff;
            leftIndex = leftEnd;
            rightIndex = rightEnd;
            continue;
        }

        const charDiff = compareChars(leftChar, rightChar, ignoreCase);
        if (charDiff !== 0) return charDiff;
        leftIndex += 1;
        rightIndex += 1;
    }
    if (leftIndex < left.length) return 1;
    if (rightIndex < right.length) return -1;
    return left.length - right.length;
}

function isDigitOrSpace(char: string): boolean {
    return char >= "0" && char <= "9";
}

function skipDigits(value: string, start: number): number {
    let index = start;
    while (index < value.length && value[index] >= "0" && value[index] <= "9") {
        index += 1;
    }
    return index;
}

function skipChar(value: string, start: number, char: string): number {
    let index = start;
    while (index < value.length && value[index] === char) {
        index += 1;
    }
    return index;
}

function compareCharRange(
    left: string,
    right: string,
    leftOffset: number,
    rightOffset: number,
    leftEnd: number,
): number {
    for (let leftIndex = leftOffset, rightIndex = rightOffset; leftIndex < leftEnd; leftIndex += 1, rightIndex += 1) {
        const diff = left.charCodeAt(leftIndex) - right.charCodeAt(rightIndex);
        if (diff !== 0) return diff;
    }
    return 0;
}

function compareChars(left: string, right: string, ignoreCase: boolean): number {
    if (left === " " && right > " " && right < "0") return 1;
    if (right === " " && left > " " && left < "0") return -1;
    const leftValue = ignoreCase ? left.toLowerCase() : left;
    const rightValue = ignoreCase ? right.toLowerCase() : right;
    return leftValue.charCodeAt(0) - rightValue.charCodeAt(0);
}

function isOriginMainBranch(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === "origin/master" || normalized === "origin/main";
}

function isMainBranch(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return normalized === "master" || normalized === "main";
}

function parseGraphRef(ref: string): GraphRefInfo | null {
    if (ref.startsWith("HEAD -> ")) {
        return { name: ref.slice("HEAD -> ".length).trim(), type: "head" };
    }
    if (ref === "HEAD") {
        return { name: "HEAD", type: "head" };
    }
    if (ref.startsWith("tag:")) {
        return { name: ref.slice("tag:".length).trim(), type: "tag" };
    }
    if (isRemoteBranchRef(ref)) {
        return { name: ref.trim(), type: "remote" };
    }
    if (isLocalBranchRef(ref)) {
        return { name: ref.trim(), type: "local" };
    }
    return null;
}

function isLocalBranchRef(ref: string): boolean {
    if (ref === "HEAD" || ref.startsWith("HEAD -> ")) return false;
    if (ref.startsWith("tag:")) return false;
    if (isRemoteBranchRef(ref)) return false;
    return true;
}

function isRemoteBranchRef(ref: string): boolean {
    return /^[^/]+\/.+/.test(ref.trim());
}
