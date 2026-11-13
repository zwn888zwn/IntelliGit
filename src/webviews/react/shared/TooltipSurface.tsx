import React, { useEffect, useRef } from "react";
import { MENU_SURFACE_CSS } from "./menuSurface";
import { SYSTEM_FONT_STACK } from "../../../utils/constants";

export const TOOLTIP_DELAY = 400;
export const TOOLTIP_STYLE: React.CSSProperties = {
    background: "var(--intelligit-menu-tint)",
    color: "var(--vscode-menu-foreground, #d8dbe2)",
    border: "1px solid var(--vscode-menu-border, color-mix(in srgb, var(--vscode-menu-foreground, #fff) 18%, transparent))",
    borderRadius: 7,
    padding: "7px 10px",
    fontFamily: SYSTEM_FONT_STACK,
    fontSize: 12,
    lineHeight: "18px",
    fontWeight: 400,
    boxShadow: "0 8px 24px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.07)",
};

export const TooltipSurface = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function TooltipSurface({ style, className = "", ...props }, ref) {
        return <>
            <style>{MENU_SURFACE_CSS}</style>
            <div {...props} ref={ref} role="tooltip" className={`intelligit-menu-surface ${className}`} style={{ ...style, ...TOOLTIP_STYLE }} />
        </>;
    },
);

export function useTooltipDelay() {
    const timer = useRef<ReturnType<typeof setTimeout>>();
    const cancel = () => clearTimeout(timer.current);
    useEffect(() => cancel, []);
    return {
        cancel,
        show(callback: () => void) {
            cancel();
            timer.current = setTimeout(callback, TOOLTIP_DELAY);
        },
    };
}

// Native title bubbles cannot be styled. Delegate them to the same material
// inside each webview, without cancelling clicks or context-menu events.
export function installTitleTooltips(): void {
    const style = document.createElement("style");
    style.textContent = MENU_SURFACE_CSS;
    document.head.append(style);
    let anchor: Element | null = null;
    let text = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let popup: HTMLDivElement | null = null;
    const hide = () => {
        clearTimeout(timer);
        popup?.remove(); popup = null;
        if (anchor && !anchor.hasAttribute("title")) anchor.setAttribute("title", text);
        anchor = null;
    };
    document.addEventListener("pointerover", event => {
        if (!(event.target instanceof Element) || event.target.closest('[role="tooltip"]')) return;
        if (anchor?.contains(event.target)) return;
        hide();
        const target = event.target.closest("[title]");
        const title = target?.getAttribute("title");
        if (!target || !title?.trim()) return;
        if (target.hasAttribute("data-tooltip-overflow-only") && target.scrollWidth <= target.clientWidth) return;
        anchor = target; text = title;
        target.removeAttribute("title");
        timer = setTimeout(() => {
            if (anchor !== target || !target.isConnected) return;
            const bubble = document.createElement("div");
            bubble.className = "intelligit-menu-surface";
            bubble.setAttribute("role", "tooltip");
            Object.assign(bubble.style, TOOLTIP_STYLE, {
                position: "fixed", zIndex: "10000", pointerEvents: "none",
                fontSize: "12px", borderRadius: "7px", fontWeight: "400",
                width: "max-content", maxWidth: "calc(100vw - 16px)",
                whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            });
            bubble.textContent = title;
            document.body.append(bubble);
            const rect = target.getBoundingClientRect();
            const bounds = bubble.getBoundingClientRect();
            bubble.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
            bubble.style.top = `${rect.bottom + bounds.height + 14 <= window.innerHeight
                ? rect.bottom + 6 : Math.max(8, rect.top - bounds.height - 6)}px`;
            popup = bubble;
        }, TOOLTIP_DELAY);
    });
    document.addEventListener("pointerout", event => {
        if (!anchor?.contains(event.relatedTarget as Node | null)) hide();
    });
    for (const event of ["pointerdown", "contextmenu", "keydown", "scroll"]) document.addEventListener(event, hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
}
