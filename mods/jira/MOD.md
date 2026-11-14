---
name: jira
summary: Panel with my open Jira issues by sprint and the project backlog
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/jira
install: copy the folder mods/jira into ~/.config/herdr-app/mods/jira
place: none
needs: [Jira Cloud REST API over network (api.atlassian.com or the site URL), macOS Keychain item herdr-jira, security, open, git, an agent from knownAgents() for sessions (default claude)]
shared_keys: [jira.settings]
reads_keys: []
commands: [tab.new (an agent session for a task in the current folder), space.new (an agent session in a new worktree)]
---

## What it does
Lists my open Jira issues grouped by sprint plus the project backlog; the filter button next to search opens a popover with "Current sprint only" (no other sprints, no backlog) and a checkbox per status found in the loaded issues (To Do, In Progress, QA, …, with counts; none checked = all); the button shows how many filters are on. Click opens the issue in the browser; right-click copies the task ID or starts an agent session. Each row's terminal button (and the menu item) opens a "Start session" dialog for the focused pane's folder (else the active space's) with a branch name (`<key>-<first words of the title>`, editable) and a base branch (origin's default, editable), and two choices:
- New worktree: the mod runs `git fetch origin <base>` and `git worktree add -b <branch> <parent>/<repo>-<branch> origin/<base>` in the main checkout (next to it, e.g. `~/Projects/dokka/dokka-backend-DA-123-…`), then `space.new {name, folder, argv, task}` (name: `<key> <first words of the title>`, about 30 chars, as for the tab below). The task tells the agent to copy the gitignored files the worktree needs (env files, certificates, local config) from the main checkout as the repo's own docs say, install dependencies, then work on the issue.
- New branch here: `tab.new {name, folder, argv, task}`; the task tells the agent to fetch and create the branch from `origin/<base>` (stopping to ask if the tree has uncommitted changes), then work on the issue.
Outside a git repo the dialog only starts the agent there with `<key>: <title>`. The task is one line (a newline could send it early). The worktree is not removed by this mod; Herdr's worktree mod can remove it. The agent is picked in the settings form from Herdr's `knownAgents()` (installed ones on the active space's machine; programs.json can add more) and saved at once as `jira.settings.agent` / `agentName`; default Claude Code. A settings form saves site, project and credentials (email and API token).

## Files
- main.js: UI, Jira requests, Keychain access, settings form.
- jira.svg, refresh.svg, session.svg, settings.svg, filter.svg, check.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Keychain service `herdr-jira` (account = email, password = API token), via `security`.
- Shared state `jira.settings` ({ site, project, base }).
- `localStorage` `current` ("1" / "0"): the current-sprint filter; `statuses` (JSON list of status names, at most 50): the status filter.

## Notes
- Refresh every 5 min.
- Uses an API token, not OAuth; the token is briefly in `security` argv when saved (noted in code).
- macOS only (Keychain); standalone.
