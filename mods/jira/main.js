import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { exec, theme, shared, setShared } from "herdr";
import { Buffer } from "buffer";

// My open Jira issues grouped by sprint, plus the project's backlog. Click selects an issue;
// right-click: Go to Jira, Copy key.
// Settings (site, project) live in Herdr's shared state ("jira.settings"); the email and API token
// in the macOS Keychain (service herdr-jira, account = email). Nothing personal is in this repo.
// ponytail: an API token, not OAuth — OAuth needs a registered app with a secret and a local
// redirect server, which a mod can't host.
const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
const backlogJql = (project) => `project = "${project}" AND sprint is EMPTY AND statusCategory != Done ORDER BY rank ASC`;
const SERVICE = "herdr-jira";
const SETTINGS = "jira.settings";
// In progress first, then to do; Jira's order (latest update) within each.
const RANK = { indeterminate: 0, new: 1 };

const basic = (email, token) => "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

// The saved email and auth header, or null.
async function credentials() {
  const [item, token] = await Promise.all([
    exec("security", ["find-generic-password", "-s", SERVICE]),
    exec("security", ["find-generic-password", "-s", SERVICE, "-w"]),
  ]);
  const email = /"acct"<blob>="([^"]*)"/.exec(item.stdout)?.[1];
  if (token.code !== 0 || !email) return null;
  return { email, auth: basic(email, token.stdout.trim()) };
}

