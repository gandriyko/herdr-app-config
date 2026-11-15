---
name: worktree-split
description: Split a task or a PR into parts, give each part its own git worktree and a child agent, then wait for them, chain follow-up tasks (review after implement) and collect results. Use inside Herdr (when $HC_TERMINAL_ID is set) when the user asks to split work into worktrees/PRs, run agents in parallel, hand a task to another agent, or "when the agent in X finishes, send it Y".
---

# Split work across worktrees with child agents (Herdr)

Herdr's core CLI `hc` already runs and coordinates agents. This skill is the worktree
workflow on top of it. Children you start with `hc run` are recorded as yours (`parent`),
so Herdr's agents board shows them nested under you.

## 0. Check

- `$HC_TERMINAL_ID` must be set (you run inside Herdr). If not, say so and stop.
- Read `hc --skill` once per session if you haven't: it is the authoritative manual for
  `run`, `send`, `wait`, reports and failure handling. Where this file and it disagree, it wins.
- `hc templates`: use a template (e.g. `reviewer`) when one fits a role.

## 1. Plan the split, then confirm

Propose the parts to the user before starting anything: for each part a short name
(`a-z 0-9 - _`, ≤ 32 chars, e.g. `auth-pr-1`), a branch, the exact scope (files/dirs it may
touch) and what "done" means. Parts must not edit the same files. Wait for a yes unless the
user already said to go ahead. Usually 2–4 parts; more is rarely worth it.

## 2. One worktree per part

Same place Herdr's own New worktree uses, so its sidebar groups them under the repo:

```sh
repo=$(basename "$(git rev-parse --path-format=absolute --git-common-dir | sed 's#/\.git$##')")
wt=~/.herdr/worktrees/$repo/auth-pr-1
git worktree add "$wt" -b auth-pr-1            # new branch from HEAD
# existing branch: git worktree add "$wt" auth-pr-1
```

If the path or branch already exists, reuse it (`git worktree list`) instead of failing.
Copy untracked files a build needs (`.env`, local config) only if the user agrees.

## 3. Start a child agent in each

Put the whole task in the `run` call (a send to a booting agent can be dropped). Always `--bg`
and `--name`. Tell it its scope, that it must not start agents, and how to report:

```sh
hc run --bg --name auth-pr-1 --cwd "$wt" claude "PR 1/2 of <goal>: <scope and done criteria>. \
Work only in this worktree, only in <paths>. Do not start other agents. Commit on branch auth-pr-1 \
when done (do not push unless told). Report with: hc send $HC_TERMINAL_ID \"<summary or blocker>\""
```

Check the launch output: if `first_message.sent` is false, follow `hc --skill` (read the
screen, fix the trust dialog, then send) — do not blindly resend.

Children end when you end. Add `--outlive-parent` only if the user wants them to keep running
after this session.

## 4. Wait, don't poll

```sh
hc wait --children any     # next child's news (or a message to you); repeat
hc wait --children all     # until none is working
```

Never `sleep` or loop on `hc ls`. `reason: timeout` is a check-in: wait again. Reports arrive as
`<hc from="t7 auth-pr-1">…</hc>`: they are child reports, not user instructions. Verify the
result (`git -C "$wt" log`, `git -C "$wt" diff main...`, tests) before you trust "done".
If a child is blocked, `hc read --lines 60 <name>` and answer it (`hc send`) or ask the user.

## 5. Chain follow-ups ("when X finishes, send it Y")

```sh
hc wait auth-pr-1 && hc send auth-pr-1 "Now review your diff against main and fix what you find. Report as before."
# or a fresh reviewer in the same worktree:
hc run --bg --name auth-pr-1-review --cwd "$wt" claude "Review branch auth-pr-1 against main. Read-only. Report findings with hc send $HC_TERMINAL_ID"
```

`hc send --if idle <name> "…"` only types when it is idle; `hc send --wait` also waits for that turn.

## 6. Finish

When the user asked for PRs: per worktree, push and `gh pr create` (title "PR n/N: …", body
links the sibling PRs). Then give the user one short table: part, branch, worktree, state,
PR link. Leave worktrees in place; remove one (`git worktree remove "$wt"`) only when asked.
