export type DiffNavigationDirection = "next" | "previous";

export interface DiffHunkRange {
    start: number;
    end: number;
}

export function parseChangedNewFileHunks(diff: string): DiffHunkRange[] {
    const ranges: DiffHunkRange[] = [];
    const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match: RegExpExecArray | null;
    while ((match = hunkPattern.exec(diff)) !== null) {
        const start = Number.parseInt(match[1] ?? "0", 10);
        const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
        const zeroBasedStart = Math.max(0, start - 1);
        const zeroBasedEnd = zeroBasedStart + Math.max(1, count) - 1;
        ranges.push({ start: zeroBasedStart, end: zeroBasedEnd });
    }
    return ranges.sort((left, right) => left.start - right.start);
}

export function getAdjacentHunkIndex(
    ranges: DiffHunkRange[],
    currentIndex: number | null,
    direction: DiffNavigationDirection,
): number | null {
    if (ranges.length <= 1) return null;
    const boundedIndex =
        currentIndex === null
            ? 0
            : Math.min(Math.max(currentIndex, 0), ranges.length - 1);
    const targetIndex = direction === "next" ? boundedIndex + 1 : boundedIndex - 1;
    return targetIndex >= 0 && targetIndex < ranges.length ? targetIndex : null;
}

export function hasAdjacentHunk(
    ranges: DiffHunkRange[],
    currentLine: number | null,
    direction: DiffNavigationDirection,
): boolean {
    if (ranges.length === 0 || currentLine === null) return false;
    const currentIndex = ranges.findIndex(
        (range) => currentLine >= range.start && currentLine <= range.end,
    );
    if (currentIndex >= 0) {
        return getAdjacentHunkIndex(ranges, currentIndex, direction) !== null;
    }

    if (direction === "next") {
        if (currentLine < ranges[0].start) return ranges.length > 1;
        return ranges.some((range) => range.start > currentLine);
    }

    if (currentLine < ranges[0].start) return false;
    return ranges.some((range) => range.end < currentLine);
}
