# Herdr app config

My [Herdr](https://herdr.dev/app) layout (`my-layout`), the `changes-copy` mod and themes.

## Install

1. Run Herdr once (it creates `~/.config/herdr-app` and its shipped mods).
2. Put this repo there:

   ```sh
   cd ~/.config/herdr-app
   git init -b main
   git remote add origin https://github.com/gandriyko/herdr-app-config.git
   git fetch origin && git checkout -f main
   ```

3. Enable the layout (it loads `changes-copy`): `ctrl-shift-l`, or

   ```sh
   herdr-app do layout.switch --name my-layout
   ```

4. Connect the Claude Code skills (see [Skills](#skills)):

   ```sh
   mkdir -p ~/.claude/skills
   for d in ~/.config/herdr-app/skills/*/; do ln -sfn "${d%/}" ~/.claude/skills/; done
   ```

Nothing is needed in `settings.json`: mods are connected by the layout, not by settings.

## Skills

`skills/` holds Claude Code skills for agents running in Herdr. Each one is a folder with a `SKILL.md`.
Claude reads skills from `~/.claude/skills/`, so each folder is linked there (step 4 of Install
links them all). A symlink, not a copy, so `git pull` here updates the skill too.

- Re-run the step 4 loop after a pull that adds a skill. `ln -sfn` replaces an old link, so running it again is safe.
- Start a new Claude session after linking: a running one won't see the new skill.
- Check: `ls -l ~/.claude/skills` shows the links; in Claude, `/worktree-split` should autocomplete.
- Use: ask in words ("split this PR into two worktrees") or call `/worktree-split <task>`.
- Remove: `rm ~/.claude/skills/<name>` (deletes the link only).
- Only for one project instead of every one: link it into `<project>/.claude/skills/` instead.

| Skill | What it does |
| --- | --- |
| `worktree-split` | Splits a task or PR into git worktrees, runs a child agent in each with `hc run`, waits for them and chains follow-ups (review after implement). The children show nested under their parent in `agents-board`. Needs `hc`, `git`, `gh` (for PRs). |
