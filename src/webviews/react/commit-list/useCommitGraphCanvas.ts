import { useEffect } from "react";
import {
    DOT_RADIUS,
    LANE_WIDTH,
    OVERFLOW_COLUMN,
    ROW_HEIGHT,
    type GraphRow,
} from "../graph";

const GRAPH_LEFT_PAD = 4;
const OVERSCAN_ROWS = 8;
const OVERFLOW_ARROW_SIZE = 5;
const OVERFLOW_ARROW_STEM = 8;

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
        const drawOverflowArrow = (
            ctx2d: CanvasRenderingContext2D,
            x: number,
            cy: number,
            color: string,
            direction: "up" | "down",
            offsetX = 0,
        ) => {
            const drawX = x + offsetX;
            const tipY = direction === "up" ? cy - OVERFLOW_ARROW_STEM / 2 : cy + OVERFLOW_ARROW_STEM / 2;
            const tailY =
                direction === "up" ? cy + OVERFLOW_ARROW_STEM / 2 : cy - OVERFLOW_ARROW_STEM / 2;
            const headY = direction === "up" ? tipY + OVERFLOW_ARROW_SIZE : tipY - OVERFLOW_ARROW_SIZE;

            ctx2d.beginPath();
            ctx2d.strokeStyle = color;
            ctx2d.lineWidth = 2;
            ctx2d.moveTo(drawX, tailY);
            ctx2d.lineTo(drawX, tipY);
            ctx2d.moveTo(drawX, tipY);
            ctx2d.lineTo(drawX - OVERFLOW_ARROW_SIZE, headY);
            ctx2d.moveTo(drawX, tipY);
            ctx2d.lineTo(drawX + OVERFLOW_ARROW_SIZE, headY);
            ctx2d.stroke();
        };
        const draw = () => {
            raf = 0;
            const dpr = window.devicePixelRatio || 1;
            // Read theme background on every draw so theme switches repaint correctly.
            const bgColor =
                getComputedStyle(document.documentElement)
                    .getPropertyValue("--vscode-editor-background")
                    .trim() || "#1e1e1e";
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
                        ctx.beginPath();
                        ctx.strokeStyle = row.color;
                        ctx.lineWidth = 2;
                        ctx.moveTo(incomingX, y);
                        if (incomingX === cx) {
                            ctx.lineTo(cx, cy);
                        } else {
                            ctx.bezierCurveTo(
                                incomingX,
                                y + ROW_HEIGHT * 0.25,
                                cx,
                                y + ROW_HEIGHT * 0.35,
                                cx,
                                cy,
                            );
                        }
                        ctx.stroke();
                    }
                }

                for (const conn of row.connectionsDown) {
                    const fx = conn.fromCol * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    const tx = conn.toCol * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                    ctx.beginPath();
                    ctx.strokeStyle = conn.color;
                    ctx.lineWidth = 2;
                    if (conn.fromCol === conn.toCol) {
                        ctx.moveTo(fx, cy);
                        ctx.lineTo(tx, y + ROW_HEIGHT);
                    } else {
                        ctx.moveTo(fx, cy);
                        ctx.bezierCurveTo(
                            fx,
                            cy + ROW_HEIGHT * 0.4,
                            tx,
                            y + ROW_HEIGHT - ROW_HEIGHT * 0.3,
                            tx,
                            y + ROW_HEIGHT,
                        );
                    }
                    ctx.stroke();
                }

                ctx.beginPath();
                ctx.fillStyle = bgColor;
                ctx.arc(cx, cy, DOT_RADIUS + 1, 0, Math.PI * 2);
                ctx.fill();

                ctx.beginPath();
                ctx.strokeStyle = row.color;
                ctx.lineWidth = 2.5;
                ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
                ctx.stroke();

                ctx.beginPath();
                ctx.fillStyle = row.color;
                ctx.arc(cx, cy, 2, 0, Math.PI * 2);
                ctx.fill();

                const overflowX = OVERFLOW_COLUMN * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_LEFT_PAD;
                if (row.overflowAbove.length > 0) {
                    drawOverflowArrow(
                        ctx,
                        overflowX,
                        cy,
                        row.overflowAbove[0].color,
                        "up",
                        row.overflowBelow.length > 0 ? -4 : 0,
                    );
                }
                if (row.overflowBelow.length > 0) {
                    drawOverflowArrow(
                        ctx,
                        overflowX,
                        cy,
                        row.overflowBelow[0].color,
                        "down",
                        row.overflowAbove.length > 0 ? 4 : 0,
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
