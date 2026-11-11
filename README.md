# IntelliGit - Jetbrains Git for VS Code

IntelliGit brings a JetBrains-style Git workflow into VS Code, so you can stage, commit, inspect history, and manage branches without bouncing between multiple tools.

![alt text](image.png)

## How Users Benefit 

- Move faster on daily Git work with one focused UI for commit, history, and branch actions.
- Reduce context switching by keeping staging, diffs, commit graph, and commit details in IntelliGit panels.
- Handle risky Git operations with guardrails (confirmations and action availability rules for pushed/merge commits).
- Get familiar behavior if you are coming from IntelliJ/PyCharm Git tooling.

## Core Workflows

### Large JSON Preview

Right-click a `.json` file in Explorer or the editor and select **IntelliGit: JSON 格式化预览**. The JSON editor title also has a preview button. The command works without a Git repository or an open workspace.

- Opens in a read-only **Structure** view with independently expandable objects/arrays, collapse-all, and node selection. Selected scalar values appear in a selectable text box (up to 16 KB); larger values are explicitly marked as partial.
- Structure view reads only a batch of direct children at a time, with **Previous/Next batch** navigation. Headers appear before scanning large values. Locating later siblings may require a sequential scan past the preceding value; collapsing the parent cancels that scan. It does not build a complete object tree or pre-count children. The view limits retained nodes to keep memory bounded.
- Switch to **Code** for the formatted view with syntax colors and 2/4-space indentation. UTF-8 JSON is read incrementally in 64 KB chunks, with up to 1,000 display lines per page. Scrolling loads the next or previous page.
- Both views render only visible rows. Code view keeps at most three pages in the webview; earlier pages are cached on temporary disk storage and removed when the preview closes. Switching views also releases the previous view's reader and cache.
- Long strings/numbers are split into bounded display segments marked **↪**, preserving the original text and number precision. Line numbers refer to the formatted preview.
- Both views are read-only and leave the source file unchanged. Field editing/addition/deletion are not enabled in this version.
- Invalid JSON reports an error at the point reached; unvisited content has not been fully validated. Save unsaved edits before previewing; refresh after the source file changes. Nesting beyond 512 levels in a scanned value is reported rather than expanded indefinitely.

### 1) Commit and Shelf Workflow (Sidebar)

- Commit tab with file tree, selective staging checkboxes (section/folder/file), diff open on click, and commit message area
- Toolbar actions: Refresh, Rollback, Group by Directory, Shelve, Show Diff Preview, Expand All, Collapse All
- Commit, Commit and Push, and Amend support
- Shelf tab for stash-based "shelf" workflow: save full or partial changes, then Apply, Pop, or Delete

Why this helps:
- You can build clean commits quickly, even in large change sets.
- You can park unfinished work safely and come back later without losing flow.

### 2) Commit Graph and History (Bottom Panel)

- Three-pane layout: branch column, commit list/graph, and commit detail pane
- Click **Branch: All branches** above the commit list to search for a local or remote branch and filter its history. Click the **×** beside an active branch filter to return to **All branches**. Clicking a branch in the left column locates its tip in the full graph.
- Canvas-based lane graph with infinite scroll pagination for large histories
- Text/hash search and branch filter
- Selected commit shows changed files, file stats, and commit metadata

By default, history includes local branches, remote branches, tags, and HEAD.
Enable `intelligit.log.showAllRefs` in Settings to also show internal Git references,
such as Copilot/Agent checkpoints, when viewing all branches. The graph refreshes
automatically when this setting changes.

Why this helps:
- You can understand branch history and merge paths faster.
- You can inspect any commit without leaving the graph context.

### 3) Branch Management (From Branch Column Context Menu)

Available actions:

| Action | Applies To |
|--------|------------|
| Checkout | Local, Remote |
| New Branch from... | Current, Local, Remote |
| Checkout and Rebase onto Current | Local, Remote |
| Rebase Current onto Selected | Local, Remote |
| Merge into Current | Local, Remote |
| Update | Current, Local |
| Push | Current, Local |
| Rename... | Current, Local |
| Delete | Local, Remote |

Why this helps:
- Most branch operations are available directly where you browse history.
- Less command-line overhead for common branch maintenance tasks.

### 4) Commit Context Actions (From Commit Row Context Menu)

- Copy Revision Number
- Create Patch
- Cherry-Pick
- Checkout Revision
- Reset Current Branch to Here
- Revert Commit
- Undo Commit (unpushed, non-merge)
- Edit Commit Message (unpushed, non-merge)
- Drop Commit (unpushed, non-merge)
- Interactively Rebase from Here (unpushed, non-merge)
- New Branch
- New Tag

Why this helps:
- Advanced history editing is available in-place, with safer availability rules.

### 5) Workspace Change Badge

- Activity bar badge shows current changed-file count in the workspace

Why this helps:
- You always know if your working tree is clean before pushing or switching context.

