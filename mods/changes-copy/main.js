import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, run, shared, setShared, props, openOverlay, closeOverlay } from "herdr";
import { migrate, models, modelFor, settingsFor, setUse, projectKey, projectName, languageLine, runModel, describe } from "./ai.js";

// The repo's own rules for commit messages, as "### path\n<text>" blocks: tracked agent docs (CLAUDE.md, AGENTS.md,
// .claude rules/skills/commands, .github instructions) that mention commit messages most, then CLAUDE.md.
// ponytail: found by grep, capped at 4 files × 8000 chars; git's commit.template isn't read.
async function commitRules(root, on) {
  const hits = await exec("git", ["grep", "-c", "-i", "-I", "-E", "commit message|commit subject|git commit", "--", "CLAUDE.md", "AGENTS.md", ".claude/*.md", ".github/*.md", ".cursor/*"], { cwd: root, on, timeout: 10000 }).catch(() => null);
  const ranked = (hits?.code === 0 ? hits.stdout.split("\n").filter(Boolean) : []).map((l) => l.split(/:(\d+)$/)).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const paths = [...new Set([...ranked, "CLAUDE.md"])].slice(0, 4);
  const texts = await Promise.all(paths.map((p) => readTextFile(`${root}/${p}`, { on }).catch(() => null)));
  return paths.map((p, i) => texts[i]?.trim() ? `### ${p}\n${texts[i].trim().slice(0, 8000)}` : "").filter(Boolean).join("\n\n");
}

