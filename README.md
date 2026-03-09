# IntelliGit - Jetbrains Git for VS Code

IntelliGit brings a JetBrains-style Git workflow into VS Code, so you can stage, commit, inspect history, and manage branches without bouncing between multiple tools.

![alt text](image.png)

## How Users Benefit 

- Move faster on daily Git work with one focused UI for commit, history, and branch actions.
- Reduce context switching by keeping staging, diffs, commit graph, and commit details in IntelliGit panels.
- Handle risky Git operations with guardrails (confirmations and action availability rules for pushed/merge commits).
- Get familiar behavior if you are coming from IntelliJ/PyCharm Git tooling.

## Core Workflows

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
- Canvas-based lane graph with infinite scroll pagination for large histories
- Text/hash search and branch filter
- Selected commit shows changed files, file stats, and commit metadata

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

## Keyboard Shortcut

| Key | Command |
|-----|---------|
| `Alt+9` | Focus IntelliGit commit graph panel |

## Requirements

- VS Code `1.96.0` or later
- Git installed and available on `PATH`

## Installation

### From Marketplace

Search for **IntelliGit** in VS Code Extensions, or install from:

- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=MaheshKok.intelligit)
- [Open VSX Registry](https://open-vsx.org/extension/MaheshKok/intelligit)

### From VSIX

```bash
bun install
bun run package
code --install-extension intelligit-*.vsix
```

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

## Testing the Extension

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

### Test Categories

| Category | Files | What It Covers |
|----------|-------|----------------|
| Git operations | `gitops.test.ts` | `GitOps` methods: status parsing, staging, commits, shelf/stash, branch operations, numstat |
| Core utilities | `core-utils.test.ts` | Error helpers, path validation, webview HTML generation, graph computation, date formatting |
| View providers | `view-providers.integration.test.ts` | Extension host message handling for CommitPanel and CommitGraph providers |
| Extension commands | `extension.integration.test.ts` | VS Code command registration and execution (branch, commit, file operations) |
| App logic | `app-logic.coverage.test.tsx` | React app callback wiring, state management, commit/amend/push handler flows |
| Webview integration | `webview-apps.integration.test.tsx` | Full DOM render of CommitPanelApp, CommitGraphApp, and CommitInfoApp with simulated extension messages |
| UI smoke | `ui-smoke.test.tsx` | Static render of individual UI components (toolbar, file tree, tab bar, commit area, branch tree) |
| Merge conflict parser | `merge-conflict-parser.test.ts` | Conflict marker detection and extraction from file content |
| Component coverage | `low-coverage-components.test.tsx` | Leaf components not covered by integration tests |
| Extracted modules | `extracted-modules.test.ts` | Decomposed modules from the refactoring branch |

### Manual Testing in VS Code

1. Open the repo in VS Code and press `F5` to launch the Extension Development Host.
2. In the new window, open any Git repository.
3. Open IntelliGit from the activity bar (left sidebar).

**Commit panel (sidebar):**

- Toggle "Group by Directory" in the toolbar and verify both the Commit and Stash tabs respect the toggle.
- Stage files via checkboxes, write a message, and click Commit.
- Click "Amend" and verify the last commit message is loaded.
- Use the Stash tab: shelve changes, select a stash entry, and verify Apply/Pop/Delete work.

**Commit graph (bottom panel):**

- Open the IntelliGit bottom panel (or press `Alt+9`).
- Scroll down to trigger infinite-scroll pagination.
- Click a commit to see changed files and commit details.
- Right-click a commit or branch for context menu actions.
- Use the branch filter and text search.

**Branch management:**

- Right-click branches in the branch column for checkout, rename, delete, merge, rebase operations.
- Create a new branch from the context menu and verify it appears.

**Edge cases to verify:**

- Open a workspace with no Git repository and confirm graceful error handling.
- Stage a new file, edit it again after staging, and verify only one row appears (not a duplicate "M" row).
- Stage a new file then delete it from disk; verify both the staged "A" and unstaged "D" rows appear.

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
| Package manager | Bun |
| Testing | Vitest |
| Linting | ESLint |
| Formatting | Prettier |

## License

[MIT](LICENSE)
