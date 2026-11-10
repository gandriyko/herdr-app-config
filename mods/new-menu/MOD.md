---
name: new-menu
summary: Popup for creating a tab, agent tab, space or worktree.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/new-menu
install: copy the folder mods/new-menu into ~/.config/herdr-app/mods/new-menu
place: none
needs: []
shared_keys: [new-menu.agents]
reads_keys: []
commands: [tab.new, space.new, mod.open worktree (dialog, new and open)]
---

## What it does
Popup listing Terminal, each known agent (installed ones start a tab running it; others show 'not installed'), New space, New worktree and Open worktree.
Agents come from knownAgents() for the active space's machine; numbers 1-9 and global shortcuts are shown as hints.

## Files
- main.js: the popup view and shortcut formatting.
- terminal.svg, branch.svg: own icons (Terminal row, worktree rows).
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
shared new-menu.agents: last agent list per machine, shown at once while knownAgents() re-checks (small, one list per machine).

## Notes
Worktree rows need the `worktree` mod. No polling.
