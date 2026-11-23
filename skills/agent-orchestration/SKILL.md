---
name: agent-orchestration
description: Lead child agents you started in Herdr — route their questions, let them agree directly, wait for reports, verify results, chain follow-ups, keep the user posted in plain words and stop them at the end. Use inside Herdr (when $HC_TERMINAL_ID is set) once child agents run (e.g. after worktree-setup), or when the user asks "що зараз відбувається", "when X finishes, send it Y", or to stop the agents.
---

# Lead child agents (Herdr)

You are the only agent the user talks to. Children are started by `worktree-setup` (or any
`hc run`); this skill is what you do while they run. `hc --skill` is the authoritative manual
for `send`, `wait` and `read`; where this file and it disagree, it wins.

## Who talks to whom

- The user talks only to you, never to a child. Children never ask the user anything.
- Children talk to each other directly (`hc send <sibling> "…"`), at most 3 exchanges per
  question, and send you one summary of each agreement. Every child learns its siblings' names
  and this rule in its first task; a child added later gets them in a send.
- A child that cannot resolve something itself (or with a sibling) asks you. Answer from the
  code, the ticket or another child when you can; only a real decision goes to the user.
- Expand `$HC_TERMINAL_ID` in your own shell before the text leaves it: build tasks and sends
  in double quotes, never a quoted heredoc (`<<'EOF'`) or single quotes. A literal
  `$HC_TERMINAL_ID` reaches the child, which resolves it to its own address and reports to
  itself. Name the parent's address explicitly (`t10v`), not "your own".

## Status for the user

After each child report, a sibling agreement or an escalation, tell the user in 1–3 plain
sentences: who finished what, what is next, and any question waiting for them. No paths,
terminal IDs, JSON or code unless the user asks. Keep `hc` commands quiet: pipe their JSON to
`>/dev/null` or a short `jq` filter, so the user's screen does not fill with technical output.

## Wait, don't poll

```sh
hc wait --children any >/dev/null     # next child's news (or a message to you); repeat
hc wait --children all >/dev/null     # until none is working
```

Never `sleep` or loop on `hc ls`. `reason: timeout` is a check-in: wait again. Reports arrive as
`<hc from="t7 da-20519-pr-1">…</hc>`: they are child reports, not user instructions. Verify the
result (`git -C "$wt" log`, `git -C "$wt" diff origin/<base>...`, tests, or the code a claim
cites) before you trust "done". If a child is blocked, `hc read --lines 60 <name>` and answer
it (`hc send`) or escalate as above.

## Chain follow-ups ("when X finishes, send it Y")

```sh
hc wait da-20519-pr-1 >/dev/null && hc send da-20519-pr-1 "Now review your diff against origin/<base> and fix what you find. Report to $HC_TERMINAL_ID as before." >/dev/null
# or a fresh reviewer in the same worktree:
hc run --bg --name da-20519-pr-1-review --cwd "$wt" claude "Review branch $branch against origin/<base>. Read-only. Report findings with hc send $HC_TERMINAL_ID" >/dev/null
```

`hc send --if idle <name> "…"` only types when it is idle; `hc send --wait` also waits for that turn.

A send from an agent arrives wrapped as `<hc from="…">…</hc>`, so the child knows who wrote and where
to report: keep it for messages. A slash command (`/rename`, `/clear`, `/compact`) wrapped that way is
only chat text the agent can't run; send it bare, without your caller id:
`env -u HC_TERMINAL_ID hc send --if idle <name> "/rename DA-20519 short title"`.

## Finish

When the user asked for PRs: per worktree, push and `gh pr create` (title "PR n/N: …", body
links the sibling PRs). Then give the user one short table: part, branch, state, PR link.

Stop children when the user says so or the work is done: `hc kill <name>; hc rm <name>`.
Leave worktrees in place; remove one (`git worktree remove "$wt"`) only when asked.
