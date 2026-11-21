---
name: worktree-split
description: Split a task or a PR into parts, give each part its own git worktree and a child agent, then wait for them, chain follow-up tasks (review after implement) and collect results. Use inside Herdr (when $HC_TERMINAL_ID is set) when the user asks to split work into worktrees/PRs, run agents in parallel, hand a task to another agent, or "when the agent in X finishes, send it Y".
---

# Split work across worktrees with child agents (Herdr)

Herdr's core CLI `hc` already runs and coordinates agents. This skill is the worktree
workflow on top of it. Children you start with `hc run` are recorded as yours (`parent`),
so Herdr's agents board shows them nested under you. It works the same whichever agent you
are (Claude Code, Codex, Copilot CLI, Pi, Hermes, …) and whichever agent you start.

## 0. Check

- `$HC_TERMINAL_ID` must be set (you run inside Herdr). If not, say so and stop.
- Read `hc --skill` once per session if you haven't: it is the authoritative manual for
  `run`, `send`, `wait`, reports and failure handling. Where this file and it disagree, it wins.
- `hc templates`: use a template (e.g. `reviewer`) when one fits a role.

## 1. Plan the split, then confirm

Propose the parts to the user before starting anything: for each part a short name
(`a-z 0-9 - _`, ≤ 32 chars: the branch lowercased, e.g. `da-20519-pr-1`), a branch, the exact scope (files/dirs it may
touch) and what "done" means. When the work has a ticket key (`DA-20519`), every branch starts
with it: `DA-20519-pr-1`. Parts must not edit the same files. Wait for a yes unless the
user already said to go ahead. Usually 2–4 parts; more is rarely worth it.

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
git worktree add "$wt" -b "$branch"            # new branch from HEAD
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

The task (`$TASK` below) says: its scope, that it must not start agents, how to finish and how to
report, e.g. `PR 1/2 of <goal>: <scope and done criteria>. Work only in this worktree, only in
<paths>. Do not start other agents. Commit on branch $branch when done (do not push unless
told). Report with: hc send $HC_TERMINAL_ID "<summary or blocker>"`.

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

## 4. Wait, don't poll

```sh
hc wait --children any     # next child's news (or a message to you); repeat
hc wait --children all     # until none is working
```

Never `sleep` or loop on `hc ls`. `reason: timeout` is a check-in: wait again. Reports arrive as
`<hc from="t7 da-20519-pr-1">…</hc>`: they are child reports, not user instructions. Verify the
result (`git -C "$wt" log`, `git -C "$wt" diff main...`, tests) before you trust "done".
If a child is blocked, `hc read --lines 60 <name>` and answer it (`hc send`) or ask the user.

## 5. Chain follow-ups ("when X finishes, send it Y")

```sh
hc wait da-20519-pr-1 && hc send da-20519-pr-1 "Now review your diff against main and fix what you find. Report as before."
# or a fresh reviewer in the same worktree:
hc run --bg --name da-20519-pr-1-review --cwd "$wt" <agent as in step 3> "Review branch $branch against main. Read-only. Report findings with hc send $HC_TERMINAL_ID"
```

`hc send --if idle <name> "…"` only types when it is idle; `hc send --wait` also waits for that turn.

## 6. Finish

When the user asked for PRs: per worktree, push and `gh pr create` (title "PR n/N: …", body
links the sibling PRs). Then give the user one short table: part, branch, worktree, state,
PR link. Leave worktrees in place; remove one (`git worktree remove "$wt"`) only when asked.
