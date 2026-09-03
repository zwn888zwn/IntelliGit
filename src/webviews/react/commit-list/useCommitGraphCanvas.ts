import { useEffect } from "react";
import {
    LANE_WIDTH,
    ROW_HEIGHT,
    type EdgeAnchor,
    type PrintElement,
    type RenderRowModel,
} from "../graph";

const GRAPH_LEFT_PAD = 0;
const OVERSCAN_ROWS = 8;
const IDEA_BASE_ROW_HEIGHT = 22;
const EDGE_LINE_WIDTH = (1.5 * ROW_HEIGHT) / IDEA_BASE_ROW_HEIGHT;
const NODE_RADIUS = (4 * ROW_HEIGHT) / IDEA_BASE_ROW_HEIGHT;
const HEAD_OUTER_RADIUS = (6 * ROW_HEIGHT) / IDEA_BASE_ROW_HEIGHT;
const HEAD_INNER_RADIUS = (2 * ROW_HEIGHT) / IDEA_BASE_ROW_HEIGHT;

interface Args {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    viewportRef: React.RefObject<HTMLDivElement | null>;
    rows: RenderRowModel[];
    currentCommitRefs: Array<{ repoRoot: string; hash: string }>;
    graphWidth: number;
    graphScale: number;
    graphOffset: number;
}

function isHashMatch(a: string, b: string): boolean {
    if (a.length === 40 && b.length === 40) return a === b;
    return a.startsWith(b) || b.startsWith(a);
}

