---
name: task-split
description: Split a task or a PR into parts that separate agents can do in parallel, and agree the split with the user. Use when the user asks to split work into parts/PRs, to plan a task across repos (e.g. backend + frontend) or to run it with several agents. Creating worktrees and starting agents is the worktree-setup skill.
---

# Split a task into parts

This skill only plans. It ends with a split the user agreed; `worktree-setup` then creates the
worktrees and starts the agents, `agent-orchestration` leads them.

## 1. Read the task

Read the ticket (fetch it yourself) and the code it touches before you split. Find which repos
change (e.g. backend and frontend) and what contract links them (API fields, events).

## 2. Propose the parts

For each part give:

- name: `a-z 0-9 - _`, ≤ 32 chars, the branch lowercased (`da-20519-pr-1`);
- repo and branch; with a ticket key the branch starts with it (`DA-20519-pr-1`);
- scope: the files/dirs it may touch;
- done: what "finished" means (tests, commit, contract agreed).

Rules:

- Parts must not edit the same files.
- Usually 2–4 parts; more is rarely worth it. One part is fine: do not split for the sake of it.
- Name the contract between parts that depend on each other, and which part defines it.

## 3. Confirm

Show the split as a short table and wait for a yes, unless the user already said to go ahead.
Under the table, say which permissions the children get: the user's own settings, or a wider
allowance you propose (`worktree-setup`, "Permissions"). A yes covers both.
Then continue with `worktree-setup`.
