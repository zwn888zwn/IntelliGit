import { useEffect } from "react";
import {
    DOT_RADIUS,
    LANE_WIDTH,
    ROW_HEIGHT,
    type GraphRow,
} from "../graph";

const GRAPH_LEFT_PAD = 4;
const OVERSCAN_ROWS = 8;
const ARROW_HEAD_SIZE = 4;
const ARROW_STEM = 8;

interface Args {
    canvasRef: React.RefObject<HTMLCanvasElement | null>;
    viewportRef: React.RefObject<HTMLDivElement | null>;
    rows: GraphRow[];
    graphWidth: number;
    graphOffset: number;
}

export function useCommitGraphCanvas({
    canvasRef,
    viewportRef,
    rows,
    graphWidth,
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
        const drawLaneArrow = (
            ctx2d: CanvasRenderingContext2D,
            x: number,
            cy: number,
            color: string,
            direction: "up" | "down",
            offsetX = 0,
        ) => {
            const drawX = x + offsetX;
            const tipY = direction === "up" ? cy - ARROW_STEM / 2 : cy + ARROW_STEM / 2;
            const tailY = direction === "up" ? cy + ARROW_STEM / 2 : cy - ARROW_STEM / 2;
            const headY = direction === "up" ? tipY + ARROW_HEAD_SIZE : tipY - ARROW_HEAD_SIZE;

            ctx2d.beginPath();
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = 2.25;
            ctx2d.moveTo(drawX, tailY);
            ctx2d.lineTo(drawX, tipY);
            ctx2d.moveTo(drawX, tipY);
            ctx2d.lineTo(drawX - ARROW_HEAD_SIZE, headY);
            ctx2d.moveTo(drawX, tipY);
            ctx2d.lineTo(drawX + ARROW_HEAD_SIZE, headY);
            ctx2d.stroke();
        };
        const drawLaneTurn = (
            ctx2d: CanvasRenderingContext2D,
            fromX: number,
            fromY: number,
            toX: number,
            toY: number,
            color: string,
        ) => {
            ctx2d.beginPath();
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = 2;
            ctx2d.moveTo(fromX, fromY);
            if (fromX === toX) {
                ctx2d.lineTo(toX, toY);
            } else {
                const midY = fromY + (toY - fromY) * 0.48;
                ctx2d.lineTo(fromX, midY);
                ctx2d.lineTo(toX, toY - (toY - fromY) * 0.2);
                ctx2d.lineTo(toX, toY);
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
                const cy = y + ROW_HEIGHT / 2;
                const cx = row.column * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;

                for (const lane of row.passThroughLanes) {
                    const lx = lane.column * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    ctx.beginPath();
                    ctx.strokeStyle = lane.color;
                    ctx.lineWidth = 2;
                    ctx.moveTo(lx, y);
                    ctx.lineTo(lx, y + ROW_HEIGHT);
                    ctx.stroke();
                }

                if (i > 0) {
                    const prev = rows[i - 1];
                    const incomingConnection = prev.connectionsDown.find(
                        (connection) => connection.rawToCol === row.rawColumn,
                    );
                    const incomingLane =
                        prev.passThroughLanes.find((lane) => lane.rawColumn === row.rawColumn) ??
                        (prev.rawColumn === row.rawColumn
                            ? { column: prev.column, rawColumn: prev.rawColumn, color: prev.color }
                            : undefined);
                    const incomingColumn =
                        incomingConnection?.toCol ?? incomingLane?.column;
                    if (incomingColumn !== undefined) {
                        const incomingX =
                            incomingColumn * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                        drawLaneTurn(ctx, incomingX, y, cx, cy, row.color);
                    }
                }

                for (const conn of row.connectionsDown) {
                    const fx = conn.fromCol * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    const tx = conn.toCol * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    drawLaneTurn(ctx, fx, cy, tx, y + ROW_HEIGHT, conn.color);
                }

                ctx.beginPath();
                ctx.fillStyle = row.color;
                ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
                ctx.fill();

                for (const lane of row.jumpBelow) {
                    const arrowX = lane.column * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    drawLaneArrow(
                        ctx,
                        arrowX,
                        y + ROW_HEIGHT * 0.66,
                        lane.color,
                        "down",
                        0,
                    );
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
    }, [canvasRef, viewportRef, graphOffset, graphWidth, rows]);
}
