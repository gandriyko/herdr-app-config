# Mods

Our mods for Herdr. Each folder has a `MOD.md` (frontmatter: source, install, needs, shared keys; then what
it does). Read it before using or changing a mod. Rules for writing mods: `AGENTS.md`.

## Install

```bash
git clone https://github.com/gandriyko/herdr-app-config.git
cp -r herdr-app-config/mods/<name> ~/.config/herdr-app/mods/
```

Mods are standalone. Some open other mods, for example the app's own popups (`menu`, `new-menu`, `picker`) or
our `wb-diff` and `wb-ai`; see `needs` and `commands` in each `MOD.md`. The mod is expected to keep working
when one of them is absent.

## Index

| Mod | What it does |
| --- | --- |
| [agents-board](agents-board/MOD.md) | Kanban of agents (Needs you, Working, Done) opened with ⌘⇧A, with PR and checks pills, space/PR filters, search, sub-agent trees under their parent, a click goes to the agent, a reply button shows its last question or reply. |
| [agents-copy](agents-copy/MOD.md) | Sidebar agent list (clone of agents) with PR and checks chips, a space/PR filter and repeat reminders for agents still waiting. |
| [branch-picker](branch-picker/MOD.md) | Overlay that lists local git branches in a tree and checks one out |
| [changes-copy](changes-copy/MOD.md) | Changes panel (clone of changes) with list/tree views, side-by-side diff tab and AI commit messages |
| [files-copy](files-copy/MOD.md) | File tree (clone of files, dot files and Exclude masks behind a filter options button, git-ignored entries dimmed, a filter input that keeps the tree) that opens a file in its own tab or a pane beside the terminal (the last choice is remembered) to view or edit (⌘S saves), shows pictures (image files, SVG, images in rendered Markdown, which appears only once complete), ⌘F finds in the file (also in rendered Markdown); in Python files ⌘-hover underlines a name, ⌘-click jumps to its definition (centred) via jedi, ⌘[ / ⌘] go back and forward. |
| [history](history/MOD.md) | Search and read past agent sessions (Claude, Codex, ...) via the human-history tool, with resume, voice search and an AI mode that asks Claude or Codex about them |
| [jira](jira/MOD.md) | Panel with my open Jira issues (grouped by sprint or status, sorted by date) and optional project backlogs, each issue with its open PRs (CI, Copilot, approval) and the current worktree's issue highlighted |
| [prs](prs/MOD.md) | Panel listing my (or all) open GitHub PRs for the focused repo, with detail, approve, create-PR and AI review/description. |
| [start-tab](start-tab/MOD.md) | Start tab that keeps a space open after its last tab closes; opens a terminal or an installed agent in its place. |
| [status-copy](status-copy/MOD.md) | Status bar piece showing the active space's git branch, a keep-awake button and a command-palette hint. |
| [tabs-copy](tabs-copy/MOD.md) | Top tab bar with space tabs, side-panel toggle buttons and window controls. |
| [wb-ai](wb-ai/MOD.md) | AI model registry and per-project settings window used to generate commit messages, reviews and MR descriptions. |
| [wb-diff](wb-diff/MOD.md) | Diff viewer (side by side or unified) with syntax highlighting that scrolls through all changed files in one tab, with ⌘F find. |

## Shared keys (contracts)

Keys are not prefixed with a mod name on purpose and must not be renamed. Each is optional where read.

| Key | Written by | Read by | When missing |
| --- | --- | --- | --- |
| `branch.switched` | branch-picker, changes-copy | status-copy | treated as 0, no forced refresh |
| `wb.ai.models`, `wb.ai.use`, `wb.ai.project`, `wb.ai.localMigrated`, `wb.ai.projectMigrated` | wb-ai, prs, changes-copy (own copies of ai.js) | wb-ai, prs, changes-copy | defaults created (Claude model, empty projects) |
| `wb.commit.gen` and unprefixed `ai.*`, `commit.gen` | old builds only | wb-ai, prs, changes-copy (migration) | `{}`, migration skipped |
| `wb.diff.request` | changes-copy | wb-diff | `null`, nothing shown |
| `files-copy.open` | files-copy (panel), wb-diff (Open in Files) | files-copy (file tab) | the tab keeps the file it was opened with |
