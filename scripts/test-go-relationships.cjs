// Real gopls smoke test in a disposable VS Code profile. No user settings changed.
// Set INTELLIGIT_GO_EXTENSION, GOROOT and GOPLS_PATH for your installed Go tools.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { runTests } = require('@vscode/test-electron');

async function main() {
    const goExtension = process.env.INTELLIGIT_GO_EXTENSION;
    if (!goExtension) throw new Error('Set INTELLIGIT_GO_EXTENSION to the installed golang.go extension directory');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'intelligit-go-relations-'));
    try {
        const extension = path.join(root, 'extension');
        const workspace = path.join(root, 'project');
        const extensions = path.join(root, 'extensions');
        const settings = path.join(root, 'profile', 'User');
        for (const directory of [extension, workspace, extensions, settings]) await fs.mkdir(directory, { recursive: true });
        await fs.symlink(goExtension, path.join(extensions, 'golang.go'));
        await fs.writeFile(path.join(extension, 'package.json'), JSON.stringify({
            name: 'go-relations-test', publisher: 'intelligit-test', version: '0.0.1',
            engines: { vscode: '^1.96.0' }, main: './GoRelationshipDecorations.js', activationEvents: ['*'],
        }));
        for (const [entry, output] of [
            ['src/services/go/relationships.ts', 'relationships.js'],
            ['src/services/GoRelationshipDecorations.ts', 'GoRelationshipDecorations.js'],
        ]) await build({ entryPoints: [path.join(__dirname, '..', entry)], outfile: path.join(extension, output),
            bundle: true, platform: 'node', external: ['vscode'] });
        await fs.copyFile(path.join(__dirname, '../tests/native/goRelationships.cjs'), path.join(extension, 'test.cjs'));
        await fs.writeFile(path.join(settings, 'settings.json'), JSON.stringify({
            'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none',
            'go.goroot': process.env.GOROOT || '',
            'go.alternateTools': {
                ...(process.env.GOROOT ? { go: path.join(process.env.GOROOT, 'bin/go') } : {}),
                ...(process.env.GOPLS_PATH ? { gopls: process.env.GOPLS_PATH } : {}),
            },
            'go.toolsManagement.autoUpdate': false, 'go.toolsManagement.checkForUpdates': 'off',
            'go.showWelcome': false, 'editor.codeLens': true,
        }));
        delete process.env.ELECTRON_RUN_AS_NODE;
        await runTests({
            vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH || '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
            extensionDevelopmentPath: extension, extensionTestsPath: path.join(extension, 'test.cjs'),
            launchArgs: [workspace, `--user-data-dir=${path.join(root, 'profile')}`, `--extensions-dir=${extensions}`, '--new-window'],
        });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
