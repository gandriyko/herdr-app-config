// The panel's search mode (its header's magnifier button): text in every file under the panel's folder, like Find in
// Files. rg (else grep), with match case, whole word, regex, Include and Exclude globs. A hit opens in the space's one
// file viewer (openFile), replacing the file shown there.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, v_virtual_list, VirtualListScrollHandle, Scrollbar } from "gpui-base";
import { spaces, exec, watchFolder, theme, shared } from "herdr";
import { findRegex } from "./find.js";
import { openFile } from "./open.js";

// Searched: git-ignored files and dot files too (.env, tmp/), except inside these folders, the Exclude field and
// the panel's Exclude masks (shared files-copy.exclude, same mod).
const SKIP = ["node_modules", ".git", "__pycache__", "venv*", ".venv*", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".next"];
const SKIP_PART = /^(node_modules|\.git|__pycache__|\.?venv.*|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.next)$/;
const CAP = 1000, ROW = 24, OPTS = "files-copy.search"; // localStorage: { case, word, regex, include, exclude }
// argv: the program and its arguments. 127 when the program is missing; output cut at CAP + 1 lines (the extra one says "capped").
const SH = `command -v "$1" >/dev/null 2>&1 || exit 127; "$@" 2>/dev/null | head -n ${CAP + 1}`;
const RG = ["--no-heading", "--line-number", "--null", "--no-ignore", "--hidden", "--max-count", "50", "--max-columns", "400", "--max-columns-preview", "--max-filesize", "1M"];
const globList = s => s.split(/[,\s]+/).filter(Boolean);

