import React, {
    useRef,
    useEffect,
    useLayoutEffect,
    useState,
    useCallback,
    useInsertionEffect,
} from "react";
import { createPortal } from "react-dom";
import { SYSTEM_FONT_STACK } from "../../../../utils/constants";

const ITEM_HEIGHT = 24;
const ITEM_FONT_SIZE = 13;
const CONTEXT_MENU_STYLE_ID = "intelligit-ctx-styles";
const CONTEXT_MENU_STYLE_RULES = `
    .intelligit-context-menu {
        /* VS Code's inherited scrollbar-color overrides the custom scrollbar below. */
        scrollbar-color: auto;
    }
    .intelligit-context-menu::-webkit-scrollbar {
        width: 6px;
    }
    .intelligit-context-menu::-webkit-scrollbar-track {
        background: transparent;
        margin: 4px 0;
    }
    .intelligit-context-menu::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.4));
        border: 1px solid transparent;
        background-clip: padding-box;
        border-radius: 3px;
    }
    .intelligit-context-menu::-webkit-scrollbar-thumb:hover {
        background-color: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.65));
    }
    .intelligit-context-item[data-disabled="false"]:hover,
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        background: var(--vscode-menu-selectionBackground, #094771);
        color: var(--vscode-menu-selectionForeground, #fff);
    }
    .intelligit-context-item[data-disabled="false"]:focus-visible {
        outline: 1px solid var(--vscode-focusBorder, #007acc);
        box-shadow:
            0 0 0 1px var(--vscode-focusBorder, #007acc),
            inset 0 0 0 1px rgba(255, 255, 255, 0.08);
        outline-offset: -1px;
    }
`;

export interface MenuItem {
    label: string;
    action: string;
    separator?: boolean;
    icon?: React.ReactNode;
    disabled?: boolean;
    hint?: string;
    submenu?: boolean;
}

interface Props {
    x: number;
    y: number;
    items: MenuItem[];
    minWidth?: number;
    onSelect: (action: string) => void;
    onClose: () => void;
}

export function ContextMenu({
    x,
    y,
    items,
    minWidth = 180,
    onSelect,
    onClose,
}: Props): React.ReactElement {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: x, top: y });
    const menuBodyPaddingX = 3;
    const hasAnyIcon = items.some((item) => !item.separator && !!item.icon);
    const hasAnyTrailing = items.some((item) => !item.separator && (!!item.hint || !!item.submenu));

    useInsertionEffect(() => {
        if (typeof document === "undefined") return;
        if (document.getElementById(CONTEXT_MENU_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = CONTEXT_MENU_STYLE_ID;
        style.textContent = CONTEXT_MENU_STYLE_RULES;
        document.head.appendChild(style);
    }, []);

    useLayoutEffect(() => {
        const menu = ref.current;
        if (!menu) return;
        const updatePosition = () => {
            const rect = menu.getBoundingClientRect();
            const pad = 4;
            const left = Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad));
            const top = Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad));
            setPos((previous) =>
                previous.left === left && previous.top === top ? previous : { left, top },
            );
        };
        updatePosition();
        const observer = new ResizeObserver(updatePosition);
        observer.observe(menu);
        window.addEventListener("resize", updatePosition);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updatePosition);
        };
    }, [x, y, items.length]);

    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose();
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const handleBlur = () => onClose();
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("keydown", handleKey);
        window.addEventListener("blur", handleBlur);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("keydown", handleKey);
            window.removeEventListener("blur", handleBlur);
        };
    }, [onClose]);

    const handleItemClick = useCallback(
        (action: string) => {
            onSelect(action);
            onClose();
        },
        [onSelect, onClose],
    );

    return createPortal(
        <div
            ref={ref}
            role="menu"
            className="intelligit-context-menu"
            style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                zIndex: 9999,
                background: "var(--vscode-menu-background, #252526)",
                border: "1px solid var(--vscode-menu-border, rgba(255,255,255,0.14))",
                borderRadius: 5,
                padding: "3px 0",
                boxSizing: "border-box",
                minWidth: `min(${minWidth}px, calc(100vw - 8px))`,
                maxWidth: "min(480px, calc(100vw - 8px))",
                maxHeight: "calc(100vh - 8px)",
                overflowX: "hidden",
                overflowY: "auto",
                overscrollBehavior: "contain",
                fontFamily: SYSTEM_FONT_STACK,
                boxShadow: "0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.35))",
            }}
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return (
                        <div
                            key={`sep-${i}`}
                            style={{
                                height: 1,
                                margin: `3px ${menuBodyPaddingX + 3}px`,
                                background:
                                    "var(--vscode-menu-separatorBackground, rgba(255,255,255,0.12))",
                            }}
                        />
                    );
                }
                return (
                    <div
                        key={item.action}
                        className="intelligit-context-item"
                        role="menuitem"
                        data-disabled={item.disabled ? "true" : "false"}
                        aria-disabled={item.disabled}
                        tabIndex={item.disabled ? -1 : 0}
                        onClick={item.disabled ? undefined : () => handleItemClick(item.action)}
                        onKeyDown={
                            item.disabled
                                ? undefined
                                : (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          handleItemClick(item.action);
                                      }
                                  }
                        }
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: hasAnyIcon ? 7 : 0,
                            minHeight: ITEM_HEIGHT,
                            boxSizing: "border-box",
                            padding: "3px 8px",
                            margin: `0 ${menuBodyPaddingX}px`,
                            borderRadius: 3,
                            cursor: item.disabled ? "default" : "pointer",
                            fontSize: ITEM_FONT_SIZE,
                            lineHeight: "18px",
                            color: item.disabled
                                ? "var(--vscode-disabledForeground, rgba(255,255,255,0.4))"
                                : "var(--vscode-menu-foreground, #d8dbe2)",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {hasAnyIcon && (
                            <span
                                style={{
                                    width: 16,
                                    height: 16,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    flexShrink: 0,
                                    opacity: item.icon ? 0.95 : 0,
                                }}
                            >
                                {item.icon}
                            </span>
                        )}
                        <span
                            title={item.label}
                            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                        >
                            {item.label}
                        </span>
                        {hasAnyTrailing && (
                            <span
                                style={{
                                    minWidth: 58,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "flex-end",
                                    flexShrink: 0,
                                    overflow: "visible",
                                    fontSize: 11,
                                    opacity: 0.7,
                                    color: item.disabled
                                        ? "var(--vscode-disabledForeground, rgba(255,255,255,0.4))"
                                        : "var(--vscode-descriptionForeground, #9ea4b3)",
                                }}
                            >
                                {item.submenu ? (
                                    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                                        <path fill="currentColor" d="M6 4l4 4-4 4z" />
                                    </svg>
                                ) : (
                                    (item.hint ?? "")
                                )}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>,
        document.body,
    );
}
