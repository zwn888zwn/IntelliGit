import * as vscode from "vscode";
import * as path from "path";

const OPEN_DIFF = "_workbench.diff";
const MODAL_GROUP = -4;
let activeController: DiffOverlayController | undefined;

export interface ComparisonOverlay {
    isActive(): boolean;
    openDiff(original: vscode.Uri, modified: vscode.Uri, title: string): Promise<void>;
    openChanges(open: () => Promise<void>): Promise<void>;
}

interface ComparisonSession {
    panel: vscode.WebviewPanel;
    recreatePanel: () => vscode.WebviewPanel;
    replacing?: boolean;
    left: vscode.TabGroup;
    right: vscode.TabGroup;
    main: vscode.TabGroup;
    lastDiff?: { original: vscode.Uri; modified: vscode.Uri; title: string };
    selection?: vscode.Selection;
    visibleRange?: vscode.Range;
    dockedDiff?: vscode.Tab;
}

/** Open directly in the modal, including custom diff editors with opaque tab inputs. */
export async function openCommitPanelDiff(original: vscode.Uri, modified: vscode.Uri, title: string,
    source: vscode.Uri, useNativeViewer = false): Promise<void> {
    if (await activeController?.openPanelDiff(original, modified, title, source, useNativeViewer)) return;
    await vscode.commands.executeCommand("vscode.diff", original, modified, title);
}

/** Creates the comparison webview after its modal anchor exists. */
export async function showComparisonInOverlay(
    panel: vscode.WebviewPanel,
    recreatePanel: () => vscode.WebviewPanel,
): Promise<ComparisonOverlay | undefined> {
    return activeController?.showComparison(panel, recreatePanel);
}