// "path\0line:text" lines → [{ path, line (1-based), col (0-based, tabs as 4 spaces like the file view), text (a snippet), at, len (the hit in it) }].
// The hit is found again with the JS form of the query (rg's regex dialect differs a little: then the row has no tint).
export function parseGrep(out, re) {
  const list = [];
  for (const l of out.split("\n")) {
    const z = l.indexOf("\0"), m = z > 0 ? /^(\d+):(.*)$/.exec(l.slice(z + 1)) : null;
    if (!m) continue;
    const text = m[2].replace(/\r$/, "").replace(/\t/g, "    ");
    re.lastIndex = 0;
    const hit = re.exec(text), col = hit?.index ?? 0, len = hit?.[0].length ?? 0, lead = text.length - text.trimStart().length;
    const start = Math.max(lead, col - 60), cut = start > lead;
    list.push({ path: l.slice(0, z).replace(/^\.\//, ""), line: Number(m[1]), col, text: (cut ? "…" : "") + text.slice(start, start + 400), at: col - start + (cut ? 1 : 0), len });
  }
  return list;
}

export class SearchView {
  constructor(cx) {
    this.root = null; this.on = null;
    let o = {}; try { o = JSON.parse(localStorage.getItem(OPTS) ?? "{}"); } catch {}
    this.o = { case: Boolean(o.case), word: Boolean(o.word), regex: Boolean(o.regex) };
    this.query = InputState.new({ placeholder: "Search in files" });
    this.include = InputState.new({ placeholder: "Include: *.py, src/**" });
    this.exclude = InputState.new({ placeholder: "Exclude: tests, *.min.js" });
    for (const s of [this.query, this.include, this.exclude]) s.on("change", (_e, cx) => { if (this.restoring) return; this.cur = null; this.schedule(cx); });
    this.query.on("submit", (_e, cx) => this.open(this.cur ?? 0, cx));
    // res = { key, list, capped, error? }: the last answer stays on screen while a new one runs. One search at a time.
    // live: shown in the panel; hidden, its watch ends and answers are dropped (the query and last answer stay).
    this.res = null; this.cur = null; this.gen = 0; this.busy = false; this.again = false; this.live = false; this.watchGen = 0;
    this.scroll = VirtualListScrollHandle.new();
  }

  // The panel switched to search (or to another folder while searching): search the folder, focus the query.
  show(root, on, cx, focus = true) {
    const moved = root !== this.root || (on ?? null) !== this.on;
    this.root = root; this.on = on ?? null;
    if (moved) { this.res = null; this.cur = null; }
    if (!this.live || moved) { this.live = true; this.watch(cx); if (this.query.value()) this.run(cx); }
    if (focus) cx.timer.after(0, () => this.query.focus());
  }
  hide() { this.live = false; this.watchGen++; }
  save() { try { localStorage.setItem(OPTS, JSON.stringify(this.o)); } catch {} }
  // Each place (space + folder) keeps its own query, Include / Exclude, answer and picked hit (the panel holds them
  // in its per-place map); Aa / W / .* are shared by all. state() is the place's copy, restore() brings one back
  // (null: empty) and stops the search until show(). Not from render (it sets the inputs).
  state() { return { q: this.query.value(), inc: this.include.value(), exc: this.exclude.value(), res: this.res, cur: this.cur, root: this.root, on: this.on }; }
  restore(s) {
    this.hide();
    this.restoring = true;
    try { this.query.set_value(s?.q ?? ""); this.include.set_value(s?.inc ?? ""); this.exclude.set_value(s?.exc ?? ""); }
    finally { this.restoring = false; }
    this.res = s?.res ?? null; this.cur = s?.cur ?? null; this.root = s?.root ?? null; this.on = s?.on ?? null;
  }
  // The search's inputs; key tells whether the answer on screen is for them.
  inputs() {
    const q = this.query.value(), inc = globList(this.include.value()), exc = globList(this.exclude.value());
    return { q, inc, exc, o: { ...this.o }, key: JSON.stringify([this.root, q, inc, exc, this.o]) };
  }

  // Files changed under the folder (local only): search again, unless every path is in a skipped folder.
  watch(cx) {
    const gen = ++this.watchGen, root = this.root;
    if (this.on) return;
    cx.spawn(async cx => {
      try {
        while (this.live && gen === this.watchGen) {
          const paths = await watchFolder(root);
          if (!this.live || gen !== this.watchGen) return;
          if (paths.some(p => !p.slice(root.length).split("/").some(n => SKIP_PART.test(n))) && this.query.value()) this.schedule(cx);
        }
      } catch {}
    });
  }
  schedule(cx) {
    const gen = ++this.gen;
    cx.timer.after(300, acx => { if (gen === this.gen) this.run(acx); });
  }
  run(cx) {
    if (this.busy) { this.again = true; return; }
    const { q, inc, exc, o, key } = this.inputs(), re = findRegex(q, o);
    const set = (next) => { if (JSON.stringify(next) !== JSON.stringify(this.res)) { this.res = next; cx.notify(); } };
    if (!q) return set(null);
    if (!re) return set({ key, list: [], capped: false, error: "Invalid regular expression" });
    const masks = Array.isArray(shared("files-copy.exclude")) ? shared("files-copy.exclude") : [];
    const skip = [...SKIP, ...masks, ...exc], opt = { cwd: this.root, on: this.on, timeout: 10000 };
    this.busy = true;
    cx.spawn(async cx => {
      let next;
      try {
        let r = await exec("sh", ["-c", SH, "files-search", "rg", ...RG, o.case ? "-s" : "-i", ...(o.word ? ["-w"] : []), ...(o.regex ? [] : ["-F"]),
          ...inc.flatMap(g => ["-g", g]), ...skip.flatMap(g => ["-g", `!${g}`]), "--", q, "."], opt);
        // ponytail: grep's --include matches file names only (src/** doesn't narrow), and its -E differs from rg's regex.
        if (r.code === 127) r = await exec("sh", ["-c", SH, "files-search", "grep", "-rnI", "--null", o.regex ? "-E" : "-F", ...(o.case ? [] : ["-i"]), ...(o.word ? ["-w"] : []),
          ...inc.map(g => `--include=${g}`), ...skip.flatMap(g => [`--exclude=${g}`, `--exclude-dir=${g}`]), "--", q, "."], opt);
        const list = parseGrep(r.stdout, re);
        next = { key, list: list.slice(0, CAP), capped: list.length > CAP };
      } catch (e) {
        next = { ...(this.res ?? { list: [], capped: false }), key, error: /timed? ?out/i.test(String(e)) ? "Search took over 10 s" : String(e) };
      } finally {
        this.busy = false;
        // An answer for another place (switched while it ran) is dropped.
        if (this.live && next.key === this.inputs().key) set(next);
        else if (this.live) this.again = true;
        if (this.again) { this.again = false; this.run(cx); }
      }
    });
  }

  // Rows of the result list: a file row before its hits. Cached by the answer.
  rows() {
    const res = this.res;
    if (this.rowsOf?.res === res) return this.rowsOf;
    const rows = [], rowOf = [], count = new Map(), list = res?.list ?? [];
    for (const h of list) count.set(h.path, (count.get(h.path) ?? 0) + 1);
    list.forEach((h, k) => {
      if (h.path !== list[k - 1]?.path) rows.push({ path: h.path, n: count.get(h.path), k });
      rowOf.push(rows.length); rows.push({ hit: h, k });
    });
    return this.rowsOf = { res, rows, rowOf, files: count.size };
  }
  // Opens hit k in the space's one file viewer (it replaces the file shown there), centred on its line, with its
  // find row set to this search.
  open(k, cx) {
    const h = this.res?.list[k];
    if (!h) return;
    this.cur = k;
    const space = spaces().find(s => s.active);
    openFile({ space: space?.id ?? null, root: this.root, on: this.on, path: h.path, line: h.line, col: h.col + 1,
      find: { q: this.query.value(), ...this.o }, ts: Date.now(), from: space?.tabs.find(t => t.active)?.id ?? null });
    cx.notify();
  }
  move(dir, cx) {
    const n = this.res?.list.length ?? 0;
    if (!n) return;
    this.cur = this.cur === null ? (dir > 0 ? 0 : n - 1) : (this.cur + dir + n) % n;
    this.scroll.scroll_to_item(this.rows().rowOf[this.cur], "center"); cx.notify();
  }

  // A row is drawn without handlers (a virtual list's rule); the list's on_item_click opens it.
  row(r, t) {
    const base = h_flex().h(ROW).flex_none().pr(10).gap(8).items_center().rounded(6).cursor_pointer().hover(s => s.bg(t.hover)).whitespace_nowrap();
    if (!r.hit) {
      const cut = r.path.lastIndexOf("/");
      return base.pl(8).child(svg("mods/files-copy/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().font_semibold().child(r.path.slice(cut + 1)))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(cut > 0 ? r.path.slice(0, cut) : ""))
        .child(div().flex_none().px(6).rounded(8).bg(t.hover).text_size(11).text_color(t.dim).child(String(r.n)));
    }
    const h = r.hit;
    return base.pl(14).when(r.k === this.cur, el => el.bg(t.selected))
      .child(div().flex_none().w(32).text_right().text_size(11).text_color(t.dim).child(String(h.line)))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().text_size(12)
        .child(div().flex_none().child(h.text.slice(0, h.at)))
        .child(div().flex_none().bg(t.ansi3 + "55").rounded(2).child(h.text.slice(h.at, h.at + h.len)))
        .child(div().flex_1().min_w(0).truncate().child(h.text.slice(h.at + h.len))));
  }

  // The panel's body in search mode (under its header): fields, then the hits. onEscape: Esc in a field.
  render(cx, onEscape) {
    const t = theme(), { key } = this.inputs(), res = this.res, { rows, files } = this.rows();
    const field = (id, state, tip) => div().id(id).h(28).px(8).flex_1().min_w(0).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
      .when(Boolean(tip), el => el.tooltip(tip))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => {
        if (e.keystroke === "escape") { onEscape?.(cx); cx.stop_propagation(); }
        else if (e.key === "up" || e.key === "down") { this.move(e.key === "down" ? 1 : -1, cx); cx.stop_propagation(); }
      })
      .child(Input.new(state).flex_1().h_full().text_size(12).text_color(t.foreground));
    const opt = (id, label, tip, flag, first) => div().id(id).w(26).h(26).flex().items_center().justify_center().text_size(11).tooltip(tip)
      .when(!first, e => e.border_l(1).border_color(t.border))
      .text_color(this.o[flag] ? t.foreground : t.dim).when(this.o[flag], e => e.bg(t.selected)).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.o[flag] = !this.o[flag]; this.cur = null; this.save(); this.run(cx); cx.notify(); }).child(label);
    const note = (text, color = t.dim) => div().flex_none().px(14).py(6).text_size(11).text_color(color).child(text);
    const status = !this.query.value() ? "Type text to search every file under the folder (git-ignored too; not venv, node_modules, caches)"
      : !res || res.key !== key ? "Searching…" : !res.list.length ? (res.error ? "" : "No matches")
      : `${res.capped ? "First " : ""}${res.list.length} matches in ${files} files${res.capped ? " (at most 50 per file)" : ""}`;
    return v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(8).pt(8).gap(6)
        .child(h_flex().gap(6).items_center()
          .child(field("files-search-q", this.query, "Text to find in files. ↑/↓ pick a match, Enter opens it, Esc goes back to the tree"))
          .child(h_flex().flex_none().rounded(7).border_1().border_color(t.border).overflow_hidden()
            .child(opt("files-search-case", "Aa", "Match case", "case", true))
            .child(opt("files-search-word", "W", "Whole word", "word"))
            .child(opt("files-search-re", ".*", "Regular expression", "regex"))))
        .child(h_flex().child(field("files-search-inc", this.include, "Only these files: globs, comma-separated (*.py, src/**)")))
        .child(h_flex().child(field("files-search-exc", this.exclude, "Skip these files or folders: globs, comma-separated (tests, *.min.js)"))))
      .child(div().flex_1().min_h(0).relative().px(6).pt(6)
        .child(v_virtual_list("files-search-list", rows.length, ROW, i => String(i), range => rows.slice(range.start, range.end).map(r => this.row(r, t)))
          .track_scroll(this.scroll).on_item_click((k, cx) => this.open(rows[Number(k)]?.k, cx)).size_full())
        .child(Scrollbar.vertical("files-search-list").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(status), el => el.child(note(status)))
      .when(Boolean(res?.error), el => el.child(note(res.error, t.ansi1)));
  }
}
