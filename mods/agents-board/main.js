// Agents as a kanban: Needs you, Working, Done (unseen).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle, TextView } from "gpui-base";
import { agents, terminals, panes, spaces, run, theme, settings, shared, setShared, closeOverlay, props, exec, hc } from "herdr";
import { AskingTracker } from "./asking.js";
import { dropKey, headline } from "./headline.js";
import { isSelectMenu, parseOptions, parseQuestion, parseSuggestion, sameOptions } from "./reply.js";
import { PR_FILTERS, duration, glyph, icon, prColor } from "./card.js";
import { CHECKS_WORD, RECHECK, askAgain, branchKey, jiraProjects, namedKey, newPrState, prMap, prOf, refreshPrs } from "./prs.js";

const ICONS = "mods/agents-board/";
const SEND_TIMEOUT = 3000; // ms a reply `hc send` may wait for the agent's input line to clear (a normal send takes < 1 s)
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

// The screen tail for programs without a reply marker: blank runs collapsed, last 30 lines.
function tailLines(text) {
  let lines = text.split("\n");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines = lines.filter((l, i) => l.trim() || (i > 0 && lines[i - 1].trim()));
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.slice(-30);
}

// What the reply area shows for a screen: { mode, lines, question, detail, tabs, suggestion, options, select }.
function parseScreen(text) {
  const options = parseOptions(text);
  const q = parseQuestion(text);
  const p = { mode: "menu", lines: null, question: q.question || "", detail: q.detail || "", tabs: q.tabs || null, options, select: options.length > 0 && isSelectMenu(text), suggestion: options.length ? null : parseSuggestion(text) };
  if (options.length) return p;
  if (p.question) return { ...p, mode: "reply", lines: p.question.split("\n"), question: "" };
  return { ...p, mode: "screen", lines: tailLines(text) };
}
const RULE = /^[\s─━═\-_]*[─━═]{3,}[\s─━═\-_]*$/;
// One screen line as HTML: escaped, leading and repeated spaces kept (single spaces still wrap), empty → one space.
const textHtml = (l) =>
  l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/^ +| {2,}/g, (s) => "&nbsp;".repeat(s.length)) || "&nbsp;";
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
    this.wasWorking = new Set(); // addresses working at the last render
    this.busy = false;
    this.again = false;
    this.q = "";
    this.sel = null; // address of the selected card
    this.cols = []; // addresses per column in visual order (parent, then its children), set by render, for the keys
    this.colIdx = []; // per column, the index of the top-level card holding each address (for scrolling)
    store.set("collapsed", ""); // an earlier version kept folded parents here
    this.treeKey = null; // the parent links the cache below was built from
    this.parentOf = new Map(); // child address -> parent address (both agents, no cycles)
    this.kidsOf = new Map(); // parent address -> child addresses
    this.done = false;
    this.going = false; // a paneless agent is being given a pane
    this.notice = null; // a one-line error under the header
    this.pvScroll = ScrollHandle.new(); // the reply area's text box
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
    this.reply = null; // { address, mode, lines, question, detail, tabs, suggestion, options, select, typing, sending, error, input, want, busy, again, sig, loaded, stick } while a reply area is open
    this.replyFocus = false;
    this.overText = false; // pointer over the reply text: presses go to the text selection, not to the panel
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
    this.pvScroll.release();
    for (const s of this.scrolls) s.release();
    closeOverlay(props().overlay);
  }

  // Drops the reply area and its input (no screen text is kept anywhere).
  dropReply() {
    this.replySeq++;
    this.replyFocus = false;
    this.overText = false;
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

  async readScreen(address) {
    const r = await hc(["read", address]);
    return r?.code === 0 ? r.stdout : "";
  }

  // Opens the reply area at once ("Loading…") and reads the screen; it reads again when the agent's
  // turn or status changes while it is open.
  openReply(a, cx) {
    if (!a || !this.live) return;
    if (this.reply?.address === a.address) return this.closeReply(cx);
    if (this.justDismissed() && this.dismiss.address === a.address) return; // the press that closed it
    this.dropReply();
    const reply = {
      address: a.address, sending: false, error: null, mode: "loading", lines: null, question: "", detail: "", tabs: null,
      suggestion: null, options: [], select: false, typing: null, hint: "Reply to agent…", want: this.replyKey(a.address),
      busy: false, again: false, sig: "", loaded: false, stick: true, input: null,
    };
    reply.input = this.makeInput(reply.hint);
    this.reply = reply;
    this.sel = a.address;
    cx.notify();
    reply.input.focus();
    this.refreshReply(cx);
  }

  replyKey(address) {
    return `${terminals().find((x) => x.address === address)?.turn}|${this.byAddr?.get(address)?.status}`;
  }

  // Reads the screen for the open reply area. One read at a time; a change that arrives meanwhile reads once more.
  // The last good result stays on a failed read. Only the parsed fields are kept, never the screen text.
  refreshReply(cx) {
    const r = this.reply;
    if (!r || !this.live) return;
    if (r.busy) {
      r.again = true;
      return;
    }
    r.busy = true;
    cx.spawn(async (cx) => {
      try {
        do {
          r.again = false;
          let text = null, err = null;
          try {
            const res = await hc(["read", r.address, "--lines", "0"]); // the screen only: history reads can scroll the app and take seconds
            if (res?.code === 0) text = String(res.stdout);
            else err = String(res?.stderr || res?.stdout || "Failed").trim().split("\n")[0] || "Failed";
          } catch (e) {
            err = String(e?.message ?? e).split("\n")[0];
          }
          if (!this.live || this.reply !== r) return;
          let changed = false;
          if (text != null) {
            if (r.sending || r.typing) continue; // a menu key or a typed answer is in progress; it re-reads itself
            const p = parseScreen(text);
            const sig = JSON.stringify(p);
            if (!r.loaded || sig !== r.sig) {
              r.sig = sig;
              this.applyParsed(r, p);
              changed = true;
            }
          } else if (!r.loaded) {
            r.loaded = true;
            r.mode = "failed";
            changed = true;
          }
          if (err !== r.loadError) {
            r.loadError = err;
            changed = true;
          }
          if (changed) cx.notify();
        } while (r.again && this.live && this.reply === r);
      } finally {
        r.busy = false;
      }
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

  // Shows a parsed screen: a menu (question, tabs, buttons), else the agent's last reply, else the screen tail;
  // below it a text box, kept (with what was typed) unless the prompt suggestion changed.
  applyParsed(r, p) {
    r.mode = p.mode;
    r.lines = p.lines;
    r.question = p.question;
    r.detail = p.detail;
    r.tabs = p.tabs;
    r.options = p.options;
    r.select = p.select;
    r.suggestion = p.suggestion;
    r.loaded = true;
    r.stick = true;
    if (p.options.length) {
      if (r.input) {
        try {
          r.input.release();
        } catch (_e) {}
        r.input = null;
      }
      this.replyFocus = false;
      return;
    }
    const hint = p.suggestion || "Reply to agent…";
    if (r.input && (r.hint === hint || r.input.value())) return;
    const had = this.replyFocus || !r.input;
    try {
      r.input?.release();
    } catch (_e) {}
    r.hint = hint;
    r.input = this.makeInput(hint);
    if (had) r.input.focus();
  }

  // The reply after a menu key: the same as a read, and the sending state ends.
  fillReply(r, text) {
    const p = parseScreen(text);
    r.sig = JSON.stringify(p);
    r.typing = null; // the free-text option being answered
    r.sending = false;
    this.applyParsed(r, p);
  }

  // Enter in the box: a free-text answer, else the typed text or Claude's suggestion.
  submitReply(cx) {
    const r = this.reply;
    if (!r || r.sending) return;
    const text = r.input?.value().trim() || (r.typing ? "" : r.suggestion);
    if (!text) return;
    if (r.typing) return this.followUp(r, [["keys", r.address, String(r.typing)], 300, ["send", "--force", r.address, text]], cx);
    // `hc send` waits while the input line holds a person's unsent draft (Claude's gray suggestion doesn't count,
    // tested); give up after SEND_TIMEOUT and say why.
    this.runReply(["send", r.address, text], r, cx, null, SEND_TIMEOUT);
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
  // timeout (ms): run `hc` through exec so it is killed when it takes longer.
  runReply(args, r, cx, after, timeout) {
    r.sending = true;
    r.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let err = null;
      const t0 = Date.now();
      try {
        const res = await (timeout ? exec("hc", args, { timeout }) : hc(args));
        if (res?.code !== 0) err = String(res?.stderr || res?.stdout || "Failed").trim().split("\n")[0] || "Failed";
      } catch (e) {
        err = String(e?.message ?? e).split("\n")[0];
      }
      if (err && timeout && Date.now() - t0 >= timeout - 500)
        err = "Not sent: hc send is waiting for an unsent draft in the agent's input line. Open its terminal.";
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

    // contract: jira.settings is written by the jira mod ({ site: "https://x.atlassian.net", project: "DA, OPS", … }); optional.
    const jiraSet = shared("jira.settings");
    const jiraSite = jiraSet?.site;
    // Keys in the agent's texts count only for the saved projects; any when none is saved.
    const projects = jiraProjects(jiraSet);
    // The Jira key the agent names (title, tab, report), or null: its own task, even on a branch another agent made.
    // The branch's key when the agent mentions it anywhere (namedKey). The space name counts too, last:
    // the jira mod names the space after its task, which beats a stale session title (DA-20408 on DA-20571-…).
    const textKey = (a, branch) => {
      const term = termBy.get(a.address), tb = tabBy.get(a.tab);
      const texts = [term?.title, a.title, tb?.named ? tb.name : null, a.name, term?.report, spaceBy.get(a.space)?.name];
      return namedKey(texts.filter(Boolean).join("\n").toUpperCase(), projects, branch);
    };

    // Where each agent is, for PRs; a remote one has no local gh. `key`: the Jira key it names, whose PR it gets.
    const placeOf = new Map();
    for (const a of list) {
      if (a.address.includes("/")) continue;
      if (a.paneless) {
        const c = termBy.get(a.address)?.cwd;
        if (c) placeOf.set(a.address, { cwd: c, branch: null, key: textKey(a) });
        continue;
      }
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const cwd = p?.cwd || sp?.folder;
      const branch = p?.branch ?? sp?.branch ?? null;
      if (cwd) placeOf.set(a.address, { cwd, branch, key: textKey(a, branch) });
    }
    const placesKey = JSON.stringify([...placeOf.values()]);
    if (placesKey !== this.placesKey) {
      this.placesKey = placesKey;
      this.places = [...placeOf.values()];
      this.kick(cx);
    }
    // An agent with no PR pill that stops working may have just opened a PR: ask its repo now and once more
    // RECHECK later (askAgain in ./prs.js).
    const working = new Set(list.filter((a) => a.status === "working").map((a) => a.address));
    let stopped = false;
    for (const ad of this.wasWorking) if (!working.has(ad) && askAgain(this.pr, placeOf.get(ad))) stopped = true;
    this.wasWorking = working;
    if (stopped) { this.kick(cx); cx.timer.after(RECHECK + 1000, (cx) => this.kick(cx)); }
    const prFor = (a) => prOf(this.pr, placeOf.get(a.address));
    // The Jira pill (only with a site): the key the agent names, else its branch's (da-20457-fix -> DA-20457).
    const jiraFor = (a) =>
      jiraSite ? (placeOf.get(a.address)?.key ?? textKey(a)) ?? branchKey(placeOf.get(a.address)?.branch) : null;

    // One record per agent with everything the card shows.
    const info = (a) => {
      const tb = tabBy.get(a.tab);
      const term = termBy.get(a.address);
      const p = paneBy.get(a.pane);
      const sp = spaceBy.get(a.space);
      const at = a.paneless ? null : a.status === "working" ? tb?.working_since : tb?.changed_at;
      const prog = a.program?.name ?? "agent";
      const jira = jiraFor(a);
      // The headline and the report by the rule shared with the agents mod (headline.js).
      // Line 1: space / headline when there is a report too; line 2: the report, else the headline.
      const { head, report } = headline({
        tab: tb?.named && !a.paneless ? tb.name ?? "" : "",
        text: clean(term?.report) || clean(a.title),
        prog, progKey: a.program?.key, jiraKey: jira,
      });
      const par = term?.parent ? termBy.get(term.parent) : null;
      const parentAgent = term?.parent ? agentBy.get(term.parent) : null;
      return {
        a,
        at: at ?? null,
        report: report || head,
        tabShown: report ? head : "",
        program: prog,
        sub: term?.parent ? (parentAgent?.tab_name ?? par?.name ?? "") : null,
        pr: prFor(a),
        jira,
        branch: [placeOf.get(a.address)?.branch].find((b) => b && b !== "HEAD") ?? null,
        // The repo's name (its main checkout's folder), so a worktree's space reads as its repo.
        repo: this.pr.common.get(placeOf.get(a.address)?.cwd)?.replace(/\/\.git\/?$/, "").split("/").pop() || null,
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

    const matches = (r) => {
      if (flSpace && r.a.space !== flSpace) return false;
      if (fl.pr !== "any" && !(fl.pr === "with" ? r.pr : fl.pr === "failing" ? r.pr?.c === "fail" : !r.pr)) return false;
      if (this.q && ![r.program, r.a.space_name, r.a.tab_name, r.repo, r.tabShown, r.report].join("\n").toLowerCase().includes(this.q)) return false;
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
      // Unseen done first (unread check), then seen (idle), each newest first.
      [...entriesOf("done").sort(byNew), ...entriesOf("idle").sort(byNew)],
    ];
    // Visual order for the keys: a card, then its children, depth first.
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
          for (const k of kidsShown(ad)) walk(k);
        };
        walk(e.r.a.address);
      });
      this.cols.push(addrs);
      this.colIdx.push(idx);
    }
    this.byAddr = agentBy;
    if (this.sel && !agentBy.has(this.sel)) this.sel = null;
    // The card left the list (gone, filtered out, or the agent started working): its reply area goes too.
    if (this.reply && (!this.cols.some((c) => c.includes(this.reply.address)))) this.dropReply();
    if (this.reply) {
      // Read again only when this agent's turn or status changed.
      const key = `${termBy.get(this.reply.address)?.turn}|${agentBy.get(this.reply.address)?.status}`;
      if (key !== this.reply.want) {
        this.reply.want = key;
        this.refreshReply(cx);
      }
    }

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

    const PR_COLOR = prColor(t);
    // A small pill in line 1 (PR, Jira): tinted by color, a click runs act without reaching the card.
    const pill = (id, color, tip, act) => h_flex()
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
    // The branch's Jira key; a click opens the issue in the browser.
    const jiraPill = (r) => pill(`jira-${r.a.address}`, t.accent, `Open ${r.jira} in Jira`,
      () => exec("open", [`${jiraSite}/browse/${r.jira}`], { timeout: 10000 }).catch(() => {}))
      .child(r.jira);
    const prPill = (r) => {
      const pr = r.pr;
      const cwd = placeOf.get(r.a.address)?.cwd;
      return pill(`pr-${r.a.address}`, PR_COLOR[pr.c], `PR #${pr.n} · checks ${CHECKS_WORD[pr.c]}`,
        () => exec("gh", ["pr", "view", String(pr.n), "--web"], { cwd, timeout: 10000 }).catch(() => {}))
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
        .on_mouse_down("left", (_e, cx) => this.overText || cx.stop_propagation())
        .on_mouse_down_out((_e, cx) => this.dismissReply(cx))
        .on_click((_e, cx) => cx.stop_propagation())
        .when(rp.mode === "menu" && Boolean(rp.tabs?.length), (el) =>
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
        .when(rp.mode === "menu" && Boolean(rp.question), (el) =>
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
        .when(rp.mode !== "menu", (el) => el.child(textBox(rp)))
        .when(Boolean(rp.loadError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(`Read failed: ${rp.loadError}`)))
        .child(body)
        // A tinted strip with foreground text: plain red 11 px text was hard to read on the dark card.
        .when(Boolean(rp.error), (el) => el.child(div().text_size(12).px(8).py(4).rounded(6).bg(t.blocked + "33").border_1().border_color(t.blocked + "88").text_color(t.foreground).child(rp.error)));
    };

    // The agent's last reply or the screen tail: wrapped lines (spaces kept), a line of only rule characters
    // is one thin divider, scrolled to the bottom after each change (requested now and once after layout).
    const textBox = (rp) => {
      const lines = rp.lines ?? [];
      // Runs of text lines become one selectable block each (so they can be copied); a rule line stays a divider.
      const blocks = [];
      for (const l of lines) {
        if (RULE.test(l)) blocks.push(null);
        // One <p> per screen line: TextView drops <br>, so the lines ran together.
        else if (typeof blocks.at(-1) === "string") blocks[blocks.length - 1] += `<p>${textHtml(l)}</p>`;
        else blocks.push(`<p>${textHtml(l)}</p>`);
      }
      if (rp.stick && lines.length) {
        rp.stick = false;
        const last = blocks.length; // the spacer after the last block, so the last (maybe re-wrapped) row shows whole
        this.pvScroll.scroll_to_item(last);
        for (const ms of [50, 250]) {
          cx.timer.after(ms, (cx) => {
            if (!this.live || this.reply !== rp) return;
            this.pvScroll.scroll_to_item(last);
            cx.notify();
          });
        }
      }
      // The outer box clips and keeps its own height, so the text never draws over the input below.
      // Hover is tracked so the panel's press handlers (stop_propagation, close on backdrop) let a drag select text.
      return div().id(`reply-box-${rp.address}`).on_hover((h) => (this.overText = h)).w_full().flex_none().max_h(240).overflow_hidden().rounded(6).bg(t.background).border_1().border_color(t.border).mb(8).child(
       v_flex()
        .id(`reply-text-${rp.address}`)
        .w_full()
        .max_h(238)
        .overflow_y_scroll() // not _scrollbar(): its wrapper ignores max_h, so the list grew to full height and the outer clip hid the end
        .track_scroll(this.pvScroll)
        .p(8)
        .font_family(settings().font_family ?? "JetBrains Mono")
        .text_size(11)
        .line_height("15px")
        .text_color(t.muted)
        .when(!lines.length, (el) => el.child(div().text_color(t.dim).child(rp.mode === "failed" ? "Could not read the screen" : rp.loaded ? "Empty screen" : "Loading…")))
        .children(blocks.map((b, i) => (b === null ? div().h(1).my(4).bg(t.border) : TextView.html(`reply-text-${rp.address}-${i}`, b).selectable(true))))
        .child(div().h(8).flex_none()),
      );
    };

    // opts: nested = drawn inside a parent.
    const card = (r, opts = {}) => {
      const a = r.a;
      const sub = opts.nested ? null : r.sub;
      const blocked = a.status === "blocked";
      const on = this.sel === a.address;
      const pic = icon(a.program, 16, t.foreground);
      const g = glyph(t, a.status, ICONS);
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
        .hover((s) => s.bg(blocked ? t.blocked + "22" : t.hover))
        .on_click((_e, cx) => (this.justDismissed() ? null : this.go(a, cx)))
        .child(
          h_flex()
            .gap(7)
            .items_start()
            .child(
              v_flex().flex_none().w(16).gap(6).items_center()
                .when(Boolean(pic), (el) => el.child(pic))
                // The glyph slot only with a glyph, so a card with nothing more to show stays low.
                .when(Boolean(g), (el) => el.child(div().flex_none().w(16).h(16).flex().items_center().justify_center().child(g))),
            )
            .child(
              v_flex().flex_1().min_w(0).gap(4)
                .child(
                  h_flex()
                    .gap(7)
                    .items_center()
                    .child(div().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(a.paneless ? a.name : r.repo || (dropKey(a.space_name ?? "", r.jira) || a.space_name) || r.tabShown || r.program))
                    .when(Boolean(a.space_name && r.tabShown), (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(`/ ${r.tabShown}`)))
                    .when(Boolean(r.jira), (el) => el.child(jiraPill(r)))
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
                          .id(`reply-${a.address}`)
                          .flex_none()
                          .size(28) // big hit area; the negative margins keep line 2 and the card height as before
                          .my(-6)
                          .mr(-4)
                          .rounded(6)
                          .flex()
                          .items_center()
                          .justify_center()
                          .cursor_pointer()
                          .text_color(this.reply?.address === a.address ? t.foreground : t.muted)
                          .hover((s) => s.bg(t.hover).text_color(t.foreground))
                          .tooltip("Reply")
                          // Opens on the press: the open area above would close on that press and shift the card
                          // under the pointer before the click ended.
                          .on_mouse_down("left", (_e, cx) => {
                            cx.stop_propagation();
                            this.openReply(a, cx);
                          })
                          .on_click((_e, cx) => cx.stop_propagation())
                          .child(svg(ICONS + "reply.svg").size(16)),
                    ),
                )
                // The git branch, main included: always its own dim line under the report.
                .when(Boolean(r.branch), (el) => el.child(div().min_w(0).truncate().text_size(11).line_height("13px").text_color(t.dim).child(r.branch)))
                .when(this.reply?.address === a.address, (el) => el.child(replyArea(this.reply))),
            ),
        );
    };

    // A card with its children under it, indented along a vertical line.
    const node = (r, nested) => {
      const ad = r.a.address;
      const kids = kidsShown(ad);
      return v_flex()
        .flex_none()
        .gap(8)
        .child(card(r, { nested }))
        .when(kids.length > 0, (el) =>
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
      .on_mouse_down("left", (_e, cx) => this.overText || cx.stop_propagation())
      .text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (this.replyFocus) return; // typing in a reply box: its own handler owns the keys
        if (k === "escape") return this.reply ? this.closeReply(cx) : this.close(cx);
        if (k === "r" && !this.searchFocus && !e.modifiers.platform && !e.modifiers.control) {
          const a = agentBy.get(this.sel);
          if (a) this.openReply(a, cx);
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
                        .flex_auto() // sized by its label, so "Checks failing" fits the 260 px control
                        .px(6)
                        .whitespace_nowrap()
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
      .on_mouse_down("left", (_e, cx) => (this.justDismissed() || this.overText ? null : this.close(cx)))
      .child(panel);
  }
}
