---
name: wb-ai
summary: AI model registry and per-project settings window used to generate commit messages, reviews and MR descriptions.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/wb-ai
install: copy the folder mods/wb-ai into ~/.config/herdr-app/mods/wb-ai
place: none
needs: [claude CLI, codex CLI, local OpenAI-compatible server (HTTP, /models and /chat/completions), git, sh, rm]
shared_keys: [wb.ai.models, wb.ai.use, wb.ai.project, wb.ai.localMigrated, wb.ai.projectMigrated, and legacy copy from unprefixed ai.models / ai.use / ai.project to wb.*]
reads_keys: [wb.commit.gen (legacy migration only, optional), unprefixed legacy ai.* keys (migration)]
commands: [overlay mod wb-ai (window and dialog, itself)]
---

## What it does
A window to add, edit and delete AI models (provider claude, codex or local URL) and a per-use dialog (commit, review, mr) to choose model, language and prompt template for one project or for all projects (`*`). `ai.js` also runs the generation: spawns `claude -p`, `codex`, or POSTs to a local server, with a 10 minute exec timeout.

## Files
- main.js: the models window and the project settings dialog.
- ai.js: shared logic (storage in shared keys, migrations, projectKey from `git remote get-url origin`, generate/list local models). Header says it is the same file copied into changes-copy and prs; the canonical copy is here.
- icons/: chevron-down.svg, settings.svg, x.svg.
- mod.json: title "Commit generation".
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
All in shared state (`wb.ai.*`, see shared_keys); no keychain, no localStorage. Project key is `<host>|<path>` of the origin remote.

## Notes
No timers. Other mods (changes-copy, prs) read the `wb.ai.*` keys through their own copy of ai.js. their ai.js is an intentional per-mod copy (isolation rule) of this canonical file; the `wb.ai.*` settings are shared on purpose with wb-ai, prs and changes-copy (documented contract, optional where read, defaults are created). A missing model list is recreated with defaults.
