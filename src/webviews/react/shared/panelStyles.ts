import type { CSSProperties } from "react";

export const PANEL_BORDER =
    "var(--vscode-contrastBorder, color-mix(in srgb, var(--vscode-panel-border, #444) 65%, transparent))";
export const PANEL_SURFACE =
    "color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground))";
export const PANEL_HEADER_SURFACE =
    "color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground))";

export const PANEL_COUNT_STYLE: CSSProperties = {
    padding: "0 6px",
    borderRadius: 8,
    background: "color-mix(in srgb, var(--vscode-foreground) 10%, transparent)",
    color: "var(--vscode-descriptionForeground)",
    fontSize: 10,
    fontWeight: 500,
    lineHeight: "16px",
    flexShrink: 0,
};

export const PANEL_TOOLBAR_STYLE: CSSProperties = {
    height: 36,
    minHeight: 36,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 10px",
    background: PANEL_HEADER_SURFACE,
    borderBottom: `1px solid ${PANEL_BORDER}`,
};

export const PANEL_SEARCH_FIELD_STYLE: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    minWidth: 0,
    height: 24,
    padding: "0 6px",
    borderRadius: 5,
    border: `1px solid ${PANEL_BORDER}`,
    background: "var(--vscode-editor-background)",
    color: "var(--vscode-descriptionForeground)",
};

export const PANEL_SEARCH_INPUT_STYLE: CSSProperties = {
    flex: 1,
    minWidth: 0,
    width: "100%",
    height: 22,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--vscode-input-foreground)",
    padding: 0,
    fontFamily: "inherit",
    fontSize: 12,
};

export const COMPACT_SCROLLBAR_CSS = `
    .intelligit-graph-panel, .intelligit-graph-panel *, .intelligit-compact-scrollbar {
        scrollbar-color: auto;
    }
    .intelligit-graph-panel ::-webkit-scrollbar,
    .intelligit-compact-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
    .intelligit-graph-panel ::-webkit-scrollbar-track,
    .intelligit-graph-panel ::-webkit-scrollbar-corner,
    .intelligit-compact-scrollbar::-webkit-scrollbar-track,
    .intelligit-compact-scrollbar::-webkit-scrollbar-corner { background: transparent; }
    .intelligit-graph-panel ::-webkit-scrollbar-thumb,
    .intelligit-compact-scrollbar::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background);
        border: 1px solid transparent;
        background-clip: padding-box;
        border-radius: 3px;
    }
    .intelligit-graph-panel ::-webkit-scrollbar-thumb:hover,
    .intelligit-compact-scrollbar::-webkit-scrollbar-thumb:hover {
        background-color: var(--vscode-scrollbarSlider-hoverBackground);
    }
`;

export const GRAPH_PANEL_CSS = `${COMPACT_SCROLLBAR_CSS}
    .intelligit-search-field:focus-within {
        border-color: var(--vscode-focusBorder) !important;
    }
    .intelligit-search-field input::placeholder {
        color: var(--vscode-input-placeholderForeground);
        opacity: 1;
    }
    .intelligit-panel-divider { position: relative; }
    .intelligit-panel-divider::after {
        content: "";
        position: absolute;
        inset: 0 auto 0 1px;
        width: 1px;
        background: ${PANEL_BORDER};
    }
    .intelligit-panel-divider:hover::after {
        width: 2px;
        background: var(--vscode-focusBorder);
    }
    .intelligit-commit-row[aria-selected="false"]:hover {
        background: var(--vscode-list-hoverBackground) !important;
    }
`;
