---
name: workspace-status
summary: Status bar: machine, git branch, agent count with needs-you counter, and the command palette key hint.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/workspace-status
install: copy the folder mods/workspace-status into ~/.config/herdr-app/mods/workspace-status
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [app.palette]
---

## What it does
Footer line showing the active space's machine (or "This computer"), its branch, the number of agents (plus "· N needs you" for blocked ones) and the real key bound to `app.palette` (read from `keys()`), clickable to open the palette.

## Files
- main.js: the status bar view.
- mod.json: place none.
- server.svg, monitor.svg, branch.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
none

## Notes
No timers; redraws when spaces, agents or keys change. Icons server, monitor, branch are its own copies in this folder.
