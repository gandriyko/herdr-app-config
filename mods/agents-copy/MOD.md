---
name: agents-copy
summary: Sidebar list of agents (priority or grouped by space) with PR and checks chips, a space/PR filter and repeat reminders for agents still waiting.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/agents-copy
install: copy the folder mods/agents-copy into ~/.config/herdr-app/mods/agents-copy
place: none
needs: [gh, git]
shared_keys: [agents-copy.sort, agents-copy.filter, agents-copy.remind]
reads_keys: [agents.sort (legacy fallback for agents-copy.sort), sidebar.width, sidebar.collapsed]
commands: [pane.focus, terminal.pin, terminal.peek, layout.resize, mod.open agents-copy (its own sort and filter popups), mod.open agents-board (header button)]
---

## What it does
Lists agents like the shipped `agents` panel, in Priority or Grouped by space, with sub-agent trees, pins and a narrow rail mode. Cloned from agents 0.1.15.

- Rows: each non-idle agent is a small card. Line 1: program icon, space name (semibold while unseen/done), dim `/ tab`, an accent dot when done, time in state, hover pin button. Line 2: the agent's report (terminal `report`, else its title) in one monospace line. Line 3: the PR pill. Blocked cards are red-tinted. Sub-agents sit inside their parent's card.
- Priority view: groups Needs you, Working, Done (colored dot, title, count). Idle agents are single dimmed lines (icon, `space / tab`, time) at the end of Done. Grouped view uses the same cards under the space headers.

- PR chip: a pill after the row text with `#<n>` and a check glyph (red failing, green passing, yellow pending, grey none). Click opens the PR in the browser (`gh pr view --web`). No chip without an open PR, for agents on other machines, or in rail mode.
- Filter (funnel button in the header): one space or all, and PR: Any / Has PR / Checks failing / No PR. An active filter shows a chip with a clear button and an accent-colored icon. It applies to both views and to the order used by agent.next/prev.
- Reminders: while an agent stays blocked, a repeat warning toast and the `blocked` sound come every 2, 5 (default) or 10 minutes (or off), set in the sort popup. Herdr's own first toast and sound are not duplicated. Not sent for the agent you are looking at in an active window. Several due at once give one toast naming the count, focusing the longest-waiting.

## Files
- main.js: the view, popups, gh lookups, reminders.
- check.svg, columns.svg, chevron-down.svg, chevron-right.svg, clock.svg, filter.svg, layers.svg, pin.svg, pin-off.svg, spinner.svg, x.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Shared `agents-copy.sort` ("priority" | "grouped"; the old `agents.sort` is read when missing), `agents-copy.filter` ({ space, pr }), `agents-copy.remind` (0, 2, 5, 10 minutes).
- `localStorage` `changed`, `pins`: agent state times and pins to migrate, as in the shipped mod.
- Reads `sidebar.width` / `sidebar.collapsed` (app and layout contract) for the rail toggle.

## Notes
The columns button in the header (hidden in rail mode) opens the `agents-board` mod with `mod.open`. If that mod isn't installed it shows a warning toast; everything else works without it.

Cloned from agents 0.1.15.

PR lookups: each cwd is resolved once to its git common dir (cache capped at 200), so worktrees share one `gh pr list --state open --limit 100 --json number,headRefName,statusCheckRollup` call (15 s timeout). One gh call runs at a time; a request meanwhile makes one more pass. gh is asked only for feature branches: the default branch (`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, re-read every 30 min; without it `main` and `master`), a null branch and a detached HEAD are never asked, and a repo with none of them left gets no gh call. A feature branch not asked about yet is asked at once, then the repo every 5 min while none of them has an open PR, every 60 s while one has (5 min after a failure, keeping the last good answer). If gh is missing or not logged in, chips disappear and it retries only every 10 minutes. At most 30 repos are cached; only number and checks state are kept. Redraws only when the PR map changes. The existing 30 s timer drives ticks and reminders; no other timers.
