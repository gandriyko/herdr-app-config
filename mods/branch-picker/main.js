// Branch picker behind the status bar's branch (status-copy): all local branches in a tree
// (groups by their `prefix/`), recently checked-out ones pinned on top, a filter
// box. A click runs `git checkout` and nothing else — spaces, tabs and terminals
// never move. Branches that were deleted (after their merge) drop out of the
// recent list by themselves.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, setShared, notify } from "herdr";

// Where a space works now: its focused terminal's folder, else the first known one.
function place(sp, ps) {
  const tabs = new Set((sp?.tabs ?? []).map(c => c.id));
  return ps.find(p => p.focused && tabs.has(p.tab))?.cwd
    ?? ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd ?? sp?.folder ?? null;
}

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

export default class BranchPicker extends View {
  init(_props, cx) {
    const sp = spaces().find(s => s.id === props()?.space) ?? spaces().find(s => s.active);
    this.on = sp?.machine ?? null;
    this.folder = place(sp, panes());
    this.repoName = "";
    this.branches = undefined; // undefined: loading; then [{ name, at }]
    this.current = null;
    this.recents = [];
    this.recentKey = null;
    this.error = "";
    this.busy = "";
    this.dirty = null; // { b, files }: asking what to do with uncommitted changes
    this.text = "";
    this.at = 0;
    this.collapsed = new Set(JSON.parse(localStorage.getItem("collapsed") ?? "[]"));
    this.input = InputState.new({ placeholder: "filter branches" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.pick(this.pickable()[this.at], cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  async load() {
    if (!this.folder) { this.branches = []; this.error = "This space has no folder to ask."; return; }
    try {
      const top = await exec("git", [...READ, "rev-parse", "--show-toplevel", "--show-prefix"], { cwd: this.folder, on: this.on });
      if (top.code !== 0) { this.branches = []; this.error = `${this.folder} is not in a git repository.`; return; }
      const lines = top.stdout.split("\n");
      const rootRaw = (lines[0] ?? "").trim();
      const prefix = (lines[1] ?? "").trim();
      this.root = rootRaw;
      this.repoName = rootRaw.replace(/\/+$/, "").split("/").pop();
      this.inSub = Boolean(prefix.trim());
      const head = await exec("git", [...READ, "status", "--porcelain=v2", "--branch"], { cwd: this.folder, on: this.on });
      for (const line of head.stdout.split("\n")) if (line.startsWith("# branch.head ")) this.current = line.slice(14);
      const fmt = "--format=%(refname:short)%09%(committerdate:unix)";
      const local = await exec("git", [...READ, "for-each-ref", fmt, "refs/heads"], { cwd: this.folder, on: this.on });
      const list = local.stdout.split("\n").filter(Boolean)
        .map(l => { const [name, at] = l.split("\t"); return { name, at: Number(at) || 0 }; })
        .sort((a, b) => b.at - a.at);
      this.branches = list;
      // Recents live per repo; a branch deleted after its merge leaves the list with it.
      const key = JSON.stringify([this.on, rootRaw]);
      const known = new Set(list.map(b => b.name));
      const stored = JSON.parse(localStorage.getItem("recents") ?? "{}");
      this.recentKey = key;
      this.recents = (stored[key] ?? []).filter(n => known.has(n));
      if ((stored[key] ?? []).join("\n") !== this.recents.join("\n")) {
        stored[key] = this.recents;
        localStorage.setItem("recents", JSON.stringify(stored));
      }
    } catch (e) {
      this.branches = [];
      this.error = String(e?.message ?? e);
    }
  }

  // Rows to draw: the recent section (unfiltered), then a tree of the rest.
  rows() {
    const f = this.text.trim().toLowerCase();
    const all = this.branches ?? [];
    const match = (b) => !f || b.name.toLowerCase().includes(f);
    const inRecents = new Set(this.recents);
    const out = [];
    if (!f && this.recents.length) {
      const rec = this.recents.map(n => all.find(b => b.name === n)).filter(Boolean);
      if (rec.length) {
        out.push({ kind: "head", label: "Recent" });
        for (const b of rec) out.push({ kind: "row", b, depth: 0 });
      }
    }
    const rest = all.filter(b => (f || !inRecents.has(b.name)) && match(b));
    const tops = rest.filter(b => !b.name.includes("/"));
    for (const b of tops) out.push({ kind: "row", b, depth: 0 });
    const groups = {};
    for (const b of rest) if (b.name.includes("/")) {
      const g = b.name.slice(0, b.name.indexOf("/"));
      (groups[g] ??= []).push(b);
    }
    for (const g of Object.keys(groups).sort()) {
      const open = Boolean(f) || !this.collapsed.has(g);
      out.push({ kind: "group", g, count: groups[g].length, open });
      if (open) for (const b of groups[g]) out.push({ kind: "row", b, depth: 1, rest: b.name.slice(g.length + 1) });
    }
    return out;
  }

  pickable() {
    return this.rows().filter(r => r.kind === "row").map(r => r.b);
  }

  toggle(g, cx) {
    if (this.collapsed.has(g)) this.collapsed.delete(g); else this.collapsed.add(g);
    localStorage.setItem("collapsed", JSON.stringify([...this.collapsed]));
    cx.notify();
  }

  git(args) {
    return exec("git", args, { cwd: this.folder, on: this.on });
  }

  fail(r, fallback) {
    const lines = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean);
    return lines.slice(0, 5).join("\n") || fallback;
  }

  // The row's copy button: the full branch name to the clipboard, a check mark for a moment.
  copy(name, cx) {
    cx.stop_propagation();
    cx.write_to_clipboard(name);
    this.copied = name;
    this.copyReset?.cancel();
    this.copyReset = cx.timer.after(1200, (cx) => { if (this.copied === name) this.copied = null; cx.notify(); });
    cx.notify();
  }

  // A click: if tracked files have uncommitted changes, ask what to do first.
  pick(b, cx) {
    if (!b || this.busy || b.name === this.current) return;
    this.busy = b.name;
    this.error = "";
    this.dirty = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const st = await this.git([...READ, "status", "--porcelain", "-uno"]);
        const files = st.code === 0 ? st.stdout.split("\n").filter(Boolean).map(l => l.slice(3)) : [];
        if (files.length) {
          this.busy = "";
          this.dirty = { b, files };
          cx.notify();
          return;
        }
        await this.switchTo(b, false, cx);
      } catch (e) {
        this.busy = "";
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  // mode: "plain" (carry the changes over, git refuses on conflict) or "stash".
  doSwitch(b, mode, cx) {
    if (this.busy) return;
    this.busy = b.name;
    this.error = "";
    this.dirty = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.switchTo(b, mode === "stash", cx); }
      catch (e) { this.busy = ""; this.error = String(e?.message ?? e); cx.notify(); }
    });
  }

  async switchTo(b, stash, cx) {
    // Only git's state moves, the window stays as it is.
    if (stash) {
      const s = await this.git(["stash", "push", "-m", `branch-picker: before switching to ${b.name}`]);
      if (s.code !== 0) { this.busy = ""; this.error = this.fail(s, "git stash failed."); cx.notify(); return; }
    }
    const r = await this.git(["checkout", b.name]);
    if (r.code !== 0) {
      if (stash) await this.git(["stash", "pop"]); // put the changes back where they were
      this.busy = "";
      this.error = this.fail(r, "git checkout failed.");
      cx.notify();
      return;
    }
    if (stash) notify({ title: `Switched to ${b.name}`, body: "Your changes are stashed. Restore them with: git stash pop", level: "info" });
    this.recents = [b.name, ...this.recents.filter(n => n !== b.name)].slice(0, 10);
    const stored = JSON.parse(localStorage.getItem("recents") ?? "{}");
    stored[this.recentKey] = this.recents;
    localStorage.setItem("recents", JSON.stringify(stored));
    setShared("branch.switched", Date.now()); // the header chip re-asks on this
    this.close();
  }

  key(e, cx) {
    if (e.key === "escape") { if (this.dirty) { this.dirty = null; cx.stop_propagation(); return cx.notify(); } return this.close(); }
    if (this.dirty) return;
    const n = this.pickable().length;
    if (e.key === "enter") { this.pick(this.pickable()[this.at], cx); cx.stop_propagation(); return cx.notify(); }
    if ((e.key === "down" || e.key === "up") && n) { this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n; cx.stop_propagation(); return cx.notify(); }
  }

  render(cx) {
    const t = theme();
    const rows = this.rows();
    const total = (this.branches ?? []).length;
    let rowNo = -1;
    const row = (r) => {
      if (r.kind === "head") {
        return h_flex().flex_none().h(24).px(10).items_center().child(div().text_size(11).text_color(t.dim).child(r.label.toUpperCase()));
      }
      if (r.kind === "group") {
        return h_flex().id(`bg-${r.g}`).flex_none().h(28).px(10).gap(7).items_center().rounded(6).cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(r.g, cx))
          .child(div().w(16).text_size(11).text_color(t.dim).child(r.open ? "▾" : "▸"))
          .child(svg("mods/workspace-chrome/folder.svg").size(13).text_color(t.dim))
          .child(div().text_color(t.muted).child(r.g))
          .child(div().text_size(11).text_color(t.dim).child(String(r.count)));
      }
      const i = ++rowNo;
      const on = i === this.at;
      const cur = r.b.name === this.current;
      const busy = this.busy === r.b.name;
      return h_flex()
        .id(`br-${i}`)
        .flex_none()
        .h(30)
        .pl(10 + r.depth * 18)
        .pr(10)
        .gap(8)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, el => el.bg(t.selected))
        .when(!on, el => el.hover(s => s.bg(t.hover)))
        .tooltip(r.b.name)
        .on_hover((h, cx) => { if (h) this.hovered = r.b.name; else if (this.hovered === r.b.name) this.hovered = null; cx.notify(); })
        .on_click((_e, cx) => this.pick(r.b, cx))
        .child(svg(`mods/workspace-chrome/${r.depth ? "branch" : "git-branch"}.svg`).size(13).text_color(cur ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(cur ? t.foreground : t.muted).child(r.rest ?? r.b.name))
        // Copy the full name (tree rows show only the part after the folder); the click doesn't check out.
        .when(on || this.hovered === r.b.name || this.copied === r.b.name, el => el.child(div().id(`br-copy-${i}`).flex_none().size(20).flex().items_center().justify_center().rounded(4)
          .text_color(this.copied === r.b.name ? t.accent : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.copied === r.b.name ? "Copied" : `Copy “${r.b.name}”`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.copy(r.b.name, cx))
          .child(svg(`mods/${this.copied === r.b.name ? "workspace-chrome/check" : "branch-picker/copy"}.svg`).size(12))))
        .when(cur, el => el.child(div().flex_none().text_size(11).text_color(t.accent).child("current")))
        .when(busy, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(!cur && !busy && r.b.at > 0, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(r.b.at))));
    };
    return v_flex()
      .id("branch-picker")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex()
        .child(div().flex_1().font_semibold().text_color(t.foreground).child(`Branches${this.repoName ? ` of ${this.repoName}` : ""}`))
        .when(this.branches, el => el.child(div().text_size(11).text_color(t.dim).child(this.text.trim() ? `${rows.filter(r => r.kind === "row").length}/${total}` : `${total}`))))
      .when(this.inSub, el => el.child(div().text_size(11).text_color(t.dim).child(`checked out inside ${this.folder.replace(this.root + "/", "")}`)))
      .when(this.branches === undefined, el => el.child(div().text_color(t.muted).child("…")))
      .when(this.branches && this.error && !this.branches.length, el => el.child(div().text_color(t.muted).child(this.error)))
      .when(this.branches && this.branches.length && this.error, el => el.child(v_flex().gap(2).text_size(11.5).text_color(t.error ?? "#d9649a").children(this.error.split("\n").map(l => div().child(l)))))
      .when(this.dirty, el => {
        const d = this.dirty;
        const btn = (id, label, primary, action) => div().id(id).h(30).px(12).flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(12.5)
          .border(1).border_color(primary ? t.accent : t.input).bg(primary ? t.accent : t.background).text_color(primary ? t.accent_foreground : t.foreground)
          .hover(s => s.opacity(0.85)).on_click(action).child(label);
        return el.child(v_flex().gap(10).p(12).rounded(8).border(1).border_color(t.border).bg(t.surface)
          .child(div().text_color(t.foreground).font_semibold().child(`Uncommitted changes (${d.files.length} file${d.files.length === 1 ? "" : "s"})`))
          .child(v_flex().gap(2).text_size(11.5).text_color(t.muted)
            .children(d.files.slice(0, 6).map(f => div().truncate().child(f)))
            .when(d.files.length > 6, e2 => e2.child(div().text_color(t.dim).child(`… and ${d.files.length - 6} more`))))
          .child(div().text_size(11.5).text_color(t.dim).child(`Switching to ${d.b.name}: carry the changes along (git refuses if they conflict) or stash them first.`))
          .child(h_flex().gap(8).flex_wrap()
            .child(btn("sw-stash", "Stash and switch", true, (_e, cx) => this.doSwitch(d.b, "stash", cx)))
            .child(btn("sw-carry", "Switch anyway", false, (_e, cx) => this.doSwitch(d.b, "plain", cx)))
            .child(btn("sw-cancel", "Cancel", false, (_e, cx) => { this.dirty = null; cx.notify(); }))));
      })
      .when(this.branches && this.branches.length, el => el
        .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .child(div().relative().h(400).min_h(0)
          .child(v_flex().id("br-list").absolute().inset_0().overflow_y_scroll().gap(1)
            .children(rows.map(row))
            .when(!rows.some(r => r.kind === "row"), el => el.child(div().p(10).text_color(t.dim).child("No matching branch."))))
          .child(Scrollbar.vertical("br-list").absolute().inset_0())))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↑↓ choose · ↵ checkout · esc close"));
  }
}