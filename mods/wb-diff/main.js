// PhpStorm/Zed-style diff, opened as a tab in the main area when a changed file is clicked in the
// Changes panel. The panel sends { root, on, path, against, files, ... } through props (first open) and
// shared("wb.diff.request") (later clicks), so one diff tab serves the space. All listed files are shown
// one after another in one scroll (each under its own header); a click on another file of the same set
// only scrolls to it. Side-by-side or unified rows; hunk separators reveal more context lines.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { highlight, languageFor } from "./highlight.js";
import { props, shared, spaces, panes, theme, settings, exec, readTextFile, run } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", "-c", "core.quotepath=false"];
// The code's text size matches the side panels' (Changes, Files: 13); ROW is a code line's height, HEAD a file header's.
const FONT = 13, ROW = 22, HEAD = 32, CHAR_W = FONT * 0.6;
// Caps: lines per file, lines in all, files per view; STEP context lines per reveal click.
const MAX_LINES = 20000, MAX_TOTAL = 100000, MAX_FILES = 300, STEP = 20;

// The hunks of one file's unified diff (lines from its first @@ on). os/ns: first line of each side
// (a side with no lines sits after line o/n), oe/ne: one past its last.
function parseHunks(lines) {
  const hunks = [];
  let cur = null;
  for (const line of lines) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)/.exec(line);
    if (m) {
      const oc = m[2] === undefined ? 1 : +m[2], nc = m[4] === undefined ? 1 : +m[4];
      const os = oc ? +m[1] : +m[1] + 1, ns = nc ? +m[3] : +m[3] + 1;
      hunks.push((cur = { os, ns, oe: os + oc, ne: ns + nc, head: m[5].trim(), lines: [] }));
    } else if (cur && (line[0] === " " || line[0] === "-" || line[0] === "+")) cur.lines.push(line);
    // "\ No newline at end of file" and other noise is skipped
  }
  return hunks;
}

// `diff --git a/X b/X` → X (renames are off, so both halves match).
function headerPath(line) {
  const rest = line.slice(11), half = (rest.length - 1) / 2;
  if (!Number.isInteger(half)) return null;
  const a = rest.slice(0, half), b = rest.slice(half + 1);
  return a.startsWith("a/") && b === "b/" + a.slice(2) ? a.slice(2) : null;
}

// A multi-file `git diff` cut per file: path → its lines.
function splitFiles(out) {
  const map = new Map();
  let buf = null, path = null, inHunks = false;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) { buf = []; inHunks = false; path = headerPath(line); if (path !== null) map.set(path, buf); continue; }
    if (!buf) continue;
    if (line.startsWith("@@")) inHunks = true;
    // A path with spaces that splits ambiguously: take it from the ---/+++ lines.
    if (path === null && !inHunks && /^(\+\+\+ b\/|--- a\/)/.test(line)) { path = line.slice(6).replace(/^"|"$/g, ""); map.set(path, buf); }
    buf.push(line);
  }
  return map;
}

// The request's file list ([path, status, fresh, add, del] from changes-copy), or just its own file.
function fileList(req) {
  const own = { path: req.path, status: req.status ?? "M", fresh: Boolean(req.fresh) };
  if (req.commit || !Array.isArray(req.files) || !req.files.length) return [own];
  const list = req.files.slice(0, MAX_FILES).map((f) => (Array.isArray(f) ? { path: f[0], status: f[1] ?? "M", fresh: Boolean(f[2]), add: f[3], del: f[4] } : f));
  return list.some((f) => f.path === req.path) ? list : [own];
}

// Same set of files, same contents (by their line counts), same comparison: only scroll, don't reload.
const keyOf = (req, mode) => JSON.stringify([req.root, req.on, req.against, req.commit, mode, fileList(req).map((f) => [f.path, f.fresh, f.add, f.del])]);

// The changed parts of a removed line `a` and its added counterpart `b`, as [from, to) character ranges of
// each, by a token LCS. Null when the lines share too little (then the whole row is the change) or are long.
function wordDiff(a, b) {
  if (a === b || a.length > 500 || b.length > 500) return null;
  const tok = (s) => s.match(/\w+|\s+|[^\w\s]/g) ?? [];
  const x = tok(a), y = tok(b), n = x.length, m = y.length;
  if (!n || !m || n * m > 40000) return null;
  const L = new Uint16Array((n + 1) * (m + 1)), at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[at(i, j)] = x[i] === y[j] ? L[at(i + 1, j + 1)] + 1 : Math.max(L[at(i + 1, j)], L[at(i, j + 1)]);
  const ra = [], rb = [];
  const add = (rs, from, to) => { const last = rs[rs.length - 1]; if (last && last[1] === from) last[1] = to; else rs.push([from, to]); };
  let i = 0, j = 0, pa = 0, pb = 0, same = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { same += x[i].length; pa += x[i++].length; pb += y[j++].length; }
    else if (j < m && (i >= n || L[at(i, j + 1)] >= L[at(i + 1, j)])) { add(rb, pb, pb + y[j].length); pb += y[j++].length; }
    else { add(ra, pa, pa + x[i].length); pa += x[i++].length; }
  }
  // Mostly rewritten: marking words would just paint everything.
  if (same < 0.4 * Math.max(a.length, b.length)) return null;
  return [ra, rb];
}