/** Keeps native file diffs in a large overlay owned by the current project window. */
export class DiffOverlayController implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[];
    private readonly handled = new WeakSet<vscode.Tab>();
    private readonly panelSources = new WeakMap<vscode.Tab, vscode.Uri>();
    private panelSourceVisible = false;
    private panelQueue: Promise<unknown> = Promise.resolve();
    private modalGroup: vscode.TabGroup | undefined;
    private modalInputs: Array<vscode.TabInputTextDiff | vscode.TabInputNotebookDiff> = [];
    private mainGroup: vscode.TabGroup | undefined;
    private supported = false;
    private moving = false;
    private disposed = false;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private readonly ready: Promise<void>;
    private readonly comparisons = new Map<vscode.WebviewPanel, ComparisonSession>();
    private returnSession: ComparisonSession | undefined;

    constructor() {
        // This extension host has one controller; comparison panels share it.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        activeController = this;
        this.subscriptions = [
            vscode.window.tabGroups.onDidChangeTabs((event) => {
                // Moving an editor out of the modal creates a new Tab object.
                // Respect that explicit placement instead of immediately reopening it.
                if (this.modalGroup && !this.moving) {
                    for (const tab of event.opened) {
                        if (tab.group !== this.modalGroup && this.modalInputs.some((input) => sameDiff(tab.input, input))) {
                            this.handled.add(tab);
                        }
                    }
                }
                this.schedule();
            }),
            vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
            vscode.commands.registerCommand("intelligit.openOverlaySource", () => this.openSource()),
            vscode.commands.registerCommand("intelligit.returnToComparison", () => this.returnToComparison()),
            vscode.workspace.onDidChangeConfiguration((event) => {
                if (event.affectsConfiguration("intelligit.diff.openInOverlay") ||
                    event.affectsConfiguration("workbench.editor.useModal")) this.schedule();
            }),
        ];
        // Modal groups are not part of the public extension API. Check the host's
        // modal commands before using the internal diff command; older hosts keep
        // their normal editor behavior. Never change the user's useModal setting.
        this.ready = Promise.resolve(vscode.commands.getCommands(true)).then((commands) => {
            this.supported = commands.includes("workbench.action.closeModalEditor");
            this.schedule();
        }, () => {});
    }

    dispose(): void {
        this.disposed = true;
        if (activeController === this) activeController = undefined;
        if (this.timer) clearTimeout(this.timer);
        for (const subscription of this.subscriptions) subscription.dispose();
        this.comparisons.clear();
    }

    private schedule(): void {
        this.updatePanelSourceContext();
        if (this.disposed || this.moving || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.openActiveDiff();
        }, 0);
    }

    async showComparison(panel: vscode.WebviewPanel, recreatePanel: () => vscode.WebviewPanel): Promise<ComparisonOverlay | undefined> {
        await this.ready;
        if (!this.enabled() || this.moving) return;
        const groups = vscode.window.tabGroups;
        const before = new Set(groups.all);
        let session = this.comparisons.get(panel);
        this.moving = true;
        try {
            const placeholderUri = (await vscode.workspace.openTextDocument({ content: "" })).uri;
            // A webview overlay created before the modal cannot resolve the CSS
            // anchor inside that later DOM subtree (VS Code 1.144). Build the modal
            // first, then recreate the webview so its overlay follows its anchor.
            await vscode.commands.executeCommand("_workbench.open", placeholderUri, [MODAL_GROUP, {
                preserveFocus: true, inactive: true,
            }]);
            const left = groups.all.find((group) => !before.has(group));
            const placeholder = left?.tabs.find((tab) => tab.input instanceof vscode.TabInputText &&
                tab.input.uri.toString() === placeholderUri.toString());
            if (!left || !placeholder) return;
            const previousPanel = panel;
            const previousTabs = new Set(groups.all.flatMap((group) => group.tabs));
            if (session) session.replacing = true;
            try {
                panel = recreatePanel();
                await waitForPanelTab(panel, previousTabs);
            } finally {
                if (session) session.replacing = false;
            }
            this.comparisons.delete(previousPanel);
            const source = groups.all.find((group) => group.viewColumn === panel.viewColumn);
            if (!source || !isPanelTab(source.activeTab, panel)) {
                await groups.close(placeholder, true);
                return;
            }
            await focusGroup(source);
            await vscode.commands.executeCommand("moveActiveEditor", {
                to: "position", by: "group", value: left.viewColumn,
            });
            if (!left.tabs.some((tab) => isPanelTab(tab, panel))) {
                await groups.close(placeholder, true);
                return;
            }
            await groups.close(placeholder, true);
            await focusGroup(left);
            await vscode.commands.executeCommand("workbench.action.newGroupRight");
            const right = groups.all.find((group) => !before.has(group) && group !== left);
            if (!right) return;
            await vscode.commands.executeCommand("vscode.setEditorLayout", {
                orientation: 0, groups: [{ size: 0.23 }, { size: 0.77 }],
            });
            this.mainGroup = source;
            this.modalGroup = right;
            this.modalInputs = [];
            if (session) {
                Object.assign(session, { panel, left, right, main: source });
            } else {
                session = { panel, recreatePanel, left, right, main: source };
            }
            this.comparisons.set(panel, session);
            const current = session;
            const ownedPanel = panel;
            this.subscriptions.push(panel.onDidDispose(() => {
                if (current.replacing) return;
                this.comparisons.delete(ownedPanel);
                if (this.returnSession === current) {
                    this.returnSession = undefined;
                    void vscode.commands.executeCommand("setContext", "intelligit.canReturnToComparison", false);
                }
            }));
            const isActive = () => groups.all.includes(current.left) && groups.all.includes(current.right);
            return {
                isActive,
                openChanges: async (open) => {
                    if (!isActive()) {
                        await open();
                        return;
                    }
                    // vscode.changes has no placement argument and closes a modal.
                    // Dock first to retain the session, then move its native editor
                    // into the new right-hand group after rebuilding the tree.
                    await vscode.commands.executeCommand("workbench.action.moveModalEditorToMain");
                    await open();
                    const compact = await waitForNewTab(new Set(), (tab) => {
                        const input = tab.input as { textDiffs?: unknown } | undefined;
                        return tab.isActive && tab.group.isActive && Array.isArray(input?.textDiffs);
                    });
                    current.panel.reveal(compact.group.viewColumn, false);
                    const restored = await this.showComparison(current.panel, current.recreatePanel);
                    if (!restored?.isActive()) return;
                    await focusGroup(compact.group);
                    await vscode.commands.executeCommand("moveActiveEditor", {
                        to: "position", by: "group", value: current.right.viewColumn,
                    });
                    await focusGroup(current.right);
                },
                openDiff: async (original, modified, title) => {
                    this.moving = true;
                    try {
                        if (isActive()) {
                            await focusGroup(current.right);
                            await vscode.commands.executeCommand(OPEN_DIFF, original, modified, title, [
                                MODAL_GROUP, { pinned: false },
                            ]);
                            this.modalGroup = current.right;
                            this.modalInputs = current.right.tabs.flatMap((tab) =>
                                tab.input instanceof vscode.TabInputTextDiff || tab.input instanceof vscode.TabInputNotebookDiff
                                    ? [tab.input] : []);
                        } else {
                            // The user explicitly docked the comparison. Keep this
                            // session there instead of fighting the native button.
                            await vscode.commands.executeCommand("vscode.diff", original, modified, title, { preview: true });
                        }
                        const tab = groups.activeTabGroup.activeTab;
                        if (tab) this.handled.add(tab);
                        current.lastDiff = { original, modified, title };
                    } finally {
                        this.moving = false;
                        this.schedule();
                    }
                },
            };
        } catch (error) {
            console.warn("IntelliGit: could not open the comparison overlay", error);
            return;
        } finally {
            this.moving = false;
            this.schedule();
        }
    }

    private updatePanelSourceContext(): void {
        const group = this.modalGroup;
        const tab = group && vscode.window.tabGroups.all.includes(group) ? group.activeTab : undefined;
        const visible = !!tab && this.panelSources.has(tab);
        if (visible !== this.panelSourceVisible) {
            this.panelSourceVisible = visible;
            void vscode.commands.executeCommand("setContext", "intelligit.panelDiffHasSource", visible);
        }
    }

    openPanelDiff(original: vscode.Uri, modified: vscode.Uri, title: string,
        source: vscode.Uri, useNativeViewer: boolean): Promise<boolean> {
        const pending = this.panelQueue.then(() => this.openPanelTab(original, modified, title, source, useNativeViewer));
        this.panelQueue = pending.catch(() => {});
        return pending;
    }

    private async openPanelTab(original: vscode.Uri, modified: vscode.Uri, title: string,
        source: vscode.Uri, useNativeViewer: boolean): Promise<boolean> {
        await this.ready;
        if (!this.enabled()) return false;
        const groups = vscode.window.tabGroups;
        const main = groups.activeTabGroup;
        const previousGroups = new Set(groups.all);
        const expected = new vscode.TabInputTextDiff(original, modified);
        this.moving = true;
        try {
            await vscode.commands.executeCommand(OPEN_DIFF, original, modified, title, [
                MODAL_GROUP, useNativeViewer ? { pinned: true } : { pinned: true, override: "default" },
            ]);
        } catch (error) {
            this.moving = false;
            console.warn("IntelliGit: could not open diff in overlay", error);
            return false;
        }
        try {
            const tab = await waitForNewTab(new Set(), candidate =>
                (candidate.group === this.modalGroup || !previousGroups.has(candidate.group)) &&
                (sameDiff(candidate.input, expected) || (useNativeViewer && candidate.label === title)));
            if (main !== this.modalGroup) this.mainGroup = main;
            this.modalGroup = tab.group;
            this.modalInputs = [expected];
            this.handled.add(tab);
            this.panelSources.set(tab, source);
            return true;
        } finally {
            this.moving = false;
            this.schedule();
        }
    }

    private enabled(): boolean {
        return !this.disposed && this.supported &&
            vscode.workspace.getConfiguration("intelligit").get("diff.openInOverlay", true) &&
            vscode.workspace.getConfiguration("workbench.editor").get("useModal") !== "off";
    }

    private async openActiveDiff(): Promise<void> {
        if (!this.enabled() || this.moving) return;

        const groups = vscode.window.tabGroups;
        if (this.modalGroup && !groups.all.includes(this.modalGroup)) {
            this.modalGroup = undefined;
            this.modalInputs = [];
        }
        const source = groups.activeTabGroup.activeTab;
        if (!source || source.group === this.modalGroup || this.handled.has(source)) return;
        const input = source.input;
        if (!(input instanceof vscode.TabInputTextDiff) &&
            !(input instanceof vscode.TabInputNotebookDiff)) return;

        const existingGroups = new Set(groups.all);
        this.handled.add(source);
        this.mainGroup = source.group;
        this.moving = true;
        try {
            // Leave size, position and maximization to the native modal defaults.
            // Keep the original URIs and shared dirty documents/undo history.
            await vscode.commands.executeCommand(OPEN_DIFF, input.original, input.modified, source.label, [
                MODAL_GROUP,
                { pinned: true },
            ]);
            if (this.disposed) return;
            // The open command can resolve before the extension host sees the new
            // tab group. Wait for the actual diff before removing the original.
            const target = await waitForNewTab(new Set(), candidate =>
                (candidate.group === this.modalGroup || !existingGroups.has(candidate.group)) &&
                sameDiff(candidate.input, input));
            if (this.disposed) return;
            this.modalGroup = target.group;
            this.modalInputs = [input];
            this.handled.add(target);
            // Close the old tab only after the same diff exists in the overlay.
            // VS Code retains the shared dirty document and its undo history.
            if (sameDiff(source.input, input) && groups.all.some((group) => group.tabs.includes(source))) {
                await groups.close(source, true);
            }
        } catch (error) {
            // Preserve the original diff if an internal host command changes.
            console.warn("IntelliGit: could not open the diff overlay", error);
        } finally {
            this.moving = false;
            this.schedule();
        }
    }

    private async openSource(): Promise<void> {
        const groups = vscode.window.tabGroups;
        // A modal title action belongs to the modal even if VS Code still
        // reports the editor behind it as the globally active group.
        const group = this.modalGroup && groups.all.includes(this.modalGroup)
            ? this.modalGroup : groups.activeTabGroup;
        const tab = group.activeTab;
        if (!tab) return;
        const panelSource = this.panelSources.get(tab);
        const input = tab.input instanceof vscode.TabInputTextDiff ? tab.input : undefined;
        if (!input && !panelSource) return;
        const source = panelSource ?? (input && (workingFileUri(input.modified) ?? workingFileUri(input.original)));
        if (!source) {
            void vscode.window.showWarningMessage("无法定位这个 Diff 对应的工作区文件。");
            return;
        }
        const editor = input && findModifiedEditor(input.modified, tab.group);
        const historyLine = input?.modified.scheme === "intelligit-diff"
            ? Number(new URLSearchParams(input.modified.query).get("sourceLine")) : 0;
        const selection = Number.isInteger(historyLine) && historyLine > 0
            ? new vscode.Selection(historyLine - 1, 0, historyLine - 1, 0) : editor?.selection;
        try {
            await vscode.workspace.fs.stat(source);
            const document = panelSource ? undefined : await vscode.workspace.openTextDocument(source);
            if (this.disposed || !groups.all.includes(group) || group.activeTab !== tab) return;
            const session = [...this.comparisons.values()].find((value) => value.right === tab.group);
            const destination = this.mainGroup && groups.all.includes(this.mainGroup)
                ? this.mainGroup : groups.all.find((group) => group !== tab.group);
            // Open the real document before closing the diff, so dirty edits remain
            // referenced and VS Code does not need to prompt to close that document.
            const options: vscode.TextDocumentShowOptions = {
                viewColumn: destination?.viewColumn ?? vscode.ViewColumn.One,
                preview: false,
                selection: document && selection ? document.validateRange(selection) : selection,
            };
            const openFile = async (preserveFocus: boolean) => {
                const target = { ...options, preserveFocus };
                if (document?.languageId === "markdown" || /\.(md|markdown|mdown|mkd|mkdn|mdwn|markdn|mdtxt|mdtext|copilotmd)$/i.test(source.path)) {
                    await vscode.commands.executeCommand("vscode.openWith", source, "vscode.markdown.preview.editor", target);
                } else if (document) {
                    const opened = await vscode.window.showTextDocument(document, target);
                    if (!preserveFocus && target.selection) {
                        opened.selection = new vscode.Selection(target.selection.start, target.selection.end);
                        opened.revealRange(target.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                    }
                } else {
                    await vscode.commands.executeCommand("vscode.open", source, target);
                }
            };
            await openFile(true);
            if (groups.all.includes(tab.group) && tab.group === this.modalGroup) {
                if (session && input) {
                    session.selection = selection;
                    session.visibleRange = editor?.visibleRanges[0];
                    // Dock the live webview and diff without disposing either.
                    // The file tree keeps its filter, expansion and selection state.
                    await vscode.commands.executeCommand("workbench.action.moveModalEditorToMain");
                    session.dockedDiff = groups.all.flatMap((group) => group.tabs)
                        .find((candidate) => sameDiff(candidate.input, input));
                    this.returnSession = session;
                    await vscode.commands.executeCommand("setContext", "intelligit.canReturnToComparison", true);
                } else {
                    await vscode.commands.executeCommand("workbench.action.closeModalEditor");
                }
            }
            await openFile(false);
        } catch {
            void vscode.window.showWarningMessage(`无法打开工作区文件：${source.fsPath}`);
        }
    }

    private async returnToComparison(): Promise<void> {
        const session = this.returnSession;
        if (!session || this.disposed || !this.comparisons.has(session.panel)) return;
        session.panel.reveal(session.main.viewColumn, false);
        const overlay = await this.showComparison(session.panel, session.recreatePanel);
        if (!overlay || !session.lastDiff) return;
        const { original, modified, title } = session.lastDiff;
        await overlay.openDiff(original, modified, title);
        const editor = findModifiedEditor(modified, session.right);
        if (editor) {
            if (session.selection) editor.selection = new vscode.Selection(
                editor.document.validatePosition(session.selection.anchor),
                editor.document.validatePosition(session.selection.active),
            );
            if (session.visibleRange) editor.revealRange(
                editor.document.validateRange(session.visibleRange), vscode.TextEditorRevealType.AtTop,
            );
        }
        const docked = session.dockedDiff;
        if (docked && sameDiff(docked.input, new vscode.TabInputTextDiff(original, modified)) &&
            vscode.window.tabGroups.all.some((group) => group.tabs.includes(docked))) {
            await vscode.window.tabGroups.close(docked, true);
        }
        session.dockedDiff = undefined;
        this.returnSession = undefined;
        await vscode.commands.executeCommand("setContext", "intelligit.canReturnToComparison", false);
    }
}

