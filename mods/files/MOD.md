---
name: files
summary: Lazy file browser for the focused pane's folder with git marks and read-only previews
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/files
install: copy the folder mods/files into ~/.config/herdr-app/mods/files
place: none
needs: [git, sh (powershell on Windows)]
shared_keys: []
reads_keys: []
commands: []
---

## What it does
Tree of the focused pane's folder, loaded lazily per directory (local or remote machine). Files carry git status marks. Clicking a file shows a read-only preview in an editor. It refreshes when the folder changes.

## Files
- main.js: the whole mod (listing, git marks, preview, watching).
- chevron-down.svg, chevron-right.svg, file.svg, folder.svg: tree icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
none

## Notes
- Refresh every 10 s plus `watchFolder`.
- Limits: 500 entries per folder, 5000 total (a note is shown), previews cut at 400000 chars.
- Standalone.