export function useCommitGraphCanvas({
    canvasRef,
    viewportRef,
    rows,
    currentCommitRefs,
    graphWidth,
    graphScale,
    graphOffset,
}: Args): void {
    useEffect(() => {
        const canvas = canvasRef.current;
        const viewport = viewportRef.current;
        if (!canvas || !viewport) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        if (rows.length === 0) {
            canvas.width = 0;
            canvas.height = 0;
            canvas.style.width = `${graphWidth}px`;
            canvas.style.height = "0px";
            canvas.style.top = "0px";
            canvas.style.left = `${graphOffset}px`;
            return;
        }

        let raf = 0;
        const positionX = (position: number): number =>
            (position * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD) * graphScale;
        const anchorY = (rowTop: number, anchor: EdgeAnchor): number => {
            switch (anchor) {
                case "top":
                    return rowTop;
                case "center":
                    return rowTop + ROW_HEIGHT / 2;
                case "bottom":
                    return rowTop + ROW_HEIGHT;
                case "nextCenter":
                    return rowTop + ROW_HEIGHT + ROW_HEIGHT / 2;
            }
        };
        const isCurrentCommit = (row: RenderRowModel): boolean =>
            currentCommitRefs.some((ref) => {
                const sameRepo = row.repoRoot ? ref.repoRoot === row.repoRoot : true;
                return sameRepo && isHashMatch(row.commitHash, ref.hash);
            });
        const strokeSeparatedLine = (
            ctx2d: CanvasRenderingContext2D,
            fromX: number,
            fromY: number,
            toX: number,
            toY: number,
            color: string,
            separate: boolean,
        ): void => {
            const lineWidth = Math.max(1, EDGE_LINE_WIDTH * graphScale);
            const stroke = (): void => {
                ctx2d.beginPath();
                ctx2d.moveTo(fromX, fromY);
                ctx2d.lineTo(toX, toY);
                ctx2d.stroke();
            };

            if (separate) {
                // Clear only previously drawn graph pixels so crossing lanes remain visually
                // distinct over regular and selected-row backgrounds.
                ctx2d.save();
                ctx2d.globalCompositeOperation = "destination-out";
                ctx2d.lineWidth = lineWidth + 4;
                stroke();
                ctx2d.restore();
            }

            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = lineWidth;
            stroke();
        };
        const drawEdgeElement = (
            ctx2d: CanvasRenderingContext2D,
            rowTop: number,
            element: Extract<PrintElement, { type: "edge" }>,
            separate: boolean,
        ) => {
            strokeSeparatedLine(
                ctx2d,
                positionX(element.fromPosition),
                anchorY(rowTop, element.fromAnchor),
                positionX(element.toPosition),
                anchorY(rowTop, element.toAnchor),
                element.color,
                separate,
            );
        };
        const drawTerminalElement = (
            ctx2d: CanvasRenderingContext2D,
            rowTop: number,
            element: Extract<PrintElement, { type: "terminal" }>,
        ) => {
            const x = positionX(element.position);
            if (element.direction === "down") {
                strokeSeparatedLine(
                    ctx2d,
                    x,
                    rowTop,
                    x,
                    rowTop + ROW_HEIGHT / 2,
                    element.color,
                    false,
                );
            } else {
                strokeSeparatedLine(
                    ctx2d,
                    x,
                    rowTop + ROW_HEIGHT / 2,
                    x,
                    rowTop + ROW_HEIGHT,
                    element.color,
                    false,
                );
            }
        };
        const draw = () => {
            raf = 0;
            const dpr = window.devicePixelRatio || 1;
            const scrollTop = viewport.scrollTop;
            const viewportHeight = viewport.clientHeight;
            const visibleStart = Math.floor(scrollTop / ROW_HEIGHT);
            const visibleEnd = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
            const drawStart = Math.max(0, visibleStart - OVERSCAN_ROWS);
            const drawEnd = Math.min(rows.length, visibleEnd + OVERSCAN_ROWS);
            const drawHeight = Math.max(1, (drawEnd - drawStart) * ROW_HEIGHT);

            canvas.width = graphWidth * dpr;
            canvas.height = drawHeight * dpr;
            canvas.style.width = `${graphWidth}px`;
            canvas.style.height = `${drawHeight}px`;
            canvas.style.top = `${drawStart * ROW_HEIGHT}px`;
            canvas.style.left = `${graphOffset}px`;

            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, graphWidth, drawHeight);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            for (let i = drawStart; i < drawEnd; i++) {
                const row = rows[i];
                const y = (i - drawStart) * ROW_HEIGHT;
                const rowEdges = row.elements.filter(
                    (element): element is Extract<PrintElement, { type: "edge" }> =>
                        element.type === "edge",
                );
                const crossingEdges = new Set<Extract<PrintElement, { type: "edge" }>>();
                for (let firstIndex = 0; firstIndex < rowEdges.length; firstIndex += 1) {
                    const first = rowEdges[firstIndex];
                    if (first.fromAnchor !== "center" || first.toAnchor !== "nextCenter") continue;
                    for (
                        let secondIndex = firstIndex + 1;
                        secondIndex < rowEdges.length;
                        secondIndex += 1
                    ) {
                        const second = rowEdges[secondIndex];
                        if (
                            second.fromAnchor === "center" &&
                            second.toAnchor === "nextCenter" &&
                            (first.fromPosition - second.fromPosition) *
                                (first.toPosition - second.toPosition) <
                                0
                        ) {
                            crossingEdges.add(second);
                        }
                    }
                }
                for (const element of row.elements) {
                    if (element.type === "edge") {
                        drawEdgeElement(ctx, y, element, crossingEdges.has(element));
                    } else if (element.type === "terminal") {
                        drawTerminalElement(ctx, y, element);
                    }
                }

                const node = row.elements.find((element) => element.type === "node");
                if (node) {
                    const cx = positionX(node.position);
                    const cy = y + ROW_HEIGHT / 2;
                    const nodeRadius = Math.max(2.25, NODE_RADIUS * graphScale);
                    if (isCurrentCommit(row)) {
                        ctx.beginPath();
                        ctx.fillStyle = node.color;
                        ctx.arc(
                            cx,
                            cy,
                            Math.max(6, HEAD_OUTER_RADIUS * graphScale),
                            0,
                            Math.PI * 2,
                        );
                        ctx.fill();

                        const previousCompositeOperation = ctx.globalCompositeOperation;
                        ctx.globalCompositeOperation = "destination-out";
                        ctx.beginPath();
                        ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.globalCompositeOperation = previousCompositeOperation;

                        ctx.beginPath();
                        ctx.fillStyle = node.color;
                        ctx.arc(
                            cx,
                            cy,
                            Math.max(2, HEAD_INNER_RADIUS * graphScale),
                            0,
                            Math.PI * 2,
                        );
                        ctx.fill();
                    } else {
                        ctx.beginPath();
                        ctx.fillStyle = node.color;
                        ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
                        ctx.fill();
                    }
                }
            }
        };

        const scheduleDraw = () => {
            if (raf !== 0) return;
            raf = window.requestAnimationFrame(draw);
        };

        const observer = new ResizeObserver(scheduleDraw);
        observer.observe(viewport);
        // Observe theme-related attribute changes and redraw with updated colors.
        const themeObserver = new MutationObserver(scheduleDraw);
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-vscode-theme-id"],
        });
        themeObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ["class", "style", "data-vscode-theme-id"],
        });
        viewport.addEventListener("scroll", scheduleDraw, { passive: true });
        window.addEventListener("resize", scheduleDraw);
        scheduleDraw();

        return () => {
            if (raf !== 0) {
                window.cancelAnimationFrame(raf);
            }
            observer.disconnect();
            themeObserver.disconnect();
            viewport.removeEventListener("scroll", scheduleDraw);
            window.removeEventListener("resize", scheduleDraw);
        };
    }, [canvasRef, viewportRef, currentCommitRefs, graphOffset, graphScale, graphWidth, rows]);
}
