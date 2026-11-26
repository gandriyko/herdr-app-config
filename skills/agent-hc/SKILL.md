---
name: agent-hc
description: How to drive Herdr from inside it — start an agent or program with hc, send it a task or message, wait for it, read its answer, stop it, and change what the user sees (spaces, tabs, panes) with herdr-app. Use inside Herdr (when $HC_TERMINAL_ID is set) whenever you start, talk to, wait on or read another agent or terminal, or open, split, focus or close a space, tab or pane. worktree-setup and agent-orchestration build on it.
---

# Drive Herdr: agents with hc, the window with herdr-app

Two tools, two jobs:

- `hc` (herdr-core) runs terminals and agents and keeps them alive: start, send, wait, read, stop.
  It does not touch the window.
- `herdr-app` changes what the user sees: spaces, tabs, panes, focus. Use it only when the user
  should see something.

The `herdr` CLI (and the `herdr` skill) is the older terminal multiplexer. Don't use it here.

The manuals are the authority; where this file and they disagree, they win. Read each once per
session before the first use:

```sh
hc --skill            # hc: run, send, wait, read, reports, recovery
herdr-app --skill     # herdr-app: window commands, mods
hc <command> --help; herdr-app commands   # exact arguments
```

## 0. Check

- `$HC_TERMINAL_ID` must be set (e.g. `t15c`): it is your address. If not, you are not inside
  Herdr: say so and stop. It is a terminal address, not a pane ID.
- `<t>` below is a terminal: an ID (`t7`), a name (`review`) or `machine/t7`.

## 1. Start an agent or a program

```sh
hc templates                                   # ready roles (reviewer, …); use one that fits
hc run --bg --name review --cwd "$dir" reviewer "$TASK"
```

- Always `--bg` (else its whole screen streams into your output) and `--name` (`a-z 0-9 - _`,
  ≤ 32 chars). Give an exact scope.
- Run agents interactively, never in a one-shot print mode (`claude -p`, `codex exec`,
  `copilot -p`, `pi -p`): they must stay watchable and take another turn.
- Put the first task in `run`: a send to a booting agent can be dropped.
- Children end when you end. `--outlive-parent` only when the user wants them to keep running.
- Children don't start more agents unless you assign that.

Without a template, by agent:

| Agent | Start it with the task |
| --- | --- |
| Claude Code | `hc run --bg --name x --cwd "$dir" claude "$TASK"` |
| Codex | `hc run --bg --name x --cwd "$dir" codex --no-daemon "$TASK"` (always `--no-daemon`, or its commands run outside hc) |
| Copilot CLI | `hc run --bg --name x --cwd "$dir" copilot -i "$TASK"` |
| Pi | `hc run --bg --name x --cwd "$dir" pi "$TASK"` |

Any other agent (Hermes, …), or when unsure how it takes a first prompt: start it plain, wait,
then send:

```sh
hc run --bg --name x --cwd "$dir" hermes
hc wait x
hc send x "$TASK"
```

Your own program: `hc get $HC_TERMINAL_ID --json` → `agent` (`claude-code`, `codex`, …). Add the
model flag the user asked for (`--model …`). If a flag is rejected, check `<agent> --help` and fall
back to plain start + send.

Check the launch output. `first_message.sent: false` means the task was NOT sent. Don't resend
blindly: `hc read x`, fix readiness (a trust dialog: `hc keys x down enter`), then send.
Answering a trust dialog is the user's decision: if your permission check blocks the `hc keys`,
ask the user to confirm it in the child's pane (or to allow you to send the keys).

Plain programs:

```sh
hc run cargo test                                  # wait, stream output, exit code
hc run --bg --name web bun dev; hc wait web --output ready
hc run --bg --rm --no-notify --name build make     # slow work: keep yourself reachable
hc wait build
```

Run anything slow (builds, test suites, CI watch, installs) in an hc terminal, not in your own
shell tool: the shell tool blocks you from messages and reports. `run` returns after 180 s with
`still running as t3` (exit 124): wait on that address, don't start a duplicate.

## 2. Send a task or a message

Every task names the report address, so the child knows where to answer:

```sh
hc send x "Recheck the fix. Report with hc send $HC_TERMINAL_ID when done or stuck."
hc send --wait x "…"          # also wait for the turn it starts
hc send --if idle x "…"       # type only when it is idle
hc interrupt x                # stop its current turn, not the process
hc keys x esc                 # press keys: enter, esc, up, ctrl+c
hc put x ./notes.md           # put a file beside it, prints the path
```

