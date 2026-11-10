---
name: workspace-chrome
summary: Sidebar header and footer: Herdr title, search, sidebar collapse toggle, Settings and Add machine rows.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/workspace-chrome
install: copy the folder mods/workspace-chrome into ~/.config/herdr-app/mods/workspace-chrome
place: none
needs: []
shared_keys: [sidebar.width, sidebar.collapsed]
reads_keys: [sidebar.width]
commands: [app.settings, layout.resize, mod.open picker (search), mod.open machine-add (Add machine)]
---

## What it does
Header (default): Herdr logo and name, a search button opening `picker`, and a button that collapses the sidebar to a rail (76px on macOS for the traffic lights, 44px elsewhere) and back to the saved width. With prop `footer` it renders the sidebar footer: Settings (with a dot when an app update is ready) and Add machine. The rail is detected by sidebar width below 160px.

## Files
- main.js: header and footer views, toggleSidebar.
- *.svg (about 30 files): icon set; other mods' views in this layout (workspace-status etc.) may also reference them.
- mod.json: place none.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
Shared state `sidebar.width` (width before collapsing, default 268) and `sidebar.collapsed` (legacy flag). No localStorage, no keychain.

## Notes
No timers or external programs. Uses `image("frame/welcome/herdr.png")` from the app. `sidebar.width` and `sidebar.collapsed` are a documented contract with agents (both write them); optional where read (width falls back to 268). Opens `picker` and `machine-add` mods; missing mods mean dead buttons.
