---
name: agents
summary: Sidebar list of agents with status, pinning, sorting and peek
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/agents
install: copy the folder mods/agents into ~/.config/herdr-app/mods/agents
place: none
needs: []
shared_keys: [sidebar.width, sidebar.collapsed, agents.sort]
reads_keys: [sidebar.width]
commands: [layout.resize, terminal.pin, terminal.peek, pane.focus, overlay popup of itself (sort menu)]
---

## What it does
Sidebar view of running agents (and pinned terminals) from `agents()`/`terminals()`. Click focuses the pane or peeks a terminal that has no pane. Agents can be pinned, and the list is sorted by a choice from a small popup menu. The sidebar toggles between a wide list and a narrow rail by resizing the `sidebar` layout column.

## Files
- main.js: the whole mod (list, sort popup, collapse logic, pin handling).
- check.svg, spinner.svg, chevron-down.svg, chevron-right.svg, pin.svg, pin-off.svg, clock.svg, layers.svg: own copies of the icons used.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- localStorage: `agents.changed`, `agents.pins` (pins waiting for a terminal to appear). The old unprefixed `changed` and `pins` are read once as a fallback.
- Shared state: `agents.sort` (sort choice), `sidebar.width`, `sidebar.collapsed`.

## Notes
- A 30 s timer only refreshes relative times.
- Imports no other mod; icons are its own copies.
- `sidebar.width` and `sidebar.collapsed` are a documented contract with workspace-chrome (both write them); optional where read (width falls back to 268).
