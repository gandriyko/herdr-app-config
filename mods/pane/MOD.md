---
name: pane
summary: Header bar for a pane: program icon, title, folder, agent status and split/zoom/close buttons.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/pane
install: copy the folder mods/pane into ~/.config/herdr-app/mods/pane
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [pane.focus, pane.split, pane.zoom, pane.close]
---

## What it does
Used as a pane header in a layout: { "pane": { "header": { "content": { "mod": "pane" } } } }. Shows the program icon, agent name or terminal title, folder and status, and buttons to split right/down, zoom and close. Click focuses the pane.

## Files
- main.js: the header view.
- close.svg, split-down.svg, split-right.svg, unzoom.svg, zoom.svg: button icons.
- spinner.svg: working-state icon.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
Other mods (tabs) reference pane/close.svg. No polling.
