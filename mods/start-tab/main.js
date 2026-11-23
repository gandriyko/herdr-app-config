import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, knownAgents, run, props, shared, setShared } from "herdr";

// The last agents each machine reported, shown at once while knownAgents() checks again.
const KNOWN = "start-tab.agents";

// A tab that keeps a space open after its last real tab closed (tabs-copy opens it).
// Picking something opens it as a new tab in this space and closes this one.
export default class StartTab extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    const machine = this.space()?.machine ?? null;
    this.agents = shared(KNOWN)?.[machine ?? ""] ?? [];
    cx.spawn(async (cx) => {
      try {
        const fresh = await knownAgents({ on: machine });
        if (JSON.stringify(fresh) === JSON.stringify(this.agents)) return;
        this.agents = fresh;
        setShared(KNOWN, { ...shared(KNOWN), [machine ?? ""]: fresh });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  space() {
    const id = props()?.space;
    return spaces().find((s) => s.id === id) ?? spaces().find((s) => s.active);
  }

  launch(args) {
    const space = this.space();
    if (!space) return;
    const mine = panes().find((p) => p.mod === "start-tab" && space.tabs.some((t) => t.id === p.tab));
    run("tab.new", { space: space.id, folder: props()?.folder || space.folder || undefined, ...args });
    if (mine) run("tab.close", { id: mine.tab });
  }

  render() {
    const t = theme();
    const installed = this.agents.filter((a) => a.installed);
    const row = (id, icon, name, hint, action) => h_flex().id(id).h(34).px(12).gap(10).rounded(7).items_center()
      .text_color(t.foreground).hover((s) => s.bg(t.selected)).on_click(action)
      .child(icon).child(div().flex_1().child(name)).child(div().text_size(11).text_color(t.dim).child(hint));
    const agentIcon = (a) => a.tint ? svg(a.icon).size(16).text_color(t.foreground) : image(a.icon).size(16);
    return div().size_full().flex().items_center().justify_center().bg(t.background).text_size(13)
      .id("start-tab").track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "0" || e.key === "t") return this.launch({});
        const a = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (a) this.launch({ name: a.name, argv: a.run });
      })
      .child(v_flex().w(320).gap(2).p(8).rounded(10).border(1).border_color(t.border).bg(t.raised)
        .child(div().px(12).pt(6).pb(8).text_size(15).child(this.space()?.name ?? "Space"))
        .child(row("terminal", svg("icons/shell.svg").size(16), "Terminal", "T", () => this.launch({})))
        .child(div().px(12).pt(8).pb(4).text_size(11).text_color(t.dim).child("Start an agent"))
        .children(installed.map((a, i) => row(a.key, agentIcon(a), a.name, i < 9 ? String(i + 1) : "", () => this.launch({ name: a.name, argv: a.run }))))
        .when(installed.length === 0, (el) => el.child(div().px(12).py(6).text_color(t.dim)
          .child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))));
  }
}
