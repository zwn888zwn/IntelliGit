// Shared material for custom menus. Keep an opaque fallback for hosts without
// backdrop filters and for high-contrast / reduced-transparency preferences.
export const MENU_SURFACE_CSS = `
    .intelligit-menu-surface {
        --intelligit-menu-tint: var(--vscode-menu-background, #303033);
        background: var(--intelligit-menu-tint);
        color: var(--vscode-menu-foreground, #d8dbe2);
        border: 1px solid var(--vscode-menu-border, color-mix(in srgb, var(--vscode-menu-foreground, #fff) 18%, transparent));
        border-radius: 12px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.07);
    }
    .intelligit-menu-search-header {
        background: var(--intelligit-menu-tint);
        border-radius: 7px 7px 0 0;
    }
    @supports (backdrop-filter: blur(1px)) {
        .intelligit-menu-surface {
            --intelligit-menu-tint: color-mix(in srgb, var(--vscode-menu-background, #303033) 68%, transparent);
            backdrop-filter: blur(16px) saturate(135%);
        }
        .intelligit-menu-search-header {
            backdrop-filter: blur(20px);
        }
    }
    @media (prefers-reduced-transparency: reduce) {
        .intelligit-menu-surface {
            --intelligit-menu-tint: var(--vscode-menu-background, #303033);
            backdrop-filter: none;
        }
        .intelligit-menu-search-header { backdrop-filter: none; }
    }
    body.vscode-high-contrast .intelligit-menu-surface,
    body.vscode-high-contrast-light .intelligit-menu-surface {
        --intelligit-menu-tint: var(--vscode-menu-background, var(--vscode-editor-background));
        backdrop-filter: none;
        border-color: var(--vscode-contrastBorder, var(--vscode-menu-foreground));
        box-shadow: none;
    }
    body.vscode-high-contrast .intelligit-menu-search-header,
    body.vscode-high-contrast-light .intelligit-menu-search-header { backdrop-filter: none; }
`;