async function focusGroup(group: vscode.TabGroup): Promise<void> {
    const names = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth"];
    const ordinal = names[group.viewColumn - 1];
    if (!ordinal) throw new Error("Editor group is outside VS Code's addressable columns");
    await vscode.commands.executeCommand(`workbench.action.focus${ordinal}EditorGroup`);
}

function isPanelTab(tab: vscode.Tab | undefined, panel: vscode.WebviewPanel): boolean {
    return tab?.input instanceof vscode.TabInputWebview && tab.label === panel.title &&
        (tab.input.viewType === panel.viewType || tab.input.viewType === `mainThreadWebview-${panel.viewType}`);
}

function waitForPanelTab(panel: vscode.WebviewPanel, previous: Set<vscode.Tab>): Promise<void> {
    return waitForNewTab(previous, (tab) => isPanelTab(tab, panel)).then(() => {});
}

function waitForNewTab(previous: Set<vscode.Tab>, matches: (tab: vscode.Tab) => boolean): Promise<vscode.Tab> {
    const find = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .find((tab) => !previous.has(tab) && matches(tab));
    const existing = find();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const listener = vscode.window.tabGroups.onDidChangeTabs(() => {
            const tab = find();
            if (!tab) return;
            clearTimeout(timer);
            listener.dispose();
            resolve(tab);
        });
        const timer = setTimeout(() => {
            listener.dispose();
            reject(new Error("Comparison editor did not open"));
        }, 5000);
    });
}

