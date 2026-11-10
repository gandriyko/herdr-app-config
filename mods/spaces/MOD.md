---
name: spaces
summary: Sidebar list of spaces: colored avatars, worktrees under their repo, machine groups, branch and ahead/behind.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/spaces
install: copy the folder mods/spaces into ~/.config/herdr-app/mods/spaces
place: none
needs: [git, hc]
shared_keys: [space.colors]
reads_keys: [space.colors]
commands: [space.select, space.new, space.move, mod.open menu (popup, space menu)]
---

## What it does
Shows each space with a stable colored avatar, grouped by machine when several are known, with linked worktrees nested under their main checkout. Shows branch and ahead/behind where unusual. Click selects, right-click opens the menu mod, drag reorders; a rail mode shows when the sidebar is narrow.

## Files
- main.js: the spaces view, git status, machine groups, drag reorder.
- plus.svg, branch.svg, chevron-right.svg, chevron-down.svg, server.svg, monitor.svg: own copies of icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
localStorage `machines.reconnecting` and `machines.folded`; shared `space.colors` (space id to color, pruned for gone spaces).

## Notes
Timers: render() calls a coalesced kick() that checks new spaces and git-due places (one follow-up check 1.6 s later only while a new space or reorder is pending), a 2 s fallback check, 15 s machine list refresh, 60 s git fallback while the window is active. Uses watchFolder on each repo to refresh git. `space.colors` is a documented contract with picker; optional where read (falls back to {} and default color). Depends on menu mod for the right-click menu.
