---
name: files-copy
summary: File tree (clone of files) that opens a file in its own tab to view or edit (⌘S saves); in Python files ⌘-hover underlines a name and ⌘-click jumps to its definition via jedi.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/files-copy
install: copy the folder mods/files-copy into ~/.config/herdr-app/mods/files-copy
place: none
needs: [sh, git, find (filter outside git), uv (uvx fetches jedi on first use; Python go-to-definition only), curl (web images in Markdown)]
shared_keys: [files-copy.open]
reads_keys: [wb.diff.request (root of the focused diff tab; optional)]
commands: [tab.new (files-copy with props), tab.select, tab.rename]
---

## What it does
In a side panel: a lazy file tree for the focused pane's folder (500 entries per folder, 5,000 total) with
git marks. Files and folders whose names start with a dot are hidden; the `.*` button in the header shows
them. Cloned from the shipped `files` mod.

The input above the tree filters it: every word typed must be in a file's path (case-insensitive), and the
tree then shows only the matching files with their folders, all open (first 500 matches). With dot files
hidden, a dot file or folder still matches when a typed word is in its name (`env` finds `.env.local`). The list comes
from `git ls-files -co --exclude-standard` (tracked and untracked) plus ignored files outside ignored folders
(`git ls-files -oi --exclude-standard --directory`, so `.env.local` but not `node_modules/`), or `find` outside git
(skips node_modules), at most 20,000 files; it is asked again on each refresh while a filter is typed.
↑/↓ in the input move a highlight over the matching files (wrapping, the list scrolls to it); Enter opens
the highlighted file, or the first match when none is.
Esc or the × in the input clears the filter and brings back the normal tree. Each place (space and
folder) keeps its own filter text, open folders and last file while the panel lives; switching spaces
swaps them.

The panel follows the focused terminal's folder; while a file tab (or a `wb-diff` tab, via `wb.diff.request`) is focused it stays on that tab's root folder, and while another mod's tab is focused it keeps the folder it had.

A click on a file opens it in a tab: a syntax-highlighted editor at full height. One tab per space is reused, as Changes does with its diff tab; the tab is named after the file.

