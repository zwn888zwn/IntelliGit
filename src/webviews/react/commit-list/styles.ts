import type { CSSProperties } from "react";
import { ROW_HEIGHT } from "../graph";
import { PANEL_BORDER, PANEL_SEARCH_FIELD_STYLE, PANEL_SEARCH_INPUT_STYLE, PANEL_TOOLBAR_STYLE } from "../shared/panelStyles";

export const AUTHOR_COL_WIDTH = 96;
export const DATE_COL_WIDTH = 102;
export const HASH_COL_WIDTH = 74;
export const META_COL_GAP = 2;
export const ROW_SIDE_PADDING = 8;

export const ROOT_STYLE: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "var(--vscode-editor-background)",
};

export const FILTER_BAR_STYLE: CSSProperties = {
    ...PANEL_TOOLBAR_STYLE,
};

export const FILTER_ICON_STYLE: CSSProperties = {
    flexShrink: 0,
};

export const FILTER_INPUT_WRAP_STYLE: CSSProperties = {
    ...PANEL_SEARCH_FIELD_STYLE,
    flex: "1 1 140px",
    minWidth: 80,
    maxWidth: 260,
    marginLeft: "auto",
};

export const FILTER_INPUT_STYLE: CSSProperties = {
    ...PANEL_SEARCH_INPUT_STYLE,
};

export const FILTER_CLEAR_BUTTON_STYLE: CSSProperties = {
    flexShrink: 0,
    width: 14,
    height: 14,
    border: "none",
    background: "transparent",
    color: "var(--vscode-descriptionForeground)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    cursor: "pointer",
    lineHeight: "14px",
};

export const BRANCH_SCOPE_STYLE: CSSProperties = {
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "var(--vscode-descriptionForeground)",
    fontSize: "11px",
    flexShrink: 1,
};

export function headerRowStyle(graphWidth: number): CSSProperties {
    return {
        display: "flex",
        alignItems: "center",
        height: 24,
        fontSize: "10px",
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        borderBottom: `1px solid ${PANEL_BORDER}`,
        color: "var(--vscode-descriptionForeground)",
        paddingLeft: graphWidth,
        paddingRight: ROW_SIDE_PADDING,
        flexShrink: 0,
    };
}

export const SCROLL_VIEWPORT_STYLE: CSSProperties = {
    height: "100%",
    minHeight: 0,
    overflow: "auto",
};

export function contentContainerStyle(rowCount: number): CSSProperties {
    return {
        position: "relative",
        height: rowCount * ROW_HEIGHT,
    };
}

export const CANVAS_STYLE: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    pointerEvents: "none",
    zIndex: 3,
};

export const LOADING_MORE_STYLE: CSSProperties = {
    padding: "8px",
    textAlign: "center",
    fontSize: "11px",
    opacity: 0.5,
};

export const REF_CONTAINER_STYLE: CSSProperties = {
    display: "flex",
    gap: "3px",
    marginLeft: 8,
    flexShrink: 0,
};

export const REF_LABEL_STYLE: CSSProperties = {
    padding: "1px 6px",
    borderRadius: "3px",
    fontSize: "10px",
    lineHeight: "16px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: 160,
    display: "inline-block",
};
