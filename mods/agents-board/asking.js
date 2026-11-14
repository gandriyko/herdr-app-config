// "Asking" detection: an agent that finished its turn on a choice menu or a question needs the person,
// though herdr-core reports it as done/idle. One screen read per (address, turn), never on a timer.
// Pure helpers at module scope; the tracker's state lives in the instance the view creates in init().

const MENU = [/Enter to confirm/, /Esc to cancel/, /^\s*[❯>]\s*\d+\.\s/m, /\(y\/n\)|\[y\/N\]|\[Y\/n\]/i];
const BORDER = /^\s*[─━]{10,}\s*$/;
const BOX_ONLY = /^[\s─━│┃╭╮╰╯┌┐└┘]*$/;
const PROMPT_ONLY = /^\s*[❯>]\s*$/;
const FOOTER = /auto mode|shift\+tab|esc to interrupt|ctrl\+[a-z] to|↻|bypass permissions|accept edits|plan mode|\? for shortcuts/i;
const QUESTION_END = /[?？][\s"'’”)\]*_`]*$/;
const MENU_LINES = 14;
const MAX_ENTRIES = 200;
const DONE_STATES = new Set(["done", "idle"]);

// True when the screen text shows a choice menu, a yes/no prompt, or a reply that ends in a question.
export function isAsking(text) {
  if (!text) return false;
  const lines = text.split("\n");
  // The input box is two border lines around the prompt; the reply or menu sits above the upper one.
  const borders = [];
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) if (BORDER.test(lines[i])) borders.push(i);
  const end = borders.length === 2 ? borders[1] : borders.length === 1 ? borders[0] : lines.length;
  // A menu is drawn right above the input box: only the last few lines count, so text that merely quotes one doesn't.
  const near = lines.slice(0, end).filter((l) => l.trim()).slice(-MENU_LINES).join("\n");
  if (MENU.some((re) => re.test(near))) return true;
  for (let i = end - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || BOX_ONLY.test(l) || PROMPT_ONLY.test(l) || FOOTER.test(l)) continue;
    return QUESTION_END.test(l.trim());
  }
  return false;
}

export class AskingTracker {
  // hc: the host's hc(args); isLive: the view's live flag. A change of an agent's state notifies the view.
  constructor(hc, isLive) {
    this.hc = hc;
    this.isLive = isLive;
    this.seen = new Map(); // address -> { turn, asking }
    this.cur = new Map(); // address -> { turn, status } from the last sync
    this.want = new Map(); // address -> turn, queued for a read
    this.running = false;
  }

  // True for an agent finished on a menu or question, for its current turn only.
  is(address) {
    const e = this.seen.get(address);
    const c = this.cur.get(address);
    return Boolean(e && e.asking && c && e.turn === c.turn && DONE_STATES.has(c.status));
  }

  // Looks at the agents once per render/tick: queues a read for each done/idle agent whose turn wasn't read.
  // Returns the list with asking agents' status turned into "blocked" (and `asking: true`).
  apply(list, terms, cx) {
    const turns = new Map(terms.map((t) => [t.address, t.turn]));
    const gone = new Set(this.seen.keys());
    this.cur = new Map();
    for (const a of list) {
      gone.delete(a.address);
      const turn = turns.get(a.address);
      this.cur.set(a.address, { turn, status: a.status });
      if (!DONE_STATES.has(a.status)) {
        // Working or blocked: nothing to remember, the next finish is a new turn.
        this.seen.delete(a.address);
        this.want.delete(a.address);
        continue;
      }
      if (turn == null) continue;
      if (this.seen.get(a.address)?.turn !== turn && this.want.get(a.address) !== turn) this.want.set(a.address, turn);
    }
    for (const k of gone) {
      this.seen.delete(k);
      this.want.delete(k);
    }
    while (this.seen.size > MAX_ENTRIES) this.seen.delete(this.seen.keys().next().value);
    if (this.want.size) this.pump(cx);
    return list.map((a) => (this.is(a.address) ? { ...a, status: "blocked", asking: true } : a));
  }

  // One read in flight at a time; the rest wait in `want`.
  pump(cx) {
    if (this.running || !this.isLive()) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.isLive() && this.want.size) {
          const [address, turn] = this.want.entries().next().value;
          this.want.delete(address);
          const before = this.is(address);
          let asking = false;
          try {
            const r = await this.hc(["read", address]);
            asking = r?.code === 0 && isAsking(r.stdout);
          } catch {
            asking = false;
          }
          if (!this.isLive()) return;
          // The agent may have left or started working meanwhile: only a still-listed done/idle agent keeps the answer.
          if (!this.cur.has(address) || !DONE_STATES.has(this.cur.get(address).status)) continue;
          this.seen.set(address, { turn, asking });
          if (this.is(address) !== before) cx.notify();
        }
      } finally {
        this.running = false;
      }
    });
  }
}
