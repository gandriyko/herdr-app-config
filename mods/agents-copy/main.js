// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, exec, notify, playSound, settings } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
// Own keys are `agents-copy.*`; the shipped mod's `agents.*` value is read once as a fallback.
const getShared = (k) => shared(`agents-copy.${k}`) ?? shared(`agents.${k}`);
const sortOf = () => SORTS.find((s) => s.id === getShared("sort")) ?? SORTS[0];
const REMINDS = [0, 2, 5, 10];
const remindMinutes = () => {
  const m = shared("agents-copy.remind");
  return REMINDS.includes(m) ? m : 5;
};
const PR_FILTERS = [
  { id: "any", label: "Any" },
  { id: "with", label: "Has PR" },
  { id: "failing", label: "Checks failing" },
  { id: "none", label: "No PR" },
];
const filterOf = () => {
  const f = shared("agents-copy.filter");
  return { space: typeof f?.space === "string" ? f.space : null, pr: PR_FILTERS.some((x) => x.id === f?.pr) ? f.pr : "any" };
};
const CHECKS_WORD = { fail: "failing", pass: "passing", pending: "pending", none: "none" };

// One PR's checks as "fail" | "pending" | "pass" | "none" from gh's statusCheckRollup.
function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "STARTUP_FAILURE"].includes(concl) || state === "FAILURE" || state === "ERROR") return "fail";
    if ((c.status && String(c.status).toUpperCase() !== "COMPLETED") || state === "PENDING" || state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}
