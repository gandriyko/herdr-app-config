// Agents as a kanban: Needs you, Working, Done (unseen).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, shared, setShared, openOverlay, closeOverlay, props, exec, hc } from "herdr";
import { AskingTracker } from "./asking.js";
import { CHECKS_WORD, newPrState, prMap, prOf, refreshPrs } from "./prs.js";

const ICONS = "mods/agents-board/";
const PR_FILTERS = [
  { id: "any", label: "Any" },
  { id: "with", label: "Has PR" },
  { id: "failing", label: "Checks failing" },
  { id: "none", label: "No PR" },
];
const COLS = [
  { key: "blocked", title: "Needs you", color: "blocked" },
  { key: "working", title: "Working", color: "working" },
  { key: "done", title: "Done", color: "done" },
];

const SIZE_DEFAULT = { w: 0.82, h: 0.85 };
const clampFrac = (v, d) => (Number.isFinite(v) ? Math.min(0.98, Math.max(0.4, v)) : d);
// The stored size as shares of the window (shared `agents-board.size`).
const sizeOf = () => {
  const z = shared("agents-board.size");
  return { w: clampFrac(z?.w, SIZE_DEFAULT.w), h: clampFrac(z?.h, SIZE_DEFAULT.h) };
};
// Shares to pixels for a window of W x H: at least 640 x 420 (never more than the window).
const toPx = (z, W, H) => ({ w: Math.round(Math.min(W, Math.max(640, z.w * W))), h: Math.round(Math.min(H, Math.max(420, z.h * H))) });

const filterOf = () => {
  const f = shared("agents-board.filter");
  return { space: typeof f?.space === "string" ? f.space : null, pr: PR_FILTERS.some((x) => x.id === f?.pr) ? f.pr : "any" };
};
// The report is text, or (from some programs) an object with the text in it.
const textOf = (s) => (typeof s === "string" ? s : (s && (s.text ?? s.summary ?? s.message ?? s.title ?? s.status)) || "");
const clean = (s) => String(textOf(s)).replace(/^[^\p{L}\p{N}~/]+/u, "").trim();

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