// Highlighted spans cut at the range edges, the parts inside a range given background `bg`.
function markSpans(spans, ranges, bg) {
  if (!ranges?.length) return spans;
  const out = [];
  let pos = 0;
  for (const p of spans) {
    let s = p.text, at = pos;
    while (s.length) {
      const r = ranges.find((r) => r[1] > at);
      const inside = r && r[0] <= at, edge = !r ? Infinity : inside ? r[1] : r[0];
      const take = Math.min(s.length, edge - at);
      out.push(inside ? { ...p, text: s.slice(0, take), bg } : { ...p, text: s.slice(0, take) });
      s = s.slice(take); at += take;
    }
    pos += p.text.length;
  }
  return out;
}

const STATUS = { A: "ansi2", D: "ansi1", U: "ansi5", M: "ansi3" };

// Readable colors for code on any theme, from its background/foreground (WCAG contrast).
const rgb = (c) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c ?? "");
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const hex = (v) => "#" + v.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const lum = (v) => { const [r, g, b] = v.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, w) => a.map((x, i) => x * w + b[i] * (1 - w)); // w of a, the rest b
// `c` moved toward `fg` just enough to reach `min` contrast on `bg`.
const lift = (c, fg, bg, min) => { for (let w = 0; w <= 1.0001; w += 0.05) { const v = mix(fg, c, w); if (contrast(v, bg) >= min) return v; } return fg; };
// The theme with code colors fixed up: dim (comments) ≥ 4.5:1, syntax ansi ≥ 4.5:1 (the normal or bright
// variant, whichever contrasts more), plus `lineNo` ≥ 3:1 for gutters and separator text. `prev`: the last result, reused while the colors match.
function palette(t, prev) {
  const key = [t.background, t.foreground, t.dim, ...Array.from({ length: 15 }, (_, i) => t[`ansi${i}`])].join();
  if (prev?.key === key) return prev;
  const bg = rgb(t.background), fg = rgb(t.foreground);
  let p = t;
  if (bg && fg) {
    p = { ...t, dim: hex(lift(bg, fg, bg, 4.5)), lineNo: hex(lift(bg, fg, bg, 3)) };
    for (let i = 1; i <= 6; i++) {
      // The normal or bright variant, whichever stands out more on this background.
      const cs = [rgb(t[`ansi${i}`]), rgb(t[`ansi${i + 8}`])].filter(Boolean).sort((a, b) => contrast(b, bg) - contrast(a, bg));
      if (cs.length) p[`ansi${i}`] = hex(lift(cs[0], fg, bg, 4.5));
    }
    // Changed rows: a clear red/green wash; the changed words inside them: a stronger one. Light themes take less.
    const dark = lum(bg) < lum(fg);
    const del = rgb(p.ansi1), add = rgb(p.ansi2);
    const [row, word] = dark ? [0.34, 0.62] : [0.24, 0.46];
    Object.assign(p, { delBg: hex(mix(del, bg, row)), addBg: hex(mix(add, bg, row)), delWord: hex(mix(del, bg, word)), addWord: hex(mix(add, bg, word)) });
  } else p = { ...t, lineNo: t.dim, delBg: t.ansi1 + "30", addBg: t.ansi2 + "30", delWord: t.ansi1 + "70", addWord: t.ansi2 + "70" };
  return { key, p };
}

