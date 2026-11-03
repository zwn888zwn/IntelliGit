const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");
const { DiffOverlayController, showComparisonInOverlay } = require("./controller");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (predicate()) return;
        await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
}

exports.run = async () => {
    const workspace = path.join(process.env.INTELLIGIT_DIFF_TEST_ROOT, "workspace");
    const anchor = vscode.Uri.file(path.join(workspace, "anchor.txt"));
    const modified = vscode.Uri.file(path.join(workspace, "games.go"));
    const original = vscode.Uri.parse("diff-test:/games.go");
    await fs.writeFile(anchor.fsPath, "Return to this editor after reviewing.\n");
    await fs.writeFile(modified.fsPath, "package main\n// working tree\n");
    const provider = vscode.workspace.registerTextDocumentContentProvider("diff-test", {
        provideTextDocumentContent: () => "package main\n// committed version\n",
    });
    const controller = new DiffOverlayController();
    try {
        await vscode.window.showTextDocument(anchor, { preview: false });
        const main = vscode.window.tabGroups.activeTabGroup;
        const document = await vscode.workspace.openTextDocument(modified);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(modified, new vscode.Position(0, 0), "// unsaved work\n");
        assert(await vscode.workspace.applyEdit(edit));
        assert(document.isDirty);

        await vscode.commands.executeCommand("vscode.diff", original, modified, "Review first file");
        await until(() => vscode.window.tabGroups.all.some((group) =>
            group !== main && group.activeTab?.label === "Review first file"), "automatic overlay");
        await until(() => !main.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff), "remove original diff tab");
        assert(document.isDirty, "moving the editor must not save or discard edits");
        assert(document.getText().startsWith("// unsaved work\n"));
        assert(!String(await fs.readFile(modified.fsPath)).includes("unsaved work"));
        assert(await document.save());
        assert(String(await fs.readFile(modified.fsPath)).startsWith("// unsaved work\n"));

        await vscode.commands.executeCommand("workbench.action.closeModalEditor");
        await until(() => vscode.window.tabGroups.all.length === 1, "close overlay");
        assert.equal(main.activeTab.label, "anchor.txt");

        // A second diff must reopen normally rather than being suppressed by the
        // controller's loop guard after the first overlay was destroyed.
        await vscode.commands.executeCommand("vscode.diff", original, modified, "Review next file");
        await until(() => vscode.window.tabGroups.all.some((group) =>
            group !== main && group.activeTab?.label === "Review next file"), "second overlay");
        await until(() => !main.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff), "second source removal");
        await vscode.commands.executeCommand("workbench.action.moveModalEditorToMain");
        await delay(200);
        assert.equal(vscode.window.tabGroups.all.length, 1, "the native dock button must not bounce back into the modal");
        assert(main.activeTab.input instanceof vscode.TabInputTextDiff);
        await vscode.window.tabGroups.close(main.activeTab);

        await vscode.commands.executeCommand("vscode.diff", original, modified, "Open source test");
        await until(() => vscode.window.tabGroups.all.length === 2, "source test overlay");
        await until(() => !main.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff), "source test ready");
        await until(() => !controller.moving, "source test routing complete");
        await vscode.commands.executeCommand("workbench.action.compareEditor.focusPrimarySide");
        await until(() => vscode.window.activeTextEditor?.document.uri.toString() === modified.toString(), "modified side focused");
        const modifiedEditor = vscode.window.activeTextEditor;
        assert(modifiedEditor);
        modifiedEditor.selection = new vscode.Selection(1, 2, 1, 2);
        await delay(50);
        await vscode.commands.executeCommand("intelligit.openOverlaySource");
        await until(() => vscode.window.tabGroups.all.length === 1, "open source closes the overlay");
        assert(main.activeTab.input instanceof vscode.TabInputText);
        assert.equal(main.activeTab.input.uri.toString(), modified.toString());
        await until(() => vscode.window.activeTextEditor?.selection.active.line === 1, "source cursor restored");

        await vscode.window.showTextDocument(modified, { preview: false });
        await delay(100);
        assert.equal(vscode.window.tabGroups.all.length, 1, "ordinary files stay in the main editor");

        let panel;
        let dimensions;
        const listeners = [];
        const createPanel = () => {
            const previous = panel;
            panel = vscode.window.createWebviewPanel("diff-test.files", "Comparison files",
                { viewColumn: vscode.ViewColumn.One, preserveFocus: Boolean(previous) }, {
                    enableScripts: true, retainContextWhenHidden: true,
                });
            dimensions = undefined;
            listeners.push(panel.webview.onDidReceiveMessage((message) => { dimensions = message; }));
            panel.webview.html = `<html><body><input value="keep-filter"><script>
                const vscode = acquireVsCodeApi();
                const report = () => vscode.postMessage({width: innerWidth, height: innerHeight});
                window.addEventListener('message', report);
                window.addEventListener('resize', report);
                report();
            </script></body></html>`;
            previous?.dispose();
            return panel;
        };
        const comparison = await showComparisonInOverlay(createPanel(), createPanel);
        assert(comparison?.isActive(), `file tree must live in a modal group: ${JSON.stringify({
            panelType: panel.viewType, supported: controller.supported, moving: controller.moving,
            groups: vscode.window.tabGroups.all.map(group => ({ column: group.viewColumn,
                tabs: group.tabs.map(tab => ({ label: tab.label, input: tab.input })) })),
        })}`);
        await comparison.openDiff(original, modified, "Compare games");
        assert.equal(vscode.window.tabGroups.all.length, 3, "main editor plus two modal groups");
        assert(vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputWebview)));
        await until(() => dimensions?.height > 300, "webview fills its modal group instead of the unanchored 300x150 rectangle");

        const another = vscode.Uri.file(path.join(workspace, "another.go"));
        await fs.writeFile(another.fsPath, "package main\n// another file\n");
        await comparison.openDiff(original, another, "Compare another");
        assert.equal(vscode.window.tabGroups.all.length, 3, "switching files must reuse the right-hand group");
        assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.modified.toString(), another.toString());
        const unsaved = new vscode.WorkspaceEdit();
        unsaved.insert(another, new vscode.Position(0, 0), "// retain unsaved\n");
        await vscode.workspace.applyEdit(unsaved);
        await vscode.commands.executeCommand("intelligit.openOverlaySource");
        await until(() => vscode.window.tabGroups.all.length === 1, "hide comparison for source editing");
        assert.equal(main.activeTab.input.uri.toString(), another.toString());
        assert(vscode.window.activeTextEditor.document.isDirty, "jumping out must retain unsaved work");
        await vscode.commands.executeCommand("intelligit.returnToComparison");
        await until(() => vscode.window.tabGroups.all.length === 3, "restore comparison");
        assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.input.modified.toString(), another.toString());
        await panel.webview.postMessage({ report: true });
        await until(() => dimensions?.height > 300, "restored tree has valid modal geometry");
        assert(await (await vscode.workspace.openTextDocument(another)).save());
        await comparison.openChanges(() => vscode.commands.executeCommand("vscode.changes", "Compact comparison", [
            [modified, original, modified], [another, original, another],
        ]));
        await until(() => vscode.window.tabGroups.all.length === 3, "compact diff stays beside the file tree");
        assert(vscode.window.tabGroups.activeTabGroup.activeTab.label.startsWith("Compact comparison"));
        await until(() => dimensions?.height > 300, "compact diff preserves valid tree geometry");
        await comparison.openDiff(original, modified, "Compare games again");
        await comparison.openChanges(() => vscode.commands.executeCommand("vscode.changes", "Compact comparison", [
            [modified, original, modified], [another, original, another],
        ]));
        assert(vscode.window.tabGroups.activeTabGroup.activeTab.label.startsWith("Compact comparison"));
        assert.equal(vscode.window.tabGroups.all.length, 3);
        await until(() => dimensions?.height > 300, "repeated compact action preserves the tree");
        await vscode.commands.executeCommand("workbench.action.closeModalEditor");
        for (const listener of listeners) listener.dispose();
        await until(() => vscode.window.tabGroups.all.length === 1, "close comparison");

        await vscode.workspace.getConfiguration("workbench.editor").update("useModal", "off", true);
        await vscode.commands.executeCommand("vscode.diff", original, modified, "Modal disabled");
        await delay(100);
        assert.equal(vscode.window.tabGroups.all.length, 1);
        assert.equal(main.activeTab.input.modified.toString(), modified.toString());
        console.log("PASS: automatic overlay, dirty content, source jump, native docking, split comparison, switching files, retained tree, return to comparison, modal opt-out");
    } finally {
        controller.dispose();
        provider.dispose();
    }
};
