const WEBVIEW_CONFIGS = [
    { entry: "react/json-preview/JsonPreviewApp", out: "webview-jsonpreview" },
    { entry: "react/selection-history/SelectionHistoryApp", out: "webview-selectionhistory" },
    { entry: "react/CommitGraphApp", out: "webview-commitgraph" },
    { entry: "react/commit-panel/CommitPanelApp", out: "webview-commitpanel" },
    { entry: "react/CommitInfoApp", out: "webview-commitinfo" },
    { entry: "react/project-comparison/ProjectComparisonApp", out: "webview-projectcomparison" },
    { entry: "react/merge-editor/MergeEditorApp", out: "webview-mergeeditor" },
    {
        entry: "react/merge-conflicts-session/MergeConflictSessionApp",
        out: "webview-mergeconflictsession",
    },
];

module.exports = { WEBVIEW_CONFIGS };
