---
name: machine-add
summary: Dialog that finds SSH hosts and adds them as machines with one click
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/machine-add
install: copy the folder mods/machine-add into ~/.config/herdr-app/mods/machine-add
place: none
needs: [hc, ssh config via hc, sh, open]
shared_keys: []
reads_keys: []
commands: [hc machine add/ls; opened via mod.open machine-add from sidebars/welcome]
---

## What it does
Dialog (560 px) that lists candidate hosts (and accepts a typed one), adds each with `hc machine add`, and shows per-host state. When a host needs interactive input (password, host key, installing herdr-core) it tells the user the command to run in a terminal. It also checks the remote OS and, on macOS, can open the Full Disk Access settings.

## Files
- main.js: the dialog (host discovery, add, remote checks).
- circle-check.svg, spinner.svg, server.svg: own copies of the icons used.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
- Timer every 3 s re-reads `hc machine ls --json` while open.
- Designed to be opened by other mods (`mod.open machine-add`).
