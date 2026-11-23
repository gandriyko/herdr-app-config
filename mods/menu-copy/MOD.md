---
name: menu-copy
summary: Context menu for a space (rename, New/Open/Remove worktree, Remove all worktrees, close) and other targets.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/menu-copy
install: copy the folder mods/menu-copy into ~/.config/herdr-app/mods/menu-copy
place: none
needs: [git]
shared_keys: []
reads_keys: []
commands: [space.rename, space.close, tab.rename, tab.new, tab.close, pane.rename, pane.split, pane.zoom, pane.close, terminal.right_click, terminal.park, app.help, app.theme, overlay mod worktree, overlay mod menu-copy (Remove all worktrees dialog)]
---

## What it does
The stock `menu` popup. For a space in a git repo it adds "Remove all worktrees": a dialog (this mod opened again with props `{ clean: { folder, machine } }`, clean.js) that lists the repo's linked worktrees and, on Enter, runs `git worktree prune` and then `git worktree remove` (never `--force`) on each and closes the spaces inside the removed ones. git refuses a worktree with uncommitted or untracked changes, submodules or a lock; the dialog skips it and shows git's reason. A detached worktree with commits on no branch is skipped too. Branches stay; the main checkout is never touched. Cloned from the stock `menu` mod 0.1.17.

## Files
- main.js: the menu.
- clean.js: the Remove all worktrees dialog.
- *.svg: item icons.
- mod.json: cloned_from menu 0.1.17.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
None.

## Notes
Opened by `spaces-copy` (space right-click). Ignored files (e.g. copied `.env`) are deleted with their worktree, as `git worktree remove` does.
