---
name: toast
summary: Notification popup style: icon or level dot, title, body; click runs the action and dismisses.
source: https://github.com/gandriyko/herdr-app-config/tree/main/mods/toast
install: copy the folder mods/toast into ~/.config/herdr-app/mods/toast
place: none
needs: []
shared_keys: []
reads_keys: []
commands: [any app command given in the notification's action (action.name with action.args), closeOverlay]
---

## What it does
Renders notifications posted with `notify({ title, body, level, icon, action })`. A level dot (error=blocked, warning=working, success=done, info=accent) or an image icon, a bold title and an optional one-line body. Clicking runs `action.name` with `action.args` and closes the toast.

## Files
- main.js: the toast view.
- mod.json: place none.
- gpui-kit.d.ts, jsconfig.json: editor typings.

## Settings and data
none

## Notes
Standalone, stateless, no timers. Colors come from the theme. Replace it to restyle every notification.
