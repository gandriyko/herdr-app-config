import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, theme, run, window, keys, exec, shared, openOverlay } from "herdr";

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
    this.git = {}; // keyOf -> { branch, ahead, behind }, null: not a repo
    this.checked = {}; // keyOf -> when it was last asked
    // The active space's branch: asked when the space or its folder moves, after a checkout in the
    // branch picker, and every 30 s. From a timer, not render(): a task spawned with render's cx never runs.
    // ponytail: a 1 s compare of a string and a number, no exec unless something changed.
    // One git at a time, and a place is asked again only 30 s after the last ask, answered or not:
    // a hung or failing git (an unreachable machine) must not start a new one every second.
    const tick = (cx) => {
      if (this.asking) return;
      const key = keyOf(spaces().find(p => p.active), panes());
      if (!JSON.parse(key)[1]) return;
      const at = this.checked[key];
      if (at === undefined || Date.now() - at > 30000 || Number(shared("branch.switched") ?? 0) > at) this.ask(key, cx);
    };
    tick(cx);
    cx.timer.every(2000, tick);
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
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
