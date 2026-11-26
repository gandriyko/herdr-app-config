# Herdr app config

My [Herdr](https://herdr.dev/app) layout (`my-layout`), the `changes-copy` mod and themes.

## Install

1. Run Herdr once (it creates `~/.config/herdr-app` and its shipped mods).
2. Put this repo there:

   ```sh
   cd ~/.config/herdr-app
   git init -b main
   git remote add origin https://github.com/gandriyko/herdr-app-config.git
   git fetch origin && git checkout -f main
   ```

3. Enable the layout (it loads `changes-copy`): `ctrl-shift-l`, or

   ```sh
   herdr-app do layout.switch --name my-layout
   ```

4. Connect the agent skills (see [Skills](#skills)):

   ```sh
   for dir in ~/.claude/skills ~/.agents/skills ~/.hermes/skills; do
     case $dir in */.hermes/*) [ -d ~/.hermes ] || continue;; esac
     mkdir -p "$dir"
     for d in ~/.config/herdr-app/skills/*/; do ln -sfn "${d%/}" "$dir/"; done
   done
   ```

Nothing is needed in `settings.json`: mods are connected by the layout, not by settings.

## Shared helpers

Herdr loads a mod's modules only from its own folder, so a helper used by several mods is kept once
in `lib/` and copied into each mod that has a file of the same name. Edit `lib/<file>`, then run
`scripts/sync-lib`, and commit `lib/` with the synced copies.

| Helper | Copied into |
| --- | --- |
| `ai.js` | `wb-ai`, `changes-copy`, `prs` |
| `highlight.js` | `wb-diff`, `files-copy` |
| `asking.js` | `agents-copy`, `agents-board` |
| `prs.js` | `agents-copy`, `agents-board` |
| `pr-badges.js` | `prs`, `jira` |
| `find.js` | `files-copy`, `wb-diff` |
| `card.js` | `agents-copy`, `agents-board` |

## Skills

`skills/` holds agent skills for agents running in Herdr. Each one is a folder with a `SKILL.md`
in the shared [Agent Skills](https://agentskills.io) format, so one copy serves every agent. Each
agent reads skills from its own folder, so the folders are linked there (step 4 of Install). A
symlink, not a copy, so `git pull` here updates the skill too.

| Agent | Folder it reads | Linked by step 4 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills` | yes |
| Codex | `~/.agents/skills` (not `~/.codex/skills`) | yes |
| Copilot CLI | `~/.copilot/skills`, `~/.agents/skills`, `~/.claude/skills` | yes, via the other two |
| Pi | `~/.pi/agent/skills`, `~/.agents/skills` | yes, via `~/.agents/skills` |
| Hermes | `~/.hermes/skills` | yes, when `~/.hermes` exists |

- Re-run the step 4 loop after a pull that adds a skill, or after installing Hermes. `ln -sfn` replaces an old link, so running it again is safe.
- Start a new agent session after linking (Copilot: `/skills reload`; Hermes picks it up without a restart).
- Check: `ls -l ~/.claude/skills ~/.agents/skills` shows the links; in Claude, `/worktree-setup` autocompletes.
- Use: ask in words ("split this task into backend and frontend parts") or call the skill by name.
- Remove: `rm ~/.claude/skills/<name> ~/.agents/skills/<name>` (deletes the links only).
- Only for one project: link it into `<project>/.claude/skills/` or `<project>/.agents/skills/` instead.

| Skill | What it does |
| --- | --- |
| `agent-hc` | How an agent drives Herdr from inside it: start agents and programs with `hc` (per-agent launch commands), send tasks and messages (report address, bare slash commands), wait without polling, read answers, stop them; open, split, focus and close spaces, tabs and panes with `herdr-app`. The base for `worktree-setup` and `agent-orchestration`. Needs `hc`, `herdr-app`. |
| `task-split` | Splits a task or PR into parts for parallel agents (name, repo, branch, scope, done, the contract between parts) and agrees the split, and the children's permissions, with the user. Plans only. |
| `worktree-setup` | For the agreed parts, creates git worktrees (next to the repo as `<repo>-<branch>`, branches prefixed with the ticket key) and starts a child agent in each with `hc run`, passing its task and parameters plus the message rules (no progress updates, no question dialogs, a `BLOCKED:` question format, a final report that starts with `DONE`/`FAILED`/`BLOCKED`) and the permissions the user agreed (the user's own by default; permission prompts go to the user), with Claude Code, Codex, Copilot CLI, Pi or Hermes as parent or child. The children show nested under their parent in `agents-board`. Needs `hc`, `git`. |
| `agent-orchestration` | Leads the running children: they agree with each other directly (the contract owner sends the parent one summary) and escalate through the parent (a conflict between the task and a repo rule always goes to the user), the user talks only to the parent and after every event gets a status board (a table of all children with state marks, what changed, what is needed from the user); waits for reports and acts on their first word (verifies `DONE`, fixes `FAILED`, answers or escalates `BLOCKED`), at most two fix rounds per problem, chains follow-ups (review after implement), sends slash commands bare (no `<hc from>` wrapper), opens PRs and stops the agents. Needs `hc`, `gh` (for PRs). |
