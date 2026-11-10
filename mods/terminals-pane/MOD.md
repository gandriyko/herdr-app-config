---
name: terminals-pane
summary: Compact pane header for a terminals layout: program icon, title, folder and split/zoom/close buttons.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/terminals-pane
install: copy the folder mods/terminals-pane into ~/.config/herdr-app/mods/terminals-pane
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [pane.focus, pane.split, pane.zoom, pane.close]
---

## What it does
Header drawn above each terminal pane (props `{ pane, terminal }`). Shows the program icon, the pane title (bold when focused), the ~-shortened folder if the title does not already include it, and buttons for split right, split down, zoom/unzoom and close. Clicking the header focuses the pane.

## Files
- main.js: the header view.
- mod.json: title "Terminals pane header".
- split-right.svg, split-down.svg, zoom.svg, unzoom.svg, close.svg: button icons.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
none

## Notes
No timers or external programs. Button icons are its own copies in this folder (split-right, split-down, zoom, unzoom, close). Colors are hardcoded.
