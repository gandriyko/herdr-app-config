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
- localStorage: `view` (list/tree), `scope`, `commitH` (commit box height), `bases` (chosen base branch per repo root, last 50).
- Shared state holds the AI model list, chosen models and per-project settings (see keys above).

## Notes
- Timers: refresh every 60 s while the folder watch is live (every 10 s for a remote repo or a dead watch), 2 s context check; the watch ignores caches and build noise (`node_modules`, `.venv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.DS_Store`, `*.pyc`, …); `watchFolder` with a generation flag; git calls time out at 180 s, AI runs at 600 s.
- Branch scope compares against the merge-base with the base branch: by default origin/HEAD, main or master. A click on the active branch button opens a picker of `main`, `master`, `release`, `release-beta`, `production`, `production-beta`, showing only those the repo has (`origin/<name>` preferred over the local branch, one `git for-each-ref` call), plus a field for any other branch (Enter; a missing one shows "no branch X" and the default is used).
- Each file row of the uncommitted list, and each folder row in the tree, has a Discard button. It always opens a confirmation dialog (a dialog copy of this mod, `props.discard`) listing the files; the folder one covers every listed file under it, subfolders included. Confirmed: `git restore --source=HEAD --staged --worktree -- <tracked paths>` (a staged new file is removed, a conflict takes HEAD's side) and `git clean -f -- <untracked paths>`, with exactly the paths the list showed. Hidden in branch scope and before the first commit.
- Generate sends the diff (first 60000 chars), `git status --short --branch` and the repo's own commit rules: the tracked agent docs that mention commit messages most (`CLAUDE.md`, `AGENTS.md`, `.claude/**/*.md`, `.github/**/*.md`, `.cursor/**`), then `CLAUDE.md`; at most 4 files, 8000 chars each. They take precedence over the `wb-ai` template.
- Depends on mods `wb-diff` and `wb-ai` being installed for diff tab and AI settings.
- `wb.diff.request` (read by wb-diff) and `branch.switched` (read by status-copy) are documented contracts; optional where read.
- ai.js is an intentional per-mod copy (isolation rule) with the same origin as wb-ai/ai.js; the `wb.ai.*` settings are shared on purpose with wb-ai, prs and changes-copy (documented contract, optional where read, defaults are created).
