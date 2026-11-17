---
name: agents-copy
summary: Sidebar list of agents (priority or grouped by space) with PR and checks chips, a space/PR filter and repeat reminders for agents still waiting.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/agents-copy
install: copy the folder mods/agents-copy into ~/.config/herdr-app/mods/agents-copy
place: none
needs: [gh, git, hc]
shared_keys: [agents-copy.sort, agents-copy.filter, agents-copy.remind]
reads_keys: [agents.sort (legacy fallback for agents-copy.sort), sidebar.width, sidebar.collapsed]
commands: [pane.focus, terminal.pin, terminal.peek, terminal.keep, layout.resize, mod.open agents-copy (its own sort and filter popups), mod.open agents-board (header button)]
---

## What it does
Lists agents like the shipped `agents` panel, in Priority or Grouped by space, with sub-agent trees, pins and a narrow rail mode. Cloned from agents 0.1.15.

- Cards: every agent, in every state, is the same card (rounded, raised background, 1px border). Left column: the program icon with the status glyph under it (a fixed 16 px slot, empty when idle, so all cards share a minimum height). Glyph: spinner when working, a red circle with a pulsing `?` when blocked, a check in a 16 px accent circle when done and unseen (the unread mark), none when idle (seen cards are not dimmed). Line 1: space name (semibold), dim `/ tab` only when the person named the tab and it differs from line 2 and from the program name, time in state on the right (hover shows the pin button). Line 2: the agent's report (terminal `report`, else its title, else the tab name if a person named it; with none, the program name in dim text), wraps up to two lines, then cut off. Every card is two lines: the PR pill sits in line 1 right after the name. Blocked cards are red-tinted with red text; idle (seen) cards are dimmed. The focused agent's card (the one being worked with) has an accent border and an accent tint (a blocked one keeps its red tint). No branch is shown. Sub-agents sit inside their parent's card.
- Priority view: groups Needs you, Working, Done (colored dot, title, count); idle agents are cards without the unread check at the end of Done. Grouped view uses the same cards under the space headers.

