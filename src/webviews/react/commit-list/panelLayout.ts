/** Keep the log usable when a previously wide window is narrowed.
 * The saved widths remain preferences and are restored as space becomes available. */
export function fitGraphPaneWidths(width: number, branch: number, info: number): { branch: number; info: number } {
    if (width <= 0) return { branch, info };
    const sideBudget = Math.max(0, width - Math.max(400, width / 2) - 8);
    const total = branch + info;
    if (total <= sideBudget) return { branch, info };
    const scale = sideBudget / Math.max(1, total);
    return { branch: Math.floor(branch * scale), info: Math.floor(info * scale) };
}
