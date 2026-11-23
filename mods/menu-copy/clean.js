// "Remove all worktrees" dialog: lists the linked worktrees of the focused repo,
// then runs `git worktree remove` (never --force) on each and closes its space.
// git itself refuses a worktree with uncommitted or untracked changes, submodules
// or a lock; those are skipped with git's reason. Branches stay.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, closeOverlay, props, spaces, panes, exec } from "herdr";

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on, timeout: 120_000 });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder is in: its main checkout and linked worktrees [{ path, branch }], or null outside git.
async function worktrees(folder, on) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!common.ok) return null;
  await git(folder, ["worktree", "prune"], on); // drop worktrees whose folder is already gone
  const r = await git(folder, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"], on);
  if (!r.ok) throw new Error(r.err || "git worktree list failed.");
  const [main, ...rest] = r.out.split(/\n\n+/).map((b) => b.split("\n"));
  const list = rest.filter((l) => !l.includes("bare")).map((l) => ({
    path: l[0].slice("worktree ".length),
    branch: l.find((x) => x.startsWith("branch "))?.slice("branch refs/heads/".length) ?? null,
  }));
  return { main: main[0].slice("worktree ".length), list };
}

// Where a space is: its first terminal's folder, else where it was made.
function place(s, all) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || "";
}

export class Clean {
  constructor({ folder, machine }, cx) {
    this.on = machine ?? undefined;
    this.repo = undefined; // undefined: loading, null: not in git
    this.error = "";
    this.busy = false;
    this.done = null; // { removed, skipped: [{ path, why }] }
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => {
      try { this.repo = folder ? await worktrees(folder, this.on) : null; }
      catch (error) { this.repo = null; this.error = String(error); }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  go(cx) {
    if (this.busy || this.done || !this.repo?.list.length) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const removed = [], skipped = [];
      for (const w of this.repo.list) {
        try {
          // A detached HEAD may hold commits no branch keeps: removing the worktree would lose them.
          if (!w.branch) {
            const lost = await git(w.path, ["rev-list", "-n1", "HEAD", "--not", "--branches", "--remotes", "--tags"], this.on);
            if (!lost.ok || lost.out) { skipped.push({ path: w.path, why: "detached HEAD with commits on no branch" }); continue; }
          }
          const r = await git(this.repo.main, ["worktree", "remove", w.path], this.on);
          if (!r.ok) { skipped.push({ path: w.path, why: r.err.replace(/^fatal: /, "") || "git worktree remove failed" }); continue; }
          removed.push(w.path);
        } catch (error) { skipped.push({ path: w.path, why: String(error) }); }
      }
      const all = panes(), inside = (p) => removed.some((dir) => p === dir || p.startsWith(dir + "/"));
      for (const s of spaces()) if ((s.machine ?? undefined) === this.on && inside(place(s, all))) run("space.close", { id: s.id, confirmed: true });
      this.done = { removed, skipped };
      this.busy = false;
      cx.notify();
    });
  }

  render(t) {
    const r = this.repo, d = this.done;
    const name = r ? r.main.split("/").at(-1) : "";
    const button = (id, label, color, act) =>
      div().id(id).px(10).py(4).rounded(6).border(1).border_color(color).text_size(12).text_color(color)
        .cursor_pointer().hover((s) => s.opacity(0.8)).on_click((_e, cx) => act(cx)).child(label);
    const line = (text, color) => div().truncate().text_size(11.5).text_color(color).child(text);
    const items = d ? [...d.removed.map((p) => line(`removed  ${p}`, t.dim)), ...d.skipped.map((s) => line(`skipped  ${s.path}: ${s.why}`, t.blocked))]
      : (r?.list ?? []).map((w) => line(`${w.branch ?? "detached"}  ${w.path}`, t.dim));
    return v_flex()
      .id("clean-worktrees")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter") d ? this.close() : this.go(cx);
        else return;
        cx.stop_propagation();
      })
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(`Remove all worktrees${name ? ` of ${name}` : ""}`))
      .child(div().text_color(t.muted).child(
        r === undefined ? "…"
          : r === null ? this.error || "This folder is not in a git repository."
            : d ? `Removed ${d.removed.length}, skipped ${d.skipped.length}.`
              : r.list.length === 0 ? "No worktrees besides the main checkout."
                : "Removes every linked worktree and closes its space. Branches stay. Worktrees with uncommitted or untracked changes are skipped."))
      .child(v_flex().id("clean-list").flex_1().min_h(0).gap(2).overflow_y_scroll().children(items))
      .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
        .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)).child("removing…"))
        .when(!this.busy && (d || !r?.list.length), (el) => el.child(button("clean-close", "Close  esc", t.foreground, () => this.close())))
        .when(!this.busy && !d && Boolean(r?.list.length), (el) => el
          .child(button("clean-cancel", "Cancel  esc", t.foreground, () => this.close()))
          .child(button("clean-go", `Remove ${r.list.length}  ↵`, t.blocked, (cx) => this.go(cx)))));
  }
}