async function jira(base, auth, path, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw Object.assign(new Error(`Jira ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.json();
}

// A classic API token works against the site; a token "with scopes" only through Atlassian's gateway
// (read:jira-work and read:jira-user). /myself, not a search: Jira answers an unauthenticated search
// with 200 and no issues. Returns the base that took the credentials; throws Jira's 401/403 if none did.
async function findBase(site, auth) {
  const cloudId = await fetch(`${site}/_edge/tenant_info`).then((r) => r.json()).then((j) => j.cloudId, () => null);
  let rejected = null;
  for (const candidate of [site, ...(cloudId ? [`https://api.atlassian.com/ex/jira/${cloudId}`] : [])]) {
    try { await jira(candidate, auth, "/rest/api/3/myself"); return candidate; }
    catch (e) { if (e.status !== 401 && e.status !== 403) throw e; rejected = e; }
  }
  throw rejected;
}

// The sprint an issue is in now: the active one, else the next planned one, else none.
function sprintOf(sprints) {
  const list = Array.isArray(sprints) ? sprints : [];
  return list.find((s) => s.state === "active") ?? list.find((s) => s.state === "future") ?? null;
}

const normalizeSite = (text) => {
  const site = text.trim().replace(/\/+$/, "");
  return site && !/^https?:\/\//.test(site) ? `https://${site}` : site;
};

export default class Jira extends View {
  init(_props, cx) {
    this.groups = []; this.backlog = []; this.count = 0; this.error = null; this.loading = false;
    this.setup = false; this.editing = false; this.saving = false; this.formError = null; this.savedEmail = null; this.query = "";
    const input = (placeholder) => { const s = InputState.new({ placeholder }); s.on("submit", (_e, cx) => this.save(cx)); return s; };
    this.site = input("https://your-company.atlassian.net");
    this.project = input("Project key for the backlog, e.g. DA");
    this.email = input("Atlassian email");
    this.token = input("API token");
    this.token.set_masked(true);
    this.search = InputState.new({ placeholder: "Search by key or title" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.refresh(cx);
    cx.timer.every(5 * 60 * 1000, (cx) => this.refresh(cx));
  }

  settings() { return shared(SETTINGS) ?? {}; }

  // Fills the form from what is saved; the token field stays empty (empty = keep the saved one).
  fillForm() {
    const s = this.settings();
    this.site.set_value(s.site ?? ""); this.project.set_value(s.project ?? ""); this.email.set_value(this.savedEmail ?? "");
    this.token.set_value(""); this.formError = null;
  }

  openSettings(cx) { this.fillForm(); this.editing = !this.editing; cx.notify(); }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const creds = await credentials(), s = this.settings();
        this.savedEmail = creds?.email ?? null;
        if (!creds || !s.site) {
          if (!this.setup) { this.setup = true; this.fillForm(); }
          this.groups = []; this.backlog = []; this.count = 0; return;
        }
        this.setup = false;
        // Once per session: a token that stopped working would otherwise look like "no issues".
        if (!this.verified) {
          const base = await findBase(s.site, creds.auth); this.verified = true;
          if (base !== s.base) setShared(SETTINGS, { ...s, base });
        }
        const base = this.settings().base ?? s.site;
        // The sprint field's id differs per site; ask once. Without it issues still show, under "No sprint".
        this.sprintField ??= await jira(base, creds.auth, "/rest/api/3/field")
          .then((all) => all.find((f) => f.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")?.id ?? null, () => null);
        // ponytail: first 100 of mine and 50 of the backlog; page with nextPageToken if that's ever too few.
        const fields = ["summary", "status", "issuetype", "labels", ...(this.sprintField ? [this.sprintField] : [])];
        const search = (jql, fields, maxResults) => jira(base, creds.auth, "/rest/api/3/search/jql", { jql, fields, maxResults });
        const [{ issues = [] }, { issues: backlog = [] }] = await Promise.all([
          search(MINE_JQL, fields, 100),
          s.project ? search(backlogJql(s.project), ["summary", "status", "issuetype", "labels"], 50) : { issues: [] },
        ]);
        const groups = new Map();
        for (const issue of issues) {
          const sprint = sprintOf(issue.fields[this.sprintField]);
          const id = sprint ? `s${sprint.id}` : "none";
          if (!groups.has(id)) groups.set(id, { id, name: sprint?.name ?? "No sprint", order: sprint ? (sprint.state === "active" ? 0 : 1) : 2, issues: [] });
          groups.get(id).issues.push(issue);
        }
        this.groups = [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
        for (const g of this.groups) g.issues.sort((a, b) => (RANK[a.fields.status?.statusCategory?.key] ?? 2) - (RANK[b.fields.status?.statusCategory?.key] ?? 2));
        this.backlog = backlog; this.count = issues.length; this.error = null;
      } catch (e) {
        // A revoked or expired token: back to the form.
        if (e.status === 401) {
          this.setup = true; this.verified = false; this.groups = []; this.backlog = []; this.count = 0;
          this.fillForm(); this.formError = "Jira rejected the saved token · paste a new one";
        } else this.error = String(e.message ?? e);
      } finally { this.loading = false; cx.notify(); }
    });
  }

  // Checks the form against Jira, then saves: settings to shared state, a new token to the Keychain.
  save(cx) {
    if (this.saving) return;
    const site = normalizeSite(this.site.value()), project = this.project.value().trim().toUpperCase();
    const email = this.email.value().trim(), token = this.token.value().trim();
    const fail = (message) => { this.formError = message; cx.notify(); };
    if (!/^https:\/\/[^\s/]+$/.test(site)) return fail("Jira URL: https://<name>.atlassian.net");
    if (project && !/^[A-Z][A-Z0-9_]*$/.test(project)) return fail("Project key: letters, digits and _ (like DA)");
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail("Enter your Atlassian email");
    // The saved token belongs to the saved email; a different email needs its own token.
    const needToken = !this.savedEmail || email !== this.savedEmail;
    if (token ? /\s/.test(token) || token.length < 20 : needToken) return fail("Paste the API token (Open token page → Create API token → Copy)");
    this.saving = true; this.formError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const auth = token ? basic(email, token) : (await credentials())?.auth;
        if (!auth) throw new Error("No saved token · paste one");
        const base = await findBase(site, auth);
        if (token) {
          await exec("security", ["delete-generic-password", "-s", SERVICE]);
          // ponytail: -w puts the token in `security`'s argv for a moment (local ps only); its prompt can't be driven from a mod.
          const r = await exec("security", ["add-generic-password", "-s", SERVICE, "-a", email, "-w", token]);
          if (r.code !== 0) throw new Error(`Keychain: ${(r.stderr || r.stdout).trim()}`);
          this.savedEmail = email; this.token.set_value("");
        }
        setShared(SETTINGS, { site, project, base });
        this.sprintField = undefined; this.verified = true; this.setup = false; this.editing = false;
      } catch (e) {
        this.formError = e.status === 401 || e.status === 403
          ? `Jira rejected these credentials (${e.message}). Check the URL and email; a token with scopes needs read:jira-work and read:jira-user.`
          : String(e.message ?? e);
      } finally { this.saving = false; cx.notify(); }
      if (!this.setup && !this.editing) this.refresh(cx);
    });
  }

  field(id, label, state, t) {
    return v_flex().gap(3)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().id(id).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().text_size(12).text_color(t.foreground)));
  }

  formView(t) {
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().flex_1().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    const keepToken = this.savedEmail ? "API token (empty: keep the saved one)" : "API token";
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(this.setup ? "Connect Jira" : "Jira settings"))
      .child(this.field("site", "Jira URL", this.site, t))
      .child(this.field("project", "Backlog project key (optional)", this.project, t))
      .child(this.field("email", "Atlassian email", this.email, t))
      .child(this.field("token", keepToken, this.token, t))
      .child(h_flex().gap(6)
        .child(button("open-token-page", "Open token page", false, () => exec("open", [TOKEN_PAGE])))
        .child(button("save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx))))
      .when(this.editing, (e) => e.child(button("cancel", "Cancel", false, (_e, cx) => { this.editing = false; cx.notify(); })))
      .when(Boolean(this.formError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.formError)))
      .child(div().text_size(10).text_color(t.dim).child("Checked against Jira before saving. The token goes to the macOS Keychain (herdr-jira); a token with scopes needs read:jira-work and read:jira-user."));
  }

  url(key) { return `${this.settings().site}/browse/${key}`; }

  menuView(t) {
    const { key, x, y } = this.menu, w = 200;
    const item = (id, label, action) => div().id(id).h(26).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; action(cx); cx.notify(); }).child(label);
    return v_flex().id("issue-menu").absolute().top(y).left(Math.max(4, Math.min(x, (this.width ?? w) - w - 4))).w(w).p(4).gap(1)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      .child(item("menu-open", "Go to Jira", () => exec("open", [this.url(key)])))
      .child(item("menu-copy-key", `Copy ${key}`, (cx) => cx.write_to_clipboard(key)));
  }

  groupHeader(name, count, t) {
    return h_flex().h(24).flex_none().px(8).pt(6).gap(6).items_center().text_size(10).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(name.toUpperCase()))
      .child(div().child(String(count)));
  }

  // `section` keeps ids unique: an issue of mine can also sit in the backlog.
  issueRow(issue, t, section) {
    const f = issue.fields, cat = f.status?.statusCategory?.key;
    const color = cat === "indeterminate" ? t.working : cat === "done" ? t.done : t.muted;
    const hotfix = (f.labels ?? []).some((l) => l.toLowerCase() === "hotfix");
    return h_flex().id(`issue-${section}-${issue.key}`).h(22).flex_none().px(8).gap(6).items_center().rounded(5).cursor_pointer().relative()
      // Label "hotfix": a red bar on the row's left edge.
      .when(hotfix, (e) => e.child(div().absolute().left(1).top(4).bottom(4).w(3).rounded(2).bg(t.ansi1)))
      .when(this.selected === issue.key || this.menu?.key === issue.key, (s) => s.bg(t.selected))
      .hover((s) => s.bg(t.hover)).tooltip(`${issue.key} · ${f.issuetype?.name ?? ""}\n${f.summary}`)
      .on_click((_e, cx) => { this.selected = issue.key; cx.notify(); })
      // The root's own right-press handler (it runs next) places the menu.
      .on_mouse_down("right", () => { this.menuKey = issue.key; })
      .child(div().flex_none().text_size(11).text_color(t.dim).child(issue.key))
      .child(div().flex_1().min_w(0).truncate().child(f.summary ?? ""))
      .child(div().flex_none().max_w(96).truncate().text_size(10).text_color(color).child(f.status?.name ?? ""));
  }

  render(cx) {
    const t = theme(), q = this.query, form = this.setup || this.editing;
    const match = (issue) => !q || issue.key.toLowerCase().includes(q) || (issue.fields.summary ?? "").toLowerCase().includes(q);
    const groups = this.groups.map((g) => ({ ...g, issues: g.issues.filter(match) })).filter((g) => g.issues.length);
    const backlog = this.backlog.filter(match), project = this.settings().project;
    const empty = form ? null : this.error || (this.loading && !this.groups.length ? "Loading…"
      : q && !groups.length && !backlog.length ? "No matches" : !this.groups.length ? "No open issues assigned to you" : null);
    const iconButton = (id, icon, tip, onClick, spin = false) => div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick).child(svg(icon).size(14).when(spin, (s) => s.spin(900)));
    return v_flex().id("jira").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .on_mouse_down("right", (e, cx) => {
        if (!this.menuKey) return;
        this.selected = this.menuKey;
        this.menu = { key: this.menuKey, x: e.local_position?.x ?? 8, y: e.local_position?.y ?? 8 }; this.menuKey = null;
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Jira"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.count} open`))
        .child(div().flex_1())
        .when(!this.setup, (e) => e.child(iconButton("settings", "mods/jira/settings.svg", "Settings", (_e, cx) => this.openSettings(cx))))
        .child(iconButton("refresh", "mods/jira/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), this.loading)))
      .when(!form, (e) => e.child(div().flex_none().px(8).pt(8)
        .child(div().id("search").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("jira-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(form, (e) => e.child(this.formView(t)))
          .when(Boolean(empty), (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(!form, (e) => e
            .children(groups.flatMap((g) => [this.groupHeader(g.name, g.issues.length, t), ...g.issues.map((issue) => this.issueRow(issue, t, "mine"))]))
            // The project backlog, set apart from my issues by a rule.
            .when(backlog.length > 0, (e) => e
              .child(div().flex_none().mt(8).mx(8).h(1).bg(t.border))
              .child(this.groupHeader(`${project} backlog`, backlog.length, t))
              .children(backlog.map((issue) => this.issueRow(issue, t, "backlog"))))))
        .child(Scrollbar.vertical("jira-list").absolute().inset_0()))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(t)));
  }
}
