---
name: win98
summary: Windows 98 look: taskbar, desktop, pane title bars, Start menu, dialogs, Minesweeper, Solitaire and Clippy.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/win98
install: copy the folder mods/win98 into ~/.config/herdr-app/mods/win98
place: none
needs: [xdg-open or open (opens links), sh, ps (uptime), hc CLI (machine ls), optional agent CLIs checked with command -v (claude, codex, pi, opencode, amp, gemini, cursor-agent, copilot, grok, kimi, crush); Bun, ImageMagick, FFmpeg only for art generators]
shared_keys: [win98.apps, win98.boot, win98.clippy, win98.desktop, win98.init, win98.menu.owner, win98.menus, win98.mines, win98.mines.req, win98.mute, win98.run, win98.scale, win98.sol.deck, win98.sol.draw, win98.sol.req, win98.sol.scoring, win98.start, win98.welcome]
reads_keys: []
commands: [space.select, space.new, tab.select, tab.settle, pane.focus, pane.zoom, pane.close, agent.focus, layout.switch, layout.resize, layout.set, window.close; overlays of itself (role dialog, menu, mines, sol)]
---

## What it does
One mod with many roles, chosen by `props().role` in main.js: taskbar (Start, quick launch, tab windows, agents tray, speaker, clock), desktop icons, pane window title bars, menus (incl. Start), dialogs (Run, Shutdown, About, Display Properties, Welcome, boot screen...), Minesweeper, Solitaire and the Clippy assistant for agents. Works with a `layouts/win98.json` layout and `themes/win98.json` theme; fonts and sounds are bundled.

## Files
- main.js: role router. kit.js: Win98 drawing helpers (bevels, buttons, title bars), scale, sounds, app state.
- taskbar.js, desktop.js, window.js, menu.js, dialog.js: shell parts. mines.js, sol.js, clippy.js: games and assistant.
- icons/ (svg), img/ (png), sounds/, fonts/ (Pixelated MS Sans Serif, PxPlus IBM VGA with licenses), art/ (Bun generators, logo.svg).
- README.md: layout, keys and art generator usage. mod.json: place none.

## Settings and data
All state is shared keys prefixed `win98.` (see shared_keys). Keys in keys.json section `layout:win98`, e.g. `win98.start`. No keychain or localStorage.

## Notes
Timers: 60 s clock tick aligned to the minute; 1 s only while the Date/Time dialog is open; startup dialogs use one-off delays. Imports stay inside the folder. Needs a custom layout/theme to look right; standalone otherwise.
