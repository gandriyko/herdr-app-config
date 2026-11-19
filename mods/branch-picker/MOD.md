---
name: branch-picker
summary: Overlay that lists local git branches in a tree and checks one out
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/branch-picker
install: copy the folder mods/branch-picker into ~/.config/herdr-app/mods/branch-picker
place: none
needs: [git]
shared_keys: [branch.switched]
reads_keys: []
commands: []
---

## What it does
Opened as an overlay behind the status bar branch. Shows local branches grouped by `prefix/`: the current branch first (with a Pull button: `git pull --ff-only`, or `--rebase --autostash` when diverged, aborted on conflict; ↓N from the last fetch), then recently used ones, the local tree, and at the bottom a "Remote" group: the 30 newest remote branches that have no local one (a click runs `git checkout <name>`, which makes a local branch tracking it), with a filter box and copy-name button. On open it runs `git fetch` in the background when this repo's last one from the picker is over 5 minutes old (a small spinner on Pull meanwhile), then reads the list and ↓N again. The current branch is skipped by ↑↓/↵. Clicking runs `git checkout` only; spaces, tabs and terminals stay put. After a switch it sets `branch.switched` so the header chip refreshes.

## Files
- main.js: the picker (git calls, tree, recents, checkout, error display).
- copy.svg: copy-name icon.
- folder.svg, branch.svg, git-branch.svg, check.svg, spinner.svg: own copies of the icons used.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- localStorage: `branch-picker.collapsed` (collapsed groups), `branch-picker.recents` (recent branches per repo, max 10), `branch-picker.fetched` (time of the last background fetch per repo, last 50 repos). Old unprefixed `collapsed`/`recents` are read as a fallback.
- No keychain or data files.

## Notes
- Runs git with read-only/no-lock options for reads; works on the focused folder of the given space (also remote machines via `on`).
- Draws at most 200 list rows (render deadline); the rest are reached by the filter.
- `branch.switched` is a documented contract with status-copy (also written by changes-copy); optional where read.
