---
name: changes
summary: Panel listing uncommitted git changes with a unified diff and a commit box
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/changes
install: copy the folder mods/changes into ~/.config/herdr-app/mods/changes
place: none
needs: [git]
shared_keys: []
reads_keys: []
commands: []
---

## What it does
For the focused pane's folder shows the changed files (`git status`) and the diff of the selected file against HEAD in a virtual list. Untracked files are shown as all-added. It has a commit message input and runs add/commit from the panel. It refreshes on folder changes and on a timer.

## Files
- main.js: the whole mod (status parsing, diff view, commit).
- changes.svg: mod icon.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
- Refresh every 10 s plus `watchFolder` on the repo root.
- Limits: first 1000 changed files, 1500 diff lines, lines cut at 4000 chars, file read at 400000 chars.
- Standalone: no other mods used.
