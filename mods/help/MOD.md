---
name: help
summary: Filterable overlay listing the app's keybindings
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/help
install: copy the folder mods/help into ~/.config/herdr-app/mods/help
place: none
needs: []
shared_keys: []
reads_keys: []
commands: []
---

## What it does
Shows the keybind list (prefix+?), grouped into spaces, tabs, panes, agents, terminal and window. Typing filters. Read-only: keys are changed in keys.json.

## Files
- main.js: the overlay (reads `keys()`).
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
- No polling; standalone.
