---
name: jira
summary: Panel with my open Jira issues (grouped by sprint or status, sorted by date) and optional project backlogs
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/jira
install: copy the folder mods/jira into ~/.config/herdr-app/mods/jira
place: none
needs: [Jira Cloud REST API over network (api.atlassian.com or the site URL), macOS Keychain item herdr-jira, security, open, git, an agent from knownAgents() for sessions (default claude)]
shared_keys: [jira.settings]
reads_keys: []
commands: [tab.new (an agent session for a task in the current folder), space.new (an agent session in a new worktree), space.select (jump to the space of an existing worktree)]
---

## What it does
Lists my open Jira issues plus the backlog of one or more projects (keys comma-separated, e.g. `DA, OPS`; one section per project). The filter button next to search opens a popover with Sort (Updated or Created, newest first, my issues and backlogs; in a sprint group in-progress issues still come first), Group by (Sprint, Status, Parent — the epic of a story/task or the issue of a sub-task, from Jira's `parent` field, "No parent" last — or None; my issues), "Show project backlog" (off = its request is not made), "Current sprint only" (no other sprints, no backlog) and a checkbox per status found in the loaded issues (To Do, In Progress, QA, …, with counts; none checked = all); the button shows how many filters are on. Each row shows the issue type's icon (Jira's own, see Settings and data; else the mod's, picked by the type's name: sub-task, bug, story, epic, customer ticket, PM/QA, security, investigation, else task), the key, the status and the age since creation ("today", "5d ago"). Click opens the issue in the browser; right-click copies the task ID or starts an agent session.

The row's terminal button (and "Start <agent> session…" in the menu) opens a "Start session" dialog for the focused pane's folder (else the active space's) with an editable branch name (`<key>-<first words of the title>`) and base branch (origin's default), and two choices:
- New worktree (default): a worktree for the branch next to the main checkout, then a space there running the agent with the task.
  - Reuse: before creating, the mod runs `git worktree list --porcelain` in the main checkout. A worktree that already has the branch is reused: its space is selected if one is open on that folder (same machine), else a new space opens there. A local branch with no worktree gets `git worktree add <path> <branch>`. Otherwise `git fetch origin <base>` and `git worktree add -b <branch> <parent>/<repo>-<branch> origin/<base>` (next to the main checkout, e.g. `~/Projects/dokka/dokka-backend-DA-123-…`), then `space.new {name, folder, machine, argv, task}`.
- New branch here: `tab.new {name, folder, argv, task}`; the task tells the agent to fetch and create the branch from `origin/<base>` (stopping to ask if the tree has uncommitted changes), then work on the issue.
Prompt (both choices): `<key>: <title> — Task description: <description> — …`. The description is fetched at start time (`GET /rest/api/3/issue/<key>?fields=description`), flattened from Atlassian Document Format to one line of at most 3000 characters; if the fetch fails it is left out. The rest tells the agent to copy the gitignored files the worktree needs (env files, certificates, local config) from the main checkout as the repo's own docs say, install dependencies, then work on the issue. The task is one line (a newline could send it early).
If our `history` mod is installed here (`~/.config/herdr-app/mods/history/main.js` exists), and the space is on this machine, the dialog holds it below the form (a two-block `layout`: jira with `{start}`, history with `{query: <key>, folder, embedded: true}`), listing past sessions that mention the task key in the dialog's folder's project; history's Resume closes the whole dialog (both blocks share `props().overlay`). Without the mod, or on a remote space, the dialog is the form alone.
Outside a git repo the dialog only starts the agent there with `<key>: <title>` and the description. The worktree is not removed by this mod; Herdr's worktree mod can remove it. The agent is picked in the settings form from Herdr's `knownAgents()` (installed ones on the active space's machine; programs.json can add more) and saved at once as `jira.settings.agent` / `agentName`; default Claude Code. A settings form saves site, project and credentials (email and API token).

## Files
- main.js: UI, Jira requests, Keychain access, settings form.
- jira.svg, refresh.svg, session.svg, settings.svg, filter.svg, check.svg: icons.
- type-*.svg (task, bug, story, epic, subtask, customer, pmqa, security, investigation): fallback issue type icons, colored outlines like Jira's (full color, via image()).
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Keychain service `herdr-jira` (account = email, password = API token), via `security`.
- Shared state `jira.settings` ({ site, project ("DA, OPS"), base, agent, agentName, sort ("updated" | "created"), groupBy ("sprint" | "status" | "parent" | "none"), backlog (false = hidden) }).
- Status order (status groups, the status list in the filter): the columns of each project's board, left to right, read once per session from `GET /rest/agile/1.0/board?projectKeyOrId=<key>` and `/board/<id>/configuration` (first scrum board, else first board; the saved projects and those of my issues, at most 5). Statuses on no board go after them: to do, in progress, done, then by name. A token with scopes also needs read:board-scope:jira-software and read:board-scope.admin:jira-software for this; without them the fallback order is used.
- `data/jira/types/<type id>-<avatar id>.svg`: Jira's issue type icons (the type's `iconUrl`, fetched with the credentials through the API base), saved once and kept across restarts; after a refresh, types not seen this session are looked up. Only SVG is kept (Herdr's fetch reads text); a PNG icon or a failed fetch falls back to the mod's own. Delete the folder to fetch them again.
- Fetches the 100 latest-updated of my issues and the top 100 (by rank) of the backlogs, then sorts them locally.
- `localStorage` `current` ("1" / "0"): the current-sprint filter; `statuses` (JSON list of status names, at most 50): the status filter.

## Notes
- Loads once on open; refreshes every 5 min only when the Auto checkbox in the header is on (off by default, saved in `localStorage` `jira.auto`).
- Uses an API token, not OAuth; the token is briefly in `security` argv when saved (noted in code).
- macOS only (Keychain); standalone.
