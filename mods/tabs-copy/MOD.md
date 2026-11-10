---
name: tabs-copy
summary: Top tab bar with space tabs, side-panel toggle buttons and window controls.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/tabs-copy
install: copy the folder mods/tabs-copy into ~/.config/herdr-app/mods/tabs-copy
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [tab.rename, tab.move, tab.select, tab.close, tab.new, tab.prev, tab.next, layout.select, layout.show, layout.hide, window.minimize, window.maximize, window.close, overlay mod menu (tab context menu), overlay mod new-menu (+ popup)]
---

## What it does
Draws the tab bar of the active space: program icon, agent topic as name, status spinner or dot, close button on the active tab. Click selects, double click renames, drag-drop reorders, right click opens the tab menu, wheel switches tabs. At the right it shows one button per child of the layout stack `panel-body` (Files, Changes, Jira, PR, History...) that toggles the side panel, then window buttons. It remembers the open side panel per space. Cloned from the stock `tabs` mod 0.1.14.

## Files
- main.js: the whole view (tabs, panel buttons, per-space panel memory, key command listener via nextCommand).
- mod.json: title "Tabs", cloned_from tabs 0.1.14.
- close.svg, spinner.svg, panel-*.svg, win-*.svg: icons (close, working spinner, panel button icons, Windows window buttons).
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
localStorage key `panels`: map of space id to the panel shown last. Key commands: bind `tabs-copy.<panel id>` (e.g. `tabs-copy.jira`) in keys.json to toggle a panel.

## Notes
No timers. Relies on the layout having nodes `sidebar`, `panel`, `panel-body`; without them the panel buttons are simply absent. Opens the `menu` and `new-menu` overlays (app mods); those buttons do nothing useful if the mods are removed.
