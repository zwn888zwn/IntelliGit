// Handles vertical drag-to-resize logic for the bottom commit area.
// Returns the current height and a mousedown handler for the drag handle.

import { useState, useCallback, useEffect, useRef } from "react";

interface DragResizeAPI {
    height: number;
    onMouseDown: (e: React.MouseEvent) => void;
}

export interface DragResizeOptions {
    maxReservedHeight?: number;
    onResize?: (height: number) => void;
    resolveInitialHeight?: (containerHeight: number) => number;
}

export function useDragResize(
    initialHeight: number,
    minHeight: number,
    containerRef: React.RefObject<HTMLDivElement | null>,
    options: DragResizeOptions = {},
): DragResizeAPI {
    const [height, setHeight] = useState(initialHeight);
    const dragging = useRef(false);
    const heightRef = useRef(height);
    const didResolveInitialHeight = useRef(false);
    const { maxReservedHeight = 60, onResize, resolveInitialHeight } = options;
    const onResizeRef = useRef(onResize);

    useEffect(() => {
        onResizeRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
        heightRef.current = height;
    }, [height]);

    useEffect(() => {
        if (!resolveInitialHeight || didResolveInitialHeight.current) return;

        const resolveHeight = () => {
            const containerHeight = containerRef.current?.clientHeight ?? 0;
            if (containerHeight <= 0 || didResolveInitialHeight.current) return false;

            const maxH = containerHeight - maxReservedHeight;
            const nextHeight = Math.max(
                minHeight,
                Math.min(maxH, resolveInitialHeight(containerHeight)),
            );
            didResolveInitialHeight.current = true;
            heightRef.current = nextHeight;
            setHeight(nextHeight);
            return true;
        };

        if (resolveHeight()) return;
        if (typeof ResizeObserver === "undefined" || !containerRef.current) return;

        const observer = new ResizeObserver(() => {
            if (resolveHeight()) observer.disconnect();
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [containerRef, maxReservedHeight, minHeight, resolveInitialHeight]);

    const onMouseDown = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging.current = true;
            const startY = e.clientY;
            const startH = heightRef.current;

            const onMouseMove = (ev: MouseEvent) => {
                if (!dragging.current) return;
                const delta = startY - ev.clientY;
                const maxH = containerRef.current
                    ? containerRef.current.clientHeight - maxReservedHeight
                    : 500;
                const nextHeight = Math.max(minHeight, Math.min(maxH, startH + delta));
                setHeight(nextHeight);
                onResizeRef.current?.(nextHeight);
            };

            const onMouseUp = () => {
                dragging.current = false;
                document.removeEventListener("mousemove", onMouseMove);
                document.removeEventListener("mouseup", onMouseUp);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            document.addEventListener("mousemove", onMouseMove);
            document.addEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
        },
        [containerRef, maxReservedHeight, minHeight],
    );

    return { height, onMouseDown };
}