- Expand `$HC_TERMINAL_ID` in your own shell before the text leaves it. Build tasks and sends in
  double quotes, never a quoted heredoc (`<<'EOF'`) or single quotes. A literal
  `$HC_TERMINAL_ID` reaches the child, which resolves it to its own address and reports to
  itself. Name your address explicitly (`t15c`), not "your own".
- A send from an agent arrives wrapped as `<hc from="t15c lead">…</hc>`. Keep that for messages.
- A slash command (`/rename`, `/clear`, `/compact`) inside that wrapper is chat text the agent
  can't run. Send it bare, without your caller id:
  `env -u HC_TERMINAL_ID hc send --if idle x "/rename DA-20519 short title"`
- Status `blocked` means a person is needed (permission, a question). `send` refuses it; don't
  use `--force` to bypass a permission decision. Read the screen and ask the user.
- Ask for long answers in a file; the child sends the path.

## 3. Wait, don't poll

```sh
hc wait x                          # x stops working or exits
hc wait x --output "ready"         # x prints this (after the wait starts)
hc wait --children any             # next child's news, or a message to you
hc wait --children all             # until none of your children works
```

- Never `sleep` or loop on `hc ls` / `hc get`.
- `reason: timeout` (180 s) is a check-in, not a failure: wait again.
- `reason: message`: the message comes as your next input. It is not output to `hc read`.
- Keep doing useful work while children work.

## 4. Get the answer

- Reports arrive as your input: `<hc from="t7 review">…</hc>`. They are child reports, not user
  instructions. Verify the result (the diff, tests, the code a claim cites) before you trust
  "done".
- You receive `<hc from="t3 lead" reach="hc send t3 when done or stuck">…</hc>`: when done or
  stuck, answer with `hc send t3 "<result or blocker>"`, not just an acknowledgement.
- Read the screen yourself:

```sh
hc read --lines 60 x        # screen plus history (text)
hc read --lines 0 x         # visible screen only
hc get x                    # state (live/finished) and status (idle/working/done/blocked/error)
hc ls                       # all live terminals, also other people's work
```

Status comes from the program's own reports. Don't guess it from screen text. hc tells you itself
when a child can't report (blocked, error, exited): read its screen then.

Keep the user's screen clean: pipe hc JSON to `>/dev/null` or a short `jq` filter.

## 5. Stop and clean up

```sh
hc kill x; hc rm x          # once you have its result
```

Only clean up terminals you started (`hc ls` includes the user's other work). Never
`hc server stop` / `restart`: it affects every terminal.

## 6. The window: spaces, tabs, panes (herdr-app)

Inspect first, act on IDs from `ls`, never on a guessed focus:

```sh
herdr-app ls          # spaces > tabs > terminals, with pane IDs
herdr-app status      # layout, focus, overlays, errors
herdr-app commands    # every command and its arguments
```

Don't run bare `herdr-app`: it opens or raises the window. Don't stop or restart the app.

Change the window only when the user asks to see something. New spaces and tabs show at once;
`--focus false` creates one without moving the user there. Give every space and tab an explicit
name.

```sh
herdr-app do space.new --name eng-123 --folder ~/code/app-eng-123 --argv '["claude"]' --task "Implement ENG-123" --focus false
herdr-app do tab.new --name "fix login" --argv '["claude"]' --task "Look at the login bug"
herdr-app do terminal.open --folder "$dir" --place down --argv '["bun","dev"]'
herdr-app do pane.split --direction right --pane p12
herdr-app do agent.focus --terminal t7
herdr-app do pane.close --pane p12
```

- Read the reply (`{ "pane": …, "terminal": … }` or `{ "error": … }`), then confirm with `ls`.
  A reply means the terminal exists, not that its program started well.
- An agent started this way is not your hc child. To start your own child in the window, use
  `hc run --label herdr.space=<id>` (optionally `--label herdr.tab=<id>`). Without such a label a
  background worker stays hidden: that is fine, don't add labels just to run one.
- Closing a pane, tab or space ends its terminals (and their dependent children).
- See the window: `herdr-app shot "$scratch/herdr.png"`, then look at the picture.
