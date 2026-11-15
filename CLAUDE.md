# Project rules

The rules for writing mods live in `mods/AGENTS.md`, shared with other agents (the root AGENTS.md is
Herdr's and rewritten on every start). Read them before writing or changing a mod:

@mods/AGENTS.md

# Skills

`skills/<name>/SKILL.md` are agent skills (Agent Skills format) for agents running in Herdr, tracked
here and linked into `~/.claude/skills/`, `~/.agents/skills/` and `~/.hermes/skills/` (README, Install
step 4 and the Skills section). Keep them agent-neutral: no Claude-only commands without the others. When setting this repo up on
a machine, or after a pull that adds a skill, run that link loop and tell the user to start a new
agent session. A new or changed skill updates the Skills table in `README.md` in the same commit.