Editing: local files under 400,000 chars are editable (a remote space's or a truncated file is read-only).
Unsaved edits put ● after the path and a Save button in the header; ⌘S or Save writes the file with
`writeTextFile`, only if the file on disk is still what was opened (else the footer says it changed and the
edits stay). Opening another file in the tab or going back/forward saves first; a failed save keeps the
file open. Closing the tab with unsaved edits opens a "Save changes?" dialog (this mod, kind dialog, the edits
in its props): Save writes them with the same guard, Don't save or Esc drops them. On app quit there is no
dialog and unsaved edits are lost. A Markdown file (`.md`, `.markdown`) opens rendered (read-only, text
selectable, unsaved edits included); the Source button shows its text, Preview goes back. The × at the end of the header closes the tab (unsaved edits ask first). Edit shows only with the source, not over the rendered view.

Find in file: a find field (with counter and ↑/↓) sits in the tab header for a searchable file (⌘F focuses it; case-insensitive, Enter next, ⇧Enter
previous, Esc clears it, counter `3/12`, first 1,000 hits, then `+`). It searches whatever the tab shows:
the line view (Python, `.env`, Markdown source) tints every hit and centres the current one; the editor
selects the current hit; rendered Markdown matches the visible words only (link targets, image sources and
markup excluded) and marks the block that holds the hit with an accent edge and scrolls to it, because the text
view can't highlight words. For this, Markdown is cut into blocks at blank lines before a paragraph or heading
(never inside a fence or HTML block, or when the file has reference links).

While a file is edited in the editor, the ⇄ button after the find field shows a replace row (collapsed by default; Esc in its field hides it) under the header with a Replace field and Replace (current hit; Enter in the field does the same) and All buttons; Replace all is one edit (not several undo steps).

Find options (remembered): `Aa` match case, `W` whole word, `.*` regular expression (an invalid one says so; Replace may use `$1`, `$&`). Ctrl-F (⌘F is the app's terminal search) focuses the field, also in the editor, where the binding is made in the editor's context so other mods' editors lose their own Ctrl-F and takes a one-line selection as the query. ⌘G / F3 step to the next hit, with Shift the previous. Replace all is one edit.

Editing helpers: ⌘L or Ctrl+G opens a go-to-line field under the header (Enter jumps). Revert (shown with unsaved edits; click twice within 3 s) drops the edits and loads the file from disk. Auto-save (header toggle, remembered in localStorage `files-copy.autosave`) saves 1.5 s after the last edit. The open local file is read again every 3 s while its tab is on screen: if it changed on disk it reloads when untouched, otherwise the footer says so and Revert loads it. F12 in the editor on a Python name jumps to its definition (jedi reads the saved file; the caret moves there). For Markdown in the editor, Split shows the rendered text beside it, following the typing.

Rendered Markdown opens behind a "Loading…" cover until its pictures are fetched and the text has settled
(150 ms after the last picture, at most 3 s), then shows in one redraw instead of popping in piece by piece.


Images: the app draws pictures only from its own folder, so each one is copied into `data/files-copy/images`
(a local file named by path hash and mtime; a web image downloaded with `curl`, 20 s / 20 MB limits, kept by
URL) and drawn from there; the folder keeps the newest 300 files. In rendered Markdown a line holding images
(`![alt](src)`, linked ones, `<img src=… width=…>`) becomes its own row of pictures, with the rest of the line
(e.g. a heading's text) beside them; relative sources resolve against the file's folder. TextView itself draws
no images, so the text around them is rendered in separate blocks (a paragraph with an image inside is split
there; fenced code is left alone). A picture that can't be had (missing, `data:`, a remote space's file, more
than 200 in one document) shows as `[alt]`. Picture files (png, jpg, gif, webp, bmp, ico, tiff) open as the
picture, scaled down to the width (local only); an `.svg` opens as the picture too, with Source/Preview as for
Markdown (Preview shows it as saved).

Markdown (`.md`, `.markdown`) is drawn by the mod's own view too (the editor leaves it uncoloured), with
highlight.js's line-by-line Markdown colours (headings, `code`, **bold**, links, fences).
`.env*` files are drawn by the mod's own view too (below), coloured line by line with highlight.js's shell
rules, so one unbalanced quote in a value (`PASS=it's`) colours only its own line, not the rest of the file
as a multi-line grammar would; their Edit opens the editor as plain text for the same reason.

Other files use the built-in editor. A `.py` file is drawn by the mod itself (fixed row height and
character width, own scrolling), so it knows which name is under the pointer: with ⌘ held that name is
underlined and the pointer is a hand. ⌘-click opens its definition: in the same file, or the tab switches
to another file, including files outside the folder (stdlib, site-packages). The clicked name stays tinted
and a spinner turns in the header while jedi looks; the definition's line is scrolled to the vertical
middle of the view and its name tinted. ← / → in the tab header, ⌘[ / ⌘] or Ctrl+- / Ctrl+Shift+- go
back and forward through jumps (file and scroll position); a new jump drops the forward history. Mouse
side buttons work only when mapped to ⌘[ / ⌘] (Logi Options+, SteerMouse, BetterTouchTool): the mod API
reports only the left, right and middle buttons. The view is read-only with a caret: a click places it, drag or Shift+click selects,
double-click selects a word, triple-click a line; arrows (Shift extends), Home/End, PageUp/PageDown,
⌘←/⌘→ (line indent/end), ⌘↑/⌘↓ (file start/end) move it; ⌘A selects all and ⌘C copies. Typing changes
nothing there by itself: in an editable file a typed key (a character, Enter, Tab, Backspace, Delete) switches
to the built-in editor with the same caret or selection and applies the key there; the Edit button does the
switch too (⌘-click definitions
are off until the file is opened again). The wheel scrolls. Other languages have no go-to-definition.

## Files
- main.js: the panel (tree), the file tab (same class, opened with props) and go-to-definition (the jedi
  script is the `GOTO` string, so it also runs on remote machines).
- highlight.js: per-line syntax highlighter for the Python view (copied from wb-diff).
- chevron-down.svg, chevron-right.svg, file.svg, folder.svg: tree icons; spinner.svg: while finding; close.svg: clears the filter.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Shared state `files-copy.open` ({ space, root, on, path, ts }): written by the panel on a click (and by
  wb-diff's Open in Files button: a documented contract, keep the shape), read by that space's file tab.
- `localStorage` `files-copy.hidden`: "1" when dot files are shown.
- `data/files-copy/images/`: copies of the pictures shown (newest 300 kept); safe to delete.
- The jedi run uses the project's `.venv` or `venv` (in the pane's folder) when present, otherwise the
  Python uvx picks. Imports resolve from the folder above the file's top package (the first parent
  without `__init__.py`, e.g. a service folder inside a monorepo), with the pane's folder on `sys.path`.

## Notes
Each jump runs one `uvx --with jedi python -c …` (20 s timeout, one at a time) that exits when done, about
0.3–2 s; the status line under the code says why a jump failed. The pointer-to-name mapping assumes a
monospace font at 0.6 em (JetBrains Mono, Menlo, SF Mono); a tab character is drawn as 4 spaces.
