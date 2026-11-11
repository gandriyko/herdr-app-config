---
name: prs
summary: Panel listing my open GitHub PRs for the focused repo, with detail, approve, create-PR and AI review/description.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/prs
install: copy the folder mods/prs into ~/.config/herdr-app/mods/prs
place: none
needs: [gh, git, claude CLI (optional), codex CLI (optional), local OpenAI-compatible server (optional), open (macOS)]
shared_keys: [prs.changed, wb.ai.models, wb.ai.use, wb.ai.project, wb.ai.localMigrated, wb.ai.projectMigrated, wb.<key> (migration copy)]
reads_keys: [wb.ai.models, wb.ai.use, wb.ai.project, wb.commit.gen (legacy migration), unprefixed legacy ai.* keys (migration)]
commands: [mod.open prs (dialog for PR detail and create), mod.open wb-ai (model settings: dialog and window)]
---

## What it does
Lists open PRs authored by me (first 100, via gh) in the repo of the focused folder, with CI, review, approval and Copilot-review state. Click opens a dialog with description, comments and reviews; buttons open the PR in the browser, copy the link, approve, or generate an AI review.
A create-PR dialog (the header's + button) pushes the branch and runs gh pr create, with an AI-written title and description.

## Files
- main.js: panel view, gh calls, PR detail and create dialogs.
- ai.js: AI model settings and runner shared across mods (copy of mods/wb-ai/ai.js): claude/codex CLIs or a local server.
- approved.svg, changes.svg, draft.svg, plus.svg, pr.svg, refresh.svg: status and button icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
localStorage `prs.auto` (old unprefixed `auto` is read as fallback): auto-refresh on/off. Shared `wb.ai.*` keys hold the AI model list, per-use model and per-project templates (owned by the wb-ai mod; migrated from older `wb.*` keys). No keychain.

## Notes
Polls gh every 60 s when auto is on, checks the focused folder and prs.changed every 2 s (cheap compare). Diff sent to AI is capped at 60000 chars, CLAUDE.md at 8000. gh and AI calls have timeouts (120-600 s). Works without the `wb.ai.*` keys but AI features need a model configured in wb-ai.
- ai.js is an intentional per-mod copy (isolation rule) with the same origin as wb-ai/ai.js; the `wb.ai.*` settings are shared on purpose with wb-ai, prs and changes-copy (documented contract, optional where read, defaults are created).
