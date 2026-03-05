// Shared utility for registering VS Code theme/icon-theme change listeners.
// Eliminates duplicated listener boilerplate across view providers and services.

import * as vscode from "vscode";

/**
 * Registers color theme and icon theme change listeners that invoke the
 * given callback. Returns an array of disposables that the caller must
 * manage (dispose when no longer needed).
 */
export function registerThemeChangeListeners(onThemeChange: () => void): vscode.Disposable[] {
    return [
        vscode.window.onDidChangeActiveColorTheme(() => onThemeChange()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (
                event.affectsConfiguration("workbench.iconTheme") ||
                event.affectsConfiguration("workbench.colorTheme")
            ) {
                onThemeChange();
            }
        }),
    ];
}

/**
 * Disposes all disposables in the array and clears it in-place.
 */
export function disposeAll(disposables: vscode.Disposable[]): void {
    for (const d of disposables) {
        d.dispose();
    }
    disposables.length = 0;
}
