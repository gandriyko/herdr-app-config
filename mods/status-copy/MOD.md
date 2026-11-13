---
name: status-copy
summary: Status bar piece showing the active space's git branch, a keep-awake button and a command-palette hint.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/status-copy
install: copy the folder mods/status-copy into ~/.config/herdr-app/mods/status-copy
place: none
needs: [git, caffeinate (macOS) or systemd-inhibit (Linux) for keep-awake, ps, kill]
shared_keys: [status-copy.awake]
reads_keys: [branch.switched]
commands: [app.palette, mod.open branch-picker (popup), mod.open status-copy (its own keep-awake popup)]
---

## What it does
Shows the active space's branch with ahead/behind counts, a machine or server icon, and the key bound to the command palette (or 'commands'). Clicking the branch opens the branch picker above the bar; clicking the hint runs app.palette. Cloned from workspace-status 0.1.14.

A coffee button keeps the computer awake: its popup offers "Allow sleep", "While an agent is working" and 1, 2, 3 or 5 hours. The bar runs `caffeinate -ims -t <secs>` on macOS or `systemd-inhibit --what=idle:sleep sleep <secs>` on Linux, whichever is on PATH (neither: no button); the display may sleep. It runs it in agent mode while any agent's status is `working` (10-minute runs, renewed), in timed mode until the chosen time, with the time left next to the icon. The icon turns the "working" color while it runs.

## Files
- main.js: the status view, git status reads, keep-awake button, popup and caffeinate control.
- icons/: branch.svg, monitor.svg, server.svg, coffee.svg, check.svg.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Shared state `status-copy.awake` ({ mode: "off" | "agents" | "timed", until }), written by the popup, acted on by the bar.
- `localStorage` `caffPid`: the running caffeinate / systemd-inhibit pid, ended on the next start after a reload or crash.

## Notes
`branch.switched` (timestamp written by branch-picker and changes-copy) is a documented contract; optional where read, works without it. It refreshes after a checkout. On this computer it also watches the repo's git common dir (`watchFolder`) and asks again when a HEAD or a ref under refs/heads, refs/remotes moves, so a pull, commit or checkout from a terminal, or a pull whose popup was closed early, shows within 2 s. Checks every 2 s by cheap compare, runs git status -uno at most every 30 s per place, one at a time. Needs the `branch-picker` mod for the click action.

Keep-awake: the same 2 s tick compares the choice with what runs; the program is started or killed only on a change. Each run has its own time limit, so one left by a crash ends by itself; `close()` and the next start kill it (only if the pid is still caffeinate or systemd-inhibit). macOS: lid-close sleep on battery is not blocked (`caffeinate -s` only works on power). Linux: a lid switch handled by logind may still suspend (`handle-lid-switch` is not inhibited); systems without systemd get no button.