## Quick Start

1. Open a Git repository in VS Code.
2. Open IntelliGit from the activity bar.
3. Use the `Commit` tab to stage files, write a message, and commit.
4. Open the bottom IntelliGit panel to inspect graph history, filter by branch, and review commit details.
5. Use branch or commit context menus for advanced operations.

## Diff Review Overlay

### Selected code history

Select a function or a block of code in a working source file, then right-click
**IntelliGit > 查看选中代码的历史**. The overlay lists commits that affected that
fragment on the left and shows its historical before/after text on the right.
The newest matching change opens automatically; **再加载 100 条** loads older results.
Without a selection, IntelliGit uses the enclosing function when the language
provider supplies symbols, otherwise the current line. History is pinned to the
HEAD captured when opened.

Saved and unsaved local edits are mapped back to HEAD without saving the buffer
or changing the Git index. New uncommitted code has no Git history. Ambiguous
partial replacements and paths absent from HEAD are reported instead of showing
history for the wrong lines. Git's line-history tracking follows historical
renames, but does not promise semantic tracking across arbitrary refactors or
code moved between files. The source-file button returns to the original selection.

### Changes introduced by the current branch

The existing **Compare Working Tree with Branch...** and **Compare Current
Branch with Branch...** flows now ask for the comparison mode after you select
a branch: **直接比较** uses that branch's tip; **从共同祖先比较** uses its common
ancestor with HEAD. Working-tree comparisons include uncommitted changes in
either mode; current-branch comparisons include only committed changes.
Cancelling either picker leaves the current editors alone.

**查看本分支引入的改动…** is also available from the Explorer context menu
and Command Palette, with a target-branch picker. This shortcut
opens the committed common-ancestor comparison directly.

This compares the common ancestor with the current committed HEAD. It excludes
uncommitted edits and changes made only on the target branch. The file list,
individual diffs and compact **Open All Changes** view use the same pinned
commits; Refresh resolves the endpoints again and reloads the selected file.
Unrelated histories or multiple merge bases are reported without guessing.
The existing direct branch and working-tree comparisons remain available.

### Overlay navigation

Opening a native file diff automatically shows it in a large overlay inside the
current project window. This includes IntelliGit and VS Code Source Control file
diffs. Press **Escape** or close the overlay to return; the Git Log stays behind it.
The native editor keeps the real document, including unsaved changes and saving.
Use **在编辑器中打开源文件** in the overlay toolbar to open the working file at the
current position in the main editor. The native **Open Modal Editor in Main
Window** button docks the diff without automatically popping it back out.

Project/branch comparisons show their file tree on the left and the native diff on
the right inside one overlay. Selecting another file reuses the right-hand pane.
Opening a source file keeps this comparison in background tabs; **返回比较** in the
editor toolbar restores the tree's filter, expansion and selection, and the last
diff position and tree scroll position. The comparison's **Open All Changes**
button shows the compact multi-file diff in the right-hand pane. Closing the
comparison itself ends that session. Ordinary files and other multi-file changes
summaries keep their existing presentation.

Set `intelligit.diff.openInOverlay` to `false` to use regular diff tabs.
The feature respects `workbench.editor.useModal: "off"` and falls back to normal
tabs on hosts without modal editors. It uses VS Code's internal modal-group command
because the public extension API does not expose this placement yet; host updates
may require compatibility adjustments. It has been exercised in VS Code 1.144.1.

Run `npm run test:diff-overlay` for the isolated native-host smoke test. On platforms
other than macOS, set `VSCODE_EXECUTABLE_PATH` to the installed VS Code executable.
The test creates its own temporary profile and example files.

## Copilot Request Performance (Status Bar)

The Copilot status bar is hidden by default. Enable
`intelligit.copilotPerformance.enabled` in Settings to show it. The right status
bar shows the last completed Copilot LLM request, for example
`⚡ 45.0 tok/s · TTFT 2.3s · gpt-6.1`. Hover for output tokens, request duration,
completion time and the completed requests in the same user turn. The value stays
visible while the next request is running. Missing metrics show `—`.

Some third-party model providers, including the observed Codex Bridge request
path, do not produce `llm_request` entries in Copilot's debug log. Completed tool
turns alone contain no token throughput or TTFT. In that case the item reports
**日志缺少请求指标** instead of continuing to display **等待请求**; the provider
must supply request metrics before throughput can be calculated.

Run **IntelliGit: 管理 Copilot 调试日志** from the Command Palette (also available
while the status bar is hidden), or click the item. Choose **启用 Copilot 文件日志** to enable
`github.copilot.chat.agentDebugLog.fileLogging.enabled`, then reload the window.
This also limits each JSONL file to 5 MB and retains 10 sessions per storage
location through Copilot's own settings, preserving any stricter existing limits.
IntelliGit reads the current VS Code profile's global and workspace debug logs;
it does not upload them or keep another copy. Copilot normally flushes logs every
4 seconds; IntelliGit updates when the completed request reaches disk.

