# Mods

Our mods for Herdr. Each folder has a `MOD.md` (frontmatter: source, install, needs, shared keys; then what
it does). Read it before using or changing a mod. Rules for writing mods: `AGENTS.md`.

## Install

```bash
git clone https://github.com/gandriyko/herdr-app-config.git
cp -r herdr-app-config/mods/<name> ~/.config/herdr-app/mods/
```

Mods are standalone, but some open others (`menu`, `new-menu`, `picker`, `wb-diff`, `wb-ai`, ...); see
`needs` and `commands` in each `MOD.md`.

## Index

| Mod | What it does |
| --- | --- |
| [agents](agents/MOD.md) | Sidebar list of agents with status, pinning, sorting and peek |
| [branch-picker](branch-picker/MOD.md) | Overlay that lists local git branches in a tree and checks one out |
| [changes-copy](changes-copy/MOD.md) | Changes panel (clone of changes) with list/tree views, side-by-side diff tab and AI commit messages |
| [changes](changes/MOD.md) | Panel listing uncommitted git changes with a unified diff and a commit box |
| [confirm](confirm/MOD.md) | Confirmation dialog that runs an app command on Enter |
| [files](files/MOD.md) | Lazy file browser for the focused pane's folder with git marks and read-only previews |
| [help](help/MOD.md) | Filterable overlay listing the app's keybindings |
| [history](history/MOD.md) | Search and read past agent sessions (Claude, Codex, ...) via the hh tool, with resume |
| [jira](jira/MOD.md) | Panel with my open Jira issues by sprint and the project backlog |
| [machine-add](machine-add/MOD.md) | Dialog that finds SSH hosts and adds them as machines with one click |
| [menu](menu/MOD.md) | Popup context menu for panes, tabs, spaces and the global app menu. |
| [new-menu](new-menu/MOD.md) | Popup for creating a tab, agent tab, space or worktree. |
| [pane](pane/MOD.md) | Header bar for a pane: program icon, title, folder, agent status and split/zoom/close buttons. |
| [peek](peek/MOD.md) | Top bar for a peeked sub-agent or terminal overlay. |
| [picker](picker/MOD.md) | Go-to popup: filter and jump to a tab, space or agent, or start new work. |
| [prompt](prompt/MOD.md) | Small text-entry dialog that runs a Herdr command with the typed name. |
| [prs](prs/MOD.md) | Panel listing my open GitHub PRs for the focused repo, with detail, approve, create-PR and AI review/description. |
| [spaces](spaces/MOD.md) | Sidebar list of spaces: colored avatars, worktrees under their repo, machine groups, branch and ahead/behind. |
| [status-copy](status-copy/MOD.md) | Status bar piece showing the active space's git branch and a command-palette hint. |
| [tabs-copy](tabs-copy/MOD.md) | Top tab bar with space tabs, side-panel toggle buttons and window controls. |
| [tabs](tabs/MOD.md) | Tab bar for the active space with panel toggles, new-tab menu and window buttons. |
| [terminals-bar](terminals-bar/MOD.md) | Draggable top bar for a terminals layout: space picker, tab tiles and window controls. |
| [terminals-pane](terminals-pane/MOD.md) | Compact pane header for a terminals layout: program icon, title, folder and split/zoom/close buttons. |
| [toast](toast/MOD.md) | Notification popup style: icon or level dot, title, body; click runs the action and dismisses. |
| [wb-ai](wb-ai/MOD.md) | AI model registry and per-project settings window used to generate commit messages, reviews and MR descriptions. |
| [wb-diff](wb-diff/MOD.md) | Side-by-side diff viewer with syntax highlighting, opened as a tab for a changed file or commit. |
| [win98](win98/MOD.md) | Windows 98 look: taskbar, desktop, pane title bars, Start menu, dialogs, Minesweeper, Solitaire and Clippy. |
| [workspace-chrome](workspace-chrome/MOD.md) | Sidebar header and footer: Herdr title, search, sidebar collapse toggle, Settings and Add machine rows. |
| [workspace-status](workspace-status/MOD.md) | Status bar: machine, git branch, agent count with needs-you counter, and the command palette key hint. |
| [worktree](worktree/MOD.md) | Dialog to create, open or remove git worktrees for a space, locally or on a remote machine. |

## Shared keys (contracts)

Keys are not prefixed with a mod name on purpose and must not be renamed. Each is optional where read.

| Key | Written by | Read by | When missing |
| --- | --- | --- | --- |
| `sidebar.width` | agents, workspace-chrome | agents, workspace-chrome | width 268 on expand |
| `sidebar.collapsed` | agents, workspace-chrome | none here (legacy flag for older mods) | ignored |
| `space.colors` | picker, spaces | picker, spaces | `{}`; colors are assigned, default `ansi6` |
| `branch.switched` | branch-picker, changes-copy | status-copy | treated as 0, no forced refresh |
| `wb.ai.models`, `wb.ai.use`, `wb.ai.project`, `wb.ai.localMigrated`, `wb.ai.projectMigrated` | wb-ai, prs, changes-copy (own copies of ai.js) | wb-ai, prs, changes-copy | defaults created (Claude model, empty projects) |
| `wb.commit.gen` and unprefixed `ai.*`, `commit.gen` | old builds only | wb-ai, prs, changes-copy (migration) | `{}`, migration skipped |
| `wb.diff.request` | changes-copy | wb-diff | `null`, nothing shown |
| `workspace.panels` | Herdr / user (no mod) | tabs | `["files", "changes"]` |