// The card's status glyph: spinner (working), pulsing "?" (blocked), dot (unseen done), nothing (idle).
function glyph(t, status) {
  if (status === "working") return svg(ICONS + "spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().flex_none().size(16).rounded(8).bg(t.blocked).text_color(t.background).text_size(11).font_bold().flex().items_center().justify_center().loop("opacity", { from: 1, to: 0.55, period: 1400 }).child("?");
  if (status === "done") return div().flex_none().size(8).rounded(4).bg(t.accent).tooltip("Not seen yet");
  return null;
}

const WORDS = { working: "working", blocked: "needs you", done: "finished", idle: "idle" };
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export default class Board extends View {
  init(_props, cx) {
    this.live = true;
    if (props()?.peekBar) {
      // The bar over a peeked agent: no board state, timers or PR polling.
      this.layoutName = shared("layout");
      this.going = false;
      this.back = false;
      return;
    }
    this.pr = newPrState();
    // Agents finished on a menu or a question count as blocked; one screen read per turn.
    this.asking = new AskingTracker(hc, () => this.live);
    this.prJson = "{}";
    this.placesKey = "";
    this.places = [];
    this.busy = false;
    this.again = false;
    this.q = "";
    this.sel = store.get("sel") || null; // address of the selected card (remembered across openings)
    this.cols = []; // addresses per column, set by render, for the keys
    this.done = false;
    this.win = null; // the window's size (the overlay covers it)
    this.drag = null; // { mode, size } while the panel is being resized
    this.scrolls = COLS.map(() => ScrollHandle.new());
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search agents" });
    this.input.on("change", (_e, cx) => {
      this.q = this.input.value().trim().toLowerCase();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.peek(this.byAddr?.get(this.sel), cx));
    this.input.focus();
    cx.timer.after(400, () => this.live && this.input.focus());
    // Only the "4m" / "7m" texts and the PR refresh need time to pass.
    cx.timer.every(30000, (cx) => {
      if (!this.live) return;
      this.kick(cx);
      cx.notify();
    });
  }

  close(cx) {
    this.live = false;
    if (props()?.peekBar) return this.barClose();
    for (const s of this.scrolls) s.release();
    closeOverlay(props().overlay);
  }

  // The peek bar closes (any way except the go button): the board comes back, once, and only
  // in the layout the peek was opened in.
  barClose() {
    if (this.going || this.back) return;
    this.back = true;
    if (shared("layout") !== this.layoutName) return;
    try {
      run("mod.open", { name: "agents-board" });
    } catch (_e) {}
  }

  barLeave(go) {
    const { terminal, pane, overlay } = props();
    if (go) this.going = true;
    closeOverlay(overlay);
    if (go) {
      if (pane) run("pane.focus", { pane });
      else run("agent.focus", { terminal });
    } else this.barClose();
  }

  bar() {
    const t = theme();
    const { terminal, pane } = props();
    const a = agents().find((x) => x.address === terminal);
    const k = terminals().find((x) => x.address === terminal);
    const tb = spaces().flatMap((s) => s.tabs).find((x) => x.id === a?.tab);
    const prog = (a?.program?.name ?? k?.program?.name ?? "agent").trim();
    const report = clean(k?.report) || clean(a?.title) || (tb?.name ?? "").trim();
    const tabName = tb?.named ? (tb.name ?? "").trim() : "";
    const tabShown = tabName && tabName.toLowerCase() !== report.toLowerCase() && tabName.toLowerCase() !== prog.toLowerCase() ? tabName : null;
    const st = a?.status ?? k?.status ?? null;
    const pic = icon(a?.program ?? k?.program, 16, t.foreground);
    const btn = (id, label, tip, onClick) =>
      div()
        .id(id)
        .flex_none()
        .px(8)
        .py(2)
        .rounded(5)
        .text_size(12)
        .text_color(t.muted)
        .cursor_pointer()
        .tooltip(tip)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down((_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          onClick();
        })
        .child(label);
    return h_flex()
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(a?.space_name || tabShown || prog))
      .when(Boolean(a?.space_name && tabShown), (el) => el.child(div().min_w(0).truncate().text_color(t.dim).child(`/ ${tabShown}`)))
      .when(Boolean(glyph(t, st)), (el) => el.child(glyph(t, st)))
      .when(Boolean(st), (el) => el.child(div().flex_none().text_color(t[st] ?? t.dim).child(WORDS[st] ?? st)))
      .child(div().flex_1())
      .child(btn("bar-board", "← Board", "Back to the board", () => this.barLeave(false)))
      .child(btn("bar-go", "↗", "Go to agent", () => this.barLeave(true)))
      .child(btn("bar-close", "✕", "Close (back to the board)", () => this.barLeave(false)));
  }

  kick(cx) {
    if (!this.live) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    if (!this.places.length) return;
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

  // Closes the board (the peek is an overlay and would sit under it), then peeks the agent;
  // falls back to focusing its pane when peek is not available.
  peek(a, cx) {
    if (!a || this.done) return;
    this.done = true;
    store.set("sel", a.address);
    this.close(cx);
    try {
      const z = sizeOf();
      const px = this.win ? toPx(z, this.win.width, this.win.height) : null;
      openOverlay({
        kind: "dialog",
        width: px ? px.w : z.w,
        height: px ? px.h : z.h,
        layout: {
          id: "peek", type: "column",
          children: [
            { id: "bar", type: "block", size: { px: 34 }, content: { mod: "agents-board", props: { peekBar: true, terminal: a.address, pane: a.pane } } },
            { id: "term", type: "block", content: { terminal: a.address } },
          ],
        },
      });
    } catch (_e) {
      try {
        run("terminal.peek", { terminal: a.address });
        return;
      } catch (_e2) {}
      if (a.pane) run("pane.focus", { pane: a.pane });
      else run("agent.focus", { terminal: a.address });
    }
  }

  // Resizing: the panel stays centered, so its width is twice the pointer's distance from the center.
  dragTo(e, cx) {
    const d = this.drag;
    const win = this.win;
    if (!d || !win) return;
    const cur = d.size;
    let { w, h } = cur;
    if (d.mode.includes("x")) w = (2 * Math.abs(e.position.x - win.width / 2)) / win.width;
    if (d.mode.includes("y")) h = (2 * Math.abs(e.position.y - win.height / 2)) / win.height;
    w = clampFrac(w, cur.w);
    h = clampFrac(h, cur.h);
    if (Math.abs(w - cur.w) < 0.001 && Math.abs(h - cur.h) < 0.001) return;
    d.size = { w, h };
    cx.notify();
  }

  endDrag(cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    setShared("agents-board.size", { w: +d.size.w.toFixed(4), h: +d.size.h.toFixed(4) });
    cx.notify();
  }

  // Moves the selection with an arrow key.
  move(key, cx) {
    const cols = this.cols;
    if (!cols.some((c) => c.length)) return;
    let ci = cols.findIndex((c) => c.includes(this.sel));
    let ri = ci >= 0 ? cols[ci].indexOf(this.sel) : 0;
    if (ci < 0) ci = Math.max(0, cols.findIndex((c) => c.length));
    else if (key === "up") ri = Math.max(0, ri - 1);
    else if (key === "down") ri = Math.min(cols[ci].length - 1, ri + 1);
    else {
      const step = key === "right" ? 1 : -1;
      let n = ci + step;
      while (n >= 0 && n < cols.length && !cols[n].length) n += step;
      if (n >= 0 && n < cols.length) {
        ci = n;
        ri = Math.min(ri, cols[n].length - 1);
      }
    }
    this.sel = cols[ci][ri] ?? null;
    this.scrolls[ci]?.scroll_to_item(ri);
    cx.notify();
  }

  render(cx) {
    if (props()?.peekBar) return this.bar();
    const t = theme();
    const now = Date.now();
    // Each host list once.
    const terms = terminals();
    const list = this.asking.apply(agents(), terms, cx);
    const spaceList = spaces();
    const paneList = panes();

    const termBy = new Map(terms.map((x) => [x.address, x]));
    const agentBy = new Map(list.map((a) => [a.address, a]));
    const tabBy = new Map();
    const spaceBy = new Map();
    for (const s of spaceList) {
      spaceBy.set(s.id, s);
      for (const tb of s.tabs) tabBy.set(tb.id, tb);
    }
    const paneBy = new Map(paneList.map((p) => [p.pane, p]));

    const fl = filterOf();
    const flSpace = spaceBy.has(fl.space) ? fl.space : null;

    // Where each agent is, for PRs; a remote one has no local gh.
    const placeOf = new Map();
    for (const a of list) {
      if (a.address.includes("/")) continue;
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const cwd = p?.cwd || sp?.folder;
      if (cwd) placeOf.set(a.address, { cwd, branch: p?.branch ?? sp?.branch ?? null });
    }
    const placesKey = JSON.stringify([...placeOf.values()]);
    if (placesKey !== this.placesKey) {
      this.placesKey = placesKey;
      this.places = [...placeOf.values()];
      this.kick(cx);
    }
    const prFor = (a) => prOf(this.pr, placeOf.get(a.address));

    // One record per agent with everything the card shows.
    const info = (a) => {
      const tb = tabBy.get(a.tab);
      const term = termBy.get(a.address);
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const at = a.status === "working" ? tb?.working_since : tb?.changed_at;
      const prog = a.program?.name ?? "agent";
      // Line 2: the report, else the agent's title, else the tab name; never the bare program name.
      let report = clean(term?.report) || clean(a.title) || (tb?.named ? (tb.name ?? "").trim() : "");
      if (report.toLowerCase() === prog.trim().toLowerCase()) report = "";
      // The tab shows on line 1 only when a person named it and it says something new.
      const tabName = tb?.named ? (tb.name ?? "").trim() : "";
      const tabShown = tabName && tabName.toLowerCase() !== report.toLowerCase() && tabName.toLowerCase() !== prog.trim().toLowerCase() ? tabName : null;
      const par = term?.parent ? termBy.get(term.parent) : null;
      const parentAgent = term?.parent ? agentBy.get(term.parent) : null;
      return {
        a,
        at: at ?? null,
        report,
        tabShown,
        program: prog,
        sub: term?.parent ? (parentAgent?.tab_name ?? par?.name ?? "") : null,
        pr: prFor(a),
      };
    };
    const all = list.map(info);

    const matches = (r) => {
      if (flSpace && r.a.space !== flSpace) return false;
      if (fl.pr !== "any" && !(fl.pr === "with" ? r.pr : fl.pr === "failing" ? r.pr?.c === "fail" : !r.pr)) return false;
      if (this.q && ![r.program, r.a.space_name, r.a.tab_name, r.report].join("\n").toLowerCase().includes(this.q)) return false;
      return true;
    };
    const shown = all.filter(matches);
    const byStatus = (s) => shown.filter((r) => r.a.status === s);
    const late = Infinity;
    const columns = [
      byStatus("blocked").sort((x, y) => (x.at ?? late) - (y.at ?? late)),
      byStatus("working").sort((x, y) => (x.at ?? late) - (y.at ?? late)),
      // Unseen done first, then seen (idle, dimmed), each newest first.
      [...byStatus("done").sort((x, y) => (y.at ?? 0) - (x.at ?? 0)), ...byStatus("idle").sort((x, y) => (y.at ?? 0) - (x.at ?? 0))],
    ];
    this.cols = columns.map((c) => c.map((r) => r.a.address));
    this.byAddr = agentBy;
    if (this.sel && !agentBy.has(this.sel)) this.sel = null;

    // Summary counts what is there at all, not what the filter leaves.
    const cnt = (s) => all.filter((r) => r.a.status === s).length;
    const parts = [[cnt("blocked"), "need you"], [cnt("working"), "working"], [cnt("done"), "unseen"], [cnt("idle"), "seen"]].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
    const summary = parts.length ? parts.join(" · ") : "No agents";

    // Filter chips.
    const spaceChips = [];
    for (const s of spaceList) {
      const mine = all.filter((r) => r.a.space === s.id);
      if (mine.length) spaceChips.push({ id: s.id, label: s.name, n: mine.length });
    }
    const setFilter = (patch) => setShared("agents-board.filter", { space: flSpace, pr: fl.pr, ...patch });

    const PR_COLOR = { fail: t.blocked, pass: t.done, pending: t.working, none: t.muted };
    const prPill = (r) => {
      const pr = r.pr;
      const color = PR_COLOR[pr.c];
      const cwd = placeOf.get(r.a.address)?.cwd;
      return h_flex()
        .id(`pr-${r.a.address}`)
        .flex_none()
        .h(20)
        .px(6)
        .gap(4)
        .rounded(6)
        .items_center()
        .bg(color + "26")
        .text_size(11)
        .font_medium()
        .text_color(color)
        .cursor_pointer()
        .hover((el) => el.bg(color + "40"))
        .tooltip(`PR #${pr.n} · checks ${CHECKS_WORD[pr.c]}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          exec("gh", ["pr", "view", String(pr.n), "--web"], { cwd, timeout: 10000 }).catch(() => {});
        })
        .child(`#${pr.n}`)
        .when(pr.c === "pass", (el) => el.child(svg(ICONS + "check.svg").size(11).flex_none()))
        .when(pr.c === "fail", (el) => el.child(svg(ICONS + "x.svg").size(11).flex_none()))
        .when(pr.c === "pending", (el) => el.child(svg(ICONS + "spinner.svg").size(11).flex_none().spin(900)));
    };

    const timeText = (r) => {
      if (r.at == null) return "";
      return duration(now - r.at);
    };

    const card = (r) => {
      const a = r.a;
      const blocked = a.status === "blocked";
      const on = this.sel === a.address;
      const pic = icon(a.program, 16, t.foreground);
      const g = glyph(t, a.status);
      return v_flex()
        .id(`card-${a.address}`)
        .flex_none()
        .gap(4)
        .py(8)
        .px(9)
        .rounded(7)
        .bg(blocked ? t.blocked + "14" : t.raised)
        .border_1()
        .border_color(on ? t.accent : blocked ? t.blocked + "66" : t.border)
        .cursor_pointer()
        .when(a.status === "idle", (el) => el.opacity(0.55))
        .hover((s) => s.bg(blocked ? t.blocked + "22" : t.hover))
        .on_click((_e, cx) => this.peek(a, cx))
        .child(
          h_flex()
            .gap(7)
            .items_start()
            .child(
              v_flex().flex_none().w(16).gap(6).items_center()
                .when(Boolean(pic), (el) => el.child(pic))
                .child(div().flex_none().w(16).h(16).flex().items_center().justify_center().when(Boolean(g), (el) => el.child(g))),
            )
            .child(
              v_flex().flex_1().min_w(0).gap(4)
                .child(
                  h_flex()
                    .gap(7)
                    .items_center()
                    .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(a.space_name || r.tabShown || r.program))
                    .when(Boolean(a.space_name && r.tabShown), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(`/ ${r.tabShown}`)))
                    .when(r.sub !== null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("↳ sub-agent")))
                    .child(div().flex_1())
                    .child(div().flex_none().flex().justify_end().whitespace_nowrap().overflow_hidden().text_size(11).text_color(blocked ? t.blocked : t.dim).child(timeText(r))),
                )
                .when(r.sub, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(`↳ sub-agent of ${r.sub}`)))
                .child(
                  div()
                    .min_w(0)
                    .max_h(34)
                    .overflow_hidden()
                    .text_size(12)
                    .line_height("17px")
                    .text_color(r.report ? (blocked ? t.blocked : t.muted) : t.dim)
                    .child(r.report || r.program || " "),
                )
                .when(Boolean(r.pr), (el) => el.child(h_flex().items_center().child(prPill(r)))),
            ),
        );
    };

    const column = (def, i) => {
      const rows = columns[i];
      const body = this.scrolls[i];
      return v_flex()
        .flex_1()
        .min_w(0)
        .h_full()
        .gap(8)
        .child(
          h_flex()
            .flex_none()
            .gap(8)
            .px(4)
            .h(22)
            .items_center()
            .child(div().flex_none().size(9).rounded(5).bg(t[def.color]))
            .child(div().text_size(13).font_semibold().text_color(t.foreground).child(def.title))
            .child(div().text_size(12).text_color(t.dim).child(String(rows.length)))

        )
        .child(
          v_flex()
            .id(`col-${def.key}`)
            .flex_1()
            .min_h(0)
            .gap(8)
            .overflow_y_scrollbar()
            .track_scroll(body)
            .when(!rows.length, (el) => el.child(div().p(16).text_size(12).text_color(t.dim).child("Nothing here")))
            .children(rows.map(card))
        );
    };

    const chip = (id, label, on, onClick, n) =>
      h_flex()
        .id(id)
        .flex_none()
        .h(24)
        .px(9)
        .gap(5)
        .items_center()
        .rounded(12)
        .text_size(12)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
        .when(!on, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click(() => onClick())
        .child(div().max_w(160).truncate().child(label))
        .when(n != null, (el) => el.child(div().text_size(11).text_color(t.dim).child(String(n))));

    const z = this.drag ? this.drag.size : sizeOf();
    const px = this.win ? toPx(z, this.win.width, this.win.height) : null;
    const start = (mode) => (e, cx) => {
      cx.stop_propagation();
      if (e.click_count >= 2 && mode === "xy") {
        this.drag = null;
        setShared("agents-board.size", { ...SIZE_DEFAULT });
        return cx.notify();
      }
      this.drag = { mode, size: sizeOf() };
    };
    const panel = v_flex()
      .id("agents-board")
      .track_focus(this.handle)
      .relative()
      .w(px ? px.w : 0)
      .h(px ? px.h : 0)
      .flex_none()
      .overflow_hidden()
      .rounded(12)
      .border_1()
      .border_color(t.border)
      .shadow_xl()
      .p(18)
      .gap(12)
      .bg(t.canvas)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close(cx);
        const empty = !this.input.value();
        if (k === "up" || k === "down" || (empty && (k === "left" || k === "right"))) this.move(k, cx);
        else if (k === "enter") this.peek(agentBy.get(this.sel), cx);
        else return;
        cx.stop_propagation();
      })
      .child(
        h_flex()
          .flex_none()
          .gap(12)
          .items_center()
          .child(div().text_size(17).font_semibold().text_color(t.foreground).child("Agents"))
          .child(div().text_size(12).text_color(t.muted).child(summary))
          .child(div().flex_1())
          .child(
            h_flex()
              .w(260)
              .h(30)
              .flex_none()
              .px(9)
              .gap(7)
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .bg(t.background)
              .child(svg(ICONS + "search.svg").size(14).flex_none().text_color(t.dim))
              .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)),
          )
          .child(
            div()
              .id("board-close")
              .flex_none()
              .size(28)
              .rounded(7)
              .flex()
              .items_center()
              .justify_center()
              .cursor_pointer()
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Close (Esc)")
              .on_click((_e, cx) => this.close(cx))
              .child(svg(ICONS + "x.svg").size(15)),
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(14)
          .items_center()
          .child(
            h_flex()
              .gap(3)
              .items_center()
              .min_w(0)
              .overflow_hidden()
              .child(chip("sp-all", "All", flSpace === null, () => setFilter({ space: null }), all.length))
              .children(spaceChips.map((c) => chip(`sp-${c.id}`, c.label, flSpace === c.id, () => setFilter({ space: c.id }), c.n))),
          )
          .child(div().flex_1())
          .child(h_flex().gap(3).flex_none().children(PR_FILTERS.map((f) => chip(`pf-${f.id}`, f.id === "any" ? "PR: Any" : f.label, fl.pr === f.id, () => setFilter({ pr: f.id }))))),
      )
      .child(h_flex().flex_1().min_h(0).gap(14).children(COLS.map(column)))
      .child(div().id("edge-w").absolute().left(0).top(14).bottom(14).w(5).cursor_ew_resize().on_mouse_down("left", start("x")))
      .child(div().id("edge-e").absolute().right(0).top(14).bottom(14).w(5).cursor_ew_resize().on_mouse_down("left", start("x")))
      .child(div().id("edge-s").absolute().bottom(0).left(14).right(14).h(5).cursor_ns_resize().on_mouse_down("left", start("y")))
      .child(
        div()
          .id("grip")
          .absolute()
          .right(2)
          .bottom(2)
          .size(14)
          .cursor_nwse_resize()
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .tooltip("Drag to resize, double-click to reset")
          .on_mouse_down("left", start("xy"))
          .child(svg(ICONS + "grip.svg").size(14)),
      );

    // The overlay covers the window: a dim backdrop (a click on it closes) with the panel centered.
    return div()
      .id("board-root")
      .size_full()
      .flex()
      .items_center()
      .justify_center()
      .bg("#00000066")
      .on_size_change((sz, cx) => {
        if (this.win && this.win.width === sz.width && this.win.height === sz.height) return;
        this.win = { width: sz.width, height: sz.height };
        cx.notify();
      })
      .on_mouse_move((e, cx) => this.dragTo(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_mouse_down("left", (_e, cx) => this.close(cx))
      .child(panel);
  }
}
