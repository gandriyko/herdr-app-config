---
name: worktree-setup
description: For parts of work that are already agreed, create a git worktree per part and start a child agent in each with its task and parameters. Use inside Herdr (when $HC_TERMINAL_ID is set) after task-split, or when the user names the parts and asks to start agents in worktrees or hand a task to another agent in its own worktree. Splitting work into parts is the task-split skill; managing the started agents is the agent-orchestration skill.
---

# Create worktrees and start child agents (Herdr)

This skill only sets agents up: worktrees, branches, tasks, launch. The parts come from
`task-split`; once the agents run, follow `agent-orchestration`. Children you start with `hc run` are recorded as yours (`parent`),
so Herdr's agents board shows them nested under you. It works the same whichever agent you
are (Claude Code, Codex, Copilot CLI, Pi, Hermes, …) and whichever agent you start.

## 0. Check

- `$HC_TERMINAL_ID` must be set (you run inside Herdr). If not, say so and stop.
- Read `hc --skill` once per session if you haven't: it is the authoritative manual for
  `run`, `send`, `wait`, reports and failure handling. Where this file and it disagree, it wins.
- `hc templates`: use a template (e.g. `reviewer`) when one fits a role.

## 1. Input: the agreed parts

This skill does not split work. It takes parts the user already agreed (from the `task-split`
skill or named directly). Each part has: a name (`a-z 0-9 - _`, ≤ 32 chars: the branch
lowercased, e.g. `da-20519-pr-1`), a repo, a branch (`DA-20519-pr-1`), the scope, the done
criteria. If any of these is missing, ask; do not invent a split.

A part may live in another repo (e.g. the frontend of a backend ticket): run step 2 from that
repo. Take its base branch from where its recent PRs merge (`gh pr list --state merged -L 15
--json baseRefName`), not from `origin/HEAD`, which can be stale.

## 2. One worktree per part

Next to the main checkout, named `<repo>-<branch>`, so `ls` of the parent dir lists them beside
the repo (`~/Projects/dokka/dokka-backend` → `~/Projects/dokka/dokka-backend-DA-20519-pr-1`).
Herdr's sidebar still nests them under the repo (it groups by `git rev-parse --git-common-dir`,
not by path), and Open / Remove worktree list them (`git worktree list`). Only Herdr's own New
worktree dialog puts checkouts elsewhere (`<worktrees.directory>/<repo>/<branch>`).

```sh
branch=DA-20519-pr-1
root=$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')
wt=$(dirname "$root")/$(basename "$root")-$branch
git fetch origin --quiet
git worktree add "$wt" -b "$branch" origin/<base> --no-track   # new branch
# existing branch: git worktree add "$wt" "$branch"
```

If the path or branch already exists, reuse it (`git worktree list`) instead of failing.
Copy untracked files a build needs (`.env`, local config) only if the user agrees.

## 3. Start a child agent in each

Which agent: the one the user named, else the same program you are
(`hc get $HC_TERMINAL_ID --json` → `agent`, e.g. `claude-code`, `codex`). Prefer a template from
`hc templates` when one fits. Always `--bg` and `--name`, and run it interactively, never in a
one-shot print mode (`claude -p`, `codex exec`, `copilot -p`): it must stay watchable and
able to take another turn.

The task (`$TASK` below) carries every parameter the child needs:

- goal, scope (only this worktree, only `<paths>`) and done criteria;
- the ticket text when the child may lack access to the tracker (fetch it yourself and paste it);
- branch and finish rule: commit on `$branch` when done, no push unless told;
- no other agents;
- the communication rules and sibling names from `agent-orchestration` ("Who talks to whom");
- report address: `hc send <your address> "<summary or blocker>"`.

Expand `$HC_TERMINAL_ID` in your own shell before the text leaves it: build tasks and sends in
double quotes, never a quoted heredoc (`<<'EOF'`) or single quotes. A literal `$HC_TERMINAL_ID`
reaches the child, which resolves it to its own address and reports to itself. Name the parent's
address explicitly (`t10v`), not "your own".

Put the task in the `run` call when the program takes it as an argument (a send to a booting
agent can be dropped):

| Agent | Start it with the task |
| --- | --- |
| Claude Code | `hc run --bg --name da-20519-pr-1 --cwd "$wt" claude "$TASK"` |
| Codex | `hc run --bg --name da-20519-pr-1 --cwd "$wt" codex --no-daemon "$TASK"` (always `--no-daemon`, or its commands run outside hc) |
| Copilot CLI | `hc run --bg --name da-20519-pr-1 --cwd "$wt" copilot -i "$TASK"` |
| Pi | `hc run --bg --name da-20519-pr-1 --cwd "$wt" pi "$TASK"` |

Any other agent (Hermes, …), or when unsure how it takes a first prompt: start it plain, wait
until it is ready, then send the task:

```sh
hc run --bg --name da-20519-pr-1 --cwd "$wt" hermes
hc wait da-20519-pr-1
hc send da-20519-pr-1 "$TASK"
```

Add the model flag the user asked for (`--model …`). Check the launch output: if
`first_message.sent` is false, follow `hc --skill` (read the screen, fix the trust dialog, then
send) — do not blindly resend. If a flag above is rejected, check `<agent> --help` and fall back
to the plain start + send.

Children end when you end. Add `--outlive-parent` only if the user wants them to keep running
after this session.

Then continue with `agent-orchestration`.
