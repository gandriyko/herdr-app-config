// A lazy file tree for the focused pane's folder. A click opens the file in a tab (this same mod, opened
// with props), one tab per space reused through shared("files-copy.open"), like changes-copy and wb-diff.
// In the tab, Python files: ⌘-click (or F12) a name to jump to its definition (jedi via uvx).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, run, shared, setShared, props } from "herdr";
import { highlight, languageFor } from "./highlight.js";

const PY = languageFor("x.py"), ENV = languageFor(".env");
// ponytail: CHAR_W assumes a monospace font at 0.6 em (JetBrains Mono, Menlo, SF Mono); another font puts the underline off.
const FONT = 13, ROW = 20, CHAR_W = FONT * 0.6;

// argv: project root, file, line (1-based), column. Prints [{path, line, col}]; uses the project's .venv/venv when present.
const GOTO = `import sys, os, json, jedi
root, path, line, col = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
env = None
for d in (".venv", "venv"):
    if os.path.isdir(os.path.join(root, d)):
        try: env = jedi.create_environment(os.path.join(root, d), safe=False); break
        except Exception: pass
# Imports resolve from the folder above the file's top package (the first parent without __init__.py),
# e.g. src/ or a service folder inside the repo; the repo root stays on sys.path.
top = os.path.dirname(path)
while os.path.isfile(os.path.join(top, "__init__.py")) and os.path.dirname(top) != top: top = os.path.dirname(top)
project = jedi.Project(top, added_sys_path=[root] if top != root else [])
s = jedi.Script(path=path, project=project, environment=env)
names = s.goto(line, col, follow_imports=True, follow_builtin_imports=True) or s.infer(line, col)
print(json.dumps([{"path": str(n.module_path), "line": n.line, "col": n.column} for n in names if n.module_path and n.line]))`;
// The identifier around offset, as a range to select (empty at a non-name).
const wordAt = (text, offset) => {
  let start = offset, end = offset;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  while (end < text.length && /\w/.test(text[end])) end++;
  return { start, end };
};
const REQUEST = "files-copy.open"; // { space, root, on, path, ts }: written by the panel, read by the tab

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, ALL = 20000, MATCHES = 500;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    const p = props();
    if (p?.path) { // the file tab
      this.tab = true; this.back = []; this.fwd = []; this.space = p.space ?? null;
      this.handle = cx.focus_handle(); this.viewH = 400; this.viewW = 800;
      this.applied = Math.max(p.ts ?? 0, shared(REQUEST)?.ts ?? 0);
      this.open(p, cx);
      return;
    }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.hidden = false; try { this.hidden = localStorage.getItem("files-copy.hidden") === "1"; } catch {}
    // Filter: every word must be in the file's path; the tree then shows only matches and their folders.
    this.query = ""; this.all = null; this.filtered = null;
    this.search = InputState.new({ placeholder: "Filter files" });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value().trim().toLowerCase();
      if (this.query && !this.all && !this.listing) this.loadAll(this.context, cx);
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  // ---- panel: the tree ----

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      // Each place (space + folder) keeps its own open folders, file and filter text.
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, query: this.search.value() });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.file = saved?.file ?? null; this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.all = null; this.filtered = null;
      const query = saved?.query ?? "";
      this.query = query.trim().toLowerCase();
      // The input is set outside render (refresh also runs from render).
      if (this.search.value() !== query) cx.timer.after(0, () => { if (this.context?.key === next) this.search.set_value(query); });
    }
    // A filter in use follows the folder: its file list is asked again with every refresh (watch, 10 s timer).
    if (cwd && this.query && !this.listing) this.loadAll(this.context, cx);
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Every file under the folder (git's tracked and untracked-not-ignored, else find), capped at ALL.
  loadAll(context, cx) {
    if (!context?.cwd) return;
    const { cwd, on } = context;
    this.listing = true;
    cx.spawn(async cx => {
      try {
        let r = await exec("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd, on, timeout: 10000 }).catch(() => null);
        let paths = r?.code === 0 ? r.stdout.split("\0") : null;
        // Ignored files too (.env.local), but not the inside of ignored folders (node_modules/, build/): with
        // --directory such a folder comes as one "dir/" entry, dropped here.
        if (paths) {
          const ig = await exec("git", ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd, on, timeout: 10000 }).catch(() => null);
          if (ig?.code === 0) paths.push(...ig.stdout.split("\0").filter(p => p && !p.endsWith("/")));
        }
        if (!paths) {
          r = await exec("sh", ["-c", `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | head -n ${ALL}`], { cwd, on, timeout: 10000 });
          paths = r.stdout.split("\n").map(p => p.replace(/^\.\//, ""));
        }
        paths = paths.filter(Boolean);
        if (!this.current(context)) return;
        const all = { paths: paths.slice(0, ALL), capped: paths.length > ALL };
        if (JSON.stringify(all) !== JSON.stringify(this.all)) { this.all = all; this.filtered = null; cx.notify(); }
      } catch (e) { if (this.current(context)) { this.error = String(e); cx.notify(); } }
      finally { this.listing = false; }
    });
  }

  // The filtered tree: { dirs: Map(name → node), files: [name] } of the matching paths. Cached by its inputs.
  filterTree() {
    const f = this.filtered;
    if (f && f.query === this.query && f.hidden === this.hidden && f.all === this.all) return f;
    const words = this.query.split(/\s+/), root = { dirs: new Map(), files: [] };
    let count = 0, limited = false;
    for (const path of this.all?.paths ?? []) {
      const low = path.toLowerCase();
      if (!words.every(w => low.includes(w))) continue;
      const parts = path.split("/");
      // Hidden files off: a dot part still shows when the query names it (".env" or "env" finds .env.local; "build" doesn't open .github/).
      if (!this.hidden && parts.some(p => p.startsWith(".") && !words.some(w => p.toLowerCase().includes(w)))) continue;
      if (++count > MATCHES) { limited = true; break; }
      let node = root;
      for (const dir of parts.slice(0, -1)) node = node.dirs.get(dir) ?? node.dirs.set(dir, { dirs: new Map(), files: [] }).get(dir);
      node.files.push(parts.at(-1));
    }
    return this.filtered = { query: this.query, hidden: this.hidden, all: this.all, root, count: Math.min(count, MATCHES), limited };
  }

  filteredRows(node, prefix, depth, out, t) {
    for (const name of [...node.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      out.push(this.row(path, name, true, true, depth, t));
      this.filteredRows(node.dirs.get(name), path, depth + 1, out, t);
    }
    for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) out.push(this.row(prefix ? `${prefix}/${name}` : name, name, false, false, depth, t));
    return out;
  }

  // One file or folder row; in the filtered tree folders are always open and a click on one does nothing.
  row(path, name, dir, open, depth, t) {
    const mark = this.marks[`${this.root}/${path}`];
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .when(!dir && path === this.file, el => el.bg(t.hover))
      .on_click((_e, cx) => dir ? (!this.query && this.toggle(path, cx)) : this.pick(path, cx))
      .child(dir ? svg(`mods/files-copy/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/files-copy/${dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(name))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
  }

  // One file tab per space: a click on another file sends it a new request through shared state.
  pick(path, cx) {
    this.file = path;
    const space = spaces().find(s => s.active);
    const req = { space: space?.id ?? null, root: this.root, on: this.on ?? null, path, ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map(t => t.id));
    const existing = panes().find(p => p.mod === "files-copy" && ids.has(p.tab));
    const name = path.split("/").pop();
    setShared(REQUEST, req);
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
    else run("tab.new", { name, mod: "files-copy", props: req, space: space?.id ?? undefined });
    cx.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      if (!this.hidden && entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      out.push(this.row(path, entry.name, entry.dir, open, depth, t));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  // ---- tab: one file, full height ----

  // A newer request (another file clicked in the panel): render() reruns when shared state changes, so no
  // poll. The load runs from a timer callback, because a task spawned with render's cx never runs.
  pickRequest(cx) {
    const req = shared(REQUEST);
    if (!req?.path || req.ts <= this.applied || (req.space && req.space !== this.space)) return;
    this.applied = req.ts; this.back = []; this.fwd = [];
    cx.timer.after(0, acx => this.open(req, acx));
  }

  // req: { root, on, path } (path relative to root, or absolute: a definition outside the folder).
  // at: { line, col } (0-based) to centre and mark, or { top, mark } when going back.
  open(req, cx, at = null) {
    // Unsaved edits are saved before another file replaces them (as IDEs do); a failed save keeps the file open.
    if (this.dirty) { this.save(cx, (ok, acx) => { if (ok) this.open(req, acx, at); }); return; }
    this.code?.release(); this.code = null; this.req = req; this.fileError = null; this.status = null; this.dirty = false; this.editable = false; this.preview = false;
    this.text = null; this.lines = null; this.spans = []; this.hover = null; this.mark = null; this.scrollY = 0; this.scrollX = 0; this.centre = null; this.longest = undefined;
    this.caret = this.anchor = { line: 0, col: 0 }; this.dragging = false; // the selection runs from anchor to caret
    cx.spawn(async cx => {
      try {
        let text = await readTextFile(this.full(req.path), { on: req.on });
        if (this.req !== req) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        // Editable when whole and on this machine (writeTextFile writes local files only).
        this.editable = text.length <= 400000 && !req.on;
        this.text = text = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (!this.pyView()) { this.makeEditor(); return; }
        // ponytail: a tab drawn as 4 spaces; jedi's column on such a line is off by 3 per tab (Python code rarely has them).
        this.lines = text.split("\n").map(l => l.replace(/\r$/, "").replace(/\t/g, "    "));
        // History entries carry `top` (their mark may be null: a file opened from the panel has none).
        if (at && "top" in at) { this.mark = at.mark; this.scrollY = at.top || 0; }
        else if (at) { this.mark = { line: at.line, ...wordAt(this.lines[at.line] ?? "", at.col) }; this.centre = at.line; }
        this.caretToMark();
        this.handle.focus();
      } catch { if (this.req === req) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Python is drawn by the mod (it knows which name is under the pointer); other files use the editor.
  // .env files too: highlight.js colours each line on its own, so an unbalanced quote in one value
  // (PASS=it's) can't paint the rest of the file as a string, as the editor's bash grammar would.
  pyView() { const name = this.req.path.split("/").pop(); return name.endsWith(".py") || name.startsWith(".env"); }

  caretToMark() { if (this.mark && this.lines?.[this.mark.line] !== undefined) this.caret = this.anchor = { line: this.mark.line, col: this.mark.start }; }

  // The pointer as a caret position: the nearest gap between characters.
  posAt() {
    const m = this.mouse, n = this.lines.length;
    const line = Math.max(0, Math.min(n - 1, Math.floor((m.y + this.scrollY) / ROW)));
    return { line, col: Math.max(0, Math.min(this.lines[line].length, Math.round((m.x - this.gutter + this.scrollX) / CHAR_W))) };
  }

  // { s, e } in reading order, or null when nothing is selected.
  selection() {
    const a = this.anchor, c = this.caret;
    if (a.line === c.line && a.col === c.col) return null;
    return a.line < c.line || (a.line === c.line && a.col < c.col) ? { s: a, e: c } : { s: c, e: a };
  }

  selectedText() {
    const sel = this.selection();
    if (!sel) return "";
    const { s, e } = sel, L = this.lines;
    if (s.line === e.line) return L[s.line].slice(s.col, e.col);
    return [L[s.line].slice(s.col), ...L.slice(s.line + 1, e.line), L[e.line].slice(0, e.col)].join("\n");
  }

  // Scrolls just enough to show the caret.
  reveal() {
    const { line, col } = this.caret, H = this.viewH, W = this.viewW - this.gutter - 12, x = col * CHAR_W;
    if (line * ROW < this.scrollY) this.scrollY = line * ROW;
    else if ((line + 1) * ROW > this.scrollY + H) this.scrollY = (line + 1) * ROW - H;
    if (x < this.scrollX) this.scrollX = Math.max(0, x - 4 * CHAR_W);
    else if (x > this.scrollX + W - CHAR_W) this.scrollX = x - W + 4 * CHAR_W;
  }

  // Read-only keys: caret moves (Shift extends the selection), ⌘A, ⌘C, Ctrl+- back. Nothing edits.
  key(e, cx) {
    const m = e.modifiers, k = e.key.toLowerCase(), L = this.lines, n = L.length, { line, col } = this.caret;
    const at = (l, c) => { l = Math.max(0, Math.min(n - 1, l)); return { line: l, col: Math.max(0, Math.min(L[l].length, c)) }; };
    const page = Math.max(1, Math.floor(this.viewH / ROW) - 2);
    const moves = m.platform
      ? { left: () => at(line, L[line].length - L[line].trimStart().length), right: () => at(line, L[line].length), up: () => at(0, 0), down: () => at(n - 1, L[n - 1].length) }
      : { left: () => col > 0 ? at(line, col - 1) : at(line - 1, line > 0 ? L[line - 1].length : 0),
          right: () => col < L[line].length ? at(line, col + 1) : line < n - 1 ? at(line + 1, 0) : at(line, col),
          up: () => at(line - 1, col), down: () => at(line + 1, col), pageup: () => at(line - page, col), pagedown: () => at(line + page, col),
          home: () => at(line, 0), end: () => at(line, L[line].length) };
    if (m.platform && k === "c") { const s = this.selectedText(); if (s) cx.write_to_clipboard(s); }
    else if (m.platform && k === "a") { this.anchor = { line: 0, col: 0 }; this.caret = at(n - 1, L[n - 1].length); cx.notify(); }
    // Back: ⌘[ or Ctrl+-; forward: ⌘] or Ctrl+Shift+-. Mouse side buttons reach a mod only when mapped to these
    // (the mod API reports left, right and middle buttons only).
    else if ((m.platform && k === "[") || (m.control && !m.shift && k === "-")) this.goBack(cx);
    else if ((m.platform && k === "]") || (m.control && m.shift && (k === "-" || k === "_"))) this.goForward(cx);
    else if (moves[k]) {
      const sel = this.selection();
      // ←/→ without Shift on a selection lands on its start/end, as editors do.
      this.caret = sel && !m.shift && !m.platform && (k === "left" || k === "right") ? (k === "left" ? sel.s : sel.e) : moves[k]();
      if (!m.shift) this.anchor = this.caret;
      this.reveal(); cx.notify();
    }
    else return;
    cx.stop_propagation();
  }

  press(e, cx) {
    this.handle.focus();
    const z = settings().zoom || 1;
    if (e.local_position) this.mouse = { x: e.local_position.x / z, y: e.local_position.y / z };
    const w = e.modifiers.platform && this.wordUnder();
    if (w) return this.definition(w, cx);
    if (!this.mouse) return;
    const p = this.posAt(), text = this.lines[p.line];
    if (e.click_count === 2) { const r = wordAt(text, p.col); this.anchor = { line: p.line, col: r.start }; this.caret = { line: p.line, col: r.end }; }
    else if (e.click_count >= 3) { this.anchor = { line: p.line, col: 0 }; this.caret = p.line + 1 < this.lines.length ? { line: p.line + 1, col: 0 } : { line: p.line, col: text.length }; }
    else { this.caret = p; if (!e.modifiers.shift) this.anchor = p; this.dragging = true; }
    cx.notify();
  }

  // The file in the built-in editor: editable when `editable`, ⌘S (or the Save button) writes it.
  makeEditor() {
    const t = theme(), path = this.req.path, name = path.split("/").pop(), ext = name.includes(".") ? name.split(".").pop() : "txt";
    // .env while editing: plain text (see pyView: a grammar spanning lines breaks on one bad quote).
    const language = name.startsWith(".env") ? "text" : LANG[ext] ?? ext;
    this.code = EditorState.new({ language, readonly: !this.editable, value: this.text,
      font_family: settings().font_family, font_size: FONT,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    this.code.on("change", (_e, cx) => {
      const dirty = this.code.value() !== this.text;
      if (dirty !== this.dirty) { this.dirty = dirty; if (dirty) this.status = null; cx.notify(); }
    });
    this.code.focus();
  }

  // Python opens in the mod's own view (⌘-click definitions); Edit switches it to the editor.
  editPython(cx) { this.lines = null; this.spans = []; this.makeEditor(); cx.notify(); }

  // Writes the editor's text, only if the file on disk is still what was read (else says so and keeps the edits).
  // then(ok, cx) runs after.
  save(cx, then) {
    if (!this.code || !this.dirty || this.saving) { then?.(!this.dirty, cx); return; }
    const req = this.req, value = this.code.value();
    this.saving = true; cx.notify();
    cx.spawn(async cx => {
      let ok = false;
      try { await writeTextFile(this.full(req.path), value, this.text); ok = true; }
      catch (e) { this.status = `Not saved: ${String(e).includes("stale") ? "the file changed on disk since it was opened" : e}`; }
      this.saving = false;
      if (ok && this.req === req) { this.text = value; this.dirty = this.code?.value() !== value; this.status = "Saved"; }
      cx.notify();
      then?.(ok, cx);
    });
  }

  // A tab closed with unsaved edits still writes them (same stale-file guard; the app gives close 250 ms).
  // ponytail: no "discard changes?" prompt; add one if saving on close turns out unwanted.
  async close() { if (this.tab && this.dirty && this.code) await writeTextFile(this.full(this.req.path), this.code.value(), this.text).catch(() => {}); }

  full(path) { return path.startsWith("/") ? path : `${this.req.root}/${path}`; }

  // Opens another file in this tab and names the tab after it (no id: the tab in front, which is this one).
  jump(path, cx, at) {
    this.open({ ...this.req, path }, cx, at);
    run("tab.rename", { name: path.split("/").pop() });
  }

  // The name under the pointer, from fixed row height and character width (monospace).
  wordUnder() {
    const m = this.mouse;
    if (!m || !this.lines || !this.req.path.endsWith(".py")) return null; // definitions: Python only
    const line = Math.floor((m.y + this.scrollY) / ROW), x = m.x - this.gutter + this.scrollX, col = Math.floor(x / CHAR_W);
    const text = this.lines[line];
    if (text === undefined || x < 0 || !/\w/.test(text[col] ?? "")) return null;
    const w = wordAt(text, col);
    return /^\d/.test(text.slice(w.start, w.end)) ? null : { line, ...w };
  }

  // With ⌘ held the name under the pointer is underlined; redraws only when that name changes.
  track(cmd, cx) {
    const hover = cmd ? this.wordUnder() : null;
    if (JSON.stringify(hover) !== JSON.stringify(this.hover) || cmd !== Boolean(this.cmd)) { this.hover = hover; this.cmd = cmd; cx.notify(); }
  }

  definition(word, cx) {
    if (this.finding) return;
    const req = this.req, { root, on, path } = req;
    this.back.push({ path, top: this.scrollY, mark: this.mark });
    this.mark = word; this.hover = null; // the clicked name stays marked while jedi looks
    this.finding = true; this.status = null; cx.notify();
    cx.spawn(async cx => {
      try {
        // ponytail: one jedi process per jump (~0.3–2 s); a long-lived language server if that gets slow.
        const r = await exec("uvx", ["--with", "jedi", "python", "-c", GOTO, root, this.full(path), String(word.line + 1), String(word.start)], { cwd: root, on, timeout: 20000 });
        if (this.req !== req) return;
        const hit = r.code === 0 ? JSON.parse(r.stdout || "[]")[0] : null;
        if (!hit) { this.back.pop(); this.status = r.code === 0 ? "No definition found" : (r.stderr.trim().split("\n").pop() || "jedi failed"); return; }
        this.fwd = []; // a new jump ends the forward history, as in browsers
        const target = hit.path.startsWith(root + "/") ? hit.path.slice(root.length + 1) : hit.path, at = { line: hit.line - 1, col: hit.col };
        if (target === path) { this.mark = { line: at.line, ...wordAt(this.lines[at.line] ?? "", at.col) }; this.centre = at.line; this.caretToMark(); }
        else this.jump(target, cx, at);
      } catch (e) { if (this.req === req) { this.back.pop(); this.status = String(e); } }
      finally { this.finding = false; cx.notify(); }
    });
  }

  // Back/forward through jumps: each step saves where it leaves onto the other stack.
  goBack(cx) { this.step(this.back, this.fwd, cx); }
  goForward(cx) { this.step(this.fwd, this.back, cx); }
  step(from, to, cx) {
    const prev = from.pop();
    if (!prev) return;
    to.push({ path: this.req.path, top: this.scrollY, mark: this.mark });
    if (prev.path === this.req.path && this.lines) { this.scrollY = prev.top; this.mark = prev.mark; this.caretToMark(); cx.notify(); }
    else this.jump(prev.path, cx, { top: prev.top, mark: prev.mark });
  }

  scroll(dy, dx, cx) {
    const n = this.lines.length, maxY = Math.max(0, (n + 2) * ROW - this.viewH);
    const maxX = Math.max(0, this.longest * CHAR_W + this.gutter + 40 - this.viewW);
    this.scrollY = Math.max(0, Math.min(maxY, this.scrollY + dy));
    this.scrollX = Math.max(0, Math.min(maxX, this.scrollX + dx));
    this.track(Boolean(this.cmd), cx); cx.notify();
  }

  // One line's colored pieces: the hovered name underlined, the marked one tinted, the selection shaded.
  lineSpans(i, t, sel) {
    const spans = this.spans[i] ??= this.lines[i].length > 1000 ? [{ text: this.lines[i] }] : highlight(this.lines[i], this.req.path.endsWith(".py") ? PY : ENV, t);
    const sr = sel && i >= sel.s.line && i <= sel.e.line ? { line: i, start: i === sel.s.line ? sel.s.col : 0, end: i === sel.e.line ? sel.e.col : Infinity } : null;
    const cuts = [this.hover, this.mark, sr].filter(w => w?.line === i);
    const inside = (w, a, b) => w?.line === i && a >= w.start && b <= w.end;
    const out = [];
    let pos = 0;
    for (const s of spans) {
      const end = pos + s.text.length;
      // Split the piece at every word edge inside it.
      const edges = [pos, ...cuts.flatMap(w => [w.start, w.end]).filter(e => e > pos && e < end).sort((a, b) => a - b), end];
      for (let k = 0; k + 1 < edges.length; k++) {
        const a = edges[k], b = edges[k + 1], hov = inside(this.hover, a, b);
        out.push(div().flex_none().text_color(hov ? t.accent : s.color ?? t.foreground)
          .when(hov, el => el.underline()).when(inside(this.mark, a, b), el => el.bg(t.accent + "44").rounded(2))
          .when(inside(sr, a, b), el => el.bg(t.selection))
          .child(s.text.slice(a - pos, b - pos)));
      }
      pos = end;
    }
    // A selection that runs past the line end shades the newline too.
    if (sr?.end === Infinity) out.push(div().flex_none().w(CHAR_W / 2).h(ROW - 4).bg(t.selection));
    return out;
  }

  codeView(t) {
    const n = this.lines.length, H = this.viewH;
    this.gutter = String(n).length * CHAR_W + 28;
    this.longest ??= this.lines.reduce((m, l) => Math.max(m, l.length), 0);
    if (Number.isInteger(this.centre) && this.sized) { // the found line in the middle of the view
      this.scrollY = Math.max(0, Math.min((n + 2) * ROW - H, this.centre * ROW - (H - ROW) / 2)); this.centre = null;
    }
    const first = Math.floor(this.scrollY / ROW), last = Math.min(n, first + Math.ceil(H / ROW) + 1);
    const total = (n + 2) * ROW, thumb = total > H ? Math.max(24, H * H / total) : 0;
    const rows = [], sel = this.selection();
    for (let i = first; i < last; i++) rows.push(h_flex().h(ROW).flex_none().items_center().whitespace_nowrap()
      .when(this.mark?.line === i, el => el.bg(t.hover))
      .child(div().w(this.gutter - 12).mr(12).flex_none().text_right().text_size(11).text_color(this.caret.line === i ? t.foreground : t.dim).child(String(i + 1)))
      .child(div().flex_1().min_w(0).overflow_hidden().child(h_flex().relative().left(-this.scrollX).children(this.lineSpans(i, t, sel)))));
    const z = () => settings().zoom || 1, caretX = this.gutter + this.caret.col * CHAR_W - this.scrollX;
    return div().id("files-py").flex_1().min_h(0).relative().overflow_hidden().track_focus(this.handle)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(FONT)
      .when(Boolean(this.hover), el => el.cursor_pointer()).when(!this.hover, el => el.cursor_text())
      .on_size_change((s, cx) => { const h = s.height / z(), w = s.width / z(); if (h !== this.viewH || w !== this.viewW || !this.sized) { this.viewH = h; this.viewW = w; this.sized = true; cx.notify(); } })
      .on_mouse_move((e, cx) => {
        this.mouse = { x: e.local_position.x / z(), y: e.local_position.y / z() };
        if (this.dragging) { const p = this.posAt(); if (p.line !== this.caret.line || p.col !== this.caret.col) { this.caret = p; cx.notify(); } }
        this.track(e.modifiers.platform, cx);
      })
      .on_modifiers_changed((e, cx) => this.track(e.modifiers.platform, cx))
      .on_hover((hovered, cx) => { if (!hovered) { this.mouse = null; this.dragging = false; this.track(false, cx); } })
      .on_mouse_down("left", (e, cx) => this.press(e, cx))
      .on_mouse_up("left", () => { this.dragging = false; })
      .on_scroll_wheel((e, cx) => { this.scroll(-e.delta.y / z(), -e.delta.x / z(), cx); cx.stop_propagation(); })
      .on_key_down((e, cx) => this.key(e, cx))
      .child(v_flex().absolute().left(0).right(0).top(first * ROW - this.scrollY).children(rows))
      .when(caretX >= this.gutter, el => el.child(div().absolute().left(caretX).top(this.caret.line * ROW - this.scrollY + 2).w(2).h(ROW - 4).bg(t.foreground)))
      .when(thumb > 0, el => el.child(div().absolute().right(2).top(this.scrollY / Math.max(1, total - H) * (H - thumb)).w(6).h(thumb).rounded(3).bg(t.border)));
  }

  renderTab(t) {
    const path = this.req.path, py = path.endsWith(".py");
    const button = (id, label, tip, act) => div().id(id).flex_none().px(8).py(2).rounded(5).border_1().border_color(t.border).text_size(11)
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => act(cx)).child(label);
    return v_flex().id("files-tab").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.modifiers.platform && e.key.toLowerCase() === "s" && this.code) { this.save(cx); cx.stop_propagation(); } })
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(this.back.length > 0 || this.fwd.length > 0, el => el
          .child(div().id("files-back").w(20).text_color(this.back.length ? t.muted : t.border).when(this.back.length > 0, e => e.cursor_pointer())
            .tooltip("Back (⌘[ or Ctrl+-)").on_click((_e, cx) => this.goBack(cx)).child("←"))
          .child(div().id("files-fwd").w(20).text_color(this.fwd.length ? t.muted : t.border).when(this.fwd.length > 0, e => e.cursor_pointer())
            .tooltip("Forward (⌘] or Ctrl+Shift+-)").on_click((_e, cx) => this.goForward(cx)).child("→")))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(path + (this.dirty ? " ●" : "")))
        .when(this.dirty, el => el.child(button("files-save", this.saving ? "Saving…" : "Save", "Save (⌘S)", cx => this.save(cx))))
        // Markdown: Preview shows it rendered (read-only, selectable; with unsaved edits as typed), Source goes back.
        .when(Boolean(this.code) && /\.(md|markdown)$/i.test(path), el => el.child(button("files-preview", this.preview ? "Source" : "Preview",
          this.preview ? "Back to the source" : "Show the rendered Markdown (read-only)", cx => { this.preview = !this.preview; cx.notify(); })))
        .when(Boolean(this.lines) && this.editable, el => el.child(button("files-edit", "Edit", "Edit this file (⌘-click definitions are off while editing)", cx => this.editPython(cx))))
        .when(this.finding, el => el.child(h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.accent)
          .child(svg("mods/files-copy/spinner.svg").size(12).spin(900)).child("Finding definition…")))
        .when(!this.finding && py && !this.code, el => el.child(div().flex_none().text_size(11).text_color(this.cmd ? t.accent : t.dim).child("⌘-click: definition"))))
      .child(this.code && this.preview ? div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().px(24).py(16)
          .child(TextView.markdown(`files-md-${path}`, this.code.value()).selectable(true))
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : this.lines ? this.codeView(t)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      .when(Boolean(this.status), el => el.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(this.status)));
  }

  render(cx) {
    const t = theme();
    if (this.tab) { this.pickRequest(cx); return this.renderTab(t); }
    if (key() !== this.context?.key) this.refresh(cx);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? ""))
        .child(div().id("files-hidden").flex_none().px(5).rounded(5).cursor_pointer().text_size(12).hover(s => s.bg(t.hover))
          .text_color(this.hidden ? t.foreground : t.dim).when(this.hidden, el => el.bg(t.hover))
          .on_click((_e, cx) => { this.hidden = !this.hidden; try { localStorage.setItem("files-copy.hidden", this.hidden ? "1" : "0"); } catch {} cx.notify(); })
          .child(".*")))
      .child(div().px(8).pt(8).flex_none().child(div().id("files-search").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.keystroke === "escape") this.clearFilter(cx); })
        .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground))
        .when(Boolean(this.query), el => el.child(div().id("files-search-clear").size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Clear filter (Esc)")
          .on_click((_e, cx) => this.clearFilter(cx)).child(svg("mods/files-copy/close.svg").size(10))))))
      .child(this.query ? this.filterView(t) : v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }

  clearFilter(cx) { this.search.set_value(""); this.query = ""; cx.notify(); }

  filterView(t) {
    const note = (text) => div().p(8).text_size(11).text_color(t.dim).child(text);
    if (!this.all) return v_flex().flex_1().child(note(this.error || "Loading file list…"));
    const f = this.filterTree();
    return v_flex().id("files-filtered").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.filteredRows(f.root, "", 0, [], t))
      .when(!f.count, el => el.child(note("No matching files")))
      .when(f.limited, el => el.child(note(`First ${MATCHES} matches shown`)))
      .when(this.all.capped, el => el.child(note(`Searched the first ${ALL.toLocaleString("en")} files`)));
  }
}
