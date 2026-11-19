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
Opened as an overlay behind the status bar branch. Shows local branches grouped by `prefix/` under a "Local" heading: the current branch first (with a Pull button: `git fetch` then `git merge --ff-only @{u}`, or `git rebase --autostash @{u}` when diverged, aborted on conflict; not `git pull`, whose merge of `FETCH_HEAD` breaks when another fetch runs at the same time; ↓N from the last fetch), then pinned ones (a pin button on hover pins or unpins a local branch; a pinned one keeps its pin lit), recently used ones, the local tree, and at the bottom a "Remote" group: remote branches that have no local one, newest first (a click runs `git checkout <name>`, which makes a local branch tracking it), with a filter box and copy-name button. On open it runs `git fetch` in the background when the repo's last fetch (from anywhere: the mtime of `FETCH_HEAD`) is over 5 minutes old (a small spinner on Pull meanwhile), then reads the list and ↓N again. The current branch is skipped by ↑↓/↵. Clicking runs `git checkout` only; spaces, tabs and terminals stay put. After a switch it sets `branch.switched` so the header chip refreshes.

## Files
- main.js: the picker (git calls, tree, pins, recents, checkout, error display).
- copy.svg, pin.svg: copy-name and pin icons.
- folder.svg, branch.svg, git-branch.svg, check.svg, spinner.svg: own copies of the icons used.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- `data/branch-picker/state.json` (under the app home): `pins` and `recents` (per repo, recents max 10; last 50 repos each) and `collapsed` (groups). A file, not localStorage: localStorage is per mod copy and every popup is a new copy, so it forgot them.
- No keychain.

## Notes
- Runs git with read-only/no-lock options for reads; works on the focused folder of the given space (also remote machines via `on`).
- Draws at most 100 branches per section, Local and Remote (render deadline), with a "… N more" row; the rest are reached by the filter. The newest 2000 remote branches are kept for the filter.
- `branch.switched` is a documented contract with status-copy (also written by changes-copy); optional where read.
