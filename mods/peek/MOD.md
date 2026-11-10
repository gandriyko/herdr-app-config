---
name: peek
summary: Top bar for a peeked sub-agent or terminal overlay.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/peek
install: copy the folder mods/peek into ~/.config/herdr-app/mods/peek
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [pane.focus, terminal.keep, closeOverlay]
---

## What it does
Overlay bar shown over a peeked agent (opened by the agents list or a terminal address link). Shows who it is and its status (working, needs you, finished, idle) with a spinner glyph; the arrow goes to its pane, or keeps it as a tab if it has none; X closes.

## Files
- main.js: the bar view.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none. Props: { terminal, overlay }.

## Notes
Redraw driven by agents()/terminals() updates plus the spinner frame; standalone, no dependency on other mods.
