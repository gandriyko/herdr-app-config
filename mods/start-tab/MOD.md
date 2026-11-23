---
name: start-tab
summary: Start tab that keeps a space open after its last tab closes; opens a terminal or an installed agent in its place.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/start-tab
install: copy the folder mods/start-tab into ~/.config/herdr-app/mods/start-tab (it is opened by tabs-copy)
place: none
needs: []
shared_keys: [start-tab.agents]
reads_keys: []
commands: [tab.new, tab.close]
---

## What it does
A tab whose only pane is this mod. It shows the space name, a Terminal row and the installed agents (`knownAgents` on the space's machine). A click, `T` / `0` (Terminal) or `1`–`9` (agent) opens that as a new tab in the same space, in the folder of the tab that was closed, and closes the start tab. `tabs-copy` opens it when the space's last tab is closed with its close button, `tabs-copy.close` or `tabs-copy.close-pane`. Closing the start tab itself closes the space as usual.

## Files
- main.js: the view.
- mod.json: title "Start".

## Settings and data
Props: `{ space, folder }` (space id, folder for the new tab; defaults: the active space, the space's folder). Shared key `start-tab.agents`: the last agent list per machine, shown at once while the list is checked again.

## Notes
No timers. Works alone when opened with `tab.new {mod: "start-tab"}`. A program exiting in the last tab (`exit` in the shell) still closes the space; Herdr has no hook for that.
