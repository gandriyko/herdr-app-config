---
name: worktree-setup
description: For parts of work that are already agreed, create a git worktree per part and start a child agent in each with its task and parameters. Use inside Herdr (when $HC_TERMINAL_ID is set) after task-split, or when the user names the parts and asks to start agents in worktrees or hand a task to another agent in its own worktree. Splitting work into parts is the task-split skill; managing the started agents is the agent-orchestration skill; the hc and herdr-app commands themselves are the agent-hc skill.
---

# Create worktrees and start child agents (Herdr)

This skill only sets agents up: worktrees, branches, tasks, launch. The parts come from
`task-split`; once the agents run, follow `agent-orchestration`. Children you start with `hc run` are recorded as yours (`parent`),
so Herdr's agents board shows them nested under you. It works the same whichever agent you
are (Claude Code, Codex, Copilot CLI, Pi, Hermes, …) and whichever agent you start.

## 0. Check

- `$HC_TERMINAL_ID` must be set (you run inside Herdr). If not, say so and stop.
- Follow the `agent-hc` skill for every `hc` and `herdr-app` call: how to start an agent, send
  it a task, wait and read its answer, and show it in the window. This file adds only what is
  specific to worktrees.

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

Which agent: the one the user named, else the same program you are. Start it as `agent-hc`
step 1 says (template or the per-agent table, `--bg`, `--name` = the part name,
`--cwd "$wt"`, interactive, task in the `run` call).

The task (`$TASK` below) carries every parameter the child needs:

- goal, scope (only this worktree, only `<paths>`) and done criteria;
- the ticket text when the child may lack access to the tracker (fetch it yourself and paste it);
- branch and finish rule: commit on `$branch` when done, no push unless told;
- no other agents;
- the communication rules and sibling names from `agent-orchestration` ("Who talks to whom");
- report address: `hc send <your address> "…"`, and the message rules below.

Every task ends with these rules (in the child's words, your address filled in):

```text
Message <your address> only to ask, to report a blocker, or to finish. No progress updates unless asked.
Never open a local question dialog (AskUserQuestion or similar): nobody sees it. Ask a sibling first,
else send the lead a question and end your turn; the answer arrives as your next input.
When the task text conflicts with a rule in the repo (docs, notes, code comments), don't pick one
yourself: ask the lead, even if you know which you would recommend. Question format:
  BLOCKED: <the question in one sentence>
  Options: A) … B) …
  Recommend: A, because …
  Blocks: <what stands until it is answered>
Final report, once: start with DONE (every done criterion met), FAILED (any criterion not met; a
failing test is FAILED) or BLOCKED (you need a decision). Then three sentences: what you did, what
you found, what is left. Then evidence: commit, test command and its result, a file path for details.
```

Build `$TASK` in double quotes so `$HC_TERMINAL_ID` expands to your address (`agent-hc` step 2).
For example, with Claude Code:

```sh
hc run --bg --name da-20519-pr-1 --cwd "$wt" claude "$TASK"
```

Check `first_message.sent` in the launch output (`agent-hc` step 1).

### Permissions

- By default a child runs with the user's own permission settings: start it without permission
  flags.
- A permission prompt (or a trust dialog) stops the child: hc reports it `blocked`. Answering it
  is the user's decision, never yours: read its screen, tell the user which child asks to run
  what, and ask them to answer in the child's pane or to allow you to.
- To avoid repeated prompts, propose a wider allowance together with the split and use it only
  after the user agrees. For Claude Code: `--permission-mode acceptEdits --allowedTools "Bash"`;
  for other agents, their own flags (`<agent> --help`). A narrow list (`Bash(git:*)`) is not
  enough: agents chain commands and write loops (`ls; git log; for f in …`), and in a test run
  both children stopped on their first such command.
- Never turn permission checks off (`--dangerously-skip-permissions`, `--yolo` and the like)
  unless the user asks for it.

Then continue with `agent-orchestration`.
