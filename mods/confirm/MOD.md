---
name: confirm
summary: Confirmation dialog that runs an app command on Enter
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/confirm
install: copy the folder mods/confirm into ~/.config/herdr-app/mods/confirm
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [runs the command given in props.command (name, args) via run()]
---

## What it does
Dialog opened with props `{ title, detail, command: { name, args } }` (for example "Close space?"). Enter or the confirm button closes the overlay and runs the command; Esc or Cancel only closes it.

## Files
- main.js: the dialog.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
- No polling, no state; standalone.
