---
name: wb-diff
summary: Diff viewer (side by side or unified) with syntax highlighting that scrolls through all changed files in one tab.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/wb-diff
install: copy the folder mods/wb-diff into ~/.config/herdr-app/mods/wb-diff
place: none
needs: [git]
shared_keys: []
reads_keys: [wb.diff.request (written by the Changes panel)]
commands: [tab.close]
---

## What it does
PhpStorm/Zed-style diff in a main-area tab. It loads `git diff` for every file in its request (the Changes panel's list, in the panel's order; a single file for a commit) and shows them one after another in one scroll, each under a header (status, name, folder, +/− counts) that stays pinned at the top while its rows scroll. A click on another file of the same set only scrolls to it; a different set or changed line counts reload. Side-by-side or unified layout (toolbar toggle), hunks only or whole files, line wrap, per-language highlighting. Added and removed rows get a green/red background mixed from the theme, and inside a removed/added pair the changed words a stronger one (token LCS, skipped when the lines share under 40% or exceed 500 chars). Hunk separators show how many unchanged lines are hidden and reveal them 20 at a time above or below, or all when 20 or fewer (the file's new side is read once: working tree, or `git show <commit>:<path>`). Code colors come from the theme but are lifted to WCAG contrast on its background: comments and syntax ≥ 4.5:1 (the normal or bright ansi variant, whichever contrasts more), line numbers ≥ 3:1. Alt+↑/↓ jump between changes across files, Alt+Shift+↑/↓ between files. A click on a file header folds the file to its header or opens it; with more than one file the toolbar folds all files or shows them all. Folds last while the tab shows the same files; a file picked in the Changes panel opens unfolded.

## Files
- main.js: view, git reading (one `git --no-optional-locks ... diff --no-ext-diff -- <paths>` for all tracked files, `readTextFile` for untracked ones), per-file hunk parsing, row layout (split/unified), context reveal, scrollbars.
- highlight.js: per-line syntax highlighter (code, markup and css modes), no multi-line state.
- icons/: chevron-left, chevron-right, close, diff, file, wrap, split, unified, chevron-down, expand-up, expand-down, expand-all, collapse-all, expand-files (svg).
- mod.json: place none.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
localStorage keys `wb-diff.wrap` ("1" when line wrap is on; the old `wrap` key is read once as a fallback) `wb-diff.layout` ("unified", the default, or "split") and `wb-diff.mode` ("diff", the default: hunks only, or "file": whole files). Reads the shared request `wb.diff.request` `{ root, on, path, against, status, fresh, commit, files, space, ts }`, where `files` is an optional list of `[path, status, fresh, add, del]` (without it only `path` is shown); first open gets it through props.

## Notes
No polling: render() notices a newer `wb.diff.request` (shared state changes rerun it) and schedules the load with a one-shot timer. `wb.diff.request` is a documented contract with changes-copy (writer); optional where read, works without a request (shows nothing). Caps: 300 files, 20000 lines per file, 100000 lines in all (files past it show a note); git calls time out at 60 s. File texts read for revealing are dropped on the next load. Esc closes the tab.
