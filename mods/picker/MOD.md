---
name: picker
summary: Go-to popup: filter and jump to a tab, space or agent, or start new work.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/picker
install: copy the folder mods/picker into ~/.config/herdr-app/mods/picker
place: none
needs: [hc]
shared_keys: [space.colors]
reads_keys: [space.colors]
commands: [tab.select, tab.new, space.new, tab.close]
---

## What it does
Popup (drops from the top) listing spaces and their tabs. Spaces needing attention come first, quiet ones fold into 'earlier'. Type to filter, Up/Down and Enter to go, ctrl+d closes a tab, Esc leaves. Last rows start a tab here or a space on this computer or a connected machine.

## Files
- main.js: the picker view, space color logic, rows and keyboard handling.
- search.svg, spinner.svg: own copies of the icons used.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
shared space.colors: space id to theme color name or #rrggbb; assigned once per new space and pruned for gone spaces. Overlay config in mod.json: popup at top, width 640, height 0.8.

## Notes
`space.colors` is a documented contract with spaces (both write and read it, duplicated logic); optional where read, the picker creates it when missing. Runs `hc machine ls --json` once on open.
