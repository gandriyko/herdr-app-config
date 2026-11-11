---
name: history
summary: Search and read past agent sessions (Claude, Codex, ...) via the human-history tool, with resume
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/history
install: copy the folder mods/history into ~/.config/herdr-app/mods/history
place: none
needs: [human-history, sh, env, open]
shared_keys: []
reads_keys: []
commands: [tab.new (resume a session in a new tab)]
---

## What it does
Lists the latest agent sessions of the active space's project, or searches prompts and answers while typing. A click opens the conversation as Markdown (paged), with favorite, copy session id and Resume (new tab running the agent's resume command). If `human-history` is missing it shows an install hint with a link to the repository.

## Files
- main.js: the whole mod (human-history calls, search, viewer, resume table).
- icons/*.svg: back, copy, messages, refresh, star, star-outline, title icons.
- icons/agents/*.svg: agent logos shown in each list row (claude, codex, opencode, copilot, pi, hermes; agent for any other), copied from Herdr's shipped `icons/`.

## Settings and data
- localStorage: `scope` (titles only or prompts and answers).
- human-history keeps its own index and favorites.

## Notes
- Limit 50 results, 30 messages per page.
- Timers: `human-history index` every 5 min, 2 s check for a changed space/folder, 250 ms search debounce.
- Standalone. Needs `human-history` on PATH or at `~/.cargo/bin/human-history` (Herdr started from the Dock has a short PATH, so the mod tries both).
