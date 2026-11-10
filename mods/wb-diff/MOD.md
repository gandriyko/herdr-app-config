---
name: wb-diff
summary: Side-by-side diff viewer with syntax highlighting, opened as a tab for a changed file or commit.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/wb-diff
install: copy the folder mods/wb-diff into ~/.config/herdr-app/mods/wb-diff
place: none
needs: [git]
shared_keys: []
reads_keys: [wb.diff.request (written by the Changes panel)]
commands: [tab.close]
---

## What it does
PhpStorm-style two-column diff in a main-area tab. It loads `git diff` (or the whole file, or a single commit's change) for the path in its request, highlights lines per language, shares vertical scroll between sides, scrolls each side horizontally, jumps between hunks, and can wrap lines. A new file clicked in Changes swaps the file of the same tab.

## Files
- main.js: view, git reading (`git --no-optional-locks ... diff --no-ext-diff`), hunk parsing, row layout, scrollbars.
- highlight.js: per-line syntax highlighter (code, markup and css modes), no multi-line state.
- icons/: chevron-left, chevron-right, close, diff, file, wrap (svg).
- mod.json: place none.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
localStorage key `wb-diff.wrap` ("1" when line wrap is on; the old `wrap` key is read once as a fallback). Reads the shared request `wb.diff.request` `{ root, on, path, against, fresh, commit, space, ts }`; first open gets it through props.

## Notes
No polling: render() notices a newer `wb.diff.request` (shared state changes rerun it) and schedules the load with a one-shot timer. `wb.diff.request` is a documented contract with changes-copy (writer); optional where read, works without a request (shows nothing). Esc closes the tab.