export default class DiffView extends View {
  // The tab on screen, if it is a diff tab (it holds a wb-diff pane); else null. Asked at the moment of use:
  // a tab id remembered at start is the wrong one when the tab was made while another was shown.
  shownTab() {
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active);
    return tab && panes().some((p) => p.mod === "wb-diff" && p.tab === tab.id) ? tab.id : null;
  }

  init(_props, cx) {
    // contract: wb.diff.request is written by changes-copy; optional, falls back to null (nothing shown) when missing
    this.req = props()?.path ? props() : shared("wb.diff.request") ?? null;
    this.mode = "diff"; // "diff": hunks with context; "file": whole files, changes highlighted
    this.files = []; this.rows = []; this.heads = []; this.targets = []; this.scrollY = 0; this.viewH = 400;
    // Remembered: hunks or whole files, wrap long lines (rows get as tall as they need, `cols` characters a line) and the layout.
    this.wrap = false; this.layout = "unified";
    try {
      this.wrap = (localStorage.getItem("wb-diff.wrap") ?? localStorage.getItem("wrap")) === "1";
      if (localStorage.getItem("wb-diff.layout") === "split") this.layout = "split";
      if (localStorage.getItem("wb-diff.mode") === "file") this.mode = "file";
    } catch {}
    this.viewW = 1200; this.cols = 100; this.geoCache = null;
    this.leftW = 300; this.rightW = 300; this.uniW = 300; this.error = null; this.loading = false;
    this.gen = 0; this.loadedKey = null; this.loadingKey = null; this.target = null;
    // A tab opened with its own file must not be overwritten by an older request still sitting in shared state.
    this.applied = Math.max(this.req?.ts ?? 0, props()?.path ? shared("wb.diff.request")?.ts ?? 0 : 0); this.thumbDrag = null;
    this.handle = cx.focus_handle();
    // Once its tab is really on screen it takes the keyboard (Alt+↑/↓ and Esc work without a click first).
    cx.timer.after(300, () => { if (this.shownTab()) this.handle.focus(); });
    // A copy starts the first time it shows, so the active space/tab now are its own.
    const sp = spaces().find((s) => s.active);
    this.space = props()?.space ?? sp?.id ?? null;
    if (this.req) this.load(this.req, cx);
  }

  // A newer request (another file clicked in Changes): render() reruns when shared state changes, so no
  // poll. Same files as shown: just scroll there. Else the load runs from a timer callback, because a task
  // spawned with render's cx never runs.
  pickRequest(cx) {
    // contract: wb.diff.request is written by changes-copy; optional, ignored when missing
    const req = shared("wb.diff.request");
    // Requests are per space: another space's Changes panel doesn't swap this tab's file.
    if (!req || req.ts === this.applied || (req.space && req.space !== this.space)) return;
    this.applied = req.ts; this.req = req;
    const key = keyOf(req, this.mode);
    if (key === this.loadingKey) { this.target = req.path; return; }
    if (key === this.loadedKey) { this.scrollToFile(req.path); return; }
    cx.timer.after(0, (acx) => this.load(req, acx));
  }

  load(req, cx, target = req.path) {
    const gen = ++this.gen, mode = this.mode;
    this.loading = true; this.error = null; this.loadingKey = keyOf(req, mode); this.target = target;
    cx.spawn(async (cx) => {
      try {
        const { root, on, against, commit } = req;
        const list = fileList(req);
        const tracked = list.filter((f) => !f.fresh || commit).map((f) => f.path);
        let byPath = new Map();
        if (tracked.length) {
          // Full-file mode: huge context so git emits whole files, aligned, with changes tinted.
          // `commit`: that commit's own change (from the Git panel), not the working tree's.
          const r = await exec("git", [...READ, "diff", ...(commit ? [`${commit}^!`] : against ? [against] : []), "--no-ext-diff", "--no-color", "--no-renames", mode === "file" ? "-U1000000" : "-U3", "--", ...tracked], { cwd: root, on, timeout: 60000 });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git diff failed");
          byPath = splitFiles(r.stdout);
        }
        const files = [];
        let total = 0;
        for (const f of list) {
          const file = { path: f.path, status: f.status, fresh: f.fresh && !commit, lang: languageFor(f.path), hunks: [], note: null, text: null, up: [], down: [], tail: false, plus: 0, minus: 0 };
          files.push(file);
          if (total >= MAX_TOTAL) { file.note = "Not shown: too many changed lines in this view"; continue; }
          let lines;
          if (file.fresh) {
            const text = await readTextFile(`${root}/${f.path}`, { on }).catch(() => null);
            if (text === null) { file.note = "Cannot read this file (binary, too large, or unreadable)"; continue; }
            const all = text.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
            lines = [`@@ -0,0 +1,${all.length} @@`, ...all.map((l) => "+" + l)];
          } else {
            const d = byPath.get(f.path);
            if (!d) { file.note = "No text changes"; continue; }
            const at = d.findIndex((l) => l.startsWith("@@"));
            if (at < 0) { file.note = "Binary file: no text diff"; continue; }
            lines = d.slice(at, at + MAX_LINES);
          }
          file.hunks = parseHunks(lines);
          total += lines.length;
          for (const h of file.hunks) for (const l of h.lines) { if (l[0] === "+") file.plus++; else if (l[0] === "-") file.minus++; }
          // Three trailing context lines in -U3: the file may go on below the last hunk (fewer: it ends there).
          const last = file.hunks[file.hunks.length - 1];
          if (mode === "diff" && !file.fresh && last) {
            let k = 0;
            for (let j = last.lines.length - 1; j >= 0 && last.lines[j][0] === " "; j--) k++;
            file.tail = k >= 3;
          }
        }
        if (gen !== this.gen) return;
        this.files = files; this.loadedKey = this.loadingKey; this.loadingKey = null;
        this.build();
        this.scrollToFile(this.target);
        this.loading = false;
      } catch (e) {
        if (gen !== this.gen) return;
        this.error = String(e); this.loading = false; this.loadingKey = null; this.files = []; this.build();
      }
      cx.notify();
    });
  }

  // Rows for all files in the current layout, with the revealed context. Rebuilt on load, reveal and layout
  // change only. Kinds: F file header, N note, @ separator (hidden lines), " " context, x changed pair
  // (split), - / + (unified).
  build() {
    const rows = [], heads = [], targets = [], split = this.layout === "split";
    let lw = 20, rw = 20, uw = 20;
    this.files.forEach((f, fi) => {
      heads.push(rows.length);
      rows.push({ kind: "F", fi });
      if (f.note) { rows.push({ kind: "N", fi, text: f.note }); return; }
      const out = [];
      const ctx = (from, to, off) => { for (let k = from; k < to; k++) out.push({ t: " ", o: k + off, n: k, text: f.text?.[k - 1] ?? "" }); };
      let prevNe = 1, prevOff = 0;
      f.hunks.forEach((h, hi) => {
        // The unchanged gap before this hunk: lines shown below the previous one, a separator, lines above this one.
        const gap = Math.max(0, h.ns - prevNe);
        const down = hi ? Math.min(f.down[hi - 1] ?? 0, gap) : 0;
        const up = Math.min(f.up[hi] ?? 0, gap - down);
        if (down) ctx(prevNe, prevNe + down, prevOff);
        if (gap - down - up > 0) out.push({ sep: true, hi, hidden: gap - down - up, head: h.head });
        if (up) ctx(h.ns - up, h.ns, h.os - h.ns);
        let o = h.os, n = h.ns;
        for (const l of h.lines) {
          const t = l[0];
          out.push({ t, o: t === "+" ? null : o, n: t === "-" ? null : n, text: l.slice(1) });
          if (t !== "+") o++;
          if (t !== "-") n++;
        }
        prevNe = h.ne; prevOff = h.oe - h.ne;
      });
      // Below the last hunk: known once the file's text is read, else offered when the file may go on.
      const last = f.hunks.length - 1;
      if (last >= 0 && f.text) {
        const gap = Math.max(0, f.text.length + 1 - prevNe), down = Math.min(f.down[last] ?? 0, gap);
        if (down) ctx(prevNe, prevNe + down, prevOff);
        if (gap > down) out.push({ sep: true, hi: last + 1, hidden: gap - down });
      } else if (last >= 0 && f.tail) out.push({ sep: true, hi: last + 1, hidden: null });

      for (let i = 0; i < out.length;) {
        const e = out[i];
        if (e.sep) { rows.push({ kind: "@", fi, hi: e.hi, hidden: e.hidden, head: e.head ?? "" }); i++; continue; }
        if (e.t === " ") {
          uw = Math.max(uw, e.text.length); lw = Math.max(lw, e.text.length); rw = Math.max(rw, e.text.length);
          rows.push(split ? { kind: " ", fi, left: { num: e.o, text: e.text }, right: { num: e.n, text: e.text } } : { kind: " ", fi, o: e.o, n: e.n, text: e.text });
          i++; continue;
        }
        // A run of changes: one jump target. Split pairs removals with additions line by line, like PhpStorm.
        targets.push(rows.length);
        if (split) {
          const dels = [], adds = [];
          while (i < out.length && out[i].t === "-") { dels.push({ num: out[i].o, text: out[i].text }); lw = Math.max(lw, out[i].text.length); i++; }
          while (i < out.length && out[i].t === "+") { adds.push({ num: out[i].n, text: out[i].text }); rw = Math.max(rw, out[i].text.length); i++; }
          for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ kind: "x", fi, left: dels[k] ?? null, right: adds[k] ?? null });
        } else {
          // The k-th removed line pairs with the k-th added one for word highlighting.
          const run = [];
          while (i < out.length && (out[i].t === "-" || out[i].t === "+")) { const c = out[i]; uw = Math.max(uw, c.text.length); run.push({ kind: c.t, fi, o: c.o, n: c.n, text: c.text }); i++; }
          const dels = run.filter((r) => r.kind === "-"), adds = run.filter((r) => r.kind === "+");
          for (let k = 0; k < Math.min(dels.length, adds.length); k++) { dels[k].pair = adds[k]; adds[k].pair = dels[k]; }
          rows.push(...run);
        }
      }
    });
    this.rows = rows; this.heads = heads; this.targets = targets; this.geoCache = null;
    this.leftW = Math.min(2400, lw * CHAR_W + 60); this.rightW = Math.min(2400, rw * CHAR_W + 60);
    this.uniW = Math.min(2400, uw * CHAR_W + 110);
  }

  scrollToFile(path) {
    const fi = this.files.findIndex((f) => f.path === path);
    if (fi >= 0) this.scrollY = this.yOf(this.heads[fi]);
  }

  // Reveal hidden lines at separator `hi` of file `fi`: "down" below the previous hunk, "up" above the next,
  // "all" the whole gap. Reads the file's text once (the new side: working tree, or the commit's version).
  reveal(fi, hi, dir, hidden, cx) {
    const f = this.files[fi], req = this.req;
    if (!f || !req) return;
    const apply = () => {
      const n = dir === "all" ? hidden ?? 1e9 : STEP;
      if (dir === "up" || (dir === "all" && hi < f.hunks.length)) f.up[hi] = (f.up[hi] ?? 0) + n;
      else f.down[hi - 1] = (f.down[hi - 1] ?? 0) + n;
      this.build();
    };
    if (f.text) { apply(); cx.notify(); return; }
    const gen = this.gen;
    cx.spawn(async (cx) => {
      let text = null;
      if (req.commit) {
        const r = await exec("git", [...READ, "show", `${req.commit}:${f.path}`], { cwd: req.root, on: req.on, timeout: 30000 }).catch(() => null);
        if (r?.code === 0) text = r.stdout;
      } else text = await readTextFile(`${req.root}/${f.path}`, { on: req.on }).catch(() => null);
      if (gen !== this.gen || text === null) return;
      f.text = text.replace(/\n$/, "").split("\n");
      apply();
      cx.notify();
    });
  }

  // Row geometry: file headers are HEAD tall, other rows ROW, wrapped text rows as many ROWs as their
  // longer side needs. Offsets are prefix sums, cached per (rows, cols).
  geo() {
    const cols = this.wrap ? this.cols : 0, c = this.geoCache;
    if (c && c.rows === this.rows && c.cols === cols) return c;
    const n = this.rows.length, ys = new Array(n + 1), hs = new Array(n);
    const lines = (s) => (cols ? Math.max(1, Math.ceil(((s ?? "").length || 1) / cols)) : 1);
    let y = 0;
    for (let i = 0; i < n; i++) {
      const r = this.rows[i];
      hs[i] = r.kind === "F" ? HEAD : r.kind === "@" || r.kind === "N" ? ROW : (r.left !== undefined ? Math.max(lines(r.left?.text), lines(r.right?.text)) : lines(r.text)) * ROW;
      ys[i] = y; y += hs[i];
    }
    ys[n] = y;
    return (this.geoCache = { rows: this.rows, cols, ys, hs });
  }
  yOf(i) { return this.geo().ys[Math.max(0, Math.min(i, this.rows.length))]; }
  totalH() { return this.geo().ys[this.rows.length]; }
  // The row under vertical offset y.
  indexAt(y) {
    const g = this.geo();
    let lo = 0, hi = this.rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (g.ys[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Where a jump to change run k puts the scroll (three rows of context above it).
  targetY(k) { return Math.max(0, this.yOf(this.targets[k]) - 3 * ROW); }

  // Next / previous change across all files, wrapping around.
  jump(dir, cx) {
    const n = this.targets.length;
    if (!n) return;
    const at = this.scrollY;
    let k;
    if (dir > 0) { k = this.targets.findIndex((_, j) => this.targetY(j) > at + 1); if (k < 0) k = 0; }
    else { k = n - 1; while (k >= 0 && this.targetY(k) >= at - 1) k--; if (k < 0) k = n - 1; }
    this.scrollY = this.targetY(k);
    cx.notify();
  }

  // Next / previous file header.
  jumpFile(dir, cx) {
    if (!this.heads.length) return;
    const fi = this.rows[this.indexAt(this.scrollY)]?.fi ?? 0;
    const atHead = this.yOf(this.heads[fi]) >= this.scrollY - 1;
    const to = dir > 0 ? Math.min(this.heads.length - 1, fi + 1) : atHead ? Math.max(0, fi - 1) : fi;
    this.scrollY = this.yOf(this.heads[to]);
    cx.notify();
  }

  // One source line as colored spans (same rule as the Changes panel: plain when long or unknown).
  spans(text, lang, t, marks) { return markSpans(!lang || text.length > 600 ? [{ text }] : highlight(text, lang, t), marks?.ranges, marks?.bg); }
  span(p) { return div().when(Boolean(p.color), (e) => e.text_color(p.color)).when(Boolean(p.bg), (e) => e.bg(p.bg)).child(p.text); }
  cell(text, lang, t, marks) {
    return h_flex().flex_1().min_w(0).h_full().items_center().overflow_hidden().whitespace_nowrap()
      .children(this.spans(text, lang, t, marks).map((p) => this.span(p)));
  }

  // The same line, cut into lines of `cols` characters (colors kept), each its own ROW-tall line.
  wrapCell(text, lang, t, marks) {
    const cols = this.cols, lines = [];
    let cur = [], n = 0;
    for (const p of this.spans(text, lang, t, marks)) {
      let s = p.text;
      while (s.length) {
        const take = Math.min(s.length, cols - n);
        cur.push({ ...p, text: s.slice(0, take) }); n += take; s = s.slice(take);
        if (n >= cols) { lines.push(cur); cur = []; n = 0; }
      }
    }
    if (cur.length || !lines.length) lines.push(cur);
    return v_flex().flex_1().min_w(0).children(lines.map((l) => h_flex().h(ROW).items_center().whitespace_nowrap()
      .children(l.length ? l.map((p) => this.span(p)) : [div().child(" ")])));
  }

  code(text, lang, t, marks) { return this.wrap ? this.wrapCell(text || " ", lang, t, marks) : this.cell(text || " ", lang, t, marks); }
  num(n, t) { return div().w(30).flex_none().text_right().text_size(11).text_color(t.lineNo).child(n === null || n === undefined ? "" : String(n)); }

  // One row of a code column. Headers, notes and separators leave a blank of their height here: the
  // overlay draws them across the whole view.
  row(i, t, name, width, h) {
    const r = this.rows[i];
    if (r.kind === "F" || r.kind === "@" || r.kind === "N") return div().w(width).h(h).flex_none();
    const lang = this.files[r.fi]?.lang;
    // Changed rows get a red/green wash; the words that changed inside a removed/added pair a stronger one.
    // The word ranges are worked out the first time a row shows, and kept on it.
    if (name === "unified") {
      const del = r.kind === "-", add = r.kind === "+";
      if ((del || add) && r.pair && r.words === undefined) { const w = wordDiff(del ? r.text : r.pair.text, del ? r.pair.text : r.text); r.words = w ? w[del ? 0 : 1] : null; r.pair.words = w ? w[del ? 1 : 0] : null; }
      return h_flex().w(width).h(h).flex_none().gap(10).when(del || add, (e) => e.bg(del ? t.delBg : t.addBg))
        .child(this.num(r.o, t)).child(this.num(r.n, t))
        .child(this.code(r.text, lang, t, r.words ? { ranges: r.words, bg: del ? t.delWord : t.addWord } : null));
    }
    const c = r[name], left = name === "left";
    if (r.kind === "x" && r.left && r.right && r.words === undefined) r.words = wordDiff(r.left.text, r.right.text);
    const on = r.kind === "x" && c;
    return h_flex().w(width).h(h).flex_none().gap(10).when(Boolean(on), (e) => e.bg(left ? t.delBg : t.addBg))
      .child(this.num(c?.num, t))
      .child(this.code(c ? c.text : "", lang, t, on && r.words ? { ranges: r.words[left ? 0 : 1], bg: left ? t.delWord : t.addWord } : null));
  }

  // A file header: status, name, folder, added/removed counts. A click scrolls to the file's top.
  fileHead(fi, t) {
    const f = this.files[fi], slash = f.path.lastIndexOf("/");
    return h_flex().id(`head-${fi}`).size_full().px(12).gap(8).items_center().bg(t.raised).border_y(1).border_color(t.border).cursor_pointer()
      .on_click((_e, cx) => { this.scrollY = this.yOf(this.heads[fi]); cx.notify(); })
      .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(t[STATUS[f.status] ?? "ansi3"] ?? t.muted).child(f.status ?? "M"))
      .child(div().flex_none().max_w(360).truncate().font_semibold().text_size(13).child(f.path.slice(slash + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(slash > 0 ? f.path.slice(0, slash) : ""))
      .when(f.plus > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.plus}`)))
      .when(f.minus > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${f.minus}`)));
  }

  // A separator: hidden unchanged lines, with buttons that reveal them (STEP at a time, or all).
  separator(r, t) {
    const f = this.files[r.fi], first = r.hi === 0, tail = r.hi >= f.hunks.length;
    const btn = (dir, icon, tip) => div().id(`sep-${r.fi}-${r.hi}-${dir}`).w(26).h(18).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.reveal(r.fi, r.hi, dir, r.hidden, cx))
      .child(svg(`mods/wb-diff/icons/${icon}.svg`).size(12));
    const small = r.hidden !== null && r.hidden <= STEP;
    const btns = small ? [btn("all", "expand-all", `Show ${r.hidden} hidden ${r.hidden === 1 ? "line" : "lines"}`)]
      : [!first && btn("down", "expand-down", `Show ${STEP} more lines below the change above`),
        !tail && btn("up", "expand-up", `Show ${STEP} more lines above the change below`),
        tail && btn("all", "expand-all", "Show the rest of the file")].filter(Boolean);
    const label = r.hidden === null ? "more lines below" : `${r.hidden} hidden ${r.hidden === 1 ? "line" : "lines"}`;
    return h_flex().size_full().px(8).gap(4).items_center().bg(t.raised).text_color(t.dim).text_size(11).overflow_hidden().whitespace_nowrap()
      .children(btns).child(div().flex_none().pl(4).child(label))
      .when(Boolean(r.head), (e) => e.child(div().flex_1().min_w(0).pl(8).truncate().child(r.head)));
  }

  overlayRow(i, t) {
    const r = this.rows[i];
    if (r.kind === "F") return this.fileHead(r.fi, t);
    if (r.kind === "@") return this.separator(r, t);
    return h_flex().size_full().px(12).items_center().text_size(11).text_color(t.dim).child(r.text);
  }

  render(cx) {
    this.pickRequest(cx);
    this.pal = palette(theme(), this.pal);
    const t = this.pal.p;
    const r = this.req, split = this.layout === "split";
    const z = settings().zoom || 1, H = this.viewH || 400;
    // Wrapped, a side is as wide as its half of the view (unified: the whole view), in characters.
    const colW = split ? Math.max(200, (this.viewW - 1) / 2) : Math.max(300, this.viewW);
    this.cols = Math.max(10, Math.floor((colW - (split ? 56 : 96)) / CHAR_W));
    const g = this.geo(), total = this.totalH(), max = Math.max(0, total - H);
    const off = Math.min(this.scrollY, max);
    const first = this.indexAt(off), n = this.rows.length;
    let last = first;
    while (last < n && g.ys[last] < off + H) last++;
    const thumb = max ? Math.max(24, H * H / total) : 0, thumbTop = max ? off / max * (H - thumb) : 0;
    const scroll = (to) => { this.scrollY = Math.max(0, Math.min(max, to)); };
    // The file at the top of the view, and how far through the changes the view is.
    const fi = this.rows[first]?.fi ?? -1, cf = this.files[fi];
    let passed = 0;
    while (passed < this.targets.length && this.targetY(passed) <= off + 1) passed++;
    // Like the Changes panel's icon toggle groups: joined 26x20 cells in one bordered box, the active one tinted.
    const stop = (_e, cx) => cx.stop_propagation();
    const group = (cells) => h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden().children(cells);
    const cell = (id, icon, tip, on, enabled, act) => div().id(id).w(26).h(20).flex().items_center().justify_center().tooltip(tip)
      .text_color(on ? t.foreground : enabled ? t.muted : t.lineNo)
      .when(on, (e) => e.bg(t.selected)).when(!on && enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", stop).on_click((_e, cx) => { if (enabled) act(cx); })
      .child(svg(`mods/wb-diff/icons/${icon}.svg`).size(13));
    const setMode = (m) => (cx) => { if (this.mode !== m && this.req) { this.mode = m; try { localStorage.setItem("wb-diff.mode", m); } catch {} this.load(this.req, cx, cf?.path ?? this.req.path); cx.notify(); } };
    const setLayout = (l) => (cx) => {
      if (this.layout === l) return;
      // Keep the file on top where it was, as near as the other layout's rows allow.
      const delta = fi >= 0 ? off - this.yOf(this.heads[fi]) : 0;
      this.layout = l;
      try { localStorage.setItem("wb-diff.layout", l); } catch {}
      this.build();
      if (fi >= 0) this.scrollY = this.yOf(this.heads[fi]) + delta;
      cx.notify();
    };
    const toggleWrap = (cx) => {
      const top = this.indexAt(this.scrollY);
      this.wrap = !this.wrap;
      try { localStorage.setItem("wb-diff.wrap", this.wrap ? "1" : "0"); } catch {}
      this.scrollY = this.yOf(top);
      cx.notify();
    };
    // A single new, untracked file is one block of added lines: nothing to switch or jump between.
    const whole = this.files.length === 1 && this.files[0].fresh;
    // Rows span at least the whole column, so tints don't stop where the longest line ends.
    const column = (name, w) => { const width = Math.max(w, colW); return div().id(`diff-${name}`).flex_1().min_w(0).h_full().overflow_x_scrollbar()
      .child(div().min_w(width).h_full().relative()
        .child(v_flex().absolute().left(0).top(g.ys[first] - off).children(Array.from({ length: Math.max(0, last - first) }, (_, k) => this.row(first + k, t, name, width, g.hs[first + k]))))); };
    // Headers, notes and separators across both columns, at their rows' places.
    const overlay = [];
    for (let i = first; i < last; i++) {
      const k = this.rows[i].kind;
      if (k === "F" || k === "@" || k === "N") overlay.push(div().absolute().left(0).right(0).top(g.ys[i] - off).h(g.hs[i]).child(this.overlayRow(i, t)));
    }
    // The top file's header stays pinned while its rows scroll, pushed up by the next file's header.
    if (fi >= 0 && g.ys[this.heads[fi]] < off) {
      const next = this.heads[fi + 1], top = next === undefined ? 0 : Math.min(0, g.ys[next] - off - HEAD);
      overlay.push(div().absolute().left(0).right(0).top(top).h(HEAD).child(this.fileHead(fi, t)));
    }
    const nf = this.files.length;
    return v_flex().id("diff-view").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        const down = e.key === "down", up = e.key === "up";
        if ((down || up) && e.modifiers.alt && e.modifiers.shift) { this.jumpFile(down ? 1 : -1, cx); cx.stop_propagation(); }
        else if ((down || up) && e.modifiers.alt) { this.jump(down ? 1 : -1, cx); cx.stop_propagation(); }
        // Esc closes the diff tab on screen, and only a diff tab: anywhere else the key is left alone.
        else if (e.key === "escape") { const tab = this.shownTab(); if (tab) { run("tab.close", { id: tab, confirmed: true }); cx.stop_propagation(); } }
      })
      // Takes the keyboard on any press, so Alt+↑/↓ reach it.
      .on_mouse_down("left", () => this.handle.focus())
      .child(h_flex().h(42).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/wb-diff/icons/diff.svg").size(14).text_color(t.muted))
        .child(div().flex_none().max_w(260).truncate().font_semibold().child((cf?.path ?? r?.path)?.split("/").pop() ?? "Diff"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(nf > 1 && fi >= 0 ? `file ${fi + 1} of ${nf}` : (cf?.path ?? r?.path ?? "").includes("/") ? (cf?.path ?? r.path).replace(/\/[^/]*$/, "") : ""))
        .when(whole, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("new file")))
        .child(group([cell("wrap", "wrap", "Wrap long lines", this.wrap, true, toggleWrap)]))
        .child(group([cell("layout-split", "split", "Side by side", split, true, setLayout("split")),
          cell("layout-unified", "unified", "Unified", !split, true, setLayout("unified"))]))
        .when(!whole, (e) => e
          .child(div().flex_none().text_size(11).text_color(t.dim).child(this.targets.length ? (passed ? `change ${passed} of ${this.targets.length}` : `${this.targets.length} ${this.targets.length === 1 ? "change" : "changes"}`) : ""))
          .child(group([cell("mode-diff", "diff", "Changed hunks only", this.mode === "diff", true, setMode("diff")),
            cell("mode-file", "file", "Whole files, changes highlighted", this.mode === "file", true, setMode("file"))]))
          .child(group([cell("diff-prev", "chevron-left", "Previous change (Alt+↑; previous file: Alt+Shift+↑)", false, this.targets.length > 0, (cx) => this.jump(-1, cx)),
            cell("diff-next", "chevron-right", "Next change (Alt+↓; next file: Alt+Shift+↓)", false, this.targets.length > 0, (cx) => this.jump(1, cx))])))
        .child(div().id("diff-close").w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close").on_mouse_down("left", stop).on_click(() => { const tab = this.shownTab(); if (tab) run("tab.close", { id: tab, confirmed: true }); }).child(svg("mods/wb-diff/icons/close.svg").size(12))))
      .child(div().id("diff-body").flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(FONT)
        .on_size_change((s, cx) => { const h = s.height / z, w = s.width / z; if (h !== this.viewH || w !== this.viewW) { this.viewH = h; this.viewW = w; cx.notify(); } })
        .on_hover((hovered) => { if (!hovered) this.thumbDrag = null; })
        .on_mouse_up("left", () => { this.thumbDrag = null; })
        .on_mouse_move((e, cx) => { if (this.thumbDrag) { scroll(this.thumbDrag.off + (e.position.y - this.thumbDrag.y) / z * max / Math.max(1, H - thumb)); cx.notify(); } })
        .on_scroll_wheel((ev, cx) => {
          if (Math.abs(ev.delta.y) < Math.abs(ev.delta.x)) return;
          scroll(off - ev.delta.y / z); cx.stop_propagation(); cx.notify();
        })
        .when(n > 0 && split, (e) => e.child(h_flex().size_full()
          .child(column("left", this.wrap ? colW : this.leftW))
          .child(div().w(1).h_full().flex_none().bg(t.border))
          .child(column("right", this.wrap ? colW : this.rightW))))
        .when(n > 0 && !split, (e) => e.child(h_flex().size_full().child(column("unified", this.wrap ? colW : this.uniW))))
        .children(overlay)
        .when(!n, (e) => e.child(div().p(12).text_color(t.dim).child(this.error || (this.loading ? "Loading diff…" : r ? "No text changes" : "Open a changed file from the Changes panel"))))
        .when(thumb > 0, (e) => e.child(div().id("diff-thumb").absolute().right(2).top(thumbTop).w(6).h(thumb).rounded(3).bg(t.border).hover((s) => s.bg(t.input))
          .on_mouse_down("left", (ev, cx) => { this.thumbDrag = { y: ev.position.y, off }; cx.stop_propagation(); }))));
  }
}
