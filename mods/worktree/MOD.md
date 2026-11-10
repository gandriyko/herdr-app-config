---
name: worktree
summary: Dialog to create, open or remove git worktrees for a space, locally or on a remote machine.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/worktree
install: copy the folder mods/worktree into ~/.config/herdr-app/mods/worktree
place: none
needs: [git, powershell.exe (Windows remote home lookup only)]
shared_keys: []
reads_keys: []
commands: [space.new, space.select, space.close]
---

## What it does
Dialog with props `{ space, action: "new" | "open" | "remove" }` (or `{ folder, machine }`, optional `branch`, `tab`, `argv`). New: creates a branch checkout in `~/.herdr/worktrees/<repo>/<branch-with-dashes>` with `git worktree add` and opens it as a new space. Open: filterable list from `git worktree list` (also submodule repos), selecting switches to its space or opens one. Remove: `git worktree remove` (forced when submodules exist) and closes the space.

## Files
- main.js: the dialog view and the git helpers.
- mod.json: place none.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
none. Checkouts live under `~/.herdr/worktrees` (on the remote machine's home for remote spaces).

## Notes
Works on remote machines through the `on` option of `exec`. One `cx.timer.after(600)` to refocus the input; no polling. Standalone: no imports from other mods.