function findModifiedEditor(uri: vscode.Uri, group: vscode.TabGroup): vscode.TextEditor | undefined {
    const matches = (editor: vscode.TextEditor | undefined) => editor?.document.uri.toString() === uri.toString();
    const exact = vscode.window.visibleTextEditors.find((editor) => matches(editor) && editor.viewColumn === group.viewColumn);
    if (exact) return exact;
    // VS Code may omit viewColumn for a side of a composite diff editor.
    // Prefer the focused side over another visible copy of the same document.
    const active = vscode.window.activeTextEditor;
    if (matches(active)) return active;
    return vscode.window.visibleTextEditors.find((editor) => matches(editor) && editor.viewColumn === undefined);
}

function workingFileUri(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme === "file" || uri.scheme === "vscode-remote") return uri;
    try {
        const filePath: unknown = uri.scheme === "git" ? JSON.parse(uri.query).path :
            uri.scheme === "intelligit-diff" || uri.scheme === "intelligit-diff-editable"
                ? new URLSearchParams(uri.query).get("sourceFsPath") : undefined;
        if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return;
        return uri.authority
            ? uri.with({ scheme: "vscode-remote", path: filePath, query: "", fragment: "" })
            : vscode.Uri.file(filePath);
    } catch {
        return;
    }
}

function sameDiff(input: unknown, expected: vscode.TabInputTextDiff | vscode.TabInputNotebookDiff): boolean {
    return (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) &&
        input.original.toString() === expected.original.toString() &&
        input.modified.toString() === expected.modified.toString();
}
