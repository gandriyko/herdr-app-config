---
name: jira
summary: Panel with my open Jira issues by sprint and the project backlog
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/jira
install: copy the folder mods/jira into ~/.config/herdr-app/mods/jira
place: none
needs: [Jira Cloud REST API over network (api.atlassian.com or the site URL), macOS Keychain item herdr-jira, security, open]
shared_keys: [jira.settings]
reads_keys: []
commands: []
---

## What it does
Lists my open Jira issues grouped by sprint plus the project backlog. Click opens the issue in the browser; right-click copies the task ID. A settings form saves site, project and credentials (email and API token).

## Files
- main.js: UI, Jira requests, Keychain access, settings form.
- jira.svg, refresh.svg, settings.svg: icons.
- gpui-kit.d.ts, jsconfig.json: editor typings only.

## Settings and data
- Keychain service `herdr-jira` (account = email, password = API token), via `security`.
- Shared state `jira.settings` ({ site, project, base }).

## Notes
- Refresh every 5 min.
- Uses an API token, not OAuth; the token is briefly in `security` argv when saved (noted in code).
- macOS only (Keychain); standalone.
