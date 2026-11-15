// Agents as a kanban: Needs you, Working, Done (unseen).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, settings, shared, setShared, closeOverlay, props, exec, hc } from "herdr";
import { AskingTracker } from "./asking.js";
import { isSelectMenu, parseOptions, parseQuestion, parseSuggestion, sameOptions } from "./reply.js";
import { CHECKS_WORD, newPrState, prMap, prOf, refreshPrs } from "./prs.js";

const ICONS = "mods/agents-board/";
const PR_FILTERS = [
  { id: "any", label: "Any" },
  { id: "with", label: "Has PR" },
  { id: "failing", label: "Failing" },
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

const RULE = /^[\s─━═\-_]*[─━═]{3,}[\s─━═\-_]*$/;
const termByAddr = (terms, address) => terms.find((x) => x.address === address);
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
    this.pr = newPrState();
    // Agents finished on a menu or a question count as blocked; one screen read per turn.
    this.asking = new AskingTracker(hc, () => this.live);
    this.prJson = "{}";
    this.placesKey = "";
    this.places = [];
    this.busy = false;
    this.again = false;
    this.q = "";
    this.sel = null; // address of the selected card
    this.cols = []; // addresses per column in visual order (parent, then its open children), set by render, for the keys
    this.colIdx = []; // per column, the index of the top-level card holding each address (for scrolling)
    this.collapsed = new Set(); // parent addresses whose children are folded
    try {
      const c = JSON.parse(store.get("collapsed") || "[]");
      if (Array.isArray(c)) for (const x of c.slice(0, 200)) if (typeof x === "string") this.collapsed.add(x);
    } catch (_e) {}
    this.treeKey = null; // the parent links the cache below was built from
    this.parentOf = new Map(); // child address -> parent address (both agents, no cycles)
    this.kidsOf = new Map(); // parent address -> child addresses
    this.done = false;
    this.going = false; // a paneless agent is being given a pane
    this.notice = null; // a one-line error under the header
    this.preview = null; // { address, text, error, key, want, busy, again, stick } while the screen preview is open
    this.pvScroll = ScrollHandle.new();
    this.win = null; // the window's size (the overlay covers it)
    this.drag = null; // { mode, size } while the panel is being resized
    this.scrolls = COLS.map(() => ScrollHandle.new());
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search agents" });
    this.input.on("change", (_e, cx) => {
      this.q = this.input.value().trim().toLowerCase();
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.byAddr?.get(this.sel), cx));
    this.searchFocus = false;
    this.input.on("focus", () => (this.searchFocus = true));
    this.input.on("blur", () => (this.searchFocus = false));
    this.reply = null; // { address, question, detail, tabs, suggestion, options, select, typing, sending, error, input } while a reply area is open
    this.replyFocus = false;
    this.replySeq = 0;
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
    this.dropReply();
    this.preview = null;
    this.pvScroll.release();
    for (const s of this.scrolls) s.release();
    closeOverlay(props().overlay);
  }

  // Drops the reply area and its input (no screen text is kept anywhere).
  dropReply() {
    this.replySeq++;
    this.replyFocus = false;
    const r = this.reply;
    this.reply = null;
    try {
      r?.input?.release();
    } catch (_e) {}
  }

  // A press outside the reply area closes it; the click that follows (go to a card, close the board,
  // toggle the same reply button) is swallowed for a moment so it only dismisses.
  dismissReply(cx) {
    if (!this.reply) return;
    this.dismiss = { at: Date.now(), address: this.reply.address };
    this.closeReply(cx);
  }

  justDismissed() {
    return Boolean(this.dismiss && Date.now() - this.dismiss.at < 400);
  }

  closeReply(cx) {
    if (!this.reply) return;
    this.dropReply();
    if (this.live) this.handle.focus(); // keys (arrows, r) go to the board again
    cx.notify();
  }

  // The screen preview: a click on the eye toggles it on a card; only one is open, and not with a reply area.
  togglePreview(a, cx) {
    if (!a || !this.live) return;
    if (this.preview?.address === a.address) return this.closePreview(cx);
    this.dropReply();
    this.preview = { address: a.address, text: [], loaded: false, error: null, want: null, busy: false, again: false, stick: true };
    this.sel = a.address;
    this.preview.want = this.previewKey(a.address);
    cx.notify();
    this.loadPreview(cx); // at once, not on the next render
  }

  previewKey(address) {
    return `${terminals().find((x) => x.address === address)?.turn}|${this.byAddr?.get(address)?.status}`;
  }

  closePreview(cx) {
    if (!this.preview) return;
    this.preview = null;
    if (this.live) this.handle.focus();
    cx.notify();
  }

  // Reads the last ~30 lines for the open preview. One read at a time; a change that arrives meanwhile reads once more.
  loadPreview(cx) {
    const pv = this.preview;
    if (!pv || !this.live) return;
    if (pv.busy) {
      pv.again = true;
      return;
    }
    pv.busy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          pv.again = false;
          let lines = null, err = null;
          try {
            const r = await hc(["read", pv.address, "--lines", "30"]);
            if (r?.code === 0) {
              lines = String(r.stdout).split("\n");
              while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
              // Runs of blank lines become one (a mostly empty screen), leading blanks go; then the last 30.
              lines = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
              while (lines.length && !lines[0].trim()) lines.shift();
              lines = lines.slice(-30);
            } else err = String(r?.stderr || r?.stdout || "Failed").trim().split("\n")[0] || "Failed";
          } catch (e) {
            err = String(e?.message ?? e).split("\n")[0];
          }
          if (!this.live || this.preview !== pv) return;
          let changed = !pv.loaded || err !== pv.error;
          if (lines && lines.join("\n") !== pv.text.join("\n")) {
            pv.text = lines;
            pv.stick = true;
            changed = true;
          }
          pv.loaded = true;
          pv.error = err;
          if (changed) cx.notify();
        } while (pv.again && this.live && this.preview === pv);
      } finally {
        pv.busy = false;
      }
    });
  }

  async readScreen(address) {
    const r = await hc(["read", address]);
    return r?.code === 0 ? r.stdout : "";
  }

  // Reads the screen once and opens the reply area: buttons for a choice menu, else a text input.
  openReply(a, cx) {
    if (!a || !this.live || a.status === "working") return;
    if (this.reply?.address === a.address) return this.closeReply(cx);
    this.preview = null;
    if (this.justDismissed() && this.dismiss.address === a.address) return; // the press that closed it
    this.dropReply();
    const seq = this.replySeq;
    cx.spawn(async (cx) => {
      let text = "";
      try {
        text = await this.readScreen(a.address);
      } catch (_e) {}
      if (!this.live || seq !== this.replySeq) return;
      const reply = { address: a.address, sending: false, error: null, input: null };
      this.fillReply(reply, text);
      this.reply = reply;
      this.sel = a.address;
      cx.notify();
      reply.input?.focus();
    });
  }

  // Text input for the reply box or a free-text answer; Enter submits.
  makeInput(placeholder) {
    const input = InputState.new({ placeholder });
    input.on("focus", () => (this.replyFocus = true));
    input.on("blur", () => (this.replyFocus = false));
    input.on("submit", (_e, cx) => this.submitReply(cx));
    return input;
  }

  // Puts the parsed screen into the reply: question, tabs, options (buttons), else a text input.
  // Only parsed fields are kept, never the screen text.
  fillReply(r, text) {
    if (r.input) {
      try {
        r.input.release();
      } catch (_e) {}
      r.input = null;
    }
    this.replyFocus = false;
    const options = parseOptions(text);
    const q = parseQuestion(text);
    r.question = q.question || "";
    r.detail = q.detail || "";
    r.tabs = q.tabs || null;
    r.options = options;
    r.select = options.length > 0 && isSelectMenu(text);
    r.typing = null; // the free-text option being answered
    r.suggestion = options.length ? null : parseSuggestion(text);
    r.sending = false;
    if (!options.length) r.input = this.makeInput(r.suggestion || "Reply to agent…");
  }

  // Enter in the box: a free-text answer, else the typed text or Claude's suggestion.
  submitReply(cx) {
    const r = this.reply;
    if (!r || r.sending) return;
    const text = r.input?.value().trim() || (r.typing ? "" : r.suggestion);
    if (!text) return;
    if (r.typing) return this.followUp(r, [["keys", r.address, String(r.typing)], 300, ["send", "--force", r.address, text]], cx);
    this.runReply(["send", r.address, text], r, cx);
  }

  // A click on a free-text option: a text input takes the place of the buttons.
  startTyping(o, cx) {
    const r = this.reply;
    if (!r || r.sending) return;
    r.typing = o.n;
    r.input = this.makeInput("Type your answer…");
    cx.notify();
    r.input.focus();
  }

  // Back from the free-text input to the option buttons.
  stopTyping(r, cx) {
    try {
      r.input?.release();
    } catch (_e) {}
    r.input = null;
    r.typing = null;
    this.replyFocus = false;
    if (this.live) this.handle.focus();
    cx.notify();
  }

  // Runs hc steps in order (an array is a command, a number a pause in ms), then re-reads the screen:
  // a menu still shown (next question, Submit) refreshes the area, no menu closes it.
  followUp(r, steps, cx) {
    r.sending = true;
    r.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let err = null;
      try {
        for (const s of steps) {
          if (typeof s === "number") {
            await new Promise((res) => cx.timer.after(s, () => res()));
          } else {
            const res = await hc(s);
            if (res?.code !== 0) throw new Error(String(res?.stderr || res?.stdout || "Failed").trim().split("\n")[0] || "Failed");
          }
          if (!this.live || this.reply !== r) return;
        }
        await new Promise((res) => cx.timer.after(600, () => res()));
        if (!this.live || this.reply !== r) return;
        const text = await this.readScreen(r.address);
        if (!this.live || this.reply !== r) return;
        if (!parseOptions(text).length) return this.closeReply(cx);
        this.fillReply(r, text);
        cx.notify();
        r.input?.focus();
      } catch (e) {
        err = String(e?.message ?? e).split("\n")[0];
        if (this.live && this.reply === r) {
          r.sending = false;
          r.error = err;
          cx.notify();
        }
      }
    });
  }

  // Runs one hc command for the open reply; success closes the area, failure shows the first line of stderr.
  runReply(args, r, cx, after) {
    r.sending = true;
    r.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let err = null;
      try {
        const res = await hc(args);
        if (res?.code !== 0) err = String(res?.stderr || res?.stdout || "Failed").trim().split("\n")[0] || "Failed";
      } catch (e) {
        err = String(e?.message ?? e).split("\n")[0];
      }
      if (!this.live || this.reply !== r) return;
      if (err) {
        r.sending = false;
        r.error = err;
        return cx.notify();
      }
      if (after) return after(cx);
      this.closeReply(cx);
    });
  }

  // A menu button: press its number, then (after the screen settled) Enter if the same menu is still there.
  pickOption(n, cx) {
    const r = this.reply;
    if (!r || r.sending) return;
    // "Enter to select" picker: a digit only moves the cursor, so press it, then Enter; then follow the screen.
    if (r.select) return this.followUp(r, [["keys", r.address, String(n)], 150, ["keys", r.address, "enter"]], cx);
    const menu = r.options;
    this.runReply(["keys", r.address, String(n)], r, cx, (cx) => {
      cx.timer.after(600, (cx) => {
        if (!this.live || this.reply !== r) return;
        cx.spawn(async (cx) => {
          try {
            if (sameOptions(parseOptions(await this.readScreen(r.address)), menu)) await hc(["keys", r.address, "enter"]);
          } catch (_e) {}
          if (this.live && this.reply === r) this.closeReply(cx);
        });
      });
    });
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

  // Closes the board and goes to the agent's terminal. A sub-agent without a pane first gets one
  // (terminal.keep, which may apply a moment later), then it is focused.
  go(a, cx) {
    if (!a || this.done || this.going) return;
    if (!a.paneless) {
      this.done = true;
      this.close(cx);
      run("pane.focus", { terminal: a.address });
      return;
    }
    this.going = true;
    this.notice = null;
    const fail = (msg) => {
      this.going = false;
      this.notice = msg;
      if (this.live) cx.notify();
    };
    try {
      run("terminal.keep", { terminal: a.address });
    } catch (e) {
      return fail(`Could not open ${a.name}: ${String(e?.message ?? e).split("\n")[0]}`);
    }
    // One-shot checks (no loop): the pane appears right away, or after the core confirms.
    const attempt = (n) =>
      cx.timer.after(n ? 1200 : 400, (cx) => {
        if (!this.live) return;
        if (panes().some((p) => p.terminal === a.address)) {
          this.done = true;
          this.close(cx);
          run("pane.focus", { terminal: a.address });
        } else if (n) fail(`${a.name} got no pane`);
        else attempt(1);
      });
    attempt(0);
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
    this.scrolls[ci]?.scroll_to_item(this.colIdx[ci]?.[ri] ?? ri);
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const now = Date.now();
    // Each host list once.
    const terms = terminals();
    // A sub-agent without a pane is not in agents(): make an agent-like record from its terminal, with
    // the space and tab of the listed agent its parent chain reaches. error counts as blocked, done as idle
    // (it reports to its parent, so its done is never news; same as the agents mod).
    const base = agents();
    const baseBy = new Map(base.map((a) => [a.address, a]));
    const loose = new Map(terms.filter((k) => k.state === "live" && k.status && !baseBy.has(k.address)).map((k) => [k.address, k]));
    const extras = [];
    for (const k of loose.values()) {
      let root = null;
      const seen = new Set([k.address]);
      for (let p = k.parent, n = 0; p && n < 8 && !seen.has(p); p = (loose.get(p) ?? termByAddr(terms, p))?.parent, n++) {
        seen.add(p);
        if (baseBy.has(p)) {
          root = baseBy.get(p);
          break;
        }
        if (!loose.has(p)) break;
      }
      if (!root) continue;
      extras.push({
        address: k.address,
        status: k.status === "error" ? "blocked" : ["working", "blocked"].includes(k.status) ? k.status : "idle",
        program: k.program,
        title: null,
        name: k.name || k.template || k.program?.name || k.address,
        pane: null,
        space: root.space,
        space_name: root.space_name,
        tab: root.tab,
        tab_name: root.tab_name,
        pinned: root.pinned,
        focused: false,
        paneless: true,
      });
    }
    const list = this.asking.apply(extras.length ? [...base, ...extras] : base, terms, cx);
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
      if (a.paneless) {
        const c = termBy.get(a.address)?.cwd;
        if (c) placeOf.set(a.address, { cwd: c, branch: null });
        continue;
      }
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
      const at = a.paneless ? null : a.status === "working" ? tb?.working_since : tb?.changed_at;
      const prog = a.program?.name ?? "agent";
      // Line 2: the report, else the agent's title, else the tab name; never the bare program name.
      let report = clean(term?.report) || clean(a.title) || (a.paneless ? "" : tb?.named ? (tb.name ?? "").trim() : "");
      if (report.toLowerCase() === prog.trim().toLowerCase()) report = "";
      // The tab shows on line 1 only when a person named it and it says something new.
      const tabName = tb?.named && !a.paneless ? (tb.name ?? "").trim() : "";
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

    // Parent -> children links between agents, rebuilt only when the links change.
    const links = [];
    for (const a of list) {
      const p = termBy.get(a.address)?.parent;
      if (p && p !== a.address && agentBy.has(p)) links.push(`${a.address}>${p}`);
    }
    const treeKey = links.join("|");
    if (treeKey !== this.treeKey) {
      this.treeKey = treeKey;
      const parentOf = new Map();
      for (const l of links) {
        const i = l.lastIndexOf(">");
        parentOf.set(l.slice(0, i), l.slice(i + 1));
      }
      // A cycle loses the link of its first member.
      for (const c of [...parentOf.keys()]) {
        const seen = new Set([c]);
        for (let p = parentOf.get(c); p; p = parentOf.get(p)) {
          if (p === c) {
            parentOf.delete(c);
            break;
          }
          if (seen.has(p)) break;
          seen.add(p);
        }
      }
      const kidsOf = new Map();
      for (const a of list) {
        const p = parentOf.get(a.address);
        if (!p) continue;
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(a.address);
      }
      this.parentOf = parentOf;
      this.kidsOf = kidsOf;
    }
    if (list.length) {
      let pruned = false;
      for (const x of this.collapsed) {
        if (!agentBy.has(x)) {
          this.collapsed.delete(x);
          pruned = true;
        }
      }
      if (pruned) store.set("collapsed", JSON.stringify([...this.collapsed]));
    }

    const matches = (r) => {
      if (flSpace && r.a.space !== flSpace) return false;
      if (fl.pr !== "any" && !(fl.pr === "with" ? r.pr : fl.pr === "failing" ? r.pr?.c === "fail" : !r.pr)) return false;
      if (this.q && ![r.program, r.a.space_name, r.a.tab_name, r.report].join("\n").toLowerCase().includes(this.q)) return false;
      return true;
    };
    const shown = all.filter(matches);
    const shownBy = new Map(shown.map((r) => [r.a.address, r]));
    // Nesting level: 0 = top-level card; a child is nested (level 1..3) when its parent card is shown.
    const levels = new Map();
    const levelOf = (addr) => {
      if (levels.has(addr)) return levels.get(addr);
      const p = this.parentOf.get(addr);
      let l = 0;
      if (p && shownBy.has(p)) {
        const pl = levelOf(p);
        if (pl < 3) l = pl + 1;
      }
      levels.set(addr, l);
      return l;
    };
    const kidsMemo = new Map();
    const kidsShown = (addr) => {
      let k = kidsMemo.get(addr);
      if (!k) {
        k = (this.kidsOf.get(addr) || []).filter((c) => shownBy.has(c) && levelOf(c) > 0);
        kidsMemo.set(addr, k);
      }
      return k;
    };
    const attnMemo = new Map();
    const attention = (addr) => {
      let v = attnMemo.get(addr);
      if (v === undefined) {
        v = kidsShown(addr).some((c) => shownBy.get(c).a.status === "blocked" || attention(c));
        attnMemo.set(addr, v);
      }
      return v;
    };
    // A group (a top-level card with nested descendants) sits in the column of its most urgent status
    // (blocked > working > done > idle); its time is that of the first member with that status that has one, else the parent's.
    const RANK = { blocked: 4, working: 3, done: 2, idle: 1 };
    const effMemo = new Map();
    const effOf = (addr) => {
      let v = effMemo.get(addr);
      if (v) return v;
      const r = shownBy.get(addr);
      const members = [r];
      const walkM = (ad) => {
        for (const k of kidsShown(ad)) {
          members.push(shownBy.get(k));
          walkM(k);
        }
      };
      walkM(addr);
      let status = r.a.status;
      for (const m of members) if ((RANK[m.a.status] ?? 0) > (RANK[status] ?? 0)) status = m.a.status;
      const src = members.find((m) => m.a.status === status && m.at != null);
      v = { status, at: src ? src.at : r.at };
      effMemo.set(addr, v);
      return v;
    };
    const entriesOf = (s) =>
      shown
        .filter((r) => levelOf(r.a.address) === 0)
        .map((r) => ({ r, eff: effOf(r.a.address) }))
        .filter((e) => e.eff.status === s);
    const late = Infinity;
    const byAt = (x, y) => (x.eff.at ?? late) - (y.eff.at ?? late);
    const byNew = (x, y) => (y.eff.at ?? 0) - (x.eff.at ?? 0);
    const columns = [
      entriesOf("blocked").sort(byAt),
      entriesOf("working").sort(byAt),
      // Unseen done first, then seen (idle, dimmed), each newest first.
      [...entriesOf("done").sort(byNew), ...entriesOf("idle").sort(byNew)],
    ];
    // Visual order for the keys: a card, then its open children, depth first.
    this.cols = [];
    this.colIdx = [];
    for (const c of columns) {
      const addrs = [], idx = [], seen = new Set();
      c.forEach((e, i) => {
        const walk = (ad) => {
          // Each address once per column, in first visual place.
          if (!seen.has(ad)) {
            seen.add(ad);
            addrs.push(ad);
            idx.push(i);
          }
          if (!this.collapsed.has(ad)) for (const k of kidsShown(ad)) walk(k);
        };
        walk(e.r.a.address);
      });
      this.cols.push(addrs);
      this.colIdx.push(idx);
    }
    this.byAddr = agentBy;
    if (this.sel && !agentBy.has(this.sel)) this.sel = null;
    // The card left the list (gone, filtered out, or the agent started working): its reply area goes too.
    if (this.preview && !this.cols.some((c) => c.includes(this.preview.address))) this.preview = null;
    if (this.preview) {
      // Read once on open, then again only when this agent's turn or status changes.
      const pv = this.preview;
      const key = `${termBy.get(pv.address)?.turn}|${agentBy.get(pv.address)?.status}`;
      if (key !== pv.want) {
        pv.want = key;
        this.loadPreview(cx);
      }
    }
    if (this.reply && (!this.cols.some((c) => c.includes(this.reply.address)) || agentBy.get(this.reply.address)?.status === "working")) this.dropReply();

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
        .tooltip(`PR #${pr.n} · checks ${CHECKS_WORD[pr.c]}`)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          exec("gh", ["pr", "view", String(pr.n), "--web"], { cwd, timeout: 10000 }).catch(() => {});
        })
        .child(`#${pr.n}`)
        .when(pr.c === "pass", (el) => el.child(svg(ICONS + "check.svg").size(10).flex_none()))
        .when(pr.c === "fail", (el) => el.child(svg(ICONS + "x.svg").size(10).flex_none()))
        .when(pr.c === "pending", (el) => el.child(svg(ICONS + "spinner.svg").size(10).flex_none().spin(900)));
    };

    const timeText = (r) => {
      if (r.at == null) return "";
      return duration(now - r.at);
    };

    const replyArea = (rp) => {
      const body = rp.options.length && !rp.input
        ? v_flex()
            .gap(4)
            .children(
              rp.options.map((o) =>
                v_flex()
                  .id(`opt-${o.n}`)
                  .w_full()
                  .px(9)
                  .py(5)
                  .gap(1)
                  .items_start()
                  .rounded(6)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .cursor_pointer()
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, cx) => {
                    cx.stop_propagation();
                    if (o.freeText) this.startTyping(o, cx);
                    else this.pickOption(o.n, cx);
                  })
                  .child(
                    h_flex()
                      .gap(8)
                      .child(div().flex_none().text_size(12).text_color(t.dim).child(String(o.n)))
                      .child(div().min_w(0).text_size(12).text_color(rp.sending ? t.dim : t.foreground).child(o.label)),
                  )
                  .when(Boolean(o.desc), (el) => el.child(div().pl(17).text_size(11).text_color(t.dim).child(o.desc))),
              ),
            )
        : h_flex()
            .w_full()
            .h(30)
            .px(9)
            .gap(7)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .on_key_down((e, cx) => {
              // Only Esc and Tab are intercepted; every other key (text, Enter) reaches the Input,
              // which emits "submit" on Enter. Stopping other keys would block text input.
              if (e.key === "escape") {
                if (rp.typing) this.stopTyping(rp, cx);
                else this.closeReply(cx);
                cx.stop_propagation();
              } else if (e.key === "tab" && !rp.input.value() && rp.suggestion) {
                rp.input.set_value(rp.suggestion);
                const n = rp.suggestion.length;
                rp.input.set_selected_range({ start: n, end: n });
                cx.stop_propagation();
              }
            })
            .child(Input.new(rp.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
            .when(rp.sending, (el) => el.child(svg(ICONS + "spinner.svg").size(13).flex_none().text_color(t.working).spin(900)));
      return v_flex()
        .id(`reply-area-${rp.address}`)
        .gap(4)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_down_out((_e, cx) => this.dismissReply(cx))
        .on_click((_e, cx) => cx.stop_propagation())
        .when(Boolean(rp.tabs?.length), (el) =>
          el.child(
            h_flex()
              .gap(4)
              .flex_wrap()
              .children(
                rp.tabs.map((tb, i) =>
                  h_flex()
                    .id(`reply-tab-${i}`)
                    .gap(3)
                    .px(6)
                    .py(1)
                    .items_center()
                    .rounded(5)
                    .border_1()
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(tb.done ? t.done : t.muted)
                    .when(tb.done, (e) => e.child(svg(ICONS + "check.svg").size(10).flex_none()))
                    .child(tb.label),
                ),
              ),
          ),
        )
        .when(Boolean(rp.question), (el) =>
          el.child(
            v_flex()
              .id(`reply-question-${rp.address}`)
              .w_full()
              .max_h(160)
              .overflow_y_scroll()
              .p(8)
              .gap(3)
              .rounded(6)
              .bg(t.background)
              .child(div().text_size(13).text_color(t.foreground).child(rp.question))
              .when(Boolean(rp.detail), (e) => e.child(div().text_size(12).text_color(t.dim).child(rp.detail))),
          ),
        )
        .child(body)
        .when(Boolean(rp.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(rp.error)));
    };

    const toggleFor = (addr, cx) => {
      if (this.collapsed.has(addr)) this.collapsed.delete(addr);
      else this.collapsed.add(addr);
      store.set("collapsed", JSON.stringify([...this.collapsed]));
      cx.notify();
    };

    const previewArea = (pv) => {
      const lines = pv.text;
      if (pv.stick && lines.length) {
        pv.stick = false;
        const last = lines.length - 1;
        this.pvScroll.scroll_to_item(last);
        // Once more after this frame's layout (wrapped lines are measured then).
        cx.timer.after(50, (cx) => {
          if (!this.live || this.preview !== pv) return;
          this.pvScroll.scroll_to_item(last);
          cx.notify();
        });
      }
      return v_flex()
        .id(`preview-${pv.address}`)
        .w_full()
        .gap(3)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => cx.stop_propagation())
        .child(
          v_flex()
            .id(`preview-text-${pv.address}`)
            .w_full()
            .max_h(240)
            .overflow_y_scrollbar()
            .track_scroll(this.pvScroll)
            .p(8)
            .rounded(6)
            .bg(t.background)
            .font_family(settings().font_family ?? "JetBrains Mono")
            .text_size(11)
            .line_height("15px")
            .text_color(t.muted)
            .when(!lines.length, (el) => el.child(div().text_color(t.dim).child(pv.loaded ? "Empty screen" : "Loading…")))
            // Lines wrap at the box width (spaces kept); a line of only rule characters is one thin divider.
            .children(lines.map((l) => (RULE.test(l) ? div().h(1).my(4).bg(t.border) : div().child(l || " ")))),
        )
        .when(Boolean(pv.error), (el) => el.child(div().text_size(11).text_color(t.blocked).child(pv.error)));
    };

    // opts: nested = drawn inside a parent; kids = number of nested descendants; open/attn = group state.
    const card = (r, opts = {}) => {
      const a = r.a;
      const sub = opts.nested ? null : r.sub;
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
        .on_click((_e, cx) => (this.justDismissed() ? null : this.go(a, cx)))
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
                    .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(a.paneless ? a.name : a.space_name || r.tabShown || r.program))
                    .when(Boolean(a.space_name && r.tabShown), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(`/ ${r.tabShown}`)))
                    .when(Boolean(r.pr), (el) => el.child(prPill(r)))
                    .child(div().flex_1())
                    .child(div().flex_none().flex().justify_end().whitespace_nowrap().overflow_hidden().text_size(11).text_color(blocked ? t.blocked : t.dim).child(timeText(r))),
                )
                .when(Boolean(sub), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(`↳ sub-agent of ${sub}`)))
                .child(
                  h_flex()
                    .gap(6)
                    .items_start()
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .max_h(34)
                        .overflow_hidden()
                        .text_size(12)
                        .line_height("17px")
                        .text_color(r.report ? (blocked ? t.blocked : t.muted) : t.dim)
                        .child(r.report || r.program || " "),
                    )
                    .child(
                      div()
                        .id(`eye-${a.address}`)
                        .flex_none()
                        .size(18)
                        .rounded(5)
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_pointer()
                        .text_color(this.preview?.address === a.address ? t.foreground : t.muted)
                        .hover((s) => s.bg(t.hover).text_color(t.foreground))
                        .tooltip("Show screen")
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((_e, cx) => {
                          cx.stop_propagation();
                          this.togglePreview(a, cx);
                        })
                        .child(svg(ICONS + "eye.svg").size(16)),
                    )
                    .when(a.status !== "working", (el) =>
                      el.child(
                        div()
                          .id(`reply-${a.address}`)
                          .flex_none()
                          .size(18)
                          .rounded(5)
                          .flex()
                          .items_center()
                          .justify_center()
                          .cursor_pointer()
                          .text_color(this.reply?.address === a.address ? t.foreground : t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .tooltip("Reply")
                          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                          .on_click((_e, cx) => {
                            cx.stop_propagation();
                            this.openReply(a, cx);
                          })
                          .child(svg(ICONS + "reply.svg").size(16)),
                      ),
                    ),
                )
                .when(opts.kids > 0, (el) =>
                  el.child(
                    h_flex()
                      .id(`tg-${a.address}`)
                      .flex_none()
                      .self_start()
                      .gap(4)
                      .px(4)
                      .py(1)
                      .rounded(5)
                      .items_center()
                      .text_size(11)
                      .text_color(t.muted)
                      .cursor_pointer()
                      .hover((s) => s.bg(t.hover).text_color(t.foreground))
                      .tooltip(opts.open ? "Hide children" : "Show children")
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .on_click((_e, cx) => {
                        cx.stop_propagation();
                        toggleFor(a.address, cx);
                      })
                      .child(svg(ICONS + "branch.svg").size(12).flex_none())
                      .child(`${opts.kids} ${opts.kids === 1 ? "child" : "children"}`)
                      .when(opts.attn, (e) => e.child(div().flex_none().size(12).rounded(6).bg(t.blocked).text_color(t.background).text_size(9).font_bold().flex().items_center().justify_center().tooltip("A child needs you").child("?")))
                      .child(svg(ICONS + (opts.open ? "chevron-down.svg" : "chevron-right.svg")).size(12).flex_none()),
                  ),
                )
                .when(this.reply?.address === a.address, (el) => el.child(replyArea(this.reply)))
                .when(this.preview?.address === a.address, (el) => el.child(previewArea(this.preview))),
            ),
        );
    };

    // A card with its children under it, indented along a vertical line.
    const node = (r, nested) => {
      const ad = r.a.address;
      const kids = kidsShown(ad);
      const open = !this.collapsed.has(ad);
      return v_flex()
        .flex_none()
        .gap(8)
        .child(card(r, { nested, kids: kids.length, open, attn: kids.length > 0 && attention(ad) }))
        .when(kids.length > 0 && open, (el) =>
          el.child(v_flex().ml(8).pl(8).gap(8).border_l(1).border_color(t.border).children(kids.map((k) => node(shownBy.get(k), true)))),
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
            .children(rows.map((e) => node(e.r, false)))
        );
    };

    const chip = (id, label, on, onClick, n) =>
      h_flex()
        .id(id)
        .flex_none()
        .h(30)
        .px(11)
        .gap(5)
        .items_center()
        .rounded(8)
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
        if (this.replyFocus) return; // typing in a reply box: its own handler owns the keys
        if (k === "escape") return this.reply ? this.closeReply(cx) : this.preview ? this.closePreview(cx) : this.close(cx);
        if ((k === "e" || k === "space" || k === " ") && !this.searchFocus && !e.modifiers.platform && !e.modifiers.control) {
          const a = agentBy.get(this.sel);
          if (a) this.togglePreview(a, cx);
          return cx.stop_propagation();
        }
        if (k === "r" && !this.searchFocus && !e.modifiers.platform && !e.modifiers.control) {
          const a = agentBy.get(this.sel);
          if (a && a.status !== "working") this.openReply(a, cx);
          return cx.stop_propagation();
        }
        const empty = !this.input.value();
        if (k === "up" || k === "down" || (empty && (k === "left" || k === "right"))) this.move(k, cx);
        else if (k === "enter") this.go(agentBy.get(this.sel), cx);
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
      .when(Boolean(this.notice), (el) => el.child(div().flex_none().text_size(12).text_color(t.blocked).child(this.notice)))
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
          .child(
            h_flex()
              .flex_none()
              .gap(8)
              .pr(40) // close button (28) + header gap (12): control ends where the search input ends
              .items_center()
              .child(div().text_size(11.5).text_color(t.dim).child("PR"))
              .child(
                h_flex()
                  .w(260) // same width as the search input
                  .flex_none()
                  .h(30)
                  .p(2)
                  .gap(2)
                  .items_center()
                  .rounded(8)
                  .border_1()
                  .border_color(t.border)
                  .children(
                    PR_FILTERS.map((f) =>
                      h_flex()
                        .id(`pf-${f.id}`)
                        .h_full()
                        .flex_1()
                        .items_center()
                        .justify_center()
                        .rounded(6)
                        .text_size(12)
                        .cursor_pointer()
                        .when(fl.pr === f.id, (el) => el.bg(t.selected).text_color(t.foreground).font_medium())
                        .when(fl.pr !== f.id, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
                        .on_click(() => setFilter({ pr: f.id }))
                        .child(f.label),
                    ),
                  ),
              ),
          ),
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
      .on_mouse_down("left", (_e, cx) => (this.justDismissed() ? null : this.close(cx)))
      .child(panel);
  }
}