- PR chip: a small pill in line 1 after the name with `#<n>` and a check glyph (red failing, green passing, yellow pending, grey none). Click opens the PR in the browser (`gh pr view --web`). No chip without an open PR, for agents on other machines, or in rail mode. The PR is found by the agent's folder and branch, so agents in the same folder share it; when the branch names a Jira key (e.g. `DA-20457-…`) and some of those agents mention the key (title, report, tab or name, case-insensitive), only they get the chip (and match the PR filter). If none mentions it, the ones that mention another Jira key lose the chip and the rest keep it.
- Filter (funnel button in the header): one space or all, and PR: Any / Has PR / Checks failing / No PR. An active filter shows a chip with a clear button and an accent-colored icon. It applies to both views and to the order used by agent.next/prev.
- Asking: an agent that finished (done or idle) on a choice menu counts as blocked: Needs you group, red tint, pulsing `?`, ordered and reminded like a blocked one (its time counts from when it was detected). It stays so until the screen is re-read without a menu (turn, done-to-idle or title change) or it starts working.
- Search (magnifier button in the header, not in rail mode): opens a box under the header, focused. Text filters (case-insensitive substring) by program, name, template, title, report, space and tab names, and the names of its sub-agents; it applies after the filter. Esc, the x, or a click on an agent or sub-agent row (going to it) closes it and clears the text. The space/PR filter is not reset.
- Sub-agents without a pane (started with `hc run`) are rows under their parent. A click gives one a pane with `terminal.keep` (it lands in its parent's tab; the core may apply it a moment later), then focuses it after one-shot checks at 0.4 s and 1.6 s; if no pane appears or the keep fails, it is peeked (`terminal.peek`) instead. A sub-agent that already has a pane is focused.
- Last message (experiment): an eye button at the end of line 2 expands the card. One `hc read <address> --lines 0` (the visible screen) gives the last message: the person's prompt (`❯ ` line, labelled YOU) or the agent's reply (`⏺` block, tool calls skipped, labelled AGENT), whichever is lower above the input box, up to 12 lines, in a box under line 2 ("Loading…", "No message on screen" or "Could not read the screen" otherwise). While open it reads again when that agent's turn or status changes (no timer; one read at a time, a change meanwhile reads once more; the last good message stays on a failed read). One card is open at a time; the eye again, a press anywhere outside the open card, or a click on a card collapses it, and the text is dropped. Not for agents on other machines.
- Reminders: while an agent stays blocked (or asking), a repeat warning toast and the `blocked` sound come every 2, 5 (default) or 10 minutes (or off), set in the sort popup. Herdr's own first toast and sound are not duplicated. Not sent for the agent you are looking at in an active window. Several due at once give one toast naming the count, focusing the longest-waiting.

## Files
- main.js: the view, popups, gh lookups, reminders.
- asking.js: the asking detector and its read queue.
- last.js: pure parser of the last message on a screen, for the eye button.
- check.svg, eye.svg, search.svg, columns.svg, chevron-down.svg, chevron-right.svg, clock.svg, filter.svg, layers.svg, pin.svg, pin-off.svg, spinner.svg, x.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Shared `agents-copy.sort` ("priority" | "grouped"; the old `agents.sort` is read when missing), `agents-copy.filter` ({ space, pr }), `agents-copy.remind` (0, 2, 5, 10 minutes).
- `localStorage` `changed`, `pins`: agent state times and pins to migrate, as in the shipped mod.
- Reads `sidebar.width` / `sidebar.collapsed` (app and layout contract) for the rail toggle.

## Notes
Asking detection: Claude Code reports `blocked` only for tool-permission prompts, so a menu of its own ("Enter to confirm", "Esc to cancel", a `❯ 1.` selector, `(y/n)`) shows as done/idle. Only choice menus count; a reply that merely ends in `?` does not. A footer phrase must start its line or follow a `·`, and a y/n marker must end its line, so a reply that quotes "(Y/N)" mid-sentence doesn't count. For each done/idle agent the mod runs `hc read <address>` (the screen only) and matches the last 14 lines above the input box for a menu. It reads again when the key `(address, turn, status, title)` changes: a new turn, done turning idle (the person looked at it, e.g. after dismissing a menu), or a new terminal title. The answer is kept per address (map capped at 200, dropped for agents that are gone, cleared when the agent works or is blocked). One read at a time; nothing on a timer; a redraw only when an agent's asking state changes.

The columns button in the header (hidden in rail mode) opens the `agents-board` mod with `mod.open`. If that mod isn't installed it shows a warning toast; everything else works without it.

Cloned from agents 0.1.15.

PR lookups: each cwd is resolved once to its git common dir (cache capped at 200), so worktrees share one `gh api graphql --cache 55s` call (open PRs, first 100: number, head branch, head commit's check rollup state; 15 s timeout). gh's disk cache is keyed by the request, so agents-board sending the same query text shares the answer: keep the two byte-identical. One gh call runs at a time; a request meanwhile makes one more pass. gh is asked only for feature branches: the default branch (`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, re-read every 30 min; without it `main` and `master`), a null branch and a detached HEAD are never asked, and a repo with none of them left gets no gh call. A feature branch not asked about yet is asked at once, then the repo every 5 min while none of them has an open PR, every 60 s while one has (5 min after a failure, keeping the last good answer). When an agent without a PR chip stops working (it may have just opened a PR), its repo is asked at once; gh's 55 s cache can still hold the old answer, then the next 5 min check finds it. If gh is missing or not logged in, chips disappear and it retries only every 10 minutes. At most 30 repos are cached; only number and checks state are kept. Redraws only when the PR map changes. The existing 30 s timer drives ticks and reminders; no other timers.
