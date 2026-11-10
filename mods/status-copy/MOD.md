---
name: status-copy
summary: Status bar piece showing the active space's git branch and a command-palette hint.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/status-copy
install: copy the folder mods/status-copy into ~/.config/herdr-app/mods/status-copy
place: none
needs: [git]
shared_keys: []
reads_keys: [branch.switched]
commands: [app.palette, mod.open branch-picker (popup)]
---

## What it does
Shows the active space's branch with ahead/behind counts, a machine or server icon, and the key bound to the command palette (or 'commands'). Clicking the branch opens the branch picker above the bar; clicking the hint runs app.palette. Cloned from workspace-status 0.1.14.

## Files
- main.js: the status view and git status reads.
- icons/: branch.svg, monitor.svg, server.svg.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
`branch.switched` (timestamp written by branch-picker and changes-copy) is a documented contract; optional where read, works without it. It refreshes after a checkout. Checks every 2 s by cheap compare, runs git status -uno at most every 30 s per place, one at a time. Needs the `branch-picker` mod for the click action.
