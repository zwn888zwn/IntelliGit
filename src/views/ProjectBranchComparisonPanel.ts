import * as vscode from "vscode";
import type { ProjectComparisonFile } from "../types";
import type { RepositoryEntry } from "../services/RepositoryContextService";
import { openBranchComparisonFileDiff } from "../services/diffService";
import { getErrorMessage } from "../utils/errors";
import { buildWebviewShellHtml } from "./webviewHtml";
import { IconThemeService } from "./shared";
import type {
    ProjectComparisonInbound,
    ProjectComparisonOutbound,
} from "../webviews/react/project-comparison/types";

export class ProjectBranchComparisonPanel implements vscode.Disposable {
    static readonly viewType = "intelligit.projectBranchComparison";

    private readonly panel: vscode.WebviewPanel;
    private readonly iconTheme: IconThemeService;
    private files: ProjectComparisonFile[] = [];
    private disposed = false;

    static open(
        extensionUri: vscode.Uri,
        repository: RepositoryEntry,
        branchName: string,
    ): ProjectBranchComparisonPanel {
        return new ProjectBranchComparisonPanel(extensionUri, repository, branchName);
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly repository: RepositoryEntry,
        private readonly branchName: string,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            ProjectBranchComparisonPanel.viewType,
            `Difference Between ${branchName} and Current`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
            },
        );
        this.iconTheme = new IconThemeService(extensionUri);
        this.iconTheme.attachWebview(this.panel.webview);

        this.panel.webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message).catch((error) => {
                const text = getErrorMessage(error);
                vscode.window.showErrorMessage(text);
                this.post({ type: "error", message: text });
            });
        });
        this.panel.onDidDispose(() => this.dispose());
        this.panel.webview.html = this.getHtml();
        void this.refresh();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.iconTheme.dispose();
    }

    private async refresh(): Promise<void> {
        this.post({ type: "refreshing", active: true });
        try {
            await this.iconTheme.initIconThemeData();
            const files = await this.iconTheme.decorateProjectComparisonFiles(
                await this.repository.gitOps.getBranchComparisonFiles(this.branchName),
            );
            const folderIconsByName =
                await this.iconTheme.getFolderIconsByProjectComparisonFiles(files);
            const { folderIcons, iconFonts } = this.iconTheme.getThemeData();
            this.files = files;
            this.post({
                type: "update",
                branchName: this.branchName,
                repository: this.repository.info,
                files,
                folderIcon: folderIcons.folderIcon,
                folderExpandedIcon: folderIcons.folderExpandedIcon,
                folderIconsByName,
                iconFonts,
            });
        } finally {
            this.post({ type: "refreshing", active: false });
        }
    }

    private async handleMessage(message: ProjectComparisonOutbound): Promise<void> {
        switch (message.type) {
            case "ready":
                this.post({
                    type: "update",
                    branchName: this.branchName,
                    repository: this.repository.info,
                    files: this.files,
                    iconFonts: this.iconTheme.getIconFonts(),
                });
                return;
            case "refresh":
                await this.refresh();
                return;
            case "openDiff": {
                const file = this.files.find((item) => item.path === message.path);
                if (!file) return;
                await openBranchComparisonFileDiff(
                    file,
                    this.branchName,
                    this.repository.root,
                    this.repository.gitOps,
                );
                return;
            }
        }
    }

    private post(message: ProjectComparisonInbound): void {
        void this.panel.webview.postMessage(message);
    }

    private getHtml(): string {
        return buildWebviewShellHtml({
            extensionUri: this.extensionUri,
            webview: this.panel.webview,
            scriptFile: "webview-projectcomparison.js",
            title: "Project Branch Comparison",
        });
    }
}
