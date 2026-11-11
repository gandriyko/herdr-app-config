---
name: jira
summary: Panel with my open Jira issues by sprint and the project backlog
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/jira
install: copy the folder mods/jira into ~/.config/herdr-app/mods/jira
place: none
needs: [Jira Cloud REST API over network (api.atlassian.com or the site URL), macOS Keychain item herdr-jira, security, open, an agent from knownAgents() for sessions (default claude)]
shared_keys: [jira.settings]
reads_keys: []
commands: [tab.new (a Claude session for a task)]
---

## What it does
Lists my open Jira issues grouped by sprint plus the project backlog. Click opens the issue in the browser; right-click copies the task ID or starts an agent session. Each row's terminal button starts that session: `tab.new {name: <key>, argv: <agent's run>, task: <key>, folder}` in the focused pane's folder (else the active space's), so the task key is the agent's first message. The agent is picked in the settings form from Herdr's `knownAgents()` (installed ones on the active space's machine; programs.json can add more) and saved at once as `jira.settings.agent` / `agentName`; default Claude Code. A settings form saves site, project and credentials (email and API token).

## Files
- main.js: UI, Jira requests, Keychain access, settings form.
- jira.svg, refresh.svg, session.svg, settings.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Keychain service `herdr-jira` (account = email, password = API token), via `security`.
- Shared state `jira.settings` ({ site, project, base }).

## Notes
- Refresh every 5 min.
- Uses an API token, not OAuth; the token is briefly in `security` argv when saved (noted in code).
- macOS only (Keychain); standalone.
