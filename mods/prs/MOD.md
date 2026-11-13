---
name: prs
summary: Panel listing my (or all) open GitHub PRs for the focused repo, with detail, approve, create-PR and AI review/description.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/prs
install: copy the folder mods/prs into ~/.config/herdr-app/mods/prs
place: none
needs: [gh, git, claude CLI (optional), codex CLI (optional), local OpenAI-compatible server (optional), open (macOS)]
shared_keys: [prs.changed, wb.ai.models, wb.ai.use, wb.ai.project, wb.ai.localMigrated, wb.ai.projectMigrated, wb.<key> (migration copy)]
reads_keys: [wb.ai.models, wb.ai.use, wb.ai.project, wb.commit.gen (legacy migration), unprefixed legacy ai.* keys (migration)]
commands: [mod.open prs (dialog for PR detail and create), mod.open wb-ai (model settings: dialog and window)]
---

## What it does
Lists open PRs authored by me plus those where my review is requested (two gh calls), or with the header's Mine/All switch every open PR (first 100, via gh; the Copilot sound and toast stay for PRs I opened). A PR waiting for my review (requested from me by login, not via a team) has a yellow eye icon. The list is grouped: "Mine" (opened by me) on top, then "Others" with those waiting for my review first (no grouping when one group is empty or my login is unknown). The list covers PRs in the repo of the focused folder (when a mod pane such as a wb-diff tab is focused, the last terminal folder of that space), with CI, review, approval and Copilot-review state. A row whose title starts with a task key (`[A-Za-z]+-\d+`, e.g. `DA-20323`) has a copy button for that key. The Copilot badge is red while a High or Medium Copilot thread (or one of unknown severity) is unresolved, blue when only Low ones are open (severity from Copilot's overview reviews, matched by thread URL), green once it reviewed and none are open, a yellow spinner while it is reviewing (requested, including a re-request after an earlier review; updates on the minute poll), faint when not run (pending Copilot request and open threads: one GraphQL call per repo per poll, first 50 PRs × 100 threads; gh's own reviewRequests leaves bots out). Click opens a dialog with description, comments, reviews and the unresolved line-comment threads (gh GraphQL, first 100 threads × 30 comments; resolved ones are hidden). Copilot's latest overview review (`ccr-overview-v2`) is shown as a card like GitHub's: verdict, summary, open issues with a High/Medium/Low pill linking to the thread (issues whose thread is resolved are left out), a folded "What changed" and the review effort; an overview in another layout stays a plain comment; buttons open the PR in the browser, copy the link, approve, or generate an AI review.
A create-PR dialog (the header's + button) pushes the branch and runs gh pr create, with an AI-written title and description.

## Files
- main.js: panel view, gh calls, PR detail and create dialogs.
- ai.js: AI model settings and runner shared across mods (copy of mods/wb-ai/ai.js): claude/codex CLIs or a local server.
- approved.svg, changes.svg, copy.svg, draft.svg, plus.svg, pr.svg, refresh.svg, review.svg, spinner.svg: status and button icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
localStorage `prs.auto` (old unprefixed `auto` is read as fallback): auto-refresh on/off; `prs.all`: the Mine/All switch. Shared `wb.ai.*` keys hold the AI model list, per-use model and per-project templates (owned by the wb-ai mod; migrated from older `wb.*` keys). No keychain.

## Notes
Polls gh every 60 s when auto is on; while a refresh runs only the refresh icon spins, the list is replaced when new data arrives (a failed gh or GraphQL call keeps the last good list and Copilot badges). It checks the focused folder and prs.changed every 2 s (cheap compare). In memory each PR keeps only its row fields (CI, approval and Copilot badges worked out per poll, body cut to 500 chars for search); repos no space points at are dropped on the next poll. Diff sent to AI is capped at 60000 chars. For the PR title and description the AI also gets the repo's own rules: the GitHub PR template, then the tracked agent docs that mention pull requests most (`CLAUDE.md`, `AGENTS.md`, `.claude/**/*.md`, `.github/**/*.md`, `.cursor/**`), then `CLAUDE.md`; at most 6 files, 8000 chars each. gh and AI calls have timeouts (120-600 s). Works without the `wb.ai.*` keys but AI features need a model configured in wb-ai.
- ai.js is an intentional per-mod copy (isolation rule) with the same origin as wb-ai/ai.js; the `wb.ai.*` settings are shared on purpose with wb-ai, prs and changes-copy (documented contract, optional where read, defaults are created).
