// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { AskingTracker } from "./asking.js";
import { lastMessage } from "./last.js";
import { dropKey, headline } from "./headline.js";
import { PR_FILTERS, duration, glyph, icon, prColor } from "./card.js";
import { CHECKS_WORD, RECHECK, askAgain, branchKey, jiraProjects, keysIn, namedKey, newPrState, prMap, prOf, refreshPrs } from "./prs.js";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, hc, openOverlay, closeOverlay, props, window, layout, exec, notify, playSound, settings } from "herdr";

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

// Drops what an agent puts before its title: a status glyph or spinner and the separator
// after it ("✦  Working", "⠋ - Thinking"), and Codex's blinking "[ ! ] " / "[ . ] " mark.
// Stops at an opening bracket or quote, so a title that starts with one ("[web] login") keeps it,
// and at an emoji ("🔴 login", "❤️ deploy"), except for known status marks.
const clean = (s) => (s ?? "").replace(/^(?:\[ [!.] \] |[✋⏳]️?(?=\s)|(?!(?:\p{Emoji}️|[#*]⃣))[^\p{L}\p{N}\p{Ps}\p{Pi}\p{Emoji_Presentation}])+/u, "").trim();

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
// A kept sub-agent (one with a pane) is in agents() too: it keeps its own status, done included.
const kidStatus = (k, listed) => {
  if (listed.has(k.address)) return listed.get(k.address);
  const s = k.status;
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
const filterOf = () => {
  const f = shared("agents-copy.filter");
  return { space: typeof f?.space === "string" ? f.space : null, pr: PR_FILTERS.some((x) => x.id === f?.pr) ? f.pr : "any" };
};
const SECTION = { 4: "Needs you", 2: "Working", 3: "Done" };
const SECTION_ORDER = { 4: 0, 2: 1, 3: 2 };
const MONO = "Menlo";
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };
// Idle agents join Done; Working holds a parent with a working sub-agent too.
const sectionOf = (r) => (r >= 4 ? 4 : r === 2 ? 2 : 3);
// The report is text, or (from some programs) an object with the text in it.
const reportText = (s) => (typeof s === "string" ? s : "").replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

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
    this.pr = newPrState(); // open PRs per repo (./prs.js)
    this.places = []; // { cwd, branch, key } of the listed agents
    this.wasWorking = new Set(); // addresses working at the last render
    this.prJson = "{}";
    this.busy = false;
    this.again = false;
    this.blocked = new Map(); // address -> { since, last }
    // Agents finished on a menu or a question count as blocked; one screen read per turn.
    this.asking = new AskingTracker(hc, () => this.live);
    // Quick search: the header's magnifier opens a box under it; text filters by program, space, tab, title, report.
    this.q = "";
    this.searchOpen = false;
    this.expandSeq = 0;
    this.expanded = null; // the card opened with its eye button
    this.expandKey = null;
    this.expandBusy = false;
    this.expandAgain = false;
    this.lastMsg = null; // { address, loading?, failed?, msg } for the open card; dropped on collapse
    this.search = InputState.new({ placeholder: "Search agents" });
    this.search.on("change", (_e, cx) => {
      this.q = this.search.value().trim().toLowerCase();
      cx.notify();
    });
    cx.timer.every(30000, (cx) => {
      if (!this.live) return;
      const list = this.asking.apply(agents(), terminals(), cx);
      this.trackBlocked(list, Date.now());
      this.remind(list);
      this.kick(cx);
      cx.notify();
    });
  }

  close(cx) {
    this.live = false;
    this.search?.release();
  }

  // Opens the search box and focuses it, or closes and clears it.
  toggleSearch(cx) {
    this.searchOpen = !this.searchOpen;
    if (this.searchOpen) this.search.focus();
    else {
      this.search.set_value("");
      this.q = "";
    }
    cx.notify();
  }

  // The eye button: expands one card with the last message on its screen (one read per click), or
  // collapses it. A press anywhere outside the open card, or going to an agent, collapses it too.
  toggleExpand(addr, cx) {
    const seq = ++this.expandSeq;
    if (this.expanded === addr) {
      this.expanded = null;
      this.lastMsg = null;
      return cx.notify();
    }
    this.expanded = addr;
    this.lastMsg = { address: addr, loading: true, msg: null, key: null };
    this.expandKey = null; // set by render: the agent's turn|status; a change re-reads
    cx.notify();
    this.readExpanded(addr, seq, cx);
  }

  // Reads the open card's screen. One read at a time; a turn/status change meanwhile reads once more.
  // The last good message stays shown during a re-read and after a failed one.
  readExpanded(addr, seq, cx) {
    if (this.expandBusy) return void (this.expandAgain = true);
    this.expandBusy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.expandAgain = false;
          const key = this.expandKey;
          let msg = null;
          let failed = false;
          try {
            const r = await hc(["read", addr, "--lines", "0"]);
            if (r?.code === 0) msg = lastMessage(r.stdout);
            else failed = true;
          } catch {
            failed = true;
          }
          if (!this.live || seq !== this.expandSeq || this.expanded !== addr) return;
          const prev = this.lastMsg;
          const next = failed && prev?.msg ? { ...prev, loading: false, key } : { address: addr, msg, failed, key };
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            this.lastMsg = next;
            cx.notify();
          }
        } while (this.expandAgain && this.live && seq === this.expandSeq);
      } finally {
        this.expandBusy = false;
      }
    });
  }

  collapse(cx) {
    if (!this.expanded) return;
    this.expandSeq++;
    this.expanded = null;
    this.lastMsg = null;
    cx.notify();
  }

  // Going to an agent ends the search: the box closes and its text is cleared.
  endSearch(cx) {
    if (this.searchOpen) this.toggleSearch(cx);
  }

  // A sub-agent without a pane (started with `hc run`) first gets one (terminal.keep, which the core
  // may apply a moment later), then it is focused; if no pane shows up it is peeked instead.
  openSub(addr, cx) {
    try {
      run("terminal.keep", { terminal: addr });
    } catch {
      return this.peek(addr);
    }
    const attempt = (n) =>
      cx.timer.after(n ? 1200 : 400, () => {
        if (!this.live) return;
        if (panes().some((p) => p.terminal === addr)) run("pane.focus", { terminal: addr });
        else if (n) this.peek(addr);
        else attempt(1);
      });
    attempt(0);
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
  remind(list) {
    const mins = remindMinutes();
    if (!mins || !this.blocked.size) return;
    const now = Date.now();
    const looking = window()?.active ? focused()?.terminal : null;
    const due = [];
    for (const a of list) {
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
    if (Date.now() < this.pr.ghDownUntil || !this.places.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          await refreshPrs(this.pr, this.places.slice(), exec, () => this.live);
          if (!this.live) return;
          const json = JSON.stringify(prMap(this.pr));
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

  // Live sub-agents of `addr`, depth first, each with its depth (0 = a direct child).
  // `kidsBy`: parent address -> its live terminals, built once per render.
  tree(kidsBy, addr, depth = 0) {
    return (kidsBy.get(addr) ?? []).flatMap((k) => [{ t: k, depth }, ...this.tree(kidsBy, k.address, depth + 1)]);
  }

  // The eye button of a card or a sub-agent row: shows or hides that agent's last message.
  eyeBtn(t, addr) {
    const open = this.expanded === addr;
    return div()
      .id(`ag-eye-${addr}`)
      .flex_none()
      .p(2)
      .rounded(4)
      .text_color(open ? t.accent : t.dim)
      .hover((s) => s.bg(t.hover).text_color(open ? t.accent : t.foreground))
      .tooltip(open ? "Hide last message" : "Show last message")
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleExpand(addr, cx);
      })
      .child(svg("mods/agents-copy/eye.svg").size(13));
  }

  // The open last message (this.lastMsg) in a box, or null when `addr` isn't the open one.
  msgBox(t, addr) {
    const open = this.expanded === addr ? this.lastMsg : null;
    if (!open) return null;
    return v_flex().mt(2).p(6).gap(2).rounded(5).bg(t.background).border_1().border_color(t.border).max_h(240).overflow_hidden()
      .when(Boolean(open.msg), (el) => el
        .child(div().text_size(10).font_semibold().text_color(open.msg.who === "you" ? t.accent : t.dim).child(open.msg.who === "you" ? "YOU" : "AGENT"))
        .children(open.msg.text.split("\n").map((l) => div().text_size(11).line_height("15px").text_color(t.muted).child(l || " "))))
      .when(!open.msg, (el) => el.child(div().text_size(11).text_color(t.dim).child(open.loading ? "Loading…" : open.failed ? "Could not read the screen" : "No message on screen")));
  }

  // An agent card from its parts; `small` is the sub-agent size. Both cards share this layout:
  // icon with the status glyph under it, line 1 (title … right), line 2 (report, eye), message box, bottom row.
  card(t, o) {
    const sz = o.small ? { pad: [5, 7], gap: 3, col: 14, colGap: 4, title: 12, report: 11.5, lh: 15 } : { pad: [8, 9], gap: 4, col: 16, colGap: 6, report: 12, lh: 17 };
    const { blocked, focused } = o;
    return v_flex()
      .id(o.id)
      .py(sz.pad[0])
      .px(sz.pad[1])
      .gap(sz.gap)
      .flex_none()
      .rounded(o.small ? 6 : 7)
      .border(1)
      // The agent being worked with: the selected fill, border in the same colour, as the shipped agents list does
      // (its border wins over blocked's; blocked keeps its tint). Other cards are outlined only.
      .border_color(focused ? t.selected : blocked ? t.blocked + "66" : t.border)
      .bg(blocked ? t.blocked + "14" : focused ? t.selected : t.background + "00")
      .cursor_pointer()
      .hover((s) => s.bg(blocked ? t.blocked + "22" : t.hover))
      .child(h_flex()
        .gap(o.small ? 6 : 7)
        .items_start()
        .child(v_flex().flex_none().w(sz.col).gap(sz.colGap).items_center()
          .when(Boolean(o.pic), (el) => el.child(o.pic))
          // The glyph slot only with a glyph: a card with nothing more to show stays one line high.
          .when(Boolean(o.glyph), (el) => el.child(div().flex_none().w(16).h(16).flex().items_center().justify_center().child(o.glyph))))
        .child(v_flex().flex_1().min_w(0).gap(sz.gap)
          .child(h_flex()
            .gap(7)
            // Time, pin and eye stay at the top when the headline wraps to two lines.
            .items_start()
            .when(Boolean(o.small), (el) => el.text_size(sz.title))
            .child(h_flex().flex_1().min_w(0).gap(5).items_center().children(o.title.filter(Boolean)))
            .children(o.right.filter(Boolean))
            // No line 2: the eye sits at the end of line 1 instead of on an empty row.
            .when(!o.report && Boolean(o.eye), (el) => el.child(o.eye)))
          // The git branch, main included: always its own dim line under line 1.
          .when(Boolean(o.branch), (el) => el.child(div().min_w(0).truncate().text_size(11).line_height("13px").text_color(t.dim).child(o.branch)))
          .when(Boolean(o.report), (el) => el.child(h_flex().gap(4).items_start()
            .child(div().flex_1().min_w(0).max_h(sz.lh * 2).overflow_hidden().text_size(sz.report).line_height(`${sz.lh}px`).text_color(o.reportOn ? (blocked ? t.blocked : t.muted) : t.dim).child(o.report))
            .when(Boolean(o.eye), (el) => el.child(o.eye))))
          .when(Boolean(o.box), (el) => el.child(o.box))
          .when(Boolean(o.bottom), (el) => el.child(o.bottom))));
  }

  // A sub-agent as a small card: the same layout as its parent's, indented by depth.
  subRow(t, s, shown, now) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const when = this.since(k);
    const prog = k.program?.name ?? "";
    let report = reportText(k.report) || reportText(k.title);
    if (report.toLowerCase() === prog.trim().toLowerCase()) report = "";
    return this.card(t, {
      id: `sub-${k.address}`,
      small: true,
      blocked: st === "blocked",
      focused: k.address === shown,
      pic: icon(k.program, 14, t.foreground),
      glyph: glyph(t, st, "mods/agents-copy/"),
      title: [div().min_w(0).truncate().text_color(t.foreground).font_semibold().child(k.name || k.template || prog || k.address)],
      right: [when && div().flex_none().whitespace_nowrap().text_size(11).text_color(st === "blocked" ? t.blocked : t.dim).child(duration(now - when))],
      report: report || prog || k.address,
      reportOn: Boolean(report),
      eye: !k.address.includes("/") && this.eyeBtn(t, k.address),
      box: this.msgBox(t, k.address),
    })
      .ml(s.depth * 12)
      .when(this.expanded === k.address, (el) => el.on_mouse_down_out((_e, cx) => this.collapse(cx)))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.collapse(cx);
        this.endSearch(cx);
        this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.openSub(k.address, cx);
      });
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
    const all = terminals();
    let list = this.asking.apply(agents(), all, cx);
    const allPanes = panes();
    const spaceList = spaces();
    this.trackBlocked(list, Date.now());
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    // The open card follows its agent: a new turn or status re-reads its screen (render reruns on those).
    if (this.expanded) {
      const term = all.find((k) => k.address === this.expanded);
      // A sub-agent without a pane isn't in agents(): its terminal's status instead.
      const key = `${term?.turn}|${this.listed.get(this.expanded) ?? term?.status}`;
      if (this.expandKey === null) this.expandKey = key; // the first read is already running
      else if (key !== this.expandKey) {
        this.expandKey = key;
        this.readExpanded(this.expanded, this.expandSeq, cx);
      }
    }
    this.migratePins(all);
    const termBy = new Map(all.map((k) => [k.address, k]));
    const shown = focused()?.agent;
    const now = Date.now();
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    // One pass over the terminals, and each agent's tree once per render (it's needed three times below).
    const kidsBy = new Map();
    for (const k of all) if (k.parent && k.state === "live") kidsBy.set(k.parent, [...(kidsBy.get(k.parent) ?? []), k]);
    // Sub-agents without a pane get their time in state stamped too (their row shows it).
    const paneless = [...kidsBy.values()].flat().filter((k) => !this.listed.has(k.address)).map((k) => ({ address: k.address, status: kidStatus(k, this.listed) }));
    this.track([...list, ...paneless], now);
    const trees = new Map();
    const treeOf = (addr) => trees.get(addr) ?? trees.set(addr, this.tree(kidsBy, addr)).get(addr);
    const nested = new Set(collapsed ? [] : list.flatMap((a) => treeOf(a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));

    // Where each agent is (its pane's folder and branch, else its space's) for PR chips and the filter.
    const paneBy = new Map(allPanes.map((p) => [p.pane, p]));
    const spaceBy = new Map(spaceList.map((s) => [s.id, s]));
    const textOf = (a) =>
      [a.title, a.tab_name, a.name, termBy.get(a.address)?.report, termBy.get(a.address)?.title].filter(Boolean).join("\n").toUpperCase();
    // contract: jira.settings is written by the jira mod ({ site: "https://x.atlassian.net", project: "DA, OPS", … }); optional.
    const jiraSet = shared("jira.settings");
    const jiraSite = jiraSet?.site;
    // Keys in the agent's texts count only for the saved projects; any when none is saved.
    const projects = jiraProjects(jiraSet);
    // The Jira key the agent names (its own task, even on a branch another agent made), or null;
    // the branch's key when the agent mentions it anywhere (namedKey).
    const textKey = (a, branch) => namedKey(textOf(a), projects, branch);
    const placeOf = new Map();
    for (const a of list) {
      if (a.address.includes("/")) continue; // another machine: no local gh
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const cwd = p?.cwd || sp?.folder;
      const branch = p?.branch ?? sp?.branch ?? null;
      if (cwd) placeOf.set(a.address, { cwd, branch, key: textKey(a, branch) });
    }
    this.places = [...placeOf.values()];
    const placesKey = JSON.stringify(this.places);
    if (placesKey !== this.placesKey) {
      this.placesKey = placesKey;
      if (!collapsed) this.kick(cx);
    }
    // Agents sharing a folder and branch share its PR. When the branch names a Jira key (DA-20457) and some
    // of those agents mention it (title, report, tab, name), only they get the chip; if none does, those that
    // mention another Jira key (DA-20409 on branch DA-20473-…) lose it and the rest keep it.
    const placeKey = (p) => p && `${p.cwd}\n${p.branch}`;
    const byPlace = new Map();
    for (const a of list) {
      const k = placeKey(placeOf.get(a.address));
      if (k) byPlace.set(k, [...(byPlace.get(k) ?? []), a]);
    }
    const mentions = (a, key) => textOf(a).includes(key);
    // Only keys of the saved projects count (AP-30085 in a title is not another task when the project is DA).
    const mentionsOther = (a, key) => keysIn(textOf(a)).some((k) => k !== key && (!projects.length || projects.includes(k.split("-")[0])));
    // An agent with no PR chip that stops working may have just opened a PR: ask its repo now and once more
    // RECHECK later (askAgain in ./prs.js).
    const working = new Set(list.filter((a) => a.status === "working").map((a) => a.address));
    let stopped = false;
    for (const ad of this.wasWorking) if (!working.has(ad) && askAgain(this.pr, placeOf.get(ad))) stopped = true;
    this.wasWorking = working;
    if (stopped && !collapsed) { this.kick(cx); cx.timer.after(RECHECK + 1000, (cx) => this.kick(cx)); }
    // The Jira key of the agent's branch, when the rule above gives it to this agent (else null).
    const keyFor = (a) => {
      const p = placeOf.get(a.address);
      const key = branchKey(p?.branch);
      const mates = key ? byPlace.get(placeKey(p)) ?? [] : [];
      if (!key || mates.length < 2) return key ?? null;
      if (mates.some((m) => mentions(m, key))) return mentions(a, key) ? key : null;
      return mentionsOther(a, key) ? null : key;
    };
    // An agent that names a Jira key gets the PR of that key's branch (prOf); the others share the branch's PR by the rule above.
    const prFor = (a) => {
      const p = placeOf.get(a.address);
      const pr = prOf(this.pr, p);
      return pr && (p.key || !branchKey(p.branch) || keyFor(a)) ? pr : null;
    };
    // The Jira chip (only with a site): the key the agent names, else its branch's key.
    const jiraFor = (a) => (placeOf.get(a.address)?.key ?? textKey(a)) ?? keyFor(a);

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
    // Search: an agent matches by its own texts or a sub-agent's name.
    const q = this.searchOpen ? this.q : "";
    if (q) {
      const text = (k) => [k.name, k.template, k.program?.name, k.title, k.report];
      list = list.filter((a) =>
        [...text(a), ...text(termBy.get(a.address) ?? {}), a.space_name, a.tab_name, ...treeOf(a.address).flatMap((s) => text(s.t))]
          .filter(Boolean).join("\n").toLowerCase().includes(q));
    }
    const clearFilter = () => setShared("agents-copy.filter", { space: null, pr: "any" });
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    // A helper's done is its own row's news: it doesn't pull a working parent out of Working.
    const kidRank = (k) => { const s = kidStatus(k, this.listed); return RANK[s === "done" ? "idle" : s] ?? 0; };
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...treeOf(a.address).map((s) => kidRank(s.t)))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => SECTION_ORDER[sectionOf(rankOf(x) || RANK.idle)] - SECTION_ORDER[sectionOf(rankOf(y) || RANK.idle)] || rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    // Grouped view: worktrees of one repo (same git common dir, resolved for PR chips) share a group,
    // named after the repo's folder; other agents group by space. Not after a space whose folder is the repo:
    // a space's folder is only where it started, so it named groups after unrelated spaces (and two groups alike).
    const groupOf = new Map();
    for (const a of list) {
      const c = this.pr.common.get(placeOf.get(a.address)?.cwd);
      if (!c) { groupOf.set(a.address, { id: `sp-${a.space}`, label: a.space_name || "" }); continue; }
      groupOf.set(a.address, { id: `rp-${c}`, label: c.replace(/\/\.git\/?$/, "").split("/").pop() });
    }
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    if (!byPriority) {
      // Stable sort: a group sits where its first agent was; inside it, agents keep their order.
      const first = new Map();
      rest.forEach((a, i) => first.has(groupOf.get(a.address).id) || first.set(groupOf.get(a.address).id, i));
      rest.sort((x, y) => first.get(groupOf.get(x.address).id) - first.get(groupOf.get(y.address).id));
    }
    list = [...pinned, ...rest];
    // Only when the order changed: the host keeps it (in memory) between calls.
    const order = list.map((a) => a.address);
    if (order.join("\n") !== this.order) {
      this.order = order.join("\n");
      setAgentOrder(order);
    }

    const withKids = (a, i) => {
      const subs = collapsed ? [] : treeOf(a.address);
      if (!subs.length || this.folded.has(a.address)) return [row(a, i, subs)];
      // Sub-agents right under the parent's card, the same 5 px apart as the cards, indented so they
      // read as the card's; each one a small card, deeper ones indented more.
      return [row(a, i, subs), v_flex().ml(12).mb(5).gap(5).flex_none()
        .children(subs.map((x) => this.subRow(t, x, shown, now)))];
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

    const PR_COLOR = prColor(t);
    // A small pill in line 1 (PR, Jira): tinted by color, a click runs act without reaching the card.
    const chip = (id, color, tip, act) => h_flex()
      .id(id)
      .flex_none()
      .h(16)
      .px(5)
      .gap(3)
      .rounded(4)
      .items_center()
      .bg(color + "26")
      .text_size(10.5)
      .font_medium()
      .text_color(color)
      .cursor_pointer()
      .hover((el) => el.bg(color + "40"))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); act(); });
    const prChip = (a, pr) => {
      const cwd = placeOf.get(a.address)?.cwd;
      return chip(`pr-${a.address}`, PR_COLOR[pr.c], `PR #${pr.n} \u00b7 checks ${CHECKS_WORD[pr.c]}`,
        () => exec("gh", ["pr", "view", String(pr.n), "--web"], { cwd, timeout: 10000 }).catch(() => {}))
        .child(`#${pr.n}`)
        .when(pr.c === "pass", (el) => el.child(svg("mods/agents-copy/check.svg").size(10).flex_none()))
        .when(pr.c === "fail", (el) => el.child(svg("mods/agents-copy/x.svg").size(10).flex_none()))
        .when(pr.c === "pending", (el) => el.child(svg("mods/agents-copy/spinner.svg").size(10).flex_none().spin(900)));
    };
    // The branch's Jira key; a click opens the issue in the browser.
    const jiraChip = (a, key) => chip(`jira-${a.address}`, t.accent, `Open ${key} in Jira`,
      () => exec("open", [`${jiraSite}/browse/${key}`], { timeout: 10000 }).catch(() => {}))
      .child(key);

    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .mx(6)
          .px(2)
          .rounded(6)
          .flex_none()
          .items_center()
          .gap(4)
          .when(a.focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(a.focused ? t.foreground : t.muted).child(String(i + 1)))
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
      // A worktree's agent under its repo's header names its own space.
      const full = byPriority || isPinned || groupOf.get(a.address).label !== a.space_name;
      const name = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const hover = (el) => el
        .on_hover((on, cx) => {
          const was = this.hovered;
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          if (this.hovered !== was) cx.notify();
        })
        .when(this.expanded === a.address, (el) => el.on_mouse_down_out((_e, cx) => this.collapse(cx)))
        .on_click((_e, cx) => {
          this.collapse(cx);
          this.endSearch(cx);
          run("pane.focus", { pane: a.pane });
        });
      // Time and pin share one fixed slot (fits "59m"), so hovering doesn't change the headline's width.
      const timeOrPin = div().flex_none().w(26).h(17).flex().items_center().justify_end().whitespace_nowrap().overflow_hidden()
        .text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim)
        .child(this.hovered === a.address ? pin : when ? duration(now - when) : "");
      const picFold = (p) => div().id(`agent-fold-${a.address}`)
        .when(subs.length > 0, (el) => el.on_click((_e, cx) => {
          cx.stop_propagation();
          this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
          cx.notify();
        })).child(p);

      const blocked = a.status === "blocked";
      const term = termBy.get(a.address);
      const tabInfo = tabs.get(a.tab);
      const prog = a.program?.name ?? "";
      const pr = prFor(a);
      const jiraKey = jiraSite ? jiraFor(a) : null;
      // Line 1 and line 2 by the rule shared with agents-board (headline.js).
      const { head, report } = headline({
        tab: tabInfo?.named ? tabInfo.name ?? "" : "",
        text: reportText(term?.report) || reportText(a.title),
        prog, progKey: a.program?.key, jiraKey,
      });
      const lead = head || prog || label(a);
      const b = placeOf.get(a.address)?.branch;
      const branch = b && b !== "HEAD" ? b : null;
      // Without a space header above (priority, pinned) the space goes on the bottom row;
      // a branch line already says where it is.
      const space = full && a.space_name && !branch ? dropKey(a.space_name, jiraKey) || a.space_name : null;
      const g = glyph(t, a.status, "mods/agents-copy/");
      const canPeek = !a.address.includes("/"); // the screen of another machine's agent isn't read
      const eye = this.eyeBtn(t, a.address);
      const msgBox = this.msgBox(t, a.address);
      return hover(this.card(t, {
        id: `ag-${a.address}`,
        blocked,
        focused: a.focused,
        pic: pic && picFold(pic),
        glyph: g,
        // With no line 2 the headline wraps up to two lines instead.
        title: [
          div().min_w(0).when(Boolean(report), (el) => el.truncate()).when(!report, (el) => el.max_h(36).line_height("18px").overflow_hidden())
            .text_color(t.foreground).font_semibold().child(lead),
        ],
        right: [
          machine && div().text_size(10).text_color(t.dim).child(machine),
          subs.length > 0 && fold(a, subs),
          timeOrPin,
        ],
        branch,
        report,
        reportOn: true,
        eye: canPeek && eye,
        box: msgBox,
        // PR and Jira chips on their own row at the bottom, so the name and the report keep the width.
        bottom: (pr || jiraKey || space) && h_flex().gap(5).items_center()
          .when(Boolean(jiraKey), (el) => el.child(jiraChip(a, jiraKey)))
          .when(Boolean(pr), (el) => el.child(prChip(a, pr)))
          .when(Boolean(space), (el) => el.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(space))),
      }).mb(5));
    };

    // Groups in list order: repos/spaces (grouped) or priority sections. `rest` is
    // sorted so a group's agents are neighbours.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = byPriority ? sectionOf(rankOf(a) || RANK.idle) : 0;
      const g = groupOf.get(a.address);
      const id = byPriority ? `sec-${r}` : g.id;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : g.label, status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
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
                .child(
                  div()
                    .id("ag-search")
                    .text_color(this.searchOpen ? t.accent : t.dim)
                    .hover((s) => s.text_color(this.searchOpen ? t.accent : t.foreground))
                    .on_click((_e, cx) => this.toggleSearch(cx))
                    .tooltip(this.searchOpen ? "Close search" : "Search agents")
                    .child(svg("mods/agents-copy/search.svg").size(14)),
                )
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
      .when(this.searchOpen && !collapsed, (el) =>
        el.child(h_flex()
          .id("ag-search-box")
          .mx(8)
          .mb(4)
          .h(28)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .rounded(7)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .on_key_down((e, cx) => {
            if (e.key !== "escape") return;
            this.toggleSearch(cx);
            cx.stop_propagation();
          })
          .child(svg("mods/agents-copy/search.svg").size(13).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(12.5).text_color(t.foreground))
          .child(div()
            .id("ag-search-close")
            .flex_none()
            .p(2)
            .rounded(3)
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Close search (Esc)")
            .on_click((_e, cx) => this.toggleSearch(cx))
            .child(svg("mods/agents-copy/x.svg").size(11)))),
      )
      .when(list.length === 0 && unfiltered > 0 && !collapsed, (el) =>
        el.child(h_flex().px(12).py(6).gap(6).text_size(12).text_color(t.dim)
          .child(q ? "No agents match the search" : "No agents match the filter")
          .child(div().id("ag-filter-none").cursor_pointer().text_color(t.accent).hover((s) => s.text_color(t.foreground)).on_click(q
            ? (_e, cx) => { this.search.set_value(""); this.q = ""; this.search.focus(); cx.notify(); }
            : clearFilter).child("Clear"))),
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
