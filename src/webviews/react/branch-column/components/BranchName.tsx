import { TooltipSurface, TOOLTIP_DELAY } from "../../shared/TooltipSurface";
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NODE_LABEL_STYLE } from "../styles";

interface Props {
    name: string;
    children?: React.ReactNode;
    style?: React.CSSProperties;
}

export function BranchName({ name, children, style }: Props): React.ReactElement {
    const label = useRef<HTMLSpanElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const tooltip = useRef<HTMLDivElement>(null);
    const [anchor, setAnchor] = useState<DOMRect | null>(null);
    const [position, setPosition] = useState({ left: 0, top: 0 });

    const dismiss = useCallback(() => {
        clearTimeout(timer.current);
        setAnchor(null);
    }, []);

    useEffect(() => () => clearTimeout(timer.current), [name]);

    useLayoutEffect(() => {
        if (!anchor || !tooltip.current || !label.current) return;
        if (label.current.scrollWidth <= label.current.clientWidth) {
            dismiss();
            return;
        }
        const rect = tooltip.current.getBoundingClientRect();
        const left = Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8));
        const below = anchor.bottom + 6;
        const top = below + rect.height <= window.innerHeight - 8
            ? below : Math.max(8, anchor.top - rect.height - 6);
        setPosition({ left, top });
        const width = label.current.clientWidth;
        const observer = new ResizeObserver(() => {
            if (label.current && (label.current.clientWidth !== width || label.current.scrollWidth <= label.current.clientWidth)) dismiss();
        });
        observer.observe(label.current);
        window.addEventListener("scroll", dismiss, true);
        window.addEventListener("resize", dismiss);
        window.addEventListener("blur", dismiss);
        return () => {
            observer.disconnect();
            window.removeEventListener("scroll", dismiss, true);
            window.removeEventListener("resize", dismiss);
            window.removeEventListener("blur", dismiss);
        };
    }, [anchor, name, dismiss]);

    const show = (element: HTMLElement) => {
        clearTimeout(timer.current);
        if (element.scrollWidth <= element.clientWidth) return;
        timer.current = setTimeout(() => {
            if (!element.isConnected || element.scrollWidth <= element.clientWidth) return;
            const rect = element.getBoundingClientRect();
            setPosition({ left: rect.left, top: rect.bottom + 6 });
            setAnchor(rect);
        }, TOOLTIP_DELAY);
    };

    return (
        <>
            <span
                ref={label}
                style={{ ...NODE_LABEL_STYLE, ...style }}
                onPointerEnter={event => show(event.currentTarget)}
                onPointerLeave={dismiss}
                onPointerDown={dismiss}
                onContextMenu={dismiss}
            >
                {children ?? name}
            </span>
            {anchor && createPortal(
                <>
                    <TooltipSurface
                        ref={tooltip}
                        className="intelligit-menu-surface"
                        style={{
                            position: "fixed", ...position,
                            zIndex: 10000, pointerEvents: "none",
                            width: "max-content", maxWidth: "calc(100vw - 16px)",

                            whiteSpace: "normal", overflowWrap: "anywhere",
                        }}
                    >
                        {name}
                    </TooltipSurface>
                </>,
                document.body,
            )}
        </>
    );
}
