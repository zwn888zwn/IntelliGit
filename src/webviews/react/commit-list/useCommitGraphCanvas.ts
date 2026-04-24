import { useEffect } from "react";
import {
    DOT_RADIUS,
    LANE_WIDTH,
    ROW_HEIGHT,
    type EdgeAnchor,
    type PrintElement,
    type RenderRowModel,
} from "../graph";

const GRAPH_LEFT_PAD = 0;
const OVERSCAN_ROWS = 8;

interface Args {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    viewportRef: React.RefObject<HTMLDivElement | null>;
    rows: RenderRowModel[];
    currentHash: string | null;
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
    currentHash,
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
            }
        };
        const drawEdgeElement = (
            ctx2d: CanvasRenderingContext2D,
            rowTop: number,
            element: Extract<PrintElement, { type: "edge" }>,
        ) => {
            ctx2d.beginPath();
            ctx2d.strokeStyle = element.color;
            ctx2d.lineWidth = Math.max(1.5, 2 * graphScale);
            ctx2d.moveTo(
                positionX(element.fromPosition),
                anchorY(rowTop, element.fromAnchor),
            );
            ctx2d.lineTo(
                positionX(element.toPosition),
                anchorY(rowTop, element.toAnchor),
            );
            ctx2d.stroke();
        };
        const drawTerminalElement = (
            ctx2d: CanvasRenderingContext2D,
            rowTop: number,
            element: Extract<PrintElement, { type: "terminal" }>,
        ) => {
            const x = positionX(element.position);
            ctx2d.beginPath();
            ctx2d.strokeStyle = element.color;
            ctx2d.lineWidth = Math.max(1.5, 2 * graphScale);
            if (element.direction === "down") {
                ctx2d.moveTo(x, rowTop);
                ctx2d.lineTo(x, rowTop + ROW_HEIGHT / 2);
            } else {
                ctx2d.moveTo(x, rowTop + ROW_HEIGHT / 2);
                ctx2d.lineTo(x, rowTop + ROW_HEIGHT);
            }
            ctx2d.stroke();
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
                for (const element of row.elements) {
                    if (element.type === "edge") {
                        drawEdgeElement(ctx, y, element);
                    } else if (element.type === "terminal") {
                        drawTerminalElement(ctx, y, element);
                    }
                }

                const node = row.elements.find((element) => element.type === "node");
                if (node) {
                    const cx = positionX(node.position);
                    const cy = y + ROW_HEIGHT / 2;
                    if (currentHash && isHashMatch(row.commitHash, currentHash)) {
                        ctx.beginPath();
                        ctx.strokeStyle = node.color;
                        ctx.lineWidth = Math.max(2, 2 * graphScale);
                        ctx.arc(
                            cx,
                            cy,
                            Math.max(6, (DOT_RADIUS + 3) * graphScale),
                            0,
                            Math.PI * 2,
                        );
                        ctx.stroke();
                    }
                    ctx.beginPath();
                    ctx.fillStyle = node.color;
                    ctx.arc(cx, cy, Math.max(2.5, DOT_RADIUS * graphScale), 0, Math.PI * 2);
                    ctx.fill();
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
    }, [canvasRef, viewportRef, currentHash, graphOffset, graphScale, graphWidth, rows]);
}
