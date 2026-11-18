// A lazy file tree for the focused pane's folder. A click opens the file in a tab (this same mod, opened
// with props), one tab per space reused through shared("files-copy.open"), like changes-copy and wb-diff.
// In the tab, Python files: ⌘-click (or F12) a name to jump to its definition (jedi via uvx).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, ScrollHandle, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, run, shared, setShared, props, openOverlay, closeOverlay, appHome } from "herdr";
import { highlight, languageFor } from "./highlight.js";

const PY = languageFor("x.py");
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

// Images. The app draws pictures only from its own folder, so each one is copied (a local file, named by
// path and mtime) or downloaded (a web URL, kept by URL) into IMG_DIR and drawn from there; the newest 300 stay.
const RASTER = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
const IMG_DIR = "data/files-copy/images";
// argv: source (path or http(s) URL), cache folder, base name, extension. Prints the cached file's name.
const IMG_SCRIPT = `src=$1; dir=$2; base=$3; ext=$4
mkdir -p "$dir" || exit 1
case $src in
http://*|https://*)
  for f in "$dir/$base".*; do case $f in *.part) continue;; esac; [ -s "$f" ] && { touch "$f"; echo "\${f##*/}"; exit 0; }; done
  tmp="$dir/$base.part"
  ct=$(curl -fsSL -m 20 --max-filesize 20000000 -o "$tmp" -w '%{content_type}' "$src") || { rm -f "$tmp"; exit 1; }
  case $ct in *svg*) ext=svg;; *png*) ext=png;; *jpeg*) ext=jpg;; *gif*) ext=gif;; *webp*) ext=webp;; esac
  name="$base.$ext"; mv "$tmp" "$dir/$name" || exit 1;;
*)
  [ -f "$src" ] || exit 1
  m=$(stat -f %m "$src" 2>/dev/null || stat -c %Y "$src") || exit 1
  name="$base-$m.$ext"
  if [ -s "$dir/$name" ]; then touch "$dir/$name"; else cp "$src" "$dir/$name.part" && mv "$dir/$name.part" "$dir/$name" || exit 1; fi;;
esac
ls -t "$dir" | tail -n +301 | while IFS= read -r f; do rm -f "$dir/$f"; done
echo "$name"`;
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(16) + s.length.toString(16); };
const extOf = (src) => (src.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? "img").toLowerCase();
const MD_IMG = /\[?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)(?:\]\([^)]*\))?/g; // ![alt](src "title"), maybe inside [..](link)
// Markdown cut into blocks for TextView (which draws no images): runs of plain lines, and each line holding images
// (![alt](src), linked ones, <img src=… width=…>) as { imgs, md: the rest of the line when it has words }. Fenced code stays text.
function mdBlocks(text) {
  const out = []; let buf = [], fence = null, blank = false, html = 0;
  const flush = () => { if (buf.length) out.push({ md: buf.join("\n") }); buf = []; };
  // Plain runs are cut at a blank line followed by a paragraph or heading, so a search hit has a block to scroll to.
  // Not inside a fence or an open HTML block, not before a list item/indent/quote/table row (it would restart
  // numbering or end the list), and never when the file has reference links ([id]: url), which need the whole text.
  const split = !/^ {0,3}\[[^\]]+\]:\s*\S/m.test(text);
  for (const line of text.split("\n")) {
    const was = fence;
    if (split && !was && html === 0) {
      if (blank && line.trim() && !/^\s|^([-*+]|\d+[.)])\s|^>|^\|/.test(line)) flush();
      else if (/^#{1,6}\s/.test(line)) flush();
    }
    blank = !line.trim();
    if (!was) html = Math.max(0, html + (line.match(/<(details|div|p|table|center|blockquote|ul|ol)\b(?:[^>]*[^/>])?>/gi)?.length ?? 0) - (line.match(/<\/(details|div|p|table|center|blockquote|ul|ol)>/gi)?.length ?? 0));
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; }
    if (f || fence || !/!\[[^\]]*\]\(|<img\b/i.test(line.replace(/`[^`]*`/g, ""))) { buf.push(line); continue; }
    const imgs = [];
    const rest = line.replace(MD_IMG, (_m, alt, src) => { imgs.push({ src, alt }); return ""; })
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
        if (src) imgs.push({ src, alt: tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "", width: Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1]) || null });
        return "";
      }).replace(/<[^>]+>/g, "");
    if (!imgs.length) { buf.push(line); continue; }
    flush();
    out.push({ imgs, md: /[\p{L}\p{N}]/u.test(rest) ? rest : "" });
  }
  flush();
  return out;
}

// ---- find in the tab ----
const FIND_CAP = 1000;
// Every case-insensitive hit of q in text, as [start, end) pairs (at most FIND_CAP + 1: the extra one says "capped").
function findAll(text, q) {
  const out = [], hay = text.toLowerCase(), n = q.length;
  for (let at = hay.indexOf(q); at >= 0 && out.length <= FIND_CAP; at = hay.indexOf(q, at + n)) out.push([at, at + n]);
  return out;
}
// What a Markdown block shows as words: link targets, image sources, tags and markers left out, so a hit is something readable.
const mdVisible = (md) => md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, "").replace(/[`*~]/g, "").replace(/(^|\W)_+|_+(?=\W|$)/g, "$1");

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
    if (p?.unsaved) { this.saving = false; this.saveError = null; return; } // the "Save changes?" dialog
    if (p?.path) { // the file tab
      this.tab = true; this.back = []; this.fwd = []; this.space = p.space ?? null;
      this.handle = cx.focus_handle(); this.viewH = 400; this.viewW = 800;
      this.imgs = new Map(); this.imgQueue = []; this.imgBusy = false; // source → cached file (false: failed, null: loading)
      // Find bar (always shown; ⌘F focuses it, Esc clears it): list = hits in the shown view (lines, editor offsets, or Markdown blocks), cur = the current one.
      this.find = { open: true, q: "", list: [], cur: 0, mode: null, capped: false };
      this.fmap = null; this.mdHits = new Set(); this.mdScroll = ScrollHandle.new();
      this.hold = false; this.holdCap = false; this.holdTimer = false; this.pending = false;
      this.findInput = InputState.new({ placeholder: "Find in file" });
      this.findInput.on("change", (_e, cx) => { this.find.q = this.findInput.value().toLowerCase(); this.find.cur = 0; this.runFind(cx, true); });
      this.findInput.on("submit", (e, cx) => this.stepFind(e?.shift ? -1 : 1, cx));
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
    // ↑/↓ in the filter move `cursor` over the matching files (in the order shown), Enter opens it.
    this.cursor = null; this.order = []; this.filterScroll = ScrollHandle.new();
    // Enter (the input's submit): the file under the cursor, else the first match.
    this.search.on("submit", (_e, cx) => {
      const hit = this.query && (this.order.find(o => o.path === this.cursor) ?? this.order[0]);
      if (hit) this.pick(hit.path, cx);
    });
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value().trim().toLowerCase(); this.cursor = null;
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
    for (const name of [...node.files].sort((a, b) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      this.order.push({ path, index: out.length });
      out.push(this.row(path, name, false, false, depth, t, path === this.cursor));
    }
    return out;
  }

  // One file or folder row; in the filtered tree folders are always open and a click on one does nothing.
  // `cur`: the filter's keyboard cursor is on it.
  row(path, name, dir, open, depth, t, cur = false) {
    const mark = this.marks[`${this.root}/${path}`];
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .when(!dir && path === this.file && !cur, el => el.bg(t.hover))
      .when(cur, el => el.bg(t.selected))
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
    this.code?.release(); this.code = null; this.req = req; this.fileError = null; this.status = null; this.dirty = false; this.editable = false; this.lang = null;
    this.preview = /\.(md|markdown|svg)$/i.test(req.path); // Markdown and SVG open rendered; Source shows the text
    this.text = null; this.lines = null; this.spans = []; this.hover = null; this.mark = null; this.scrollY = 0; this.scrollX = 0; this.centre = null; this.longest = undefined;
    this.caret = this.anchor = { line: 0, col: 0 }; this.dragging = false; // the selection runs from anchor to caret
    this.imgs = new Map(); this.mdCache = null; // pictures are copied again per opened file: an edited one shows anew
    // Markdown stays covered until its pictures are in and the text has settled, so nothing pops in (see mdPane).
    this.hold = this.preview && /\.(md|markdown)$/i.test(req.path); this.holdCap = false; this.holdTimer = false; this.pending = false;
    this.find.list = []; this.fmap = null; this.mdHits = new Set(); this.find.cur = 0;
    // A picture is shown, not read as text (local files only: the app draws from its own folder).
    this.raster = RASTER.test(req.path);
    if (this.raster) { if (req.on) this.fileError = "Images on another machine can't be shown"; cx.notify(); return; }
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
      finally { if (this.req === req && this.find.open) this.runFind(cx, false); cx.notify(); }
    });
  }

  // Python is drawn by the mod (it knows which name is under the pointer); other files use the editor.
  // .env files too: highlight.js colours each line on its own, so an unbalanced quote in one value
  // (PASS=it's) can't paint the rest of the file as a string, as the editor's bash grammar would.
  // Markdown too: the editor shows it uncoloured (its theme has no colours for headings, code, links).
  pyView() { const name = this.req.path.split("/").pop(); return /\.(py|md|markdown)$/i.test(name) || name.startsWith(".env"); }

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
    // Typing here (an editable file): switch to the editor at the caret and apply the key there.
    if (this.editable && !m.platform && !m.control && (["enter", "backspace", "delete", "tab"].includes(k) || e.key_char)) {
      this.typeIntoEditor(k, e.key_char, cx); cx.stop_propagation(); return;
    }
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
      if (this.find.open && this.find.q && this.findMode() === "editor") this.runFind(cx, false);
    });
    this.code.focus();
  }

  // Python opens in the mod's own view (⌘-click definitions); Edit switches it to the editor.
  editPython(cx) { this.lines = null; this.spans = []; this.preview = false; this.makeEditor(); if (this.find.open) this.runFind(cx, false); cx.notify(); }

  // A key typed in the own view: the editor takes over with the same selection (or caret), then gets the key.
  typeIntoEditor(k, char, cx) {
    const sel = this.selection() ?? { s: this.caret, e: this.caret }, orig = this.text.split("\n");
    // The own view's (line, col) as an offset in the file's text: its lines dropped \r and drew a tab as 4 columns.
    const offset = ({ line, col }) => {
      let at = 0;
      for (let i = 0; i < line; i++) at += orig[i].length + 1;
      const s = orig[line] ?? "";
      for (let i = 0, w = 0; i < s.length && w < col; i++, at++) w += s[i] === "\t" ? 4 : 1;
      return at;
    };
    let start = offset(sel.s), end = offset(sel.e);
    this.editPython(cx);
    if (start === end && k === "backspace") start = Math.max(0, start - 1);
    if (start === end && k === "delete") end = Math.min(this.text.length, end + 1);
    this.code.set_selected_range({ start, end });
    this.code.replace(k === "backspace" || k === "delete" ? "" : k === "enter" ? "\n" : k === "tab" ? "\t" : char);
    this.dirty = this.code.value() !== this.text; cx.notify();
  }

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
      if (ok && this.req === req) { this.text = value; this.dirty = this.code?.value() !== value; this.status = "Saved"; this.imgs.delete(this.full(req.path)); }
      cx.notify();
      then?.(ok, cx);
    });
  }

  // A tab closed with unsaved edits: the app can't be stopped from closing it, so a dialog (this mod) gets the
  // edits in its props and asks whether to write them. Switching files in the tab still saves without asking.
  // ponytail: on app quit the dialog can't show and the edits are lost; save on quit if that matters.
  close() {
    if (!this.tab || !this.dirty || !this.code) return;
    openOverlay({ mod: "files-copy", kind: "dialog", width: 440, height: 150,
      props: { unsaved: { path: this.full(this.req.path), text: this.code.value(), expected: this.text } } });
  }

  // The dialog: Save writes the edits (only if the file is still what the tab read), Don't save / Esc drops them.
  saveDialog(t) {
    const p = props(), u = p.unsaved;
    const save = (cx) => {
      if (this.saving) return;
      this.saving = true; this.saveError = null; cx.notify();
      cx.spawn(async cx => {
        try { await writeTextFile(u.path, u.text, u.expected); closeOverlay(p.overlay); }
        catch (e) { this.saveError = `Not saved: ${e}`; }
        this.saving = false; cx.notify();
      });
    };
    const btn = (id, label, primary, act) => h_flex().id(id).h(30).px(14).items_center().rounded(7).border_1().cursor_pointer()
      .border_color(primary ? t.accent : t.border).when(primary, el => el.bg(t.accent).text_color(t.background))
      .hover(s => s.opacity(0.88)).on_click((_e, cx) => act(cx)).child(label);
    return v_flex().id("files-unsaved").size_full().p(16).gap(10).bg(t.background).text_color(t.foreground).text_size(13)
      .child(div().font_semibold().text_size(14).child(`Save changes to ${u.path.split("/").pop()}?`))
      .child(div().text_size(12).text_color(t.dim).truncate().child(u.path))
      .when(Boolean(this.saveError), el => el.child(div().text_size(12).text_color(t.ansi1).child(this.saveError)))
      .child(h_flex().flex_1().items_end().justify_end().gap(8)
        .child(btn("files-unsaved-drop", "Don't save", false, () => closeOverlay(p.overlay)))
        .child(btn("files-unsaved-save", this.saving ? "Saving…" : "Save", true, save)));
  }

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
    const spans = this.spans[i] ??= this.lines[i].length > 1000 ? [{ text: this.lines[i] }] : highlight(this.lines[i], this.lang ??= languageFor(this.req.path) ?? PY, t);
    const sr = sel && i >= sel.s.line && i <= sel.e.line ? { line: i, start: i === sel.s.line ? sel.s.col : 0, end: i === sel.e.line ? sel.e.col : Infinity } : null;
    const ms = this.fmap?.get(i) ?? [], cuts = [this.hover, this.mark, sr].filter(w => w?.line === i).concat(ms);
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
          .when(Boolean(ms.length) && ms.some(m => a >= m.start && b <= m.end), el => el.bg(ms.find(m => a >= m.start && b <= m.end).k === this.find.cur ? t.accent + "88" : t.accent + "33").rounded(2))
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

  // ---- tab: images ----

  // The cached file for a picture (a path under the app folder), false when it can't be had, null while it's
  // fetched; asks for it the first time. Fetches run one at a time, from a timer (render's cx can't spawn).
  want(src, cx) {
    if (!this.imgs.has(src)) {
      if (this.imgs.size >= 200) return false; // ponytail: a document with more pictures shows the rest as text
      this.imgs.set(src, null); this.imgQueue.push(src);
      if (!this.imgBusy) { this.imgBusy = true; cx.timer.after(0, acx => this.fetchImages(acx)); }
    }
    return this.imgs.get(src);
  }
  fetchImages(cx) {
    cx.spawn(async cx => {
      while (this.imgQueue.length) {
        const src = this.imgQueue.shift();
        let file = false;
        try {
          const r = await exec("sh", ["-c", IMG_SCRIPT, "files-img", src, `${appHome()}/${IMG_DIR}`, fnv(src), extOf(src)], { timeout: 30000 });
          if (r.code === 0 && r.stdout.trim()) file = `${IMG_DIR}/${r.stdout.trim()}`;
        } catch {}
        if (this.imgs.get(src) === null) { this.imgs.set(src, file); cx.notify(); }
      }
      this.imgBusy = false;
    });
  }
  // A picture's source as a fetchable path or URL; null when it can't be shown (data: URIs, a file on another machine).
  imgSource(src) {
    if (/^https?:\/\//i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || this.req.on) return null;
    let p = src.split(/[?#]/)[0];
    try { p = decodeURIComponent(p); } catch {}
    return p.startsWith("/") ? p : `${this.full(this.req.path).replace(/\/[^/]*$/, "")}/${p}`;
  }
  picture(src, alt, width, t, cx) {
    const file = src ? this.want(src, cx) : false;
    if (file === null) this.pending = true;
    if (file) return image(file).max_w_full().when(Boolean(width), e => e.w(width));
    return div().text_size(12).text_color(t.dim).child(`[${alt || "image"}${file === null ? " …" : ""}]`);
  }
  // Rendered Markdown with its pictures (blocks cached by the text).
  mdBlocksOf(text) {
    if (this.mdCache?.text !== text) this.mdCache = { text, blocks: mdBlocks(text) };
    return this.mdCache.blocks;
  }
  mdView(text, t, cx) {
    const blocks = this.mdBlocksOf(text), id = `files-md-${this.req.path}`;
    this.pending = false; // set by picture() while a picture is still being fetched
    const marks = Boolean(this.find.q) && this.find.mode === "md", cur = this.find.list[this.find.cur]?.block;
    return blocks.map((b, i) => {
      const el = b.imgs
        ? h_flex().flex_wrap().items_center().gap(8).py(4)
          .children(b.imgs.map(im => this.picture(this.imgSource(im.src), im.alt, im.width, t, cx)))
          .when(Boolean(b.md), el => el.child(div().flex_1().min_w(0).child(TextView.markdown(`${id}-${i}`, b.md).selectable(true))))
        : TextView.markdown(`${id}-${i}`, b.md).selectable(true);
      // The block holding the current hit is shaded, blocks holding others get a thin accent edge (TextView can't mark words).
      return marks ? div().pl(10).border_l(2).border_color(i === cur ? t.accent : this.mdHits.has(i) ? t.accent + "55" : t.background)
        .when(i === cur, e => e.bg(t.accent + "18")).child(el) : el;
    });
  }
  // The rendered view with a cover over it until it is complete: the first frame lays everything out under the
  // cover, so the text and pictures are already in place when it lifts (one redraw, not one per picture).
  mdPane(t, cx) {
    const blocks = this.mdView(this.code ? this.code.value() : this.text, t, cx), req = this.req;
    const hold = this.hold;
    if (hold) {
      if (!this.holdCap) { this.holdCap = true; cx.timer.after(3000, acx => { if (this.req === req && this.hold) { this.hold = false; acx.notify(); } }); } // a slow picture can't keep it hidden
      if (!this.pending && !this.holdTimer) { this.holdTimer = true; cx.timer.after(150, acx => { this.holdTimer = false; if (this.req === req && this.hold && !this.pending) { this.hold = false; acx.notify(); } }); }
    }
    return v_flex().flex_1().min_h(0).relative()
      .child(div().id("files-md").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.mdScroll).px(24).py(16).children(blocks))
      .when(hold, el => el.child(div().absolute().inset_0().flex().items_center().justify_center().bg(t.background).text_color(t.dim).child("Loading…")));
  }
  // A picture file, scaled down to the view's width (the view scrolls when it's taller).
  imageView(t, cx) {
    const file = this.fileError ? false : this.want(this.full(this.req.path), cx);
    return div().id("files-img").flex_1().min_h(0).overflow_y_scrollbar().p(16)
      .child(file ? image(file).max_w_full() : div().text_color(t.dim).child(this.fileError || (file === null ? "Loading image…" : "Cannot show this image")));
  }

  // ---- tab: find ----

  // Which view a search runs over: the mod's line view, the editor, or the rendered Markdown (null: nothing to search).
  findMode() {
    if (this.raster) return null;
    if (this.preview) return /\.svg$/i.test(this.req.path) || !(this.code || this.lines) ? null : "md";
    return this.code ? "editor" : this.lines ? "lines" : null;
  }
  openFind(cx) {
    if (!this.findMode()) return;
    this.find.open = true; this.findInput.focus(); this.runFind(cx, Boolean(this.find.q));
  }
  // Esc or ×: the text is cleared (the bar stays) and the keyboard goes back to the view.
  closeFind(cx) {
    this.findInput.set_value(""); this.find.q = ""; this.find.cur = 0; this.runFind(cx, false);
    if (this.lines && !this.preview) this.handle.focus(); else if (this.code) this.code.focus();
  }
  // Recomputes the hits for the shown view (not from render); jump moves the view to the current one.
  runFind(cx, jump) {
    const f = this.find, q = f.q, mode = this.findMode();
    f.mode = mode; f.list = []; f.capped = false; this.fmap = null; this.mdHits = new Set();
    if (f.open && q && mode) {
      let raw = [];
      if (mode === "editor") raw = findAll(this.code.value(), q).map(([s, e]) => ({ s, e }));
      else if (mode === "lines") this.lines.forEach((l, line) => { if (raw.length <= FIND_CAP) for (const [start, end] of findAll(l, q)) raw.push({ line, start, end }); });
      else this.mdBlocksOf(this.code ? this.code.value() : this.text).forEach((b, block) => { if (raw.length <= FIND_CAP) for (const [start] of findAll(mdVisible(b.md ?? ""), q)) raw.push({ block, start }); });
      f.capped = raw.length > FIND_CAP; f.list = raw.slice(0, FIND_CAP);
      if (mode === "lines") { this.fmap = new Map(); f.list.forEach((m, k) => { m.k = k; if (!this.fmap.has(m.line)) this.fmap.set(m.line, []); this.fmap.get(m.line).push(m); }); }
      if (mode === "md") this.mdHits = new Set(f.list.map(m => m.block));
      f.cur = Math.min(f.cur, Math.max(0, f.list.length - 1));
    }
    if (jump) this.goFind(cx); else cx.notify();
  }
  stepFind(dir, cx) {
    const f = this.find, n = f.list.length;
    if (!n) return;
    f.cur = (f.cur + dir + n) % n; this.goFind(cx);
  }
  goFind(cx) {
    const f = this.find, m = f.list[f.cur];
    if (m) {
      if (f.mode === "lines") { this.centre = m.line; this.caret = this.anchor = { line: m.line, col: m.start }; }
      else if (f.mode === "editor") this.code.set_selected_range({ start: m.s, end: m.e });
      else if (f.mode === "md") this.mdScroll.scroll_to_item(m.block);
    }
    cx.notify();
  }
  findBar(t) {
    const f = this.find, n = f.list.length;
    const btn = (id, label, tip, act) => div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => act(cx)).child(label);
    return h_flex().flex_none().gap(6).items_center()
      .child(div().id("files-find").h(24).w(210).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_key_down((e, cx) => { if (e.keystroke === "escape") { this.closeFind(cx); cx.stop_propagation(); } })
        .child(Input.new(this.findInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(f.q ? (n ? `${f.cur + 1}/${n}${f.capped ? "+" : ""}` : "No results") : ""))
      .child(btn("files-find-prev", "↑", "Previous (⇧Enter)", cx => this.stepFind(-1, cx)))
      .child(btn("files-find-next", "↓", "Next (Enter)", cx => this.stepFind(1, cx)))
      .child(btn("files-find-close", "×", "Clear (Esc)", cx => this.closeFind(cx)));
  }

  renderTab(t, cx) {
    const path = this.req.path, py = path.endsWith(".py"), isSvg = /\.svg$/i.test(path);
    const button = (id, label, tip, act) => div().id(id).flex_none().px(8).py(2).rounded(5).border_1().border_color(t.border).text_size(11)
      .cursor_pointer().hover(s => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => act(cx)).child(label);
    return v_flex().id("files-tab").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.modifiers.platform && e.key.toLowerCase() === "s" && this.code) { this.save(cx); cx.stop_propagation(); }
        else if (e.modifiers.platform && e.key.toLowerCase() === "f" && this.findMode()) { this.openFind(cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(36).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(this.back.length > 0 || this.fwd.length > 0, el => el
          .child(div().id("files-back").w(20).text_color(this.back.length ? t.muted : t.border).when(this.back.length > 0, e => e.cursor_pointer())
            .tooltip("Back (⌘[ or Ctrl+-)").on_click((_e, cx) => this.goBack(cx)).child("←"))
          .child(div().id("files-fwd").w(20).text_color(this.fwd.length ? t.muted : t.border).when(this.fwd.length > 0, e => e.cursor_pointer())
            .tooltip("Forward (⌘] or Ctrl+Shift+-)").on_click((_e, cx) => this.goForward(cx)).child("→")))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(path + (this.dirty ? " ●" : "")))
        .when(Boolean(this.findMode()), el => el.child(this.findBar(t)))
        .when(this.dirty, el => el.child(button("files-save", this.saving ? "Saving…" : "Save", "Save (⌘S)", cx => this.save(cx))))
        // Markdown: Preview shows it rendered (read-only, selectable; with unsaved edits as typed), Source goes back.
        // SVG: Preview shows the picture as saved.
        .when(Boolean(this.code || this.lines) && /\.(md|markdown|svg)$/i.test(path), el => el.child(button("files-preview", this.preview ? "Source" : "Preview",
          this.preview ? "Back to the source" : isSvg ? "Show the picture (as saved)" : "Show the rendered Markdown (read-only)", cx => { this.preview = !this.preview; if (this.find.open) this.runFind(cx, true); else cx.notify(); })))
        // Not over the rendered Markdown: editing there would change nothing on screen (Source first).
        .when(Boolean(this.lines) && this.editable && !this.preview, el => el.child(button("files-edit", "Edit", "Edit this file (⌘-click definitions are off while editing)", cx => this.editPython(cx))))
        .when(this.finding, el => el.child(h_flex().flex_none().gap(6).items_center().text_size(11).text_color(t.accent)
          .child(svg("mods/files-copy/spinner.svg").size(12).spin(900)).child("Finding definition…")))
        .when(!this.finding && py && !this.code, el => el.child(div().flex_none().text_size(11).text_color(this.cmd ? t.accent : t.dim).child("⌘-click: definition"))))
      .child(this.raster || (isSvg && this.preview && (this.code || this.lines)) ? this.imageView(t, cx)
        : this.preview && (this.code || this.lines) ? this.mdPane(t, cx)
        // A fixed box (absolute, inset 0) instead of flex sizing: sized by flex the editor grew with its text,
        // so nothing overflowed and the wheel didn't scroll (as with the Changes list).
        : this.code ? div().flex_1().min_h(0).relative().child(Editor.new(this.code).absolute().inset_0())
        : this.lines ? this.codeView(t)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      .when(Boolean(this.status), el => el.child(div().flex_none().px(14).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(this.status)));
  }

  render(cx) {
    const t = theme();
    if (props()?.unsaved) return this.saveDialog(t);
    if (this.tab) { this.pickRequest(cx); return this.renderTab(t, cx); }
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
        .on_key_down((e, cx) => {
          if (e.keystroke === "escape") return this.clearFilter(cx);
          if (!this.query || !this.order.length || (e.key !== "up" && e.key !== "down")) return;
          const at = this.order.findIndex(o => o.path === this.cursor), n = this.order.length;
          const next = this.order[at < 0 ? (e.key === "down" ? 0 : n - 1) : (at + (e.key === "down" ? 1 : -1) + n) % n];
          this.cursor = next.path; this.filterScroll.scroll_to_item(next.index); cx.notify();
          cx.stop_propagation();
        })
        .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground))
        .when(Boolean(this.query), el => el.child(div().id("files-search-clear").size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Clear filter (Esc)")
          .on_click((_e, cx) => this.clearFilter(cx)).child(svg("mods/files-copy/close.svg").size(10))))))
      .child(this.query ? this.filterView(t) : v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }

  clearFilter(cx) { this.search.set_value(""); this.query = ""; this.cursor = null; cx.notify(); }

  filterView(t) {
    const note = (text) => div().p(8).text_size(11).text_color(t.dim).child(text);
    if (!this.all) return v_flex().flex_1().child(note(this.error || "Loading file list…"));
    const f = this.filterTree();
    this.order = []; // refilled by filteredRows, in the order shown
    return v_flex().id("files-filtered").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.filterScroll).p(6).children(this.filteredRows(f.root, "", 0, [], t))
      .when(!f.count, el => el.child(note("No matching files")))
      .when(f.limited, el => el.child(note(`First ${MATCHES} matches shown`)))
      .when(this.all.capped, el => el.child(note(`Searched the first ${ALL.toLocaleString("en")} files`)));
  }
}
