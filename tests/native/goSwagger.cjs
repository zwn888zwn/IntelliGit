const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { GoSwaggerDefinitionProvider } = require('./provider.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    if (!process.env.INTELLIGIT_SWAGGER_SOURCE) {
        const files = {
            'go.mod': 'module example.com/swagger\n\ngo 1.22\n',
            'service/models.go': 'package service\ntype Response struct { Name string }\ntype Request struct {}\ntype Alias = Response\ntype Name string\n',
            'other/models.go': 'package other\ntype Response struct {}\n',
            'client_model/models.go': 'package client_model\ntype Envelope struct { Data any }\n',
            'model/v2/models.go': 'package customname\ntype Payload struct {}\n',
            'controller/api.go': `package controller
import (
    svc "example.com/swagger/service"
    _ "example.com/swagger/client_model"
    _ "example.com/swagger/model/v2"
)
var _ svc.Request
type Local struct{}
// @Param data body svc.Request true "request"
// @Success 200 {object} client_model.Envelope{data=[]svc.Response}
// @Failure 400 {object} customname.Payload
// @Response 200 {object} svc.Alias
// @Response 200 {object} svc.Name
// @Response 200 {object} Local
// @Response 200 {object} missing.Response
// @Description svc.Response is documentation
func API() {}
`,
        };
        for (const [name, content] of Object.entries(files)) {
            await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
            await fs.writeFile(path.join(root, name), content);
        }
    }
    const file = process.env.INTELLIGIT_SWAGGER_SOURCE || path.join(root, 'controller/api.go');
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await vscode.extensions.getExtension('golang.go').activate();
    const provider = new GoSwaggerDefinitionProvider();
    const registration = vscode.languages.registerDefinitionProvider({ language: 'go', scheme: 'file' }, provider);
    const token = new vscode.CancellationTokenSource();
    const query = async (text, targetFile, targetName) => {
        const offset = doc.getText().indexOf(text);
        assert(offset >= 0, text);
        const position = doc.positionAt(offset + text.length - 2);
        let links = [];
        for (let attempt = 0; attempt < 60; attempt++) {
            links = await provider.provideDefinition(doc, position, token.token);
            if (links.length) break;
            await delay(1000);
        }
        assert.equal(links.length, 1, text + ' resolves exactly once');
        assert(links[0].targetUri.fsPath.endsWith(targetFile), JSON.stringify(links));
        const target = await vscode.workspace.openTextDocument(links[0].targetUri);
        assert.equal(target.getText(links[0].targetSelectionRange), targetName);
        assert(links[0].originSelectionRange.contains(position), 'native underline covers the clicked reference');
        const native = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, position);
        assert(native.length > 0, 'registered definition command returns targets');
        console.log('Native targets:', JSON.stringify(native));
        console.log('PASS:', text, '->', links[0].targetUri.fsPath, links[0].targetSelectionRange.start.line + 1);
        return { position, links };
    };
    try {
        if (process.env.INTELLIGIT_SWAGGER_SOURCE) {
            const { position } = await query('data=service.SolveRespV161', '/service/solve_model_v161.go', 'SolveRespV161');
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(position, position);
            await vscode.commands.executeCommand('editor.action.revealDefinition');
            for (let i = 0; i < 40 && !vscode.window.activeTextEditor?.document.uri.fsPath.endsWith('/service/solve_model_v161.go'); i++) await delay(100);
            console.log('Active after F12:', vscode.window.activeTextEditor?.document.uri.toString());
            assert(vscode.window.activeTextEditor.document.uri.fsPath.endsWith('/service/solve_model_v161.go'), 'F12 opens real target');
            await query('client_model.SuccessResponse', '/client_model/model.go', 'SuccessResponse');
            await query('service.SolveReqV143', '/service/solve_model.go', 'SolveReqV143');
        } else {
            await query('data=[]svc.Response', '/service/models.go', 'Response');
            await query('client_model.Envelope', '/client_model/models.go', 'Envelope');
            await query('body svc.Request', '/service/models.go', 'Request');
            await query('customname.Payload', '/model/v2/models.go', 'Payload');
            await query('svc.Alias', '/service/models.go', 'Alias');
            await query('svc.Name', '/service/models.go', 'Name');
            await query('{object} Local', '/controller/api.go', 'Local');
            for (const text of ['missing.Response', '@Description svc.Response']) {
                const offset = doc.getText().indexOf(text) + text.length - 2;
                assert.deepEqual(await provider.provideDefinition(doc, doc.positionAt(offset), token.token), []);
            }
            token.cancel();
            assert.deepEqual(await provider.provideDefinition(doc, doc.positionAt(doc.getText().indexOf('svc.Alias') + 6), token.token), []);
        }
    } finally { registration.dispose(); token.dispose(); }
};
