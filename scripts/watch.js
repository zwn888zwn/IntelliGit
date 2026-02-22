/* eslint-env node */

// esbuild watch mode for development. Rebuilds on file changes for both
// the extension host and webview bundles.

const esbuild = require("esbuild");
const path = require("path");

const webviewConfigs = [
    { name: "commitgraph", entry: "../src/webviews/react/CommitGraphApp.tsx", out: "../dist/webview-commitgraph.js" },
    { name: "commitpanel", entry: "../src/webviews/react/commit-panel/CommitPanelApp.tsx", out: "../dist/webview-commitpanel.js" },
    { name: "commitinfo", entry: "../src/webviews/react/CommitInfoApp.tsx", out: "../dist/webview-commitinfo.js" },
    { name: "mergeeditor", entry: "../src/webviews/react/merge-editor/MergeEditorApp.tsx", out: "../dist/webview-mergeeditor.js" },
    {
        name: "mergeconflictsession",
        entry: "../src/webviews/react/merge-conflicts-session/MergeConflictSessionApp.tsx",
        out: "../dist/webview-mergeconflictsession.js",
    },
];

async function watch() {
    const extensionCtx = await esbuild.context({
        entryPoints: [path.resolve(__dirname, "../src/extension.ts")],
        bundle: true,
        outfile: path.resolve(__dirname, "../dist/extension.js"),
        external: ["vscode"],
        format: "cjs",
        platform: "node",
        target: "node20",
        sourcemap: true,
    });

    await extensionCtx.watch();
    console.log("Watching extension...");

    for (const webview of webviewConfigs) {
        const ctx = await esbuild.context({
            entryPoints: [path.resolve(__dirname, webview.entry)],
            bundle: true,
            outfile: path.resolve(__dirname, webview.out),
            format: "esm",
            platform: "browser",
            target: "es2022",
            sourcemap: true,
        });
        await ctx.watch();
        console.log(`Watching webview: ${webview.name}`);
    }
}

watch().catch((err) => {
    console.error(err);
    process.exit(1);
});
