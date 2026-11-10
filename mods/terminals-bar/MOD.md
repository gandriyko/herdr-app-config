---
name: terminals-bar
summary: Draggable top bar for a terminals layout: space picker, tab tiles and window controls.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/terminals-bar
install: copy the folder mods/terminals-bar into ~/.config/herdr-app/mods/terminals-bar
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [tab.select, tab.new, app.palette, window.minimize, window.maximize, window.close, overlay mod menu (tab context menu), overlay mod picker (space picker)]
---

## What it does
Top bar of a terminal-first layout. A pill shows the active space name and opens the `picker` overlay. Each tab is a tile with the lead pane's program icon and status dot, the tab name and its folder (~-shortened). Click selects, right click opens the tab menu. Buttons at the right open the command palette, create a tab, and (when the window has custom buttons) minimize/maximize/close.

## Files
- main.js: the bar view (colors are hardcoded constants, not theme).
- command.svg, plus.svg, stack.svg: toolbar icons.
- win-min.svg, win-max.svg, win-restore.svg, win-close.svg: window buttons.
- mod.json: title "Terminals tabs".
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
none

## Notes
No timers, no external programs. Depends on the app mods `menu` and `picker` for the overlays it opens. Adds 72px left padding on macOS with hidden titlebar for the traffic lights.