Choose **关闭 Copilot 文件日志** in the same menu to disable file logging globally.
Each already-open window needs to reload before it stops writing logs. Existing
logs remain available for manual cleanup. Hiding the status bar does not change
Copilot's file logging setting.

Speed is approximately `outputTokens / ((dur - ttft) / 1000)`. Output tokens may
include hidden reasoning, and TTFT measures the first response chunk rather than
the first visible character.

While `intelligit.copilotPerformance.enabled` is enabled, IntelliGit
cleans historical debug logs on startup and hourly, retaining 7 days with a
100 MB total target. It counts each session's JSONL and auxiliary files. The
newest session in each storage location and sessions updated within 24 hours are
protected, so the target can temporarily be exceeded. Copilot's native per-file
limit does not cover auxiliary files. Run **IntelliGit: 清理 Copilot 历史调试日志**
or use the status bar menu to remove all eligible historical logs immediately.
Cleanup removes debug log directories only; chat history is preserved.

## JetBrains Merge Tool Setup (Optional)

IntelliGit can open merge conflicts in a JetBrains IDE merge tool (PyCharm, IntelliJ IDEA, WebStorm, etc.).

1. Open VS Code Settings and search for `IntelliGit: JetBrains Merge Tool Path`.
2. Set `intelligit.jetbrainsMergeTool.path` to your JetBrains app path.
3. On macOS, you can paste the `.app` path directly (IntelliGit auto-resolves the internal executable).
4. Keep `intelligit.jetbrainsMergeTool.preferExternal` enabled (default) if you want IntelliGit to use JetBrains first.

Examples (macOS):

- `/Applications/PyCharm.app`
- `/Applications/IntelliJ IDEA.app`
- `/Applications/WebStorm.app`
- `/Users/<your-user>/Applications/PyCharm.app`

Examples (Windows):

- `C:\\Program Files\\JetBrains\\PyCharm 2025.1\\bin\\pycharm64.exe`
- `C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.1\\bin\\idea64.exe`
- `C:\\Program Files\\JetBrains\\WebStorm 2025.1\\bin\\webstorm64.exe`

Helpful command:

- Run `IntelliGit: Detect JetBrains Merge Tool` from the Command Palette to auto-detect installed JetBrains IDEs and save the path.

If no JetBrains IDE path is configured, IntelliGit falls back to the VS Code internal merge editor.


## Requirements

- VS Code `1.96.0` or later
- Git installed and available on `PATH`
- Node.js `20+` recommended for packaging with `vsce`

## Installation

### From Marketplace

Search for **IntelliGit** in VS Code Extensions, or install from:

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit)
- [Open VSX Registry](https://open-vsx.org/extension/MaheshKok/intelligit)




## Development

```bash
# Install dependencies
bun install

# Build (development)
bun run build

# Watch mode
bun run watch

# Run linter
bun run lint

# Type check
bun run typecheck

# Run tests
bun run test

# Format code
bun run format
```

### Manually test the changes 

```bash
# Use Node 20+ (Node 22 recommended)
nvm use 22

# Install dependencies
pnpm install

# Build production bundles
node scripts/build.js --production

# Package VSIX
pnpm exec vsce package --no-dependencies

# Install locally
code --install-extension intelligit-*.vsix
```

### Packaging

```bash
# Use Node 20+ (Node 22 recommended)
nvm use 22

pnpm install
node scripts/build.js --production
pnpm exec vsce package --no-dependencies
```

The packaged VSIX is written to the repository root, for example:

```bash
/Users/wnz/goProject/IntelliGit/intelligit-0.6.2.vsix
```

### Running the Test Suite

```bash
# Run all unit and integration tests
bun run test

# Run tests in watch mode (re-runs on file changes)
bun run test -- --watch

# Run a specific test file
bun run test -- tests/unit/gitops.test.ts

# Run tests matching a pattern
bun run test -- -t "CommitPanelApp"
```

## Architecture (High Level)

```text
GitExecutor (simple-git wrapper)
    |
GitOps (operations layer)
    |
View Providers (extension host orchestration)
    |
Webviews (React apps for commit panel + commit graph panel)
```

Data flow highlights:

1. Commit selection in graph requests commit details from extension host and updates detail pane.
2. Branch selection filters the graph and clears stale commit detail state.
3. Commit panel file count updates the activity badge.
4. Refresh reloads branch state, history, and commit panel data together.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Extension host | TypeScript (strict), ES2022 |
| Git operations | simple-git v3 |
| Webviews | React 18 |
| Graph rendering | HTML5 Canvas |
| Bundler | esbuild |
| Package manager | pnpm / Bun |
| Testing | Vitest |
| Linting | ESLint |
| Formatting | Prettier |

## License

[MIT](LICENSE)
