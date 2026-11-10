# Writing mods here

The root AGENTS.md (rewritten by Herdr on every start, don't edit) explains the app. These are our own
rules for every mod we write or change; `CLAUDE.md` at the root imports this file. Check each one
before calling a mod done, along with `herdr-app check mods/<name>`.

## Performance: CPU and memory

Every mod runs inside the Herdr window process. Each `cx.notify()` redraws the **whole window**, and
every host call (`spaces()`, `panes()`, `focused()`, `agents()`, `shared()`) copies data across the
JS boundary. Small costs repeated many times a second pile up into heap growth and CPU churn over a
day of uptime.

- **Redraw only on change.** Before `cx.notify()` after async work, compare what the mod shows
  (e.g. `JSON.stringify` of the shown state) with what it showed before. Don't notify
  unconditionally in `finally`.
- **Don't poll live data.** `render()` already reruns when spaces, agents, focus, theme or shared
  state change. A timer may only be used for things nothing notifies about (focus moved to another
  folder, a remote state). Then the interval is **≥ 2000 ms** unless there is a measured reason
  for faster. Never 500 ms.
- **Timers are for data, not animation.** Use `.frames()`, `svg().spin()`, `.loop()`,
  `.transition()`; never `cx.timer.every(…, () => cx.notify())`.
- **Coalesce bursts.** A refresh triggered while one is running sets a flag and runs once more
  after it (`cx.timer.after`), never once per event. One refresh in flight at a time.
- **`watchFolder` is recursive** (on macOS it includes `node_modules`, `.git/objects`, build
  output). Drop batches whose paths are all noise, or watch the narrowest folder that answers the
  question (e.g. the git dir for index/HEAD).
- **Ask external programs for only what you use.** `git status -uno` when untracked files aren't
  shown; `--limit` and only the `--json` fields you render (`gh`); `hc read --lines N`. Cap lists
  (e.g. 1000 rows) and say so in the UI.
- **Keep state bounded.** Caches and maps keyed by folder/PR/session need a cap or eviction. Drop
  large payloads (a whole conversation, a diff) when the view closes. No big blobs in
  `setShared` or `localStorage`.
- **Long lists:** a few hundred rows or more → `uniform_list` / `v_virtual_list` with
  `on_item_click` (handlers inside the row renderer throw). Don't rebuild expensive derived data
  (trees, sorts) in `render()` when the input didn't change; cache it by the input.
- **Hidden copies keep running.** A mod in a hidden column or another tab keeps its timers and
  loops, so polling must be cheap even when nobody is looking.
- **Remote and network calls** may hang: pass `timeout` to `exec`, guard against overlapping
  fetches, and keep the last good answer on failure.
- **Measure when in doubt:** `footprint <pid>` / `vmmap --summary <pid>` for the Herdr process
  before and after; note any measured ceiling in a `ponytail:` comment.

## Isolation: every mod stands alone

A mod must work when copied alone into another person's `mods/` folder, and must not break when
another mod is removed, cloned or updated.

- **Own files only.** Import only from its own folder (`./ai.js`), never `../other-mod/`.
  Reference assets by its own path (`mods/<name>/icon.svg`); copy an icon it needs (a spinner, a
  branch icon) into its folder instead of pointing at another mod's (`mods/workspace-chrome/…`,
  `mods/pane/…`): shipped mods are replaced on every start and may drop the file.
- **Namespaced shared state.** Every `setShared` key starts with the mod's name
  (`jira.settings`, `prs.changed`). Reading another mod's key is a documented contract: name it
  in a comment at the read, and the mod must still work when the key is missing.
- **No hidden coupling.** Talk to other mods through app commands, documented shared keys or
  `mod.open`/overlays, never by assuming another mod is in the layout. Opening another mod
  (e.g. `wb-diff` from `changes-copy`) is fine; failing silently when it's absent is not.
- **Own secrets and data.** Keychain service names, `data/<mod>/` files and `localStorage` keys
  belong to one mod; don't read another mod's.
- **No module-level side effects.** Instance state lives in `init()`; module scope holds
  constants and pure helpers only (module code is shared by every copy and survives reloads).
- **Clean up.** Long-lived work (watch loops, spawned processes, terminals) checks a generation or
  "live" flag so an old loop ends, and `close(cx)` stops anything that outlives the view.
