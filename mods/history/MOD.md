---
name: history
summary: Search and read past agent sessions (Claude, Codex, ...) via the human-history tool, with resume and an AI mode that asks Claude about them
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/history
install: copy the folder mods/history into ~/.config/herdr-app/mods/history
place: none
needs: [human-history (with `mcp` and its `query` tool for AI mode), claude or codex (AI mode only), sh, env, open, git, test, wb-ai mod (optional, to pick the AI mode model)]
shared_keys: []
reads_keys: [wb.ai.models, wb.ai.use, wb.ai.project (via ai.js, written by wb-ai; optional)]
commands: [tab.new (resume a session in a new tab)]
---

## What it does
Lists the latest agent sessions of the active space's project, or searches prompts and answers while typing. A click opens the conversation as Markdown (paged), with favorite, copy session id and Resume (new tab named after the session title, running the agent's resume command). Props for opening it as an overlay or a block inside another mod's dialog (the jira mod's Start session): `query` (starts with that search), `folder` (searches that folder's project instead of the active space's), `embedded` (no frame of its own, only a top rule). In an overlay, Resume closes it. If `human-history` is missing it shows an install hint with a link to the repository.

AI mode (the sparkles button next to the search scope): a separate box takes a question in plain words; Enter runs the "History AI" model from the AI models window (wb-ai; the model line above the answer opens it). Nothing picked or wb-ai missing: Claude haiku. Claude or Codex only (local models can't call MCP tools). Codex runs `codex exec` read-only with `-c mcp_servers={human-history=...}` (only that server) and shows no cost. Claude runs `claude -p --model <model>` with only the `human-history mcp` server (`--strict-mcp-config`), no built-in tools (`--tools ""`), no user settings (`--setting-sources ""`) and the tools `search_sessions`, `read_session` and `query` (read-only SQL over the index, enforced by human-history). The prompt names the active project folder and its shared git dir and tells Claude to search only that project; sessions of other projects that Claude still names are dropped from the rows (matched by `sessions.repo`, else the folder). The prompt also gives today's date, asks for a short Markdown answer in the question's language and a last line `SESSIONS: <id> ...`. The panel shows the question, the answer, turns and cost, and up to 8 sessions it named (rows like search results: open, favorite, resume).

## Files
- main.js: the whole mod (human-history calls, search, viewer, resume table).
- ai.js: copy of lib/ai.js (model registry, codex runner); edit lib/ai.js, then scripts/sync-lib.
- icons/*.svg: back, copy, messages, refresh, sparkles (AI mode), star, star-outline, title icons.
- icons/agents/*.svg: agent logos shown in each list row (claude, codex, opencode, copilot, pi, hermes; agent for any other), copied from Herdr's shipped `icons/`.

## Settings and data
- localStorage: `scope` (`both` prompts and answers, `title` titles only, `ai` AI mode).
- The last AI answer and its session rows stay in memory until the next question; `show --json` messages fetched to list a session are dropped at once.
- human-history keeps its own index and favorites.

## Notes
- Resume opens the tab in the session's space: the active space when one of its terminals (or its folder) is in the session's repo, else the first local space that is; with none, the active space. One `git rev-parse` per space folder, only on Resume.
- Resume when the session's folder is gone (a removed worktree): opens it in the main checkout of the active space's repo and says so. For Claude it first copies `~/.claude/projects/*/<id>.jsonl` into that checkout's project dir (Claude finds a session only there); other agents resume by id from any folder.
- Limit 50 results, 30 messages per page.
- AI mode: one question costs about $0.005 and 10-13 s on haiku (measured on 3 questions, 4-6 turns; the default model, Opus, gave the same sessions for $0.13-0.23 and 14-24 s). Haiku sometimes writes `claude:<id>` in the SESSIONS line; the prefix is stripped. `claude` runs with stdin closed (else `-p` waits 3 s) and, when it isn't on Herdr's PATH (started from the Dock), through the interactive shell like lib/ai.js. The MCP server gets human-history's full path. 10 min timeout. A newer question drops the older answer, but the older `claude` runs to its end (exec can't be cancelled). Nothing runs on a timer in AI mode.
- Timers: `human-history index` every 5 min, 2 s check for a changed space/folder, 250 ms search debounce.
- Standalone. Needs `human-history` on PATH or at `~/.cargo/bin/human-history` (Herdr started from the Dock has a short PATH, so the mod tries both).
