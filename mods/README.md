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
| [branch-picker](branch-picker/MOD.md) | Overlay that lists local git branches in a tree and checks one out |
| [changes-copy](changes-copy/MOD.md) | Changes panel (clone of changes) with list/tree views, side-by-side diff tab and AI commit messages |
| [history](history/MOD.md) | Search and read past agent sessions (Claude, Codex, ...) via the human-history tool, with resume |
| [jira](jira/MOD.md) | Panel with my open Jira issues by sprint and the project backlog |
| [prs](prs/MOD.md) | Panel listing my open GitHub PRs for the focused repo, with detail, approve, create-PR and AI review/description. |
| [status-copy](status-copy/MOD.md) | Status bar piece showing the active space's git branch and a command-palette hint. |
| [tabs-copy](tabs-copy/MOD.md) | Top tab bar with space tabs, side-panel toggle buttons and window controls. |
| [wb-ai](wb-ai/MOD.md) | AI model registry and per-project settings window used to generate commit messages, reviews and MR descriptions. |
| [wb-diff](wb-diff/MOD.md) | Side-by-side diff viewer with syntax highlighting, opened as a tab for a changed file or commit. |

## Shared keys (contracts)

Keys are not prefixed with a mod name on purpose and must not be renamed. Each is optional where read.

| Key | Written by | Read by | When missing |
| --- | --- | --- | --- |
| `branch.switched` | branch-picker, changes-copy | status-copy | treated as 0, no forced refresh |
| `wb.ai.models`, `wb.ai.use`, `wb.ai.project`, `wb.ai.localMigrated`, `wb.ai.projectMigrated` | wb-ai, prs, changes-copy (own copies of ai.js) | wb-ai, prs, changes-copy | defaults created (Claude model, empty projects) |
| `wb.commit.gen` and unprefixed `ai.*`, `commit.gen` | old builds only | wb-ai, prs, changes-copy (migration) | `{}`, migration skipped |
| `wb.diff.request` | changes-copy | wb-diff | `null`, nothing shown |
