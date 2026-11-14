// Agents as a kanban: Needs you, Working, Done (unseen).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, shared, setShared, closeOverlay, props, exec } from "herdr";
import { CHECKS_WORD, newPrState, prMap, prOf, refreshPrs } from "./prs.js";

const ICONS = "mods/agents-board/";
const PR_FILTERS = [
  { id: "any", label: "Any" },
  { id: "with", label: "Has PR" },
  { id: "failing", label: "Checks failing" },
  { id: "none", label: "No PR" },
];
const MONO = "Menlo";
const COLS = [
  { key: "blocked", title: "Needs you", hint: "oldest waiting first", color: "blocked" },
  { key: "working", title: "Working", hint: "longest running first", color: "working" },
  { key: "done", title: "Done", hint: "unseen first, newest first", color: "done" },
];

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

export default class Board extends View {
  init(_props, cx) {
    this.live = true;
    this.pr = newPrState();
    this.prJson = "{}";
    this.placesKey = "";
    this.places = [];
    this.busy = false;
    this.again = false;
    this.q = "";
    this.sel = null; // address of the selected card
    this.cols = []; // addresses per column, set by render, for the keys
    this.done = false;
    this.scrolls = COLS.map(() => ScrollHandle.new());
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search agents" });
    this.input.on("change", (_e, cx) => {
      this.q = this.input.value().trim().toLowerCase();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.byAddr?.get(this.sel), cx));
    this.input.focus();
    cx.timer.after(400, () => this.live && this.input.focus());
    // Only the "4m" / "waiting 7m" texts and the PR refresh need time to pass.
    cx.timer.every(30000, (cx) => {
      if (!this.live) return;
      this.kick(cx);
      cx.notify();
    });
  }

  close(cx) {
    this.live = false;
    for (const s of this.scrolls) s.release();
    closeOverlay(props().overlay);
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

  go(a, cx) {
    if (!a || this.done) return;
    this.done = true;
    if (a.pane) run("pane.focus", { pane: a.pane });
    else run("agent.focus", { terminal: a.address });
    this.close(cx);
  }

  peek(a) {
    if (a) run("terminal.peek", { terminal: a.address });
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
    const t = theme();
    const now = Date.now();
    // Each host list once.
    const list = agents();
    const terms = terminals();
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
      const report = clean(term?.report) || clean(a.title);
      const par = term?.parent ? termBy.get(term.parent) : null;
      const parentAgent = term?.parent ? agentBy.get(term.parent) : null;
      return {
        a,
        at: at ?? null,
        report,
        program: a.program?.name ?? "agent",
        branch: p?.branch ?? sp?.branch ?? null,
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

    const button = (id, label, onClick, tint) =>
      div()
        .id(id)
        .flex_none()
        .h(24)
        .px(10)
        .rounded(6)
        .flex()
        .items_center()
        .text_size(12)
        .font_medium()
        .cursor_pointer()
        .when(tint, (el) => el.bg(tint).text_color(t.accent_foreground ?? "#ffffff").hover((s) => s.opacity(0.85)))
        .when(!tint, (el) => el.bg(t.hover).text_color(t.foreground).hover((s) => s.bg(t.selected)))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          onClick(cx);
        })
        .child(label);

    const timeText = (r) => {
      if (r.at == null) return "";
      const d = duration(now - r.at);
      return r.a.status === "blocked" ? `waiting ${d}` : d;
    };

    const card = (r) => {
      const a = r.a;
      const blocked = a.status === "blocked";
      const on = this.sel === a.address;
      const pic = icon(a.program, 16, t.foreground);
      return v_flex()
        .id(`card-${a.address}`)
        .flex_none()
        .gap(7)
        .p(10)
        .rounded(10)
        .bg(t.surface)
        .border_1()
        .border_color(on ? t.accent : blocked ? t.blocked + "88" : t.border)
        .cursor_pointer()
        .when(a.status === "idle", (el) => el.opacity(0.55))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.go(a, cx))
        .child(
          h_flex()
            .gap(7)
            .items_center()
            .when(Boolean(pic), (el) => el.child(pic))
            .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(r.program))
            .when(r.sub !== null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("↳ sub-agent")))
            .child(div().flex_1())
            .when(a.status === "done", (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.accent).tooltip("Not seen yet")))
            .child(div().flex_none().text_size(11).text_color(blocked ? t.blocked : t.dim).child(timeText(r))),
        )
        .when(r.sub, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(`↳ sub-agent of ${r.sub}`)))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().min_w(0).truncate().text_size(12).text_color(t.muted).child(`${a.space_name} / ${a.tab_name}`))
            .child(div().flex_1())
            .when(Boolean(r.branch), (el) => el.child(div().min_w(0).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(r.branch))),
        )
        .when(Boolean(r.report), (el) =>
          el.child(
            div()
              .px(8)
              .py(5)
              .rounded(6)
              .bg(t.background)
              .max_h(46)
              .overflow_hidden()
              .font_family(MONO)
              .text_size(11.5)
              .text_color(blocked ? t.blocked : t.muted)
              .child(r.report.length > 160 ? r.report.slice(0, 160) + "…" : r.report),
          ),
        )
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .when(Boolean(r.pr), (el) => el.child(prPill(r)))
            .child(div().flex_1())
            .child(button(`peek-${a.address}`, "Peek", () => this.peek(a)))
            .child(blocked ? button(`go-${a.address}`, "Answer", (cx) => this.go(a, cx), t.blocked) : button(`go-${a.address}`, "Go", (cx) => this.go(a, cx))),
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
            .child(div().flex_1())
            .child(div().text_size(11).text_color(t.dim).child(def.hint)),
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

    
    return v_flex()
      .id("agents-board")
      .track_focus(this.handle)
      .size_full()
      .p(18)
      .gap(12)
      .bg(t.canvas)
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close(cx);
        const empty = !this.input.value();
        if (k === "up" || k === "down" || (empty && (k === "left" || k === "right"))) this.move(k, cx);
        else if (k === "enter") this.go(agentBy.get(this.sel), cx);
        else if (k === "space" && empty && this.sel) this.peek(agentBy.get(this.sel));
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
      .child(h_flex().flex_1().min_h(0).gap(14).children(COLS.map(column)));
  }
}
