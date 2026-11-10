---
name: changes-copy
summary: Changes panel (clone of changes) with list/tree views, side-by-side diff tab and AI commit messages
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/changes-copy
install: copy the folder mods/changes-copy into ~/.config/herdr-app/mods/changes-copy
place: none
needs: [git, claude CLI or codex CLI or local OpenAI-compatible server (http://localhost:11434/v1 default), sh]
shared_keys: [wb.ai.models, wb.ai.use, wb.ai.project, wb.ai.localMigrated, wb.ai.projectMigrated, wb.diff.request, branch.switched]
reads_keys: [wb.ai.models, wb.ai.use, wb.ai.project, wb.commit.gen (legacy migration), unprefixed legacy ai.* keys (migration)]
commands: [tab.new/tab.select/tab.rename, mod wb-diff (tab), mod wb-ai (window/dialog overlays)]
---

## What it does
Extended copy of `changes`. Shows uncommitted or branch-scope changes as list or tree, commits/pushes, and opens a clicked file in a side-by-side diff tab (`wb-diff`). It generates commit messages and reviews through a configurable model (Claude CLI, Codex CLI or a local OpenAI-compatible server) with per-project settings edited in `wb-ai`.

## Files
- main.js: panel UI, git calls, watching, commit/push, diff tab opening.
- ai.js: model registry, per-project settings, migrations, prompt running (`runModel`).
- changes.svg, icons/*.svg: panel icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- localStorage: `view` (list/tree), `scope`, `commitH` (commit box height).
- Shared state holds the AI model list, chosen models and per-project settings (see keys above).

## Notes
- Timers: 10 s refresh, 2 s context check; `watchFolder` with a generation flag; git calls time out at 180 s, AI runs at 600 s.
- Depends on mods `wb-diff` and `wb-ai` being installed for diff tab and AI settings.
- `wb.diff.request` (read by wb-diff) and `branch.switched` (read by status-copy) are documented contracts; optional where read.
- ai.js is an intentional per-mod copy (isolation rule) with the same origin as wb-ai/ai.js; the `wb.ai.*` settings are shared on purpose with wb-ai, prs and changes-copy (documented contract, optional where read, defaults are created).
