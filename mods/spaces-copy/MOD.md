---
name: spaces-copy
summary: Sidebar list of spaces by machine, worktrees nested under their repo; its right-click menu is menu-copy.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/spaces-copy
install: copy the folder mods/spaces-copy into ~/.config/herdr-app/mods/spaces-copy
place: none
needs: [git, menu-copy (optional), machine-add (optional)]
shared_keys: [space.colors]
reads_keys: [space.colors]
commands: [space.new, space.select, overlay mod menu-copy (space context menu), overlay mod machine-add]
---

## What it does
The stock `spaces` sidebar: spaces grouped by machine, stable coloured avatars, worktree spaces nested under their repo's space, branch, ahead/behind and uncommitted changes. Differs from the stock mod only in opening `menu-copy` on right-click (for Remove all worktrees) and in its own icons. Cloned from the stock `spaces` mod 0.1.17.

## Files
- main.js: the sidebar.
- plus.svg, branch.svg, server.svg, monitor.svg, chevron-*.svg: icons.
- mod.json: cloned_from spaces 0.1.17.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
Shared key `space.colors` (Herdr's own key, kept as is so avatars match other Herdr mods): space id to colour. localStorage `machines.folded`, `machines.reconnecting`.

## Notes
Used by `layouts/my-layout.json`. Without `menu-copy` the right-click opens nothing.
