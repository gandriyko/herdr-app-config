---
name: agents-board
summary: Kanban of agents (Needs you, Working, Done) in a dialog opened with Cmd+Shift+A, with PR and checks pills, space and PR filters, search. A click on a card peeks the agent in the board's own window; closing the peek returns to the board.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/agents-board
install: copy the folder mods/agents-board into ~/.config/herdr-app/mods/agents-board, then add "cmd-shift-a": "mod.open:agents-board" to the global section of keys.json
place: none
needs: [gh, git, hc]
shared_keys: [agents-board.filter, agents-board.size]
reads_keys: []
commands: [mod.open, pane.focus, agent.focus, terminal.peek, "hc read", "hc send", "hc keys"]
---

## What it does
A frameless full-window overlay: a dim backdrop (a click on it closes the board) and a centered panel that the mod draws (default 82% x 85% of the window, at least 640 x 420 px) with three columns. Drag the bottom-right grip (or the left, right or bottom edge) to resize; the panel stays centered, so its width is twice the pointer's distance from the center. Double-click the grip to reset. The size is saved on mouse up as shares of the window, so it follows the window to another monitor. `mod.open` again, Esc or the close button closes it.

- Needs you: blocked agents and agents asking (finished on a choice menu), oldest first, with a red-tinted card and the pulsing `?`.
- Working: longest running first, with the elapsed time.
- Done: agents that finished while unseen first (newest first, accent dot), then seen (idle) agents as dimmed cards, newest first. The column count is all cards shown.
- Card: the same shape as the sidebar's. Left column: program icon with the status glyph under it (spinner working, pulsing red `?` blocked, accent dot unseen done, empty 16 px slot idle, so cards share a minimum height). Line 1: space name (`/ tab` only when the person named the tab and it differs from line 2 and the program name), time on the right. Line 2: the agent's report (else its title, else the tab name if a person named it, else the program name in dim text), wraps up to 2 lines. The PR pill (`#n` and a checks glyph, click opens the PR in the browser) sits in line 1 right after the name, only when there is one, so every card is two lines. No branch, no buttons. A click on the card (or Enter) closes the board and opens the agent in a dialog of the same size: a 34 px bar (this same mod with `peekBar` props) over the agent's terminal. The bar shows icon, space / tab, status glyph and word, and the buttons `← Board`, `↗` (go to the agent's pane, board stays closed) and `✕`. Any other close of the peek (`← Board`, `✕`, a click beside it) reopens the board, with the card you came from highlighted (`sel` in localStorage); the board only returns if the layout is the one the peek opened in. If the dialog cannot open it falls back to `terminal.peek`, then to focusing the pane. Sub-agents show "sub-agent of <tab>".
- Header: summary ("2 need you · 3 working · 1 unseen · 4 seen", zero parts left out, "No agents" when none), search (program, space, tab, report), close.
- Filters: space chips with their agent counts (idle included), and a "PR" segmented control: Any / Has PR / Failing / No PR.
- Keys: up/down between cards, left/right between columns (while the search is empty), Enter = peek the selected card, `r` = reply to the selected card (when the search box is not focused; Esc closes the reply area first, then the board).
- Reply: cards that are not working (needs you, done, idle) have a small reply button at the end of line 2. It reads the screen once (`hc read`) and opens a reply area in the card. On a choice menu: one button per option ("1 · Yes"); a click runs `hc keys <n>`, and after 600 ms, if the same menu is still shown, `hc keys enter`. Otherwise a text box, focused: the placeholder is the prompt suggestion, Tab fills it, Enter sends the text (or the suggestion when the box is empty) with `hc send`; Esc closes. A failed send shows the error under the box and keeps the text. Only one reply area is open; closing the board or the card leaving the list closes it.

## Files
- main.js: the view.
- prs.js: PR lookup helpers (state is kept by the view instance).
- asking.js: the asking detector and its read queue.
- reply.js: pure parsers for the reply area (menu options, input-line suggestion).
- reply.svg: reply icon.
- grip.svg: resize grip.
- check.svg, x.svg, spinner.svg, search.svg, chevron-down.svg, chevron-right.svg: icons.

## Settings and data
- Shared `agents-board.size` ({ w, h }): shares of the window, each clamped to 0.4-0.98, default { w: 0.82, h: 0.85 }. The peek dialog uses it too.
- Shared `agents-board.filter` ({ space, pr }). A space that is gone counts as All. Search is not saved.

## Notes
Asking detection: Claude Code reports `blocked` only for tool-permission prompts, so a menu of its own ("Enter to confirm", "Esc to cancel", a `❯ 1.` selector, `(y/n)`) shows as done/idle. Only choice menus count; a reply that merely ends in `?` does not. While the board is open, for each done/idle agent it runs `hc read <address>` (the screen only) and matches the last 14 lines above the input box for a menu. It reads again when the key `(address, turn, status, title)` changes: a new turn, done turning idle (the person looked at it, e.g. after dismissing a menu), or a new terminal title. Such an agent shows as blocked until the next read says otherwise or it works. One read at a time; nothing on a timer; a redraw only when an agent's asking state changes.

Reply suggestion heuristic: `hc read` returns plain text, so Claude's gray suggestion is the text after `❯ ` on the input line between the two `─────` rules near the bottom. A draft typed in the terminal looks the same and shows up as the "suggestion" too. Menu options are lines like `❯ 1. Yes` / `  2. Not now` within the last 14 non-empty lines above the input box (at least two, numbered from 1). Reads happen only when the area opens and once after a menu key; the screen text is never stored, only the suggestion and options, dropped on close.

The peek bar instance (`props().peekBar`) keeps no board state, timers or PR polling. Esc goes to the peeked terminal (a layout dialog), so close the peek with the bar or a click beside it. Column headers are dot, title and count, with no sort hints.

Everything is live from `agents()`, `terminals()`, `spaces()` and `panes()`; the view redraws when they change. A 30 s timer only refreshes the durations and the PR lookup.

PR lookups: each cwd is resolved once to its git common dir (cache capped at 200), so worktrees share one `gh pr list --state open --limit 100 --json number,headRefName,statusCheckRollup` call (15 s timeout). One gh call at a time; gh is asked only for feature branches: the default branch (`git symbolic-ref --quiet --short refs/remotes/origin/HEAD`, re-read every 30 min; without it `main` and `master`), a null branch and a detached HEAD are never asked, and a repo with none of them left gets no gh call. A feature branch not asked about yet is asked at once, then the repo every 5 min while none of them has an open PR, every 60 s while one has (5 min after a failure, keeping the last good answer). If gh is missing or not logged in, pills disappear and it retries every 10 minutes. At most 30 repos are cached. Agents on other machines have no PR. The view redraws only when the PR map changes. When the dialog closes everything stops.