const MAX_COMMON = 200;
const MAX_REPOS = 30;
const PR_EVERY = 60000;
const NO_PR_EVERY = 5 * 60000;
const DEFAULT_EVERY = 30 * 60000;
const GH_DOWN = 10 * 60000;
const FAIL_RETRY = 5 * 60000;
const SECTION = { 4: "Needs you", 2: "Working", 3: "Done" };
const SECTION_ORDER = { 4: 0, 2: 1, 3: 2 };
const MONO = "Menlo";
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };
// Idle agents join Done; Working holds a parent with a working sub-agent too.
const sectionOf = (r) => (r >= 4 ? 4 : r === 2 ? 2 : 3);
// The report is text, or (from some programs) an object with the text in it.
const reportText = (s) => (typeof s === "string" ? s : "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The board is a separate mod that may be absent: say so instead of failing silently.
function openBoard() {
  let ok = true;
  try {
    ok = run("mod.open", { name: "agents-board" }) !== false;
  } catch {
    ok = false;
  }
  if (!ok) notify({ title: "Agents board isn't installed", body: "Copy mods/agents-board to use it", level: "warning" });
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu || props()?.filterMenu) return;
    this.live = true;
    this.placesKey = "";
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.common = new Map(); // cwd -> git common dir (or "" when not a repo)
    this.repos = new Map(); // common dir -> { cwd, at, next, asked: Set, def, defAt, prs: { branch: { n, c } } }
    this.places = []; // { cwd, branch } of the listed agents
    this.prJson = "{}";
    this.busy = false;
    this.again = false;
    this.ghDownUntil = 0;
    this.blocked = new Map(); // address -> { since, last }
    cx.timer.every(30000, (cx) => {
      if (!this.live) return;
      this.trackBlocked(agents(), Date.now());
      this.remind();
      this.kick(cx);
      cx.notify();
    });
  }

  close(cx) {
    this.live = false;
  }

  // Blocked agents and since when; entries leave with the blocked state or the agent.
  trackBlocked(list, now) {
    const live = new Set();
    for (const a of list) {
      if (a.status !== "blocked") continue;
      live.add(a.address);
      if (!this.blocked.has(a.address)) {
        const c = this.changed[a.address];
        this.blocked.set(a.address, { since: c?.s === "blocked" ? c.at : now, last: 0 });
      }
    }
    for (const k of this.blocked.keys()) if (!live.has(k)) this.blocked.delete(k);
  }

  // Repeats the "needs you" nudge for agents still blocked; one toast per tick.
  remind() {
    const mins = remindMinutes();
    if (!mins || !this.blocked.size) return;
    const now = Date.now();
    const looking = window()?.active ? focused()?.terminal : null;
    const due = [];
    for (const a of agents()) {
      const e = this.blocked.get(a.address);
      if (!e || a.status !== "blocked") continue;
      if (a.address === looking) {
        e.last = now;
        continue;
      }
      const ref = Math.max(e.since, e.last);
      if (now - ref >= mins * 60000) due.push({ a, ref });
    }
    if (!due.length) return;
    due.sort((x, y) => x.ref - y.ref);
    const first = due[0].a;
    const one = due.length === 1;
    const short = clean(first.title).slice(0, 80);
    notify({
      title: one ? `Still waiting: ${first.space_name} / ${first.tab_name}` : `${due.length} agents still waiting`,
      body: one ? [first.program?.name, short].filter(Boolean).join(" \u00b7 ") : due.slice(0, 3).map((d) => d.a.space_name).join(", "),
      level: "warning",
      action: { name: "pane.focus", args: { terminal: first.address } },
    });
    if (settings()?.sounds?.enabled !== false) playSound("blocked");
    for (const d of due) this.blocked.get(d.a.address).last = now;
  }

  // Asks for the open PRs of repos that are due, one gh call at a time. A request
  // while one runs makes one more pass after it.
  kick(cx) {
    if (!this.live) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    if (Date.now() < this.ghDownUntil || !this.places.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          await this.refresh();
          if (!this.live) return;
          const json = JSON.stringify(this.prMap());
          if (json !== this.prJson) {
            this.prJson = json;
            cx.notify();
          }
        } while (this.again && this.live);
      } finally {
        this.busy = false;
      }
    });
  }

  // { common dir: { branch: { n, c } } } of what is shown, for compare and lookup.
  prMap() {
    const out = {};
    for (const [k, r] of this.repos) if (Object.keys(r.prs).length) out[k] = r.prs;
    return out;
  }

  async refresh() {
    const places = this.places.slice();
    const byRepo = new Map();
    for (const p of places) {
      if (!this.live) return;
      let c = this.common.get(p.cwd);
      if (c === undefined) {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: p.cwd, timeout: 5000 }).catch(() => null);
        c = r?.code === 0 ? r.stdout.trim() : "";
        if (this.common.size >= MAX_COMMON) this.common.delete(this.common.keys().next().value);
        this.common.set(p.cwd, c);
      }
      if (!c) continue;
      const e = byRepo.get(c) ?? { cwd: p.cwd, branches: new Set() };
      if (p.branch) e.branches.add(p.branch);
      byRepo.set(c, e);
    }
    const now = Date.now();
    for (const [key, e] of byRepo) {
      if (!this.live || now < this.ghDownUntil) return;
      let r = this.repos.get(key);
      if (!r) {
        if (this.repos.size >= MAX_REPOS) this.repos.delete(this.repos.keys().next().value);
        r = { cwd: e.cwd, at: 0, next: 0, asked: new Set(), prs: {}, def: null, defAt: 0 };
        this.repos.set(key, r);
      }
      r.cwd = e.cwd;
      // The repo's default branch (git's origin/HEAD), re-read every 30 min; a failure means main/master only.
      if (!r.defAt || now - r.defAt > DEFAULT_EVERY) {
        const d = await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: r.cwd, timeout: 5000 }).catch(() => null);
        if (!this.live) return;
        r.def = d?.code === 0 ? d.stdout.trim().replace(/^origin\//, "") || null : null;
        r.defAt = Date.now();
      }
      // Only a feature branch can have a PR; no candidates, no gh call.
      const cands = [...e.branches].filter((b) => b && b !== "HEAD" && b !== "main" && b !== "master" && b !== r.def);
      if (!cands.length) {
        r.prs = {};
        r.asked = new Set();
        r.next = 0;
        continue;
      }
      const novel = cands.some((b) => !r.asked.has(b));
      if (!novel && now < r.next) continue;
      const start = Date.now();
      const res = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,statusCheckRollup"], { cwd: r.cwd, timeout: 15000 }).catch(() => null);
      if (!this.live) return;
      const at = Date.now();
      r.at = at;
      r.asked = new Set(cands);
      if (!res) {
        // gh isn't installed (or the folder is gone): no chips, ask again in 10 minutes.
        this.ghDownUntil = at + GH_DOWN;
        for (const x of this.repos.values()) x.prs = {};
        return;
      }
      if (res.code !== 0) {
        if (/auth login|not logged|GH_TOKEN|authenticat/i.test(res.stderr)) {
          this.ghDownUntil = at + GH_DOWN;
          for (const x of this.repos.values()) x.prs = {};
          return;
        }
        // Not a GitHub repo, offline: keep the last good answer, try again later.
        r.next = at + FAIL_RETRY;
        continue;
      }
      try {
        const prs = {};
        for (const pr of JSON.parse(res.stdout)) prs[pr.headRefName] = { n: pr.number, c: checksOf(pr.statusCheckRollup) };
        r.prs = prs;
        // From when gh started, with slack so the 30 s tick lands on the mark; a PR on a candidate branch is checked every 60 s, none every 5 min.
        r.next = start + (cands.some((b) => prs[b]) ? PR_EVERY : NO_PR_EVERY) - 2000;
      } catch {
        r.next = at + FAIL_RETRY;
      }
    }
  }

  // The PR chip's data for an agent's place, or null.
  prOf(place) {
    if (!place) return null;
    const c = this.common.get(place.cwd);
    return (c && place.branch && this.repos.get(c)?.prs[place.branch]) || null;
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents-copy.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/agents-copy/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/agents-copy/check.svg").size(14).flex_none().text_color(t.foreground)))))
      .child(div().h(1).my(4).bg(t.border))
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Remind while waiting"))
      .children(REMINDS.map((m) => this.menuRow(t, `remind-${m}`, m ? `${m} min` : "Off", remindMinutes() === m, () => setShared("agents-copy.remind", m))));
  }

  menuRow(t, id, label, on, click) {
    return h_flex()
      .id(id)
      .h(31)
      .px(8)
      .gap(9)
      .rounded(7)
      .items_center()
      .flex_none()
      .text_color(t.foreground)
      .hover((el) => el.bg(t.hover))
      .on_click(click)
      .child(div().flex_1().truncate().child(label))
      .when(on, (el) => el.child(svg("mods/agents-copy/check.svg").size(14).flex_none().text_color(t.foreground)));
  }

  filterMenu(t) {
    const f = filterOf();
    const list = spaces();
    const space = list.some((s) => s.id === f.space) ? f.space : null;
    const set = (patch) => setShared("agents-copy.filter", { space, pr: f.pr, ...patch });
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Space"))
      .child(this.menuRow(t, "fl-all", "All spaces", space === null, () => set({ space: null })))
      .children(list.map((s) => this.menuRow(t, `fl-${s.id}`, s.name, space === s.id, () => set({ space: s.id }))))
      .child(div().h(1).my(4).bg(t.border))
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Pull request"))
      .children(PR_FILTERS.map((x) => this.menuRow(t, `fl-pr-${x.id}`, x.label, f.pr === x.id, () => set({ pr: x.id }))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(15)
      .pr(0)
      .rounded(6)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address);
      })
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/agents-copy/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.filterMenu) return this.filterMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    const allPanes = panes();
    const spaceList = spaces();
    this.trackBlocked(list, Date.now());
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const termBy = new Map(all.map((k) => [k.address, k]));
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));

    // Where each agent is (its pane's folder and branch, else its space's) for PR chips and the filter.
    const paneBy = new Map(allPanes.map((p) => [p.pane, p]));
    const spaceBy = new Map(spaceList.map((s) => [s.id, s]));
    const placeOf = new Map();
    for (const a of list) {
      if (a.address.includes("/")) continue; // another machine: no local gh
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const cwd = p?.cwd || sp?.folder;
      if (cwd) placeOf.set(a.address, { cwd, branch: p?.branch ?? sp?.branch ?? null });
    }
    this.places = [...placeOf.values()];
    const placesKey = JSON.stringify(this.places);
    if (placesKey !== this.placesKey) {
      this.placesKey = placesKey;
      if (!collapsed) this.kick(cx);
    }
    const prFor = (a) => this.prOf(placeOf.get(a.address));

    // The filter, before grouping. A space that's gone counts as none.
    const fl = filterOf();
    const flSpace = spaceBy.has(fl.space) ? fl.space : null;
    const flActive = flSpace !== null || fl.pr !== "any";
    const unfiltered = list.length;
    if (flActive) {
      list = list.filter((a) => {
        if (flSpace && a.space !== flSpace) return false;
        const pr = prFor(a);
        return fl.pr === "any" || (fl.pr === "with" ? Boolean(pr) : fl.pr === "failing" ? pr?.c === "fail" : !pr);
      });
    }
    const clearFilter = () => setShared("agents-copy.filter", { space: null, pr: "any" });
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => SECTION_ORDER[sectionOf(rankOf(x) || RANK.idle)] - SECTION_ORDER[sectionOf(rankOf(y) || RANK.idle)] || rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      return [row(a, i, subs)];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/agents-copy/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(allPanes);
    const tabs = new Map(spaceList.flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const PR_COLOR = { fail: t.blocked, pass: t.done, pending: t.working, none: t.muted };
    const prChip = (a, pr) => {
      const color = PR_COLOR[pr.c];
      const cwd = placeOf.get(a.address)?.cwd;
      return h_flex()
        .id(`pr-${a.address}`)
        .flex_none()
        .h(18)
        .px(5)
        .gap(3)
        .rounded(5)
        .items_center()
        .bg(color + "26")
        .text_size(10.5)
        .font_medium()
        .text_color(color)
        .cursor_pointer()
        .hover((el) => el.bg(color + "40"))
        .tooltip(`PR #${pr.n} \u00b7 checks ${CHECKS_WORD[pr.c]}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          exec("gh", ["pr", "view", String(pr.n), "--web"], { cwd, timeout: 10000 }).catch(() => {});
        })
        .child(`#${pr.n}`)
        .when(pr.c === "pass", (el) => el.child(svg("mods/agents-copy/check.svg").size(10).flex_none()))
        .when(pr.c === "fail", (el) => el.child(svg("mods/agents-copy/x.svg").size(10).flex_none()))
        .when(pr.c === "pending", (el) => el.child(svg("mods/agents-copy/spinner.svg").size(10).flex_none().spin(900)));
    };

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/agents-copy/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const hover = (el) => el
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }));
      const timeOrPin = this.hovered === a.address ? pin : Boolean(when) ? div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(duration(now - when)) : null;
      const picFold = (p) => div().id(`agent-fold-${a.address}`)
        .when(subs.length > 0, (el) => el.on_click((_e, cx) => {
          cx.stop_propagation();
          this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
          cx.notify();
        })).child(p);

      // Idle with nothing urgent below: one dimmed line, no report, no dot.
      if (a.status === "idle" && !(urgency.get(a.address) > RANK.idle) && subs.length === 0) {
        const dimPic = icon(a.program, 16, t.dim);
        return hover(h_flex()
          .id(`ag-${a.address}`)
          .px(8)
          .h(26)
          .flex_none()
          .mb(2)
          .rounded(7)
          .items_center()
          .gap(7)
          .text_size(12)
          .when(a.focused, (el) => el.bg(t.selected))
          .cursor_pointer()
          .hover((s) => s.bg(t.hover)))
          .when(Boolean(dimPic), (el) => el.child(picFold(dimPic)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(more ? `${name} / ${more}` : name))
          .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
          .when(Boolean(timeOrPin), (el) => el.child(timeOrPin));
      }

      const blocked = a.status === "blocked";
      const term = termBy.get(a.address);
      const tabInfo = tabs.get(a.tab);
      const prog = a.program?.name ?? "";
      // Line 2: the report, else the agent's title, else the tab name; never the bare program name.
      let report = reportText(term?.report) || reportText(a.title) || (tabInfo?.name ?? "").trim();
      if (report.toLowerCase() === prog.trim().toLowerCase()) report = "";
      // Line 1 names the tab only when a person named it and it says something new.
      const tabName = tabInfo?.named ? (tabInfo.name ?? "").trim() : "";
      let lead = full && a.space_name ? a.space_name : null;
      let tabTxt = tabName && tabName.toLowerCase() !== report.trim().toLowerCase() && tabName.toLowerCase() !== prog.trim().toLowerCase() ? tabName : null;
      if (!lead) { lead = tabTxt ?? (prog || label(a)); if (tabTxt) tabTxt = null; }
      const pr = prFor(a);
      return hover(v_flex()
        .id(`ag-${a.address}`)
        .p(8)
        .gap(4)
        .flex_none()
        .mb(5)
        .rounded(7)
        .border(1)
        .border_color(blocked ? t.blocked + "55" : t.border)
        .bg(blocked ? t.blocked + "14" : a.focused ? t.selected : t.raised)
        .cursor_pointer()
        .hover((s) => s.bg(blocked ? t.blocked + "22" : t.hover)))
        .child(h_flex()
          .gap(7)
          .items_center()
          .when(Boolean(pic), (el) => el.child(picFold(pic)))
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
            .child(div().min_w(0).max_w(tabTxt ? 120 : 200).truncate().text_color(t.foreground).when(a.status === "done", (el) => el.font_semibold()).when(a.status !== "done", (el) => el.font_medium()).child(lead))
            .when(Boolean(tabTxt), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`/ ${tabTxt}`))))
          .when(Boolean(machine), (el) => el.child(div().text_size(10).text_color(t.dim).child(machine)))
          .when(subs.length > 0, (el) => el.child(fold(a, subs)))
          .when(a.status === "working", (el) => el.child(this.status(t, a)))
          .when(a.status === "done", (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.accent)))
          .when(Boolean(timeOrPin), (el) => el.child(timeOrPin)))
        .when(Boolean(report), (el) => el.child(div().pl(23).min_w(0).truncate().text_size(12).text_color(blocked ? t.blocked : t.dim).child(report)))
        .when(Boolean(pr), (el) => el.child(h_flex().pl(23).child(prChip(a, pr))))
        .when(subs.length > 0 && !this.folded.has(a.address), (el) => el.children(subs.map((x) => this.subRow(t, x, shown, byPriority))));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = byPriority ? sectionOf(rankOf(a) || RANK.idle) : 0;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(byPriority ? 10 : 8)
        .h(byPriority ? 32 : 30)
        .flex_none()
        .gap(byPriority ? 7 : 6)
        .items_center()
        .text_size(byPriority ? 12 : 11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(byPriority && Boolean(g.status), (el) => el.child(div().flex_none().size(8).rounded(4).bg(t[g.status])))
        .child(div().truncate().text_color(byPriority ? t.foreground : t[g.status] ?? t.dim).when(byPriority, (el) => el.font_semibold()).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/agents-copy/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .when(flActive, (el) => el.child(h_flex()
                  .id("ag-filter-chip")
                  .h(18)
                  .pl(6)
                  .pr(3)
                  .gap(3)
                  .max_w(150)
                  .rounded(5)
                  .items_center()
                  .bg(t.accent + "26")
                  .text_size(10.5)
                  .text_color(t.accent)
                  .child(div().min_w(0).truncate().child([flSpace ? spaceBy.get(flSpace).name : null, fl.pr === "any" ? null : PR_FILTERS.find((x) => x.id === fl.pr).label.toLowerCase().replace("checks ", "")].filter(Boolean).join(" \u00b7 ")))
                  .child(div()
                    .id("ag-filter-clear")
                    .flex_none()
                    .p(2)
                    .rounded(3)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover))
                    .tooltip("Clear filter")
                    .on_click(clearFilter)
                    .child(svg("mods/agents-copy/x.svg").size(10)))))
                .when(!collapsed, (el) => el.child(
                  div()
                    .id("ag-board")
                    .text_size(11)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .on_click(openBoard)
                    .tooltip("Agents board (\u2318\u21e7A)")
                    .child(svg("mods/agents-copy/columns.svg").size(14)),
                ))
                .child(
                  div()
                    .id("ag-filter")
                    .text_size(11)
                    .text_color(flActive ? t.accent : t.dim)
                    .hover((s) => s.text_color(flActive ? t.accent : t.foreground))
                    .on_click(() => openOverlay({ mod: "agents-copy", kind: "popup", width: 220, height: Math.min(560, 190 + 31 * (spaceList.length + 5)), props: { filterMenu: true } }))
                    .tooltip("Filter agents")
                    .child(svg("mods/agents-copy/filter.svg").size(14)),
                )
                .child(
                  div()
                    .id("ag-sort")
                    .text_size(11)
                    .text_color(t.dim)
                    .hover((s) => s.text_color(t.foreground))
                    .on_click(() => openOverlay({ mod: "agents-copy", kind: "popup", width: 200, height: 280, props: { sortMenu: true } }))
                    .tooltip(`Sort agents: ${sort.label}`)
                    .child(svg(`mods/agents-copy/${sort.icon}.svg`).size(14)),
                ),
            ),
        ),
      )
      .when(list.length === 0 && unfiltered > 0 && !collapsed, (el) =>
        el.child(h_flex().px(12).py(6).gap(6).text_size(12).text_color(t.dim)
          .child("No agents match the filter")
          .child(div().id("ag-filter-none").cursor_pointer().text_color(t.accent).hover((s) => s.text_color(t.foreground)).on_click(clearFilter).child("Clear"))),
      )
      .when(unfiltered === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