// A pane without a folder (the wb-diff tab, any mod pane) has the keyboard after a click on a file: then the
// panel stays on the last place it knew in this space, instead of falling back to the space's own folder.
// `places` is the view's own map (space id -> { cwd, on }), capped by PLACES_MAX: module scope is shared by every copy.
const PLACES_MAX = 50;
function location(places) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd;
  if (cwd) {
    places.delete(space?.id); places.set(space?.id, { cwd, on });
    if (places.size > PLACES_MAX) places.delete(places.keys().next().value);
    return { cwd, on };
  }
  return places.get(space?.id) ?? { cwd: space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// The folder watch is recursive (node_modules, .git/objects too on macOS): a batch of only these paths can't change the list.
// ponytail: a fixed list; ask `git check-ignore --stdin` per batch if another ignored folder floods it.
const NOISE = /\/(node_modules|\.git\/(objects|logs)|target|\.venv|__pycache__|\.next|\.turbo|\.gradle|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.idea)(\/|$)|(\/\.DS_Store|\.pyc|\/\.git\/FETCH_HEAD)$/;
// Base branches the branch scope can compare against, offered only when the repo has them (origin/<name> or local).
const BASES = ["main", "master", "release", "release-beta", "production", "production-beta"];
const BASES_MAX = 50; // remembered choices (repo root -> branch name)
const STATUS = { A: "Added", M: "Modified", D: "Deleted", U: "Conflict" };
// Theme colors per status: four distinct hues, since the icon's color is all that tells them apart.
const STATUS_COLOR = { A: "ansi2", M: "ansi4", D: "ansi1", U: "ansi5" };
// As in the Files panel: ITEM the row height, INDENT per tree level, GAP between a row's parts, RADIUS its corners,
// CHEVRON the space a folder's chevron takes (a file in the tree leaves it empty, so icons line up).
const ITEM = 28, INDENT = 18, GAP = 7, RADIUS = 7, CHEVRON = 12 + GAP;
// A commit message in git's shape: a one-line title, one blank line, then the body. `compact` drops the body's own blank lines.
const tidy = (msg, compact) => {
  const lines = String(msg).replace(/\r/g, "").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  const title = (lines.shift() ?? "").trim();
  let rest = compact ? lines.filter((l) => l.trim()) : lines;
  while (rest.length && !rest[0].trim()) rest = rest.slice(1);
  while (rest.length && !rest[rest.length - 1].trim()) rest = rest.slice(0, -1);
  return rest.length ? `${title}\n\n${rest.map((l) => l.trimEnd()).join("\n")}` : title;
};
const COMMIT_MIN = 40, COMMIT_MAX = 420; // commit message box height, px
// Per-project generation settings (model, language, template) live in shared("wb.ai.project") (ai.js), edited in wb-ai.
const openGenSettings = () => openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 });
const openCommitSettings = (project) => openOverlay({ mod: "wb-ai", kind: "dialog", width: 560, props: { use: "commit", project, projectName: projectName(project) } });
export default class Changes extends View {
  key() { return JSON.stringify(location(this.places)); }
  init(_props, cx) {
    this.places = new Map();
    // The Generate button's menu (a popup copy of this mod) draws one item: no git, no timers.
    if (props()?.menu) return;
    // The Discard confirmation (a dialog copy of this mod): runs the discard itself; the panel's folder watch refreshes it.
    if (props()?.discard) { this.discarding = false; this.discardError = null; return; }
    this.files = []; this.view = "list"; this.scope = "head"; this.collapsed = new Set();
    try { if (localStorage.getItem("view") === "tree") this.view = "tree"; if (localStorage.getItem("scope") === "base") this.scope = "base"; } catch {}
    // The chosen base per repo root; none = the default (origin/HEAD, main, master).
    this.baseChoice = new Map(); this.bases = []; this.basesOpen = false;
    this.baseInput = InputState.new({ placeholder: "other branch" });
    // The picker stays open after a typed branch, so "no branch X" shows where it was typed.
    this.baseInput.on("submit", (_e, cx) => { this.setBase(this.baseInput.value(), cx); this.basesOpen = true; });
    try { this.baseChoice = new Map(Object.entries(JSON.parse(localStorage.getItem("bases") || "{}"))); } catch {}
    migrate();
    this.message = ""; this.handle = cx.focus_handle(); this.generating = false;
    this.input = TextareaState.new({ placeholder: "Commit message" });
    // The box height (px) is a splitter choice: drag the handle above it up to grow it, remembered per person.
    // The textarea is sized by this height, not by rows (a Textarea's layout height is its element's).
    this.commitH = Math.min(COMMIT_MAX, Math.max(COMMIT_MIN, Number(localStorage.getItem("commitH")) || 72));
    this.splitDrag = null;
    // No set_rows: rows would set the textarea's own viewport (16 rows), taller than the clipped box,
    // so it never scrolled to the lines below the box.
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (e, cx) => { if (!e.modifiers?.shift) this.commit(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    // While the folder watch is live it sees every change: then the poll is only a 60 s safety net (refs moved in a
    // worktree's common dir, a missed event). Remote repos (no watch) or a dead watch: every 10 s.
    this.ticks = 0;
    cx.timer.every(10000, (cx) => { if (this.on || !this.watched || ++this.ticks >= 6) { this.ticks = 0; this.refresh(cx); } });
    // Focus moved to another folder or repo: refresh for it. From a timer, not render(): a task spawned
    // with render's cx never runs, and refresh() had already set `loading`, freezing the panel for good.
    // Every tick copies spaces/panes from the host: 2 s, not 500 ms.
    cx.timer.every(2000, (cx) => { if (this.key() !== this.context) this.refresh(cx); });
  }

  watch(root, gitDir, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    // Each watch() is a generation: loops of an older one (still waiting in watchFolder) end when
    // they wake, so going A → B → A doesn't leave two watchers on A.
    const gen = this.watchGen = (this.watchGen ?? 0) + 1;
    const live = () => this.watchGen === gen && this.watched === root;
    // A worktree's index and HEAD live outside it (the main repo's .git/worktrees/<name>), so commits
    // and staging there would only show on the 10 s timer: watch that folder too.
    for (const dir of gitDir.startsWith(root + "/") ? [root] : [root, gitDir]) cx.spawn(async (cx) => {
      try {
        while (live()) {
          const paths = await watchFolder(dir);
          if (live() && !(paths?.length && paths.every((p) => NOISE.test(p)))) this.refresh(cx);
        }
      } catch { if (dir === root && live()) this.watched = null; }
    });
  }

  refresh(cx) {
    // A change during a refresh runs one more after it (see finally), instead of one per change.
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(this.places), context = this.key();
    const shown = this.shownState();
    if (context !== this.context) {
      this.context = context; this.collapsed = new Set(); this.root = null; this.files = []; this.open = null;
      this.pk = null; this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    const scope = this.scope, baseGen = this.baseGen, stale = () => this.key() !== context || this.scope !== scope || this.baseGen !== baseGen;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd, on });
        if (stale()) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.open = null; this.error = "Not a git repository"; return; }
        const [root, gitDir] = top.stdout.trim().split("\n"), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Commits not pushed yet (↑), and whether the branch has an upstream at all.
        // pushNew: no upstream, or one with another name (a branch made from origin/main); plain `git push` refuses that.
        let upstream = null, ahead = 0, behind = 0, pushNew = true;
        if (head.code === 0) {
          const up = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "HEAD", "@{u}"]);
          if (up.code === 0) { const [branch, u] = up.stdout.trim().split("\n"); upstream = u; pushNew = u.slice(u.indexOf("/") + 1) !== branch; [ahead, behind] = (await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"])).stdout.trim().split(/\s+/).map((n) => Number(n) || 0); }
        }
        let against = head.code === 0 ? "HEAD" : null, base = null, bases = [], baseMissing = null;
        // Branch scope: everything since the branch left its base (like a PR), including uncommitted work.
        if (scope === "base" && against) {
          // Which of BASES exist, as origin/<name> (fresher) or else the local branch: one call.
          const refs = await git(["for-each-ref", "--format=%(refname:short)", ...BASES.flatMap((b) => [`refs/remotes/origin/${b}`, `refs/heads/${b}`])]);
          const have = new Set(refs.code === 0 ? refs.stdout.split("\n").filter(Boolean) : []);
          bases = BASES.map((b) => have.has(`origin/${b}`) ? `origin/${b}` : have.has(b) ? b : null).filter(Boolean);
          // The chosen base (a listed one or typed in by hand) as origin/<name> first, then local.
          const choice = this.baseChoice.get(root), chosen = choice ? [`origin/${choice}`, choice] : [];
          for (const ref of [...chosen, "origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
            const r = await git(["rev-parse", "--verify", "--quiet", "--abbrev-ref", ref]);
            if (r.code !== 0) continue;
            const mb = await git(["merge-base", "HEAD", ref]);
            if (mb.code === 0) { base = r.stdout.trim(); against = mb.stdout.trim(); break; }
          }
          // A typed branch the repo doesn't have: say so, compare with the default.
          baseMissing = choice && !chosen.includes(base) ? choice : null;
          if (base && !bases.includes(base)) bases.push(base);
        }
        const stats = {};
        const results = against ? [await git(["diff", against, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        let entries = status.stdout.split("\0").filter(Boolean);
        if (base) {
          // Tracked changes come from the diff against the merge-base; untracked files from status.
          const ns = await git(["diff", against, "--name-status", "-z", "--no-renames"]);
          if (ns.code !== 0) throw new Error(ns.stderr);
          const parts = ns.stdout.split("\0"), tracked = [];
          for (let i = 0; i + 1 < parts.length; i += 2) tracked.push(`${parts[i][0] === "U" ? "UU" : parts[i][0] + " "} ${parts[i + 1]}`);
          entries = [...tracked, ...entries.filter((e) => e.startsWith("??"))];
        }
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        if (stale()) return;
        this.root = root; this.on = on; this.upstream = upstream; this.pushNew = pushNew; this.ahead = ahead; this.behind = behind; this.hasHead = head.code === 0; this.against = against; this.base = base; this.bases = bases; this.baseMissing = baseMissing; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, gitDir, cx);
        // The project (repo) key for per-project AI settings; cached in ai.js after the first lookup.
        const pk = await projectKey({ cwd: root, on });
        if (stale()) return;
        this.pk = pk;
        if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
      } catch (e) { if (!stale()) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.scope !== scope || this.baseGen !== baseGen) this.refresh(cx);
        else if (this.again) { this.again = false; cx.timer.after(500, (cx) => this.refresh(cx)); }
        // Redraw (the whole window) only when what the panel shows changed, or a frame drew "loading".
        if (this.drewLoading || this.shownState() !== shown) { this.drewLoading = false; cx.notify(); }
      }
    });
  }

  shownState() {
    return JSON.stringify([this.context, this.root, this.upstream, this.pushNew, this.ahead, this.behind, this.hasHead, this.against, this.base, this.bases, this.baseMissing, this.files, this.limited, this.error, this.pk, this.open]);
  }


  setView(view, cx) {
    if (this.view === view) return;
    this.view = view;
    try { localStorage.setItem("view", view); } catch {}
    cx.notify();
  }

  setScope(scope, cx) {
    // A click on the branch scope while it is on opens (or closes) the base branch picker.
    if (this.scope === scope) { if (scope === "base") { this.basesOpen = !this.basesOpen; cx.notify(); } return; }
    this.scope = scope; this.basesOpen = false;
    try { localStorage.setItem("scope", scope); } catch {}
    this.files = []; this.open = null; this.note = null;
    this.refresh(cx); cx.notify();
  }

  // Compare the branch against `ref` (origin/<name> or <name>), remembered per repo root.
  setBase(ref, cx) {
    const name = String(ref).trim().replace(/^origin\//, "");
    if (!name) return;
    this.basesOpen = false; this.baseInput.set_value("");
    if (!this.root || (ref === this.base && !this.baseMissing)) { cx.notify(); return; }
    this.baseChoice.delete(this.root); this.baseChoice.set(this.root, name);
    if (this.baseChoice.size > BASES_MAX) this.baseChoice.delete(this.baseChoice.keys().next().value);
    try { localStorage.setItem("bases", JSON.stringify(Object.fromEntries(this.baseChoice))); } catch {}
    this.baseGen = (this.baseGen ?? 0) + 1; this.files = []; this.open = null; this.note = null;
    this.refresh(cx); cx.notify();
  }

  // Icon toggle group: options are [value, icon in ./icons, tooltip]; `warn` paints that option red.
  segment(name, current, options, pick, t, warn = null) {
    return h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(options.map(([v, icon, tip]) => div().id(`${name}-${v}`).w(26).h(20).flex().items_center().justify_center().cursor_pointer().tooltip(tip)
        .text_color(v === warn ? t.ansi1 : current === v ? t.foreground : t.muted)
        .when(current === v, (e) => e.bg(t.selected)).when(current !== v, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => pick(v, cx)).child(svg(`mods/changes-copy/icons/${icon}.svg`).size(13))));
  }

  toggleDir(path, cx) {
    if (!this.collapsed.delete(path)) this.collapsed.add(path);
    cx.notify();
  }

  // Flat file rows, or folders-first tree rows (single-child folder chains are merged: a/b/c).
  listRows() {
    if (this.view !== "tree") return this.files.map((f) => ({ file: f, depth: 0 }));
    const top = { dirs: new Map(), files: [] };
    for (const f of this.files) {
      const parts = f.path.split("/"), name = parts.pop();
      let node = top;
      for (const part of parts) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ file: f, name });
    }
    const count = (n) => n.files.length + [...n.dirs.values()].reduce((sum, d) => sum + count(d), 0);
    const rows = [];
    const walk = (node, prefix, depth) => {
      for (const [name, first] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
        let label = name, dir = first, path = prefix + name;
        while (dir.files.length === 0 && dir.dirs.size === 1) {
          const [k, v] = [...dir.dirs][0];
          label += "/" + k; path += "/" + k; dir = v;
        }
        const open = !this.collapsed.has(path);
        rows.push({ dir: true, path, label, depth, open, count: count(dir) });
        if (open) walk(dir, path + "/", depth + 1);
      }
      for (const entry of node.files.sort((a, b) => a.name.localeCompare(b.name))) rows.push({ ...entry, depth });
    };
    walk(top, "", 0);
    return rows;
  }

  dirRow(r, t) {
    return h_flex().id(`dir-${r.path}`).h(ITEM).flex_none().pl(8 + r.depth * INDENT).pr(8).gap(GAP).items_center().rounded(RADIUS).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggleDir(r.path, cx))
      // Chevron and folder as in the Files panel.
      .child(svg(`mods/changes-copy/icons/chevron-${r.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(svg("mods/changes-copy/icons/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(r.label))
      .child(div().text_size(10).text_color(t.dim).child(String(r.count)))
      .when(this.canDiscard() && this.hasHead, (e) => e.child(this.discardButton(`discard-dir-${r.path}`, `Discard all changes in ${r.path}/ and its subfolders`, () => this.askDiscard(r.path, true), t)));
  }

  // Discard is offered only in the uncommitted list (in branch scope a row may hold committed work), and not mid-action.
  canDiscard() { return Boolean(this.root && !this.base && !this.busy && !this.loading); }

  // The row's Discard button (a file or a folder); its click opens the confirmation, not the row's own action.
  discardButton(id, tip, act, t) {
    return div().id(id).flex_none().size(20).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.ansi1)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); act(); })
      .child(svg("mods/changes-copy/icons/discard.svg").size(12));
  }

  // Where row i's text starts, in px from the row's left edge (see diffRow / fileRow).

  // A clicked file opens its side-by-side diff wide in the main area, as a wb-diff tab.
  // One diff tab per space: clicking another file sends it a new request through shared state.
  pick(path, cx) {
    this.open = path; this.note = null;
    this.openMain(path);
    cx.notify();
  }

  openMain(path) {
    if (!this.root) return;
    const file = this.files.find((f) => f.path === path);
    const space = spaces().find((s) => s.active);
    // `space`: each space's diff tab takes only its own space's requests.
    const req = { space: space?.id ?? null, root: this.root, on: this.on ?? null, path, against: this.against ?? null, status: file?.status ?? "M", fresh: Boolean(file?.fresh), ts: Date.now() };
    const ids = new Set((space?.tabs ?? []).map((t) => t.id));
    const existing = panes().find((p) => p.mod === "wb-diff" && ids.has(p.tab));
    const name = path.split("/").pop();
    setShared("wb.diff.request", req); // contract: read by wb-diff
    if (existing) { run("tab.select", { id: existing.tab }); run("tab.rename", { id: existing.tab, name }); }
    else run("tab.new", { name, mod: "wb-diff", props: req, space: space?.id ?? undefined });
  }

  // Ask the configured model for a commit message from the current diff, and drop it into the textarea.
  // Claude rides the person's subscription and starts inside the repo folder; local goes to the endpoint.
  generate(cx) {
    if (!this.root || this.generating || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, hasHead = this.hasHead, against = this.against;
    this.generating = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // This project's settings (wb-ai): model, template, language, noBlank.
        const cfg = settingsFor("commit", await projectKey({ cwd: root, on })), model = cfg.model;
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [st, df] = await Promise.all([
          git(["status", "--short", "--branch"]), // the "## branch" line: rules often take the ticket key from it
          git(["diff", ...(hasHead ? [against ?? "HEAD"] : []), "--no-color"]),
        ]);
        const fresh = (st.stdout || "").split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3)).slice(0, 20);
        let text = `Git status:\n${st.stdout}\n\nDiff:\n${(df.stdout || "").slice(0, 60000)}`;
        if (fresh.length) text += `\n\nNew untracked files (contents not shown): ${fresh.join(", ")}`;
        // The project's template (wb-ai settings) says how the message looks; the body's blank lines are dropped unless allowed.
        // The repo's own rules (read now, on the repo's machine) go in too, so any model follows them.
        const rules = await commitRules(root, on);
        const prompt = `Write one git commit message for these changes in this repository. Format: ${cfg.template}${rules ? `\n\nThe project's own files below take precedence over that format: follow what they say about commit messages (subject format, tags, ticket keys from the branch name). Ignore their other steps (asking, pushing, running commands): only the message is wanted.\n\n${rules}\n\n` : " "}Reply with the message only — no quotes, no code fences, no explanations. ${languageLine(cfg.language)}`;
        let msg = await runModel(model, `${prompt}\n\n${text}`, { cwd: root, on });
        msg = tidy(msg, cfg.noBlank !== false);
        if (!msg) throw new Error("the model returned nothing");
        if (this.key() === context) { this.input.set_value(msg); this.message = msg; }
      } catch (e) { if (this.key() === context) this.note = `Generate failed: ${e}`; }
      finally { this.generating = false; cx.notify(); }
    });
  }

  // The thin dropdown beside the Generate button.
  menuView() {
    const t = theme();
    const item = (id, label, action) => h_flex().id(id).h(30).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .text_size(12.5).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => { closeOverlay(props()?.overlay); action(); })
      .child(svg("mods/changes-copy/icons/settings.svg").size(13).text_color(t.muted)).child(label);
    // The model that writes this project's commit messages (one click), then the settings.
    const pk = props()?.project, cur = modelFor("commit", pk);
    return v_flex().p(6).gap(2).w_full().bg(t.raised).text_color(t.foreground)
      .child(div().px(8).py(4).text_size(10).font_semibold().text_color(t.dim).child("COMMIT WITH"))
      .children(models().map((m) => h_flex().id(`cm-${m.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer()
        .when(m.id === cur?.id, (s) => s.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setUse("commit", m.id, pk); closeOverlay(props()?.overlay); })
        .child(div().flex_1().truncate().text_size(12).child(m.name)).child(div().text_size(11).text_color(t.dim).child(describe(m)))))
      .child(div().h(1).my(2).bg(t.border))
      .when(Boolean(pk), (e) => e.child(item("gen-project", "Commit message settings…", () => openCommitSettings(pk))))
      .child(item("gen-settings", "AI models…", openGenSettings));
  }

  endSplit() {
    if (!this.splitDrag) return;
    this.splitDrag = null;
    try { localStorage.setItem("commitH", String(this.commitH)); } catch {}
  }

  // Pull: fast-forward when it can; when the branches diverged, rebase the local commits on top (autostash);
  // if that stops on a conflict it is aborted and said so, so nothing is left half done.
  pull(cx) {
    if (!this.root || !this.upstream || this.pulling || this.pushing || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context;
    const git = (args) => exec("git", args, { cwd: root, on, timeout: 180000 });
    const msg = (r) => (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    this.pulling = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        let r = await git(["pull", "--ff-only"]);
        if (r.code !== 0 && /not possible to fast-forward|diverg/i.test(msg(r))) {
          r = await git(["pull", "--rebase", "--autostash"]);
          if (r.code !== 0) { const m = msg(r); await git(["rebase", "--abort"]).catch(() => null); throw new Error(`rebase stopped: ${m} · rebase aborted, nothing changed`); }
        } else if (r.code !== 0) throw new Error(msg(r));
        setShared("branch.switched", Date.now()); // the header chip and the other panels ask again. contract: read by status-copy
      } catch (e) { if (this.key() === context) this.note = `Pull failed: ${e.message ?? e}`; }
      finally { this.pulling = false; this.refresh(cx); cx.notify(); }
    });
  }

  // Push the branch: plain `git push`, or `git push -u origin HEAD` when it has no upstream of its own name yet.
  push(cx) {
    if (!this.root || this.pushing || this.pulling || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, args = !this.pushNew ? ["push"] : ["push", "-u", "origin", "HEAD"];
    this.pushing = true; this.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on, timeout: 180000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "));
        setShared("branch.switched", Date.now()); // the header chip and the other panels ask again. contract: read by status-copy
      } catch (e) { if (this.key() === context) this.note = `Push failed: ${e.message ?? e}`; }
      finally { this.pushing = false; this.refresh(cx); cx.notify(); }
    });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // Discard a file, or a folder with everything under it: always asked first, in a dialog listing what goes.
  // The dialog gets the exact files shown here, so it touches nothing the list didn't show.
  askDiscard(path, isDir) {
    if (!this.root || this.busy || this.loading || this.context !== this.key()) return;
    const files = this.files.filter((f) => isDir ? f.path.startsWith(path + "/") : f.path === path);
    if (!files.length) return;
    const tracked = files.filter((f) => !f.fresh).map((f) => f.path), fresh = files.filter((f) => f.fresh).map((f) => f.path);
    openOverlay({ mod: "changes-copy", kind: "dialog", width: 480, height: 190 + Math.min(files.length, 8) * 20,
      props: { discard: { root: this.root, on: this.on ?? null, label: isDir ? `${path}/` : path, tracked, fresh } } });
  }

  // In the dialog: tracked files go back to HEAD in index and worktree (a staged new file is removed, a conflict takes
  // HEAD's side); untracked ones are deleted (git clean -f, ignored files untouched).
  runDiscard(cx) {
    const d = props().discard;
    if (this.discarding) return;
    this.discarding = true; this.discardError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = async (args) => { const r = await exec("git", args, { cwd: d.root, on: d.on, timeout: 60000 }); if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop()); };
        if (d.tracked.length) await git(["restore", "--source=HEAD", "--staged", "--worktree", "--", ...d.tracked]);
        if (d.fresh.length) await git(["clean", "-f", "--", ...d.fresh]);
        closeOverlay(props()?.overlay);
      } catch (e) { this.discardError = `Discard failed: ${e.message ?? e}`; }
      this.discarding = false; cx.notify();
    });
  }

  discardView() {
    const t = theme(), d = props().discard, all = [...d.tracked, ...d.fresh], n = all.length;
    const what = [d.tracked.length ? `${d.tracked.length} file${d.tracked.length === 1 ? "" : "s"} go back to HEAD` : "",
      d.fresh.length ? `${d.fresh.length} untracked file${d.fresh.length === 1 ? " is" : "s are"} deleted` : ""].filter(Boolean).join(", ");
    const btn = (id, label, danger, act) => div().id(id).h(30).px(14).flex().items_center().rounded(6).border_1().text_size(12.5).cursor_pointer()
      .border_color(danger ? t.ansi1 : t.border).bg(danger ? t.ansi1 : t.background).text_color(danger ? t.background : t.foreground)
      .hover((s) => s.opacity(0.85)).on_click(act).child(label);
    return v_flex().id("discard").size_full().p(16).gap(10).bg(t.background).text_color(t.foreground).text_size(13)
      .child(div().font_semibold().text_size(14).child(`Discard changes in ${d.label}?`))
      .child(div().text_size(12).text_color(t.muted).child(`${what}. This can't be undone.`))
      .child(v_flex().flex_1().min_h(0).gap(2).text_size(11.5).text_color(t.dim)
        .children(all.slice(0, 8).map((p) => div().truncate().child(p)))
        .when(n > 8, (e) => e.child(div().child(`… and ${n - 8} more`))))
      .when(Boolean(this.discardError), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.discardError)))
      .child(h_flex().gap(8).justify_end()
        .child(btn("discard-cancel", "Cancel", false, () => closeOverlay(props()?.overlay)))
        .child(btn("discard-run", this.discarding ? "Discarding…" : "Discard", true, (_e, cx) => this.runDiscard(cx))));
  }

  render(cx) {
    if (props()?.menu) return this.menuView();
    if (props()?.discard) return this.discardView();
    if (this.loading) this.drewLoading = true;
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const rows = this.listRows(), tree = this.view === "tree";
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const pushEnabled = Boolean(this.root && this.hasHead && !this.pushing && !this.pulling && !this.busy && !this.loading && (this.ahead > 0 || this.pushNew));
    const pullEnabled = Boolean(this.root && this.hasHead && this.upstream && !this.pulling && !this.pushing && !this.busy && !this.loading);
    const genEnabled = Boolean(this.root && !this.generating && !this.busy && !this.loading && this.context === this.key());
    const noBase = this.scope === "base" && Boolean(this.root) && !this.base && !this.loading;
    const canDiscard = this.canDiscard();
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
      })
      // The commit-box splitter: the handle grabs, the panel tracks the drag even outside it.
      .on_mouse_move((e, cx) => {
        if (!this.splitDrag) return;
        const z = settings().zoom || 1;
        // The handle sits above the box: dragging up grows it.
        const h = Math.round(Math.max(COMMIT_MIN, Math.min(COMMIT_MAX, this.splitDrag.h - (e.position.y - this.splitDrag.y) / z)));
        if (h !== this.commitH) { this.commitH = h; cx.notify(); }
      })
      .on_mouse_up("left", () => this.endSplit())
      .on_hover((hovered) => { if (!hovered) this.endSplit(); })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1())
        .child(this.segment("scope", this.scope, [["head", "uncommitted", "Uncommitted changes"],
          ["base", "branch", this.base ? `Branch changes vs ${this.base} (incl. uncommitted) · click to pick the base` : noBase ? "No base branch (origin/HEAD, main, master) · showing uncommitted" : "Branch changes vs base"]],
          (v, cx) => this.setScope(v, cx), t, noBase ? "base" : null))
        .child(this.segment("view", this.view, [["list", "list", "List"], ["tree", "tree", "Tree"]], (v, cx) => this.setView(v, cx), t))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // The base branch picker: the BASES this repo has, shown without "origin/".
      // A vertical list (rows like the file list's), then a field for any other branch.
      .when(this.basesOpen && this.scope === "base", (e) => e.child(v_flex().flex_none().p(6).gap(1).border_b(1).border_color(t.border).text_size(12)
        .children(this.bases.map((ref) => h_flex().id(`base-${ref}`).h(26).flex_none().px(8).gap(GAP).items_center().rounded(RADIUS).cursor_pointer().tooltip(ref)
          .text_color(ref === this.base ? t.foreground : t.muted)
          .when(ref === this.base, (s) => s.bg(t.selected)).when(ref !== this.base, (s) => s.hover((h) => h.bg(t.hover)))
          .on_click((_e, cx) => this.setBase(ref, cx))
          .child(svg("mods/changes-copy/icons/branch.svg").size(13).flex_none().text_color(ref === this.base ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().child(ref.replace(/^origin\//, "")))))
        // Any other branch by hand: Enter compares with it (origin/<name> first, then local).
        .child(div().id("base-input").h(26).mt(4).flex_none().px(8).flex().items_center().rounded(RADIUS).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.baseInput).w_full().text_size(12).text_color(t.foreground)))
        .when(Boolean(this.baseMissing), (e) => e.child(div().px(8).pt(4).text_size(11).text_color(t.ansi1).child(`No branch ${this.baseMissing} · comparing with the default`)))))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(rows.map((r) => {
        if (r.dir) return this.dirRow(r, t);
        const f = r.file, parts = tree ? [] : f.path.split("/"), name = tree ? r.name : parts.pop();
        return h_flex().id(`change-${f.path}`).h(ITEM).flex_none().px(8).pl(tree ? 8 + r.depth * INDENT + CHEVRON : 8).gap(GAP).items_center().rounded(RADIUS).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          // The file icon (as in Files) wears the status color instead of a separate A/M/D/U letter; its name is the tooltip.
          // In the tree it sits under the folders' icons.
          .child(div().id(`status-${f.path}`).flex_none().tooltip(STATUS[f.status] ?? f.status)
            .child(svg("mods/changes-copy/icons/file.svg").size(14).text_color(t[STATUS_COLOR[f.status] ?? "ansi4"])))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          // Discard: only in the uncommitted list (in branch scope a row may hold committed work), not before the first commit.
          .when(canDiscard && (f.fresh || this.hasHead), (e) => e.child(this.discardButton(`discard-${f.path}`, f.fresh ? "Discard: delete this untracked file" : "Discard this file's changes (back to HEAD)", () => this.askDiscard(f.path, false), t)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? (this.base ? `No changes since ${this.base}` : "No uncommitted changes") : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      // Explicit height: the layout under-measures the Textarea inside, which pushed the buttons off the bottom.
      // 10+10 padding, 8 handle, 8+8 gaps, 30 buttons, 1 border.
      .child(v_flex().flex_none().h(this.commitH + 75).overflow_hidden().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-split").h(12).flex_none().ml(-10).mr(-10).mt(-4).flex().items_center().justify_center().cursor_row_resize().tooltip("Drag to resize the message box").hover((s) => s.bg(t.hover))
          .on_mouse_down("left", (e, cx) => { this.splitDrag = { y: e.position.y, h: this.commitH }; cx.stop_propagation(); })
          .child(div().w(36).h(4).rounded(2).bg(t.border)))
        .child(div().id("commit-message").w_full().h(this.commitH).flex_none().overflow_hidden().px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.input).w_full().h(this.commitH - 14).text_size(12).text_color(t.foreground)))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().id("generate").h(30).flex_none().rounded(8).overflow_hidden().border_1().border_color(genEnabled ? t.accent : t.border)
            .child(h_flex().id("generate-run").px(12).h_full().items_center().gap(6).text_size(12).text_color(this.generating ? t.accent : genEnabled ? t.accent : t.dim).when(genEnabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.generate(cx)).tooltip(`Write the commit message from the diff with ${modelFor("commit", this.pk)?.name ?? "no model"} (${describe(modelFor("commit", this.pk))})`)
              .child(this.generating ? svg("mods/changes-copy/icons/spinner.svg").size(12).text_color(t.accent).spin(900) : svg("mods/changes-copy/icons/layers.svg").size(12))
              .child(this.generating ? "Generating…" : "Generate"))
            .child(div().id("generate-menu").w(26).h_full().flex().items_center().justify_center().border_l(1).border_color(t.border).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("More").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => openOverlay({ mod: "changes-copy", kind: "popup", width: 300, height: 28 * models().length + 110, props: { menu: true, project: this.pk } })).child(svg("mods/changes-copy/icons/chevron-down.svg").size(12))))
          .child(div().flex_1())
          // Pull and Push as one joined group (like the header's icon groups and Generate): a box, two cells, a divider.
          .child(h_flex().id("sync").h(30).flex_none().rounded(8).overflow_hidden().border_1().border_color(t.border)
            .child(h_flex().id("pull").h_full().px(12).gap(4).items_center().text_size(12)
              .text_color(pullEnabled ? (this.behind > 0 ? t.accent : t.foreground) : t.dim).when(pullEnabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
              .tooltip(!this.root ? "No repository" : !this.upstream ? "No upstream to pull from" : this.behind ? `git pull: ${this.behind} commit${this.behind === 1 ? "" : "s"} from ${this.upstream} (fast-forward, or rebase when diverged)` : `git pull from ${this.upstream}`)
              .on_click((_e, cx) => { if (pullEnabled) this.pull(cx); })
              .child(this.pulling ? svg("mods/changes-copy/icons/spinner.svg").size(12).spin(900) : div())
              .child(`Pull${this.behind > 0 ? ` ↓${this.behind}` : ""}`))
            .child(h_flex().id("push").h_full().px(12).gap(4).items_center().border_l(1).border_color(t.border).text_size(12)
              .text_color(pushEnabled ? (this.ahead > 0 ? t.accent : t.foreground) : t.dim).when(pushEnabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)))
              .tooltip(!this.root ? "No repository" : this.upstream && this.pushNew ? `Tracks ${this.upstream}, another name: git push -u origin HEAD` : this.upstream ? (this.ahead ? `git push: ${this.ahead} commit${this.ahead === 1 ? "" : "s"} to ${this.upstream}` : `Nothing to push: ${this.upstream} is up to date`) : "No upstream yet: git push -u origin HEAD")
              .on_click((_e, cx) => { if (pushEnabled) this.push(cx); })
              .child(this.pushing ? svg("mods/changes-copy/icons/spinner.svg").size(12).spin(900) : div())
              .child(`Push${this.ahead > 0 ? ` ↑${this.ahead}` : ""}`)))
          .child(div().id("commit").h(30).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))));
  }
}
