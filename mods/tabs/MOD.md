---
name: tabs
summary: Tab bar for the active space with panel toggles, new-tab menu and window buttons.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/tabs
install: copy the folder mods/tabs into ~/.config/herdr-app/mods/tabs
place: none
needs: []
shared_keys: []
reads_keys: [workspace.panels]
commands: [tab.select, tab.move, tab.rename, tab.close, tab.new, tab.prev, tab.next, layout.select, layout.show, layout.hide, window.minimize, window.maximize, window.close, mod.open menu (tab popup), mod.open new-menu (popup)]
---

## What it does
Tab strip for the active space: click selects, double-click renames, drag reorders, wheel switches tabs, right-click opens the tab menu, + opens the new-menu popup. Also toggles the side panel (files, changes, ...) remembered per space, and draws minimize/maximize/close window buttons.

## Files
- main.js: the tab bar view.
- close.svg, spinner.svg, panel-files.svg, panel-changes.svg: own copies of icons (close, working spinner, panel buttons).
- win-close.svg, win-max.svg, win-min.svg, win-restore.svg: Windows window-control icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
localStorage `tabs.panels` (old unprefixed `panels` is read as fallback): side panel choice per space. Reads shared `workspace.panels` (default [files, changes]).

## Notes
`workspace.panels` is a documented contract: written by Herdr or the user (no mod here), optional where read. Depends on menu and new-menu mods for popups, and on layout ids panel and panel-body. No polling.
