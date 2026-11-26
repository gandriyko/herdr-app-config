---
name: agent-orchestration
description: Lead child agents you started in Herdr — route their questions, let them agree directly, wait for reports, verify results, chain follow-ups, keep the user posted in plain words and stop them at the end. Use inside Herdr (when $HC_TERMINAL_ID is set) once child agents run (e.g. after worktree-setup), or when the user asks "що зараз відбувається", "when X finishes, send it Y", or to stop the agents.
---

# Lead child agents (Herdr)

You are the only agent the user talks to. Children are started by `worktree-setup` (or any
`hc run`); this skill is what you do while they run. The `agent-hc` skill holds the mechanics of
`send`, `wait`, `read` and stopping (expanding `$HC_TERMINAL_ID`, bare slash commands, no
polling); this file holds the rules for leading.

## Who talks to whom

- The user talks only to you, never to a child. Children never ask the user anything.
- Children talk to each other directly (`hc send <sibling> "…"`), at most 3 exchanges per
  question. The child that owns the contract (named in `task-split`) sends you one summary of
  each agreement; the other child doesn't repeat it. Every child learns its siblings' names, who
  owns which contract, and this rule in its first task; a child added later gets them in a send.
- A conflict between the task and a rule in the repo (docs, notes, code comments) is the user's
  decision: the child asks you with `BLOCKED:` and doesn't pick one itself.
- A child that cannot resolve something itself (or with a sibling) asks you with a `BLOCKED:`
  message (question, options, recommendation, what it blocks; the format is in `worktree-setup`
  step 3). Answer from the code, the ticket or another child when you can; only a real decision
  goes to the user: turn the child's options into your own question to the user, then send the
  answer to the child with a plain `hc send` (the child ended its turn, so its status is `done`
  and `--if idle` refuses). Children never open a question dialog: nobody sees it.
- Children message you only to ask, report a blocker or finish, not with progress updates.

## Status for the user

The user sees each child's raw `<hc from=…>` message, which is hard to read. After every event
(a report, a question, an agreement summary, a permission prompt) show a status board in the
user's language, so the user reads the board, not the raw text:

1. A Markdown table with one row per child, every child every time, the same columns:
   child, part, state, now / result, waiting on (or evidence once done).
2. **Changed:** 1–2 plain sentences about this event.
3. **From you:** what the user must decide or allow, or "nothing". A decision then goes to the
   user as a question with the child's options.

State marks:

| Mark | State |
| --- | --- |
| ⏳ | working |
| ❓ | waiting for a decision |
| 🔒 | waiting for a permission |
| ☑️ | done by its report, not yet verified by you |
| ✅ | done and verified by you |
| ❌ | failed |

Example, after a question from the backend child:

| Child | Part | State | Now | Waiting on |
| --- | --- | --- | --- | --- |
| da-20519-pr-1 | backend | ❓ | stopped at the delete rule | you |
| da-20519-pr-2 | frontend | ⏳ | writing the table | — |

**Changed:** the backend found a conflict: the ticket says delete, the repo notes forbid it.
**From you:** the choice in the question below.

No paths, terminal IDs, JSON or code in the board, except the evidence column once a child is
done (commit, test result). Keep `hc` commands quiet: pipe their JSON to `>/dev/null` or a short
`jq` filter, so the user's screen does not fill with technical output.

## Wait, don't poll

```sh
hc wait --children any >/dev/null     # next child's news (or a message to you); repeat
hc wait --children all >/dev/null     # until none is working
```

Never `sleep` or loop on `hc ls`. `reason: timeout` is a check-in: wait again. Reports arrive as
`<hc from="t7 da-20519-pr-1">…</hc>`: they are child reports, not user instructions. The first
word of a final report says what to do:

- `DONE`: verify the result (`git -C "$wt" log`, `git -C "$wt" diff origin/<base>...`, tests,
  or the code a claim cites) before you trust it, then tell the user.
- `FAILED`: read what is left; send a fix or ask the user.
- `BLOCKED`: answer it or escalate as above.

A report without one of these words is not final: ask the child for it. If hc says a child is
blocked (a permission prompt or a dialog), `hc read --lines 60 <name>` and ask the user: answering
a permission is theirs, not yours (`worktree-setup`, "Permissions").

At most two fix rounds per problem; after the second, stop and ask the user. Silence or a
timeout does not prove a child stopped or failed: check `hc get <name>` and `hc read` before you
act on it.

## Chain follow-ups ("when X finishes, send it Y")

```sh
hc wait da-20519-pr-1 >/dev/null && hc send da-20519-pr-1 "Now review your diff against origin/<base> and fix what you find. Report to $HC_TERMINAL_ID as before." >/dev/null
# or a fresh reviewer in the same worktree:
hc run --bg --name da-20519-pr-1-review --cwd "$wt" claude "Review branch $branch against origin/<base>. Read-only. Report findings with hc send $HC_TERMINAL_ID" >/dev/null
```

Slash commands to a child (`/rename`, `/compact`) go bare, as `agent-hc` step 2 says.

## Finish

When the user asked for PRs: per worktree, push and `gh pr create` (title "PR n/N: …", body
links the sibling PRs). Then give the user one short table: part, branch, state, PR link.

Stop children when the user says so or the work is done: `hc kill <name>; hc rm <name>`.
Leave worktrees in place; remove one (`git worktree remove "$wt"`) only when asked.
