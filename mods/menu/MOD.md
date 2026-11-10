---
name: menu
summary: Popup context menu for panes, tabs, spaces and the global app menu.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/menu
install: copy the folder mods/menu into ~/.config/herdr-app/mods/menu
place: none
needs: [git]
shared_keys: []
reads_keys: []
commands: [pane.split, pane.zoom, pane.close, terminal.park, tab.rename, tab.new, tab.close, space.rename, space.new, space.close, app.help, app.theme, mod.open worktree (dialog)]
---

## What it does
Opened as a popup with props { tab: "pane" | "tab" | "space" | "global", target }. Each kind lists its Herdr commands (split, zoom, rename, new, close, themes, keybinds) with the bound key shown on the right.
Up/Down move, Enter runs, Esc closes. Space menus use git to detect a main checkout or linked worktree and offer worktree actions.

## Files
- main.js: the menu view, item lists per kind, key-hint lookup, worktree detection via git.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
Opens the `worktree` mod as a dialog for worktree items; if that mod is absent those items do nothing useful. No polling or caching; git runs once on open.
