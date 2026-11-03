// Native-host smoke test. Uses a disposable extension, workspace and VS Code profile.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { build } = require("esbuild");
const { runTests } = require("@vscode/test-electron");

async function main() {
    const executable = process.env.VSCODE_EXECUTABLE_PATH ||
        (process.platform === "darwin" ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code" : undefined);
    if (!executable) throw new Error("Set VSCODE_EXECUTABLE_PATH to the installed VS Code executable.");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "intelligit-diff-test-"));
    const extension = path.join(root, "extension");
    const workspace = path.join(root, "workspace");
    try {
        await fs.mkdir(extension);
        await fs.mkdir(workspace);
        await fs.mkdir(path.join(root, "data/User"), { recursive: true });
        await fs.writeFile(path.join(root, "data/User/settings.json"), JSON.stringify({
            "workbench.editor.useModal": "some",
            "workbench.startupEditor": "none",
            "telemetry.telemetryLevel": "off",
        }));
        await fs.writeFile(path.join(extension, "package.json"), JSON.stringify({
            name: "intelligit-diff-test", publisher: "local", version: "0.0.1",
            engines: { vscode: "^1.110.0" }, main: "controller.js",
            contributes: {
                commands: require("../package.json").contributes.commands.filter((command) =>
                    ["intelligit.openOverlaySource", "intelligit.returnToComparison"].includes(command.command)),
                menus: {
                    "modalEditor/editorTitle": require("../package.json").contributes.menus["modalEditor/editorTitle"],
                },
            },
        }));
        await build({
            entryPoints: [path.join(__dirname, "../src/services/DiffOverlayController.ts")],
            outfile: path.join(extension, "controller.js"),
            bundle: true, platform: "node", external: ["vscode"],
        });
        await fs.copyFile(path.join(__dirname, "../tests/native/diffOverlay.cjs"), path.join(extension, "test.js"));
        // Test Electron must start as a desktop app, not the parent CLI's Node mode.
        delete process.env.ELECTRON_RUN_AS_NODE;
        await runTests({
            vscodeExecutablePath: executable,
            extensionDevelopmentPath: extension,
            extensionTestsPath: path.join(extension, "test.js"),
            extensionTestsEnv: { INTELLIGIT_DIFF_TEST_ROOT: root },
            launchArgs: [workspace, `--user-data-dir=${path.join(root, "data")}`,
                `--extensions-dir=${path.join(root, "extensions")}`, "--disable-extensions", "--new-window"],
        });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
