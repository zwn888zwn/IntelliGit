// Centralized theme colors for PyCharm's specific UI components
export const PYCHARM_THEME = {
    mergeEditor: {
        // Deep red for conflict changes
        conflictResultBg: "rgba(113, 22, 22, 0.65)",
        // Green for added/resolved changes
        addedResultBg: "rgba(56, 118, 66, 0.35)",
        // Left and Right pane background for conflict blocks
        conflictBlockBg: "rgba(116, 46, 53, 0.25)",
        conflictBlockAddedBg: "rgba(57, 127, 78, 0.2)",
        // Muted blue-gray for non-conflicting (one-side-only) changes
        nonConflictBlockBg: "rgba(47, 79, 130, 0.2)",
        nonConflictResultBg: "rgba(47, 79, 130, 0.35)",
    },
};
