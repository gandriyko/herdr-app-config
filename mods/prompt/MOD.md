---
name: prompt
summary: Small text-entry dialog that runs a Herdr command with the typed name.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/prompt
install: copy the folder mods/prompt into ~/.config/herdr-app/mods/prompt
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [any command passed in props (e.g. tab.rename, space.rename) with name added]
---

## What it does
Dialog with one input, pre-filled with props.value and selected. Enter runs props.command.name with its args plus { name: <text> }; Esc cancels.

## Files
- main.js: the prompt view.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
Standalone. Re-focuses the input 600 ms after opening (one-shot timer). No polling.
