import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, agents, theme, run, window, keys, exec, shared, setShared, openOverlay, closeOverlay, props } from "herdr";

// Keep the computer awake; the display may still sleep. macOS: `caffeinate -ims` (no idle, disk or on-power sleep);
// Linux: `systemd-inhibit --what=idle:sleep` around a `sleep`. Neither found (no systemd, Windows): no button.
const KEEPERS = {
  caffeinate: (secs) => `caffeinate -ims -t ${secs}`,
  "systemd-inhibit": (secs) => `systemd-inhibit --what=idle:sleep --who=Herdr --why='Keep awake' sleep ${secs}`,
};
// The choice is shared state, so the menu popup (another copy of this mod) and the bar agree:
// { mode: "off" | "agents" | "timed", until } — "agents": while any agent is working; "timed": until `until` (ms).
const AWAKE = "status-copy.awake";
const AWAKE_MENU = { width: 230, height: 204 };
const AGENT_SPAN = 600; // s: one caffeinate in "agents" mode; a fresh one replaces it a minute before it ends
const awakeChoice = () => shared(AWAKE) ?? { mode: "off" };
const left = (until) => {
  const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}` : `${min}m`;
};
// Ends one keeper of ours: only if that pid still is one (a stale pid may be another process by now).
// Linux cuts comm to 15 chars ("systemd-inhibit" fits); its `sleep` child outlives it but holds no lock.
const stop = (pid) => pid ? exec("/bin/sh", ["-c", `case "$(ps -p ${Number(pid)} -o comm=)" in *caffeinate|*systemd-inhibit) kill ${Number(pid)};; esac`]).catch(() => {}) : null;

// Where a space works now: its focused terminal's folder, else the first known one,
// else where the space was made (the same rule the spaces list uses).
function place(sp, ps) {
  const tabs = new Set((sp?.tabs ?? []).map(c => c.id));
  return ps.find(p => p.focused && tabs.has(p.tab))?.cwd
    ?? ps.find(p => tabs.has(p.tab) && p.cwd)?.cwd ?? sp?.folder ?? null;
}
const keyOf = (sp, ps) => JSON.stringify([sp?.machine ?? null, place(sp, ps)]);

const PICKER = { width: 460, height: 560 };

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.menu = props()?.overlay ?? null; // opened as the keep-awake menu: only that, no git, no caffeinate
    if (this.menu) return;
    // The caffeinate this bar runs: { pid, ends (ms) }. One left by a reload or crash is ended first.
    this.caff = null; this.label = null;
    let old = null; try { old = localStorage.getItem("caffPid"); } catch {}
    if (old) stop(old);
    this.keeper = null; // the keep-awake program found on this computer; until then no button
    cx.spawn(async (cx) => {
      const r = await exec("/bin/sh", ["-c", "if command -v caffeinate >/dev/null; then echo caffeinate; elif command -v systemd-inhibit >/dev/null; then echo systemd-inhibit; fi"]).catch(() => null);
      const name = r?.stdout.trim();
      if (KEEPERS[name]) { this.keeper = name; cx.notify(); }
    });
    this.git = {}; // keyOf -> { branch, ahead, behind }, null: not a repo
    this.checked = {}; // keyOf -> when it was last asked
    // The active space's branch: asked when the space or its folder moves, after a checkout in the
    // branch picker, and every 30 s. From a timer, not render(): a task spawned with render's cx never runs.
    // ponytail: a 1 s compare of a string and a number, no exec unless something changed.
    // One git at a time, and a place is asked again only 30 s after the last ask, answered or not:
    // a hung or failing git (an unreachable machine) must not start a new one every second.
    const tick = (cx) => {
      this.awake(cx);
      if (this.asking) return;
      const key = keyOf(spaces().find(p => p.active), panes());
      if (!JSON.parse(key)[1]) return;
      const at = this.checked[key];
      // contract: branch.switched is written by branch-picker, changes-copy; optional, falls back to 0 (no forced refresh) when missing
      if (at === undefined || Date.now() - at > 30000 || Number(shared("branch.switched") ?? 0) > at) this.ask(key, cx);
    };
    tick(cx);
    cx.timer.every(2000, tick);
  }

  // Runs or ends caffeinate to match the choice; from the 2 s tick. Each caffeinate has its own -t, so one left
  // behind ends by itself. One start or stop at a time.
  awake(cx) {
    if (this.caffBusy || !this.keeper) return;
    let c = awakeChoice();
    if (c.mode === "timed" && Date.now() >= c.until) { setShared(AWAKE, c = { mode: "off" }); }
    const want = c.mode === "timed" || (c.mode === "agents" && agents().some((a) => a.status === "working"));
    const label = c.mode === "timed" ? left(c.until) : null;
    if (label !== this.label) { this.label = label; cx.notify(); } // the time left in the bar, redrawn once a minute
    const ends = c.mode === "timed" ? c.until : Date.now() + AGENT_SPAN * 1000;
    const fresh = this.caff && (c.mode === "timed" ? Math.abs(this.caff.ends - c.until) < 5000 : this.caff.ends - Date.now() > 60000);
    if (want === Boolean(this.caff) && (!want || fresh)) return;
    this.caffBusy = true;
    const old = this.caff;
    cx.spawn(async (cx) => {
      try {
        if (want) {
          const secs = Math.max(1, Math.round((ends - Date.now()) / 1000));
          const r = await exec("/bin/sh", ["-c", `${KEEPERS[this.keeper](secs)} >/dev/null 2>&1 & echo $!`]);
          const pid = parseInt(r.stdout, 10);
          this.caff = pid ? { pid, ends } : null;
        } else this.caff = null;
        try { this.caff ? localStorage.setItem("caffPid", String(this.caff.pid)) : localStorage.removeItem("caffPid"); } catch {}
        if (old) await stop(old.pid);
      } finally { this.caffBusy = false; }
      cx.notify(); // the icon shows whether caffeinate runs now
    });
  }

  async close() {
    if (this.caff) await stop(this.caff.pid);
  }

  // The keep-awake button: lit while caffeinate runs; click opens the menu above the bar.
  awakeButton(t) {
    const c = awakeChoice(), on = Boolean(this.caff);
    const tip = c.mode === "timed" ? `Keeping the computer awake for ${left(c.until)} more`
      : c.mode === "agents" ? `Keeping the computer awake while an agent works${on ? " (one is working now)" : " (none working now)"}`
      : "The computer may sleep — click to keep it awake";
    return h_flex().id("awake").h(20).px(6).gap(4).items_center().rounded(5).cursor_pointer()
      .text_color(on ? t.working : c.mode === "agents" ? t.foreground : t.dim).hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "status-copy", kind: "popup", ...AWAKE_MENU,
          at: { x: Math.max(8, e.position.x - AWAKE_MENU.width + 24), y: Math.max(8, e.position.y - AWAKE_MENU.height - 14) } });
      })
      .child(svg("mods/status-copy/icons/coffee.svg").size(13))
      .when(Boolean(this.label), (el) => el.child(this.label));
  }

  // The popup: pick how long to stay awake. Writes the shared choice; the bar acts on it.
  menuView() {
    const t = theme(), c = awakeChoice();
    const item = (id, text, choice, current) => h_flex().id(id).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => { setShared(AWAKE, choice()); closeOverlay(this.menu); })
      .child(div().size(14).flex_none().child(current ? svg("mods/status-copy/icons/check.svg").size(14).text_color(t.accent) : ""))
      .child(text);
    const hours = (h) => item(`awake-${h}h`, `${h} hour${h > 1 ? "s" : ""}`, () => ({ mode: "timed", until: Date.now() + h * 3600000 }), false);
    return v_flex().size_full().p(6).gap(1).bg(t.popover).text_size(12).text_color(t.foreground)
      .child(item("awake-off", "Allow sleep", () => ({ mode: "off" }), c.mode === "off"))
      .child(item("awake-agents", "While an agent is working", () => ({ mode: "agents" }), c.mode === "agents"))
      .child(div().h(1).mx(4).my(2).bg(t.border))
      .children([1, 2, 3, 5].map(hours))
      .when(c.mode === "timed", (el) => el.child(div().px(8).pt(2).text_size(10).text_color(t.dim).child(`${left(c.until)} left`)));
  }

  // One place's branch and ahead/behind, read-only (no index writes, no locks:
  // the same shape the spaces list uses). A machine away keeps the last answer.
  ask(key, cx) {
    this.checked[key] = Date.now();
    this.asking = true;
    cx.spawn(async (cx) => {
      const [on, cwd] = JSON.parse(key), before = JSON.stringify([this.git[key]]);
      try {
        const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch", "-uno"], { cwd, on });
        if (r.code !== 0) this.git[key] = null;
        else {
          const info = { branch: null, ahead: 0, behind: 0 };
          for (const line of r.stdout.split("\n")) {
            if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
            else if (line.startsWith("# branch.ab ")) {
              const [a, b] = line.slice(12).split(" ");
              info.ahead = Math.abs(parseInt(a, 10)) || 0;
              info.behind = Math.abs(parseInt(b, 10)) || 0;
            }
          }
          this.git[key] = info;
        }
      } catch { /* couldn't ask: keep what it showed, the timer asks again in 30 s */ }
      this.asking = false;
      // A redraw is the whole window: only when the branch or ahead/behind changed.
      if (JSON.stringify([this.git[key]]) !== before) cx.notify();
    });
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  // The branch: click opens the branch picker just above the status bar.
  branchButton(space, t) {
    const g = this.git[keyOf(space, panes())];
    const branch = g?.branch ?? space?.branch; // Herdr's own until git answers
    if (!branch) return null;
    const ab = g && (g.ahead || g.behind) ? `${g.ahead ? `↑${g.ahead}` : ""}${g.behind ? ` ↓${g.behind}` : ""}`.trim() : "";
    return h_flex().id("branch").h(20).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip(`Branch ${branch}${ab ? ` · ${ab}` : ""} — click to switch`)
      // A mouse down has the pointer's window position; the popup opens upward from it.
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "branch-picker", kind: "popup", ...PICKER, props: { space: space.id },
          at: { x: Math.max(8, e.position.x - 16), y: Math.max(8, e.position.y - PICKER.height - 14) } });
      })
      .child(svg("mods/status-copy/icons/branch.svg").size(13))
      .child(div().max_w(260).truncate().child(branch))
      .when(Boolean(ab), el => el.child(div().text_color(t.dim).child(ab)));
  }

  render() {
    if (this.menu) return this.menuView();
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/status-copy/icons/${icon}.svg`).size(13)).child(text);
    const branch = this.branchButton(space, t);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(branch), el => el.child(branch))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(Boolean(this.keeper), (el) => el.child(this.awakeButton(t)))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
