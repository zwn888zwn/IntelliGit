const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GoRelationshipQuery } = require('./relationships.js');
const { GoRelationshipDecorations } = require('./GoRelationshipDecorations.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    await fs.writeFile(path.join(root, 'go.mod'), 'module example.com/relations\n\ngo 1.20\n');
    await fs.writeFile(path.join(root, 'model.go'), `package relations

type Calculator interface {
    LoadData() error
    Calculate() int
    GetType() string
}
type Base struct{}
func (b *Base) LoadData() error { return nil }
func (b *Base) GetType() string { return "base" }
type Shared struct { Base }
func (s *Shared) Calculate() int { return 1 }
type Custom struct { Base }
func (c *Custom) LoadData() error { return c.Base.LoadData() }
func (c *Custom) Calculate() int { return 2 }
var _ Calculator = &Shared{}
var _ Calculator = &Custom{}
`);
    await fs.writeFile(path.join(root, 'extra.go'), `package relations
func (b *Base) Recursive(n int) int {
    if n <= 0 { return 0 }
    return b.Recursive(n-1)
}
type Middle struct { Base }
type Leaf struct { Middle }
func (l *Leaf) LoadData() error { return nil }
type Named struct { base Base }
func (n *Named) LoadData() error { return nil }
func Factorial(n int) int {
    if n <= 1 { return 1 }
    return n * Factorial(n-1)
}
func NotRecursive() any { return NotRecursive }
`);
    const document = await vscode.workspace.openTextDocument(path.join(root, 'model.go'));
    await vscode.window.showTextDocument(document);
    let query, declarations;
    for (let attempt = 0; attempt < 45; attempt++) {
        query = new GoRelationshipQuery(() => false);
        declarations = await query.declarations(document.uri);
        const target = declarations.find(item => item.symbol.name === 'Custom');
        if (target && (await query.relations(target)).some(item => item.kind === 'I↑')) break;
        await delay(1000);
    }
    const find = (items, name) => { const item = items.find(item => item.symbol.name === name); assert(item, name); return item; };
    const targets = async (item, kind) => (await query.relations(item)).find(item => item.kind === kind)?.targets ?? [];
    const iface = find(declarations, 'Calculator');
    assert.equal((await targets(iface, 'I↓')).length, 2);
    assert.equal((await targets(find(declarations, 'LoadData'), 'I↓')).length, 2, 'shared methods deduplicated');
    assert.equal((await targets(find(declarations, 'GetType'), 'I↓')).length, 1);
    const base = find(declarations, '(*Base).LoadData');
    assert.equal((await targets(base, 'O↓')).length, 2, 'direct and nested cross-file embeddings');
    assert.equal((await targets(find(declarations, '(*Custom).LoadData'), 'I↑')).length, 1);
    const extra = await vscode.workspace.openTextDocument(path.join(root, 'extra.go'));
    const others = await query.declarations(extra.uri);
    const leafTargets = await targets(find(others, '(*Leaf).LoadData'), 'O↑');
    assert.equal(leafTargets.length, 1);
    assert(leafTargets[0].range.contains(base.symbol.selectionRange.start));
    assert.equal((await targets(find(others, '(*Named).LoadData'), 'O↑')).length, 0, 'named fields are not embedded');
    assert.equal((await targets(find(others, 'Factorial'), 'recursive')).length, 1);
    assert.equal((await targets(find(others, '(*Base).Recursive'), 'recursive')).length, 1);
    assert.equal((await targets(find(others, 'NotRecursive'), 'recursive')).length, 0, 'a function value is not a call');
    const cancelled = new GoRelationshipQuery(() => true);
    assert.deepEqual(await cancelled.declarations(document.uri), []);
    const large = vscode.Uri.file(path.join(root, 'large.go'));
    await fs.writeFile(large.fsPath, 'package relations\n//' + 'x'.repeat(1024 * 1024));
    assert.deepEqual(await query.declarations(large), [], 'large files skipped before opening');
    assert(!vscode.workspace.textDocuments.some(doc => doc.uri.toString() === large.toString()));

    const provider = new GoRelationshipDecorations();
    try {
        const token = new vscode.CancellationTokenSource();
        let lenses = [];
        for (let attempt = 0; attempt < 15; attempt++) {
            lenses = await provider.provideCodeLenses(document, token.token);
            if (lenses.some(lens => lens.command.tooltip.includes('嵌入方法'))) break;
            await delay(300);
        }
        assert(lenses.some(lens => lens.command.tooltip.includes('嵌入方法')), 'visible direct-click command');
        const lens = lenses.find(lens => lens.command.tooltip.includes('嵌入方法'));
        assert.equal(lens.command.command, 'editor.action.peekLocations');
        assert(lenses.every(item => /^\$\(intelligit-[a-z]+\)$/.test(item.command.title)), 'all relationship lenses show only icons');
        assert.equal(lens.command.title, '$(intelligit-overriding)');
        assert(lenses.some(item => item.command.title === '$(intelligit-overridden)'), 'up and down are separate icons');
        assert(lenses.every(item => /：(?:至少 )?\d+ 处/.test(item.command.tooltip)), 'hover contains name and count');
        const hints = await provider.provideInlayHints(document, new vscode.Range(0, 0, document.lineCount, 0), token.token);
        const implementationHint = hints.find(hint => hint.position.line === iface.symbol.selectionRange.start.line);
        assert(implementationHint);
        assert.equal(implementationHint.label[0].value, '2 implementations');
        assert.equal(implementationHint.position.character, document.lineAt(implementationHint.position.line).range.end.character);
        const methodHint = hints.find(hint => hint.position.line === find(declarations, 'LoadData').symbol.selectionRange.start.line);
        assert.equal(methodHint.label[0].value, '2 implementations', 'method count remains deduplicated');
        assert(!hints.some(hint => hint.position.line === base.symbol.selectionRange.start.line), 'no count on override methods');
        assert.equal(methodHint.label[0].command.command, 'editor.action.peekLocations');
        assert.equal(methodHint.label[0].command.arguments[2].length, 2);
        assert(!lenses.some(item => item.command.title === '$(intelligit-implemented)'), 'lone redundant implementation icon is hidden');
        assert(lenses.some(item => item.command.title === '$(intelligit-implementing)'), 'nonredundant icons remain');
        await vscode.workspace.getConfiguration('editor', document.uri).update('inlayHints.enabled', 'off', vscode.ConfigurationTarget.Workspace);
        const fallback = await provider.provideCodeLenses(document, token.token);
        assert(fallback.some(item => item.command.title === '$(intelligit-implemented)'), 'keep navigation when counts are hidden');
        await vscode.workspace.getConfiguration('editor', document.uri).update('inlayHints.enabled', 'on', vscode.ConfigurationTarget.Workspace);
        const edits = new vscode.WorkspaceEdit();
        const custom = find(declarations, '(*Custom).LoadData');
        edits.replace(document.uri, custom.symbol.selectionRange, 'LoadOther');
        assert(await vscode.workspace.applyEdit(edits));
        assert(!((await provider.provideCodeLenses(document, token.token)) || []).some(lens =>
            lens.range.start.line === custom.symbol.selectionRange.start.line && lens.command.tooltip.includes('嵌入方法')),
        'editing immediately drops stale navigation');
        token.dispose();
    } finally { provider.dispose(); }
    console.log('GO_RELATIONSHIPS_OK: interfaces, shared methods, cross-file/nested embedding, named-field exclusion, recursion, cancellation, large files and edit invalidation');
};
