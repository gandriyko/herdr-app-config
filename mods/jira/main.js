import { View, div, svg, image } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { exec, theme, shared, setShared, spaces, panes, focused, run, knownAgents, props, openOverlay, closeOverlay } from "herdr";
import { Buffer } from "buffer";

// My open Jira issues grouped by sprint, status or not at all and sorted by updated/created date, plus the backlog
// of one or more projects (optional, its own request). Click opens the issue in Jira;
// right-click: Copy task ID, Start agent session. The row's terminal button opens that session dialog too (new worktree, new
// or existing, or a new branch here; the agent gets the issue text); which agent
// (Herdr's knownAgents(), e.g. Claude Code or Codex) is picked in the settings form and saved in "jira.settings".agent.
// Settings (site, project) live in Herdr's shared state ("jira.settings"); the email and API token
// in the macOS Keychain (service herdr-jira, account = email). Nothing personal is in this repo.
// ponytail: an API token, not OAuth — OAuth needs a registered app with a secret and a local
// redirect server, which a mod can't host.
const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens";
const MINE_JQL = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
// The saved project keys: "DA, OPS" → ["DA", "OPS"].
const projectKeys = (text) => (text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
const backlogJql = (keys) => `project in (${keys.map((k) => `"${k}"`).join(", ")}) AND sprint is EMPTY AND statusCategory != Done ORDER BY rank ASC`;
const SERVICE = "herdr-jira";
const SETTINGS = "jira.settings";
// In progress first, then to do (in a sprint group, and the order of status groups).
const RANK = { indeterminate: 0, new: 1 };
// Statuses on no board: to do, in progress, done (Jira's own order of categories).
const CAT_ORDER = { new: 0, indeterminate: 1, done: 2 };
// Jira's "2026-11-16T10:00:00.000+0200" as ms; the offset gets its colon so any Date.parse takes it.
const timeOf = (text) => Date.parse((text ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) || 0;
// The created date as "today" / "5d ago".
const daysAgo = (text) => { const d = Math.floor((Date.now() - timeOf(text)) / 86400000); return d < 1 ? "today" : `${d}d ago`; };

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

// The order Jira shows statuses in: the columns of each project's board, left to right (status id → index, first
// project first). A project without a board, or a token without the board scope, adds nothing.
// ponytail: the first scrum board of a project (else its first board); pick one by name if a project has several.
async function boardOrder(base, auth, keys) {
  const lists = await Promise.all(keys.map(async (key) => {
    try {
      const { values = [] } = await jira(base, auth, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(key)}&maxResults=20`);
      const board = values.find((b) => b.type === "scrum") ?? values[0];
      if (!board) return [];
      const conf = await jira(base, auth, `/rest/agile/1.0/board/${board.id}/configuration`);
      return (conf.columnConfig?.columns ?? []).flatMap((c) => (c.statuses ?? []).map((st) => String(st.id)));
    } catch { return []; }
  }));
  const order = new Map();
  for (const id of lists.flat()) if (!order.has(id)) order.set(id, order.size);
  return order;
}

// Jira's own issue type icons, saved as files (image() reads them from ~/.config/herdr-app/<path>) and kept across
// restarts: one per type and avatar, a handful in all.
const ICON_DIR = "data/jira/types";
const iconFile = (type) => `${ICON_DIR}/${String(type.id).replace(/\W/g, "")}-${/avatar\/(\d+)/.exec(type.iconUrl ?? "")?.[1] ?? "0"}.svg`;
const isSvg = (text) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);

// Our own icon for an issue type, by its name, when Jira's can't be had; the first match wins, else task (TA too).
const TYPE_ICONS = [["sub", "subtask"], ["bug", "bug"], ["story", "story"], ["epic", "epic"], ["customer", "customer"],
  ["qa", "pmqa"], ["security", "security"], ["investigation", "investigation"]];
const typeIcon = (type) => {
  const name = (type?.name ?? "").toLowerCase();
  const kind = type?.subtask ? "subtask" : TYPE_ICONS.find(([part]) => name.includes(part))?.[1] ?? "task";
  return `mods/jira/type-${kind}.svg`;
};

// The sprint an issue is in now: the active one, else the next planned one, else none.
function sprintOf(sprints) {
  const list = Array.isArray(sprints) ? sprints : [];
  return list.find((s) => s.state === "active") ?? list.find((s) => s.state === "future") ?? null;
}

// Branch for a task: "DA-123-derive-sap-item-line-account" (key + first words of the title, kebab-case).
const branchFor = (key, summary) => {
  const words = (summary ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").filter(Boolean);
  let s = "";
  for (const w of words) { if ((s + "-" + w).length > 40) break; s += "-" + w; }
  return key + s;
};
// Tab/space name: "DA-123 First words of the title" (whole words, about 30 chars of title).
const tabName = (key, summary) => {
  let s = "";
  for (const w of (summary ?? "").trim().split(/\s+/).filter(Boolean)) { if (s && (s + " " + w).length > 30) break; s = s ? s + " " + w : w; }
  return s ? `${key} ${s.slice(0, 40)}` : key;
};
// A worktree sits next to the main checkout: <parent>/<repo>-<branch slug> (as dokka-backend's own recipe does).
const worktreeSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const worktreePath = (main, branch) => `${main.replace(/\/[^/]+$/, "")}/${main.split("/").pop()}-${worktreeSlug(branch)}`;

// An issue description (Atlassian Document Format) as one line of plain text, at most 3000 chars.
// Block boundaries and hard breaks become spaces; mentions and links keep their visible text or url.
function adfWalk(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return " ";
  if (node.type === "mention") return node.attrs?.text ?? "";
  if (node.type === "inlineCard" || node.type === "blockCard") return node.attrs?.url ?? "";
  const inner = (node.content ?? []).map(adfWalk).join("");
  // Whitespace after each block so adjacent paragraphs, list items and cells don't run together.
  return /^(paragraph|listItem|heading|codeBlock|blockquote|tableRow|tableCell|tableHeader|bulletList|orderedList|rule)$/.test(node.type) ? inner + " " : inner;
}
function adfText(node) {
  const text = adfWalk(node).replace(/\s+/g, " ").trim();
  return text.length > 3000 ? text.slice(0, 2999).trimEnd() + "…" : text;
}

// The issue's description as text, or "" when it can't be had (not configured, no network, no description): a start never waits on it.
async function describeIssue(settings, key) {
  try {
    const creds = await credentials();
    if (!creds || !settings.site) return "";
    const issue = await jira(settings.base ?? settings.site, creds.auth, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`);
    return adfText(issue.fields?.description);
  } catch { return ""; }
}
// Herdr's fetch has no timeout: give up on `p` after `ms` and use `fallback`.
const withTimeout = (cx, p, ms, fallback) => Promise.race([p, new Promise((resolve) => cx.timer.after(ms, () => resolve(fallback)))]);

// The agent's first message. One line: a newline could send it early.
// ponytail: the setup steps are left to the agent and the repo's own docs (which env files, certificates, deps).
const about = (description) => (description ? ` — Task description: ${description}` : "");
const worktreeTask = ({ key, summary, description, path, branch, base, main, fresh }) =>
  `${key}: ${summary}${about(description)} — You are in ${fresh ? "a new" : "an existing"} git worktree ${path} on branch ${branch}${fresh ? `, created from origin/${base}` : ""}; the main checkout is ${main}. ` +
  `First prepare this worktree as the repo's own docs say (CLAUDE.md, AGENTS.md, .claude/, README): copy the gitignored files it needs from the main checkout ` +
  `(env files, certificates, local config) unless they are already there, install dependencies, and list what you copied; don't change the main checkout. Then work on ${key}.`;
const branchTask = ({ key, summary, description, branch, base }) =>
  `${key}: ${summary}${about(description)} — First run git fetch origin, then create and switch to branch ${branch} from origin/${base}, following the repo's own rules ` +
  `(CLAUDE.md, AGENTS.md, .claude/). If the working tree has uncommitted changes, stop and ask me what to do with them. Then work on ${key}.`;

const lastLine = (r) => (r.stderr || r.stdout).trim().split("\n").pop();

// The main checkout and origin's default branch for a folder, or null when it isn't a git repo.
async function gitInfo(folder, on) {
  const git = (args) => exec("git", args, { cwd: folder, on, timeout: 15000 }).catch(() => null);
  const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common?.code !== 0) return null;
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return { main: common.stdout.trim().replace(/\/\.git\/?$/, ""), base: head?.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "master" };
}

// The agent's command; one no longer installed starts by its key, so the error shows.
async function agentArgv(want, on) {
  const agent = await knownAgents({ on }).then((all) => all.find((a) => a.key === want && a.installed), () => null);
  return agent?.run ?? [want];
}

// A worktree for `branch` and an agent there with the task; idempotent. A worktree that already has the branch is
// reused (its space is selected if open, else a new space); a local branch without one gets `worktree add <path> <branch>`;
// else fetch origin/<base> and `worktree add -b`. Returns an error string, or null.
async function openWorktree({ main, on, branch, base, key, summary, description, argv }) {
  const git = (args, timeout = 30000) => exec("git", args, { cwd: main, on, timeout });
  const listed = await git(["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return `git worktree list: ${lastLine(listed)}`;
  let path = null, fresh = true;
  for (const block of listed.stdout.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`)) { path = lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? null; break; }
  }
  if (path) {
    fresh = false;
    const open = spaces().find((s) => s.folder === path && (s.machine || null) === (on || null));
    if (open) { run("space.select", { id: open.id }); return null; }
  } else {
    path = worktreePath(main, branch);
    const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (local.code === 0) {
      const added = await git(["worktree", "add", path, branch]);
      if (added.code !== 0) return `git worktree add: ${lastLine(added)}`;
    } else {
      const fetched = await git(["fetch", "origin", base], 120000);
      if (fetched.code !== 0) return `git fetch origin ${base}: ${lastLine(fetched)}`;
      const added = await git(["worktree", "add", "-b", branch, path, `origin/${base}`]);
      if (added.code !== 0) return `git worktree add: ${lastLine(added)}`;
    }
  }
  run("space.new", { name: tabName(key, summary), folder: path, machine: on ?? "", argv,
    task: worktreeTask({ key, summary, description, path, branch, base, main, fresh }) });
  return null;
}

// A saved JSON list of strings, or [] (missing or broken).
const parseList = (text) => {
  try { const v = JSON.parse(text ?? "[]"); return Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, 50) : []; }
  catch { return []; }
};

const normalizeSite = (text) => {
  const site = text.trim().replace(/\/+$/, "");
  return site && !/^https?:\/\//.test(site) ? `https://${site}` : site;
};

export default class Jira extends View {
  init(_props, cx) {
    // Opened as the "Start session" dialog of an issue (see openStart).
    if (props()?.start) { this.initStart(cx); return; }
    this.mine = []; this.groups = []; this.backlog = []; this.backlogGroups = []; this.count = 0; this.error = null; this.loading = false;
    this.typeIcons = new Map(); // issue type id → saved icon path, or null (asked this session, none)
    this.setup = false; this.editing = false; this.saving = false; this.formError = null; this.savedEmail = null; this.query = "";
    const input = (placeholder) => { const s = InputState.new({ placeholder }); s.on("submit", (_e, cx) => this.save(cx)); return s; };
    this.site = input("https://your-company.atlassian.net");
    this.project = input("Project keys for the backlog, e.g. DA, OPS");
    this.email = input("Atlassian email");
    // ponytail: InputState has no placeholder setter, so one field per placeholder; `token` picks by savedEmail.
    this.tokenNew = input("API token");
    this.tokenKeep = input("Empty: the saved token will be used");
    this.tokenNew.set_masked(true); this.tokenKeep.set_masked(true);
    // Filters (the filter button's popover): only the active sprint (no other sprints or backlog), and the statuses
    // picked by name (none picked = all). Names, not ids: ids differ per project, names are what Jira shows.
    this.current = localStorage.getItem("current") === "1";
    this.statuses = new Set(parseList(localStorage.getItem("statuses")));
    this.filterOpen = false;
    this.search = InputState.new({ placeholder: "Search by key or title" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    // Auto-sync is off until switched on (jira.auto = "1"); the list loads once on open either way.
    this.auto = (() => { try { return localStorage.getItem("jira.auto") === "1"; } catch { return false; } })();
    this.refresh(cx);
    cx.timer.every(5 * 60 * 1000, (cx) => { if (this.auto) this.refresh(cx); });
  }

  toggleAuto(cx) {
    this.auto = !this.auto;
    try { localStorage.setItem("jira.auto", this.auto ? "1" : "0"); } catch {}
    if (this.auto) this.refresh(cx); else cx.notify();
  }

  get token() { return this.savedEmail ? this.tokenKeep : this.tokenNew; }

  settings() { return shared(SETTINGS) ?? {}; }

  // Fills the form from what is saved; the token field stays empty (empty = keep the saved one).
  fillForm() {
    const s = this.settings();
    this.site.set_value(s.site ?? ""); this.project.set_value(s.project ?? ""); this.email.set_value(this.savedEmail ?? "");
    this.token.set_value(""); this.formError = null;
  }

  openSettings(cx) { this.fillForm(); this.editing = !this.editing; if (this.editing) this.loadAgents(cx); cx.notify(); }

  // The agents installed on the active space's machine, for the session picker in the form.
  loadAgents(cx) {
    const on = spaces().find((s) => s.active)?.machine ?? null;
    this.agents = null; this.agentsError = null;
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents({ on })).filter((a) => a.installed); }
      catch (e) { this.agents = []; this.agentsError = String(e.message ?? e); }
      cx.notify();
    });
  }

  refresh(cx) {
    // Herdr's fetch has no timeout or abort: a request that hangs would keep `loading` (and so every
    // refresh) blocked for good. After 2 minutes a new one may start; the hung one's finally leaves it be.
    if (this.loading && Date.now() - this.loadingSince < 120000) return;
    const gen = this.gen = (this.gen ?? 0) + 1;
    this.loading = true; this.loadingSince = Date.now(); cx.notify();
    cx.spawn(async (cx) => {
      let icons = null;
      try {
        const creds = await credentials(), s = this.settings();
        this.savedEmail = creds?.email ?? null;
        if (!creds || !s.site) {
          if (!this.setup) { this.setup = true; this.fillForm(); }
          this.mine = []; this.backlog = []; this.count = 0; this.view = null; return;
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
        // ponytail: the 100 latest-updated of mine and the top 100 of the backlog(s), sorted here by the picked date;
        // page with nextPageToken if that's ever too few.
        const fields = ["summary", "status", "issuetype", "labels", "updated", "created", "parent"];
        const search = (jql, fields, maxResults) => jira(base, creds.auth, "/rest/api/3/search/jql", { jql, fields, maxResults });
        const keys = s.backlog === false ? [] : projectKeys(s.project);
        const [{ issues = [] }, { issues: backlog = [] }] = await Promise.all([
          search(MINE_JQL, [...fields, ...(this.sprintField ? [this.sprintField] : [])], 100),
          keys.length ? search(backlogJql(keys), fields, 100) : { issues: [] },
        ]);
        for (const issue of issues) issue.sprint = sprintOf(issue.fields[this.sprintField]);
        // Board order of statuses for the saved projects and those of my issues (at most 5); asked again only when that set changes.
        const orderKeys = [...new Set([...projectKeys(s.project), ...issues.map((i) => i.key.split("-")[0])])].slice(0, 5).join(",");
        if (orderKeys !== this.orderKeys) { this.statusOrder = await boardOrder(base, creds.auth, orderKeys.split(",").filter(Boolean)); this.orderKeys = orderKeys; }
        // render() groups and sorts them (regroup) by the settings.
        this.mine = issues; this.backlog = backlog; this.count = issues.length; this.error = null; this.view = null;
        icons = { auth: creds.auth, base, site: s.site, issues: [...issues, ...backlog] };
      } catch (e) {
        // A revoked or expired token: back to the form.
        if (e.status === 401) {
          this.setup = true; this.verified = false; this.mine = []; this.backlog = []; this.count = 0; this.view = null;
          this.fillForm(); this.formError = "Jira rejected the saved token · paste a new one";
        } else this.error = String(e.message ?? e);
      } finally { if (gen === this.gen) this.loading = false; cx.notify(); }
      // After the list shows: the icons of issue types not seen yet.
      if (icons) await this.loadIcons(cx, icons);
    });
  }

  // Jira's icons for the issue types of `issues` not asked for yet this session: a saved file is used as is, else
  // the icon is fetched (through `base`, so a token with scopes works too) and saved. One redraw if any is new.
  // ponytail: SVG only — Herdr's fetch has only text(); a PNG icon (a custom upload) keeps our own (typeIcon).
  async loadIcons(cx, { auth, base, site, issues }) {
    const types = new Map();
    for (const i of issues) { const ty = i.fields.issuetype; if (ty?.id && ty.iconUrl && !this.typeIcons.has(ty.id)) types.set(ty.id, ty); }
    if (!types.size) return;
    for (const id of types.keys()) this.typeIcons.set(id, null);
    this.home ??= (await exec("sh", ["-c", 'printf %s "$HOME"']).catch(() => null))?.stdout.trim() || null;
    if (!this.home) return;
    const root = `${this.home}/.config/herdr-app`;
    await fs.mkdir(`${root}/${ICON_DIR}`, { recursive: true }).catch(() => {});
    let found = 0;
    await Promise.all([...types.values()].map(async (ty) => {
      const path = iconFile(ty);
      try {
        if (!(await fs.exists(`${root}/${path}`))) {
          const url = ty.iconUrl.startsWith(site) ? base + ty.iconUrl.slice(site.length) : ty.iconUrl;
          const text = await withTimeout(cx, fetch(url, { headers: { Authorization: auth } }).then((r) => (r.ok ? r.text() : ""), () => ""), 15000, "");
          if (!isSvg(text)) return;
          await fs.writeFile(`${root}/${path}`, text);
        }
        this.typeIcons.set(ty.id, path); found++;
      } catch {}
    }));
    if (found) cx.notify();
  }

  // A status's place as Jira shows it: its board column; a status on no board goes after, by category (to do,
  // in progress, done), then by name in the caller.
  statusPos(status) {
    return this.statusOrder?.get(String(status?.id)) ?? 1000 + (CAT_ORDER[status?.statusCategory?.key] ?? 3);
  }

  // Groups my issues by the picked field and sorts every list by the picked date, newest first. Run by render()
  // when the data or those settings changed (so every copy of the mod follows a change made in one).
  regroup() {
    const s = this.settings(), by = s.groupBy ?? "sprint", field = s.sort === "created" ? "created" : "updated";
    const newest = (a, b) => timeOf(b.fields[field]) - timeOf(a.fields[field]);
    const rank = (i) => RANK[i.fields.status?.statusCategory?.key] ?? 2;
    const groups = new Map();
    for (const issue of this.mine) {
      const sprint = issue.sprint, status = issue.fields.status, parent = issue.fields.parent;
      // Parent: the epic of a story/task, or the issue of a sub-task (Jira Cloud's `parent` field covers both).
      const [id, name, order] = by === "status" ? [`st:${status?.name}`, status?.name ?? "No status", this.statusPos(status)]
        : by === "parent" ? (parent ? [`p:${parent.key}`, `${parent.key} ${parent.fields?.summary ?? ""}`.trim(), 0] : ["noparent", "No parent", 1])
        : by === "sprint" ? (sprint ? [`s${sprint.id}`, sprint.name, sprint.state === "active" ? 0 : 1] : ["none", "No sprint", 2])
        : ["all", "Assigned to me", 0];
      if (!groups.has(id)) groups.set(id, { id, name, order, issues: [] });
      groups.get(id).issues.push(issue);
    }
    this.groups = [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, undefined, { numeric: true }));
    // In a sprint: in progress first, then to do, each by date.
    for (const g of this.groups) g.issues.sort(by === "sprint" ? (a, b) => rank(a) - rank(b) || newest(a, b) : newest);
    // One backlog section per project, in the order the keys were saved.
    this.backlogGroups = projectKeys(s.project).map((k) => ({ id: k, name: `${k} backlog`,
      issues: this.backlog.filter((i) => i.key.startsWith(k + "-")).sort(newest) })).filter((g) => g.issues.length);
  }

  // Checks the form against Jira, then saves: settings to shared state, a new token to the Keychain.
  save(cx) {
    if (this.saving) return;
    const site = normalizeSite(this.site.value()), keys = projectKeys(this.project.value().toUpperCase()), project = keys.join(", ");
    const email = this.email.value().trim(), token = this.token.value().trim();
    const fail = (message) => { this.formError = message; cx.notify(); };
    if (!/^https:\/\/[^\s/]+$/.test(site)) return fail("Jira URL: https://<name>.atlassian.net");
    if (keys.some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k))) return fail("Project keys: letters, digits and _, separated by commas (like DA, OPS)");
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
          this.token.set_value(""); this.savedEmail = email;
        }
        setShared(SETTINGS, { ...this.settings(), site, project, base }); // keeps the agent picked below
        this.sprintField = undefined; this.orderKeys = undefined; this.verified = true; this.setup = false; this.editing = false;
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
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child(this.setup ? "Connect Jira" : "Jira settings"))
      .child(this.field("site", "Jira URL", this.site, t))
      .child(this.field("project", "Backlog project keys (optional, comma-separated)", this.project, t))
      .child(this.field("email", "Atlassian email", this.email, t))
      .child(this.field("token", "API token", this.token, t))
      .child(h_flex().gap(6)
        .child(button("open-token-page", "Open token page", false, () => exec("open", [TOKEN_PAGE])))
        .child(button("save", this.saving ? "Checking…" : "Save", true, (_e, cx) => this.save(cx))))
      .when(this.editing, (e) => e.child(button("cancel", "Cancel", false, (_e, cx) => { this.editing = false; cx.notify(); })))
      .when(this.editing, (e) => e.child(this.agentPicker(t)))
      .when(Boolean(this.formError), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.formError)))
      .child(div().text_size(10).text_color(t.dim).child("Checked against Jira before saving. The token goes to the macOS Keychain (herdr-jira); a token with scopes needs read:jira-work and read:jira-user."));
  }

  url(key) { return `${this.settings().site}/browse/${key}`; }

  // A row of one-click choices ({ key, name }), the picked one outlined; `pick(option, cx)` saves it.
  pills(t, id, options, cur, pick) {
    return h_flex().gap(6).flex_wrap().children(options.map((o) => div().id(`${id}-${o.key}`).h(24).px(10).flex().items_center().rounded(6).border_1()
      .text_size(12).cursor_pointer().border_color(o.key === cur ? t.accent : t.border).text_color(o.key === cur ? t.accent : t.foreground)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { pick(o, cx); cx.notify(); }).child(o.name)));
  }

  labeled(label, child, t) {
    return v_flex().gap(4).child(div().text_size(10).text_color(t.dim).child(label)).child(child);
  }

  // The agent for task sessions, one click to pick (saved at once, apart from Save): the installed ones of knownAgents().
  agentPicker(t) {
    return this.labeled("Agent for task sessions", this.agents === null ? div().text_size(11).text_color(t.dim).child("Checking installed agents…")
      : this.agents.length ? this.pills(t, "agent", this.agents, this.settings().agent ?? "claude",
        (a) => setShared(SETTINGS, { ...this.settings(), agent: a.key, agentName: a.name }))
      : div().text_size(11).text_color(this.agentsError ? t.ansi1 : t.dim).child(this.agentsError ?? "No installed agents found"), t);
  }

  // The focused folder (else the space's) and the machine of the active space: where a session for an issue starts.
  startPlace() {
    const space = spaces().find((s) => s.active), f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return { folder: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
  }

  summaryOf(key) {
    return [...this.mine, ...this.backlog].find((i) => i.key === key)?.fields.summary ?? "";
  }

  // Opens the "Start session" dialog for an issue, for the focused folder (else the space's) and its machine.
  openStart(key) {
    openOverlay({ mod: "jira", kind: "dialog", width: 580, height: 360,
      props: { start: { key, summary: this.summaryOf(key), ...this.startPlace() } } });
  }

  // The dialog: new worktree (the mod creates it from origin/<base>, then a new space runs the agent there and the
  // agent copies env files etc. per the repo's docs) or a new branch here (the agent creates it). Outside a git
  // repo it only starts the agent with the task. An agent no longer installed starts by its key, so the error shows.
  initStart(cx) {
    const s = props().start;
    this.st = { ...s, mode: "worktree", git: null, error: null, busy: false };
    this.stBranch = InputState.new({ value: branchFor(s.key, s.summary), placeholder: "branch name" });
    this.stBase = InputState.new({ value: "", placeholder: "base branch, e.g. master" });
    for (const i of [this.stBranch, this.stBase]) i.on("submit", (_e, cx) => this.start(cx));
    cx.spawn(async (cx) => {
      const info = s.folder ? await gitInfo(s.folder, s.on) : null;
      if (info) {
        // The main checkout (not a worktree's folder) and the remote's default branch.
        const home = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: s.on }).catch(() => null);
        this.st.git = { main: info.main, repo: info.main.split("/").pop(), home: home?.stdout.trim() || "~" };
        this.stBase.set_value(info.base);
      } else this.st.git = false;
      cx.notify();
    });
  }

  start(cx) {
    const st = this.st;
    if (st.busy || st.git === null) return;
    const branch = this.stBranch.value().trim(), base = this.stBase.value().trim().replace(/^origin\//, "");
    const want = this.settings().agent ?? "claude";
    const fail = (m) => { st.error = m; st.busy = false; cx.notify(); };
    if (st.git && (!branch || /\s/.test(branch))) return fail("Branch name without spaces");
    if (st.git && !base) return fail("Base branch, e.g. master");
    st.busy = true; st.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [argv, description] = await Promise.all([
          agentArgv(want, st.on),
          withTimeout(cx, describeIssue(this.settings(), st.key), 15000, ""),
        ]);
        if (st.git && st.mode === "worktree") {
          const error = await openWorktree({ main: st.git.main, on: st.on, branch, base, key: st.key, summary: st.summary, description, argv });
          if (error) return fail(error);
        } else {
          const task = st.git ? branchTask({ key: st.key, summary: st.summary, description, branch, base }) : `${st.key}: ${st.summary}${about(description)}`;
          run("tab.new", { name: tabName(st.key, st.summary), argv, task, ...(st.folder ? { folder: st.folder } : {}) });
        }
        closeOverlay(props().overlay);
      } catch (e) { fail(String(e.message ?? e)); }
    });
  }

  startView(t) {
    const st = this.st, agentName = this.settings().agentName ?? "Claude Code";
    // A choice card: a radio dot and a title, a short wrapped line under it. min_w(0) lets two share the row.
    const choice = (mode, title, about) => {
      const on = st.mode === mode;
      return h_flex().id(`mode-${mode}`).flex_1().min_w(0).p(10).gap(10).items_start().rounded(8).border_1().cursor_pointer()
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).hover((s) => s.border_color(t.accent))
        .on_click((_e, cx) => { st.mode = mode; cx.notify(); })
        .child(div().mt(2).size(14).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(on ? t.accent : t.muted)
          .child(div().size(6).rounded(3).bg(on ? t.accent : t.background)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(12).font_semibold().child(title))
          .child(div().text_size(11).text_color(t.dim).child(about)));
    };
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(14).flex().items_center().justify_center().rounded(7).text_size(12)
      .cursor_pointer().bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    const tilde = (p) => st.git?.home && p?.startsWith(st.git.home) ? "~" + p.slice(st.git.home.length) : p;
    const where = !st.git ? null : st.mode === "worktree"
      ? `Opens a new space in ${tilde(worktreePath(st.git.main, this.stBranch.value().trim()))}`
      : `Opens a new tab in ${tilde(st.folder)}; the agent creates the branch`;
    return v_flex().id("start").size_full().bg(t.background).text_color(t.foreground).text_size(12)
      .child(v_flex().flex_none().px(16).pt(14).pb(12).gap(4).border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(14).child(`Start ${agentName} session`))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(st.key))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(st.summary))))
      .child(v_flex().flex_1().min_h(0).px(16).py(14).gap(14)
        .child(st.git === null ? div().text_color(t.dim).child("Checking the folder…")
          : st.git === false ? div().text_color(t.dim).child(`${tilde(st.folder) ?? "No folder"} is not a git repository: the agent starts there with the task.`)
          : v_flex().gap(14)
            .child(h_flex().gap(8).items_stretch()
              .child(choice("worktree", "New worktree", "Own folder and space; the agent copies env files and certificates"))
              .child(choice("branch", "New branch here", `In the current ${st.git.repo} folder`)))
            .child(h_flex().gap(8).items_end()
              .child(div().flex_1().min_w(0).child(this.field("st-branch", "Branch", this.stBranch, t)))
              .child(div().w(150).flex_none().child(this.field("st-base", "From origin/", this.stBase, t))))
            .child(div().text_size(11).text_color(t.dim).truncate().child(where)))
        .when(Boolean(st.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(st.error))))
      .child(h_flex().flex_none().px(16).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
        .child(button("st-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("st-start", st.busy ? (st.mode === "worktree" ? "Creating worktree…" : "Starting…") : "Start", true, (_e, cx) => this.start(cx))));
  }

  menuView(t) {
    const { key, x, y } = this.menu, w = 200;
    const item = (id, label, action) => div().id(id).h(26).px(10).flex().items_center().rounded(5).cursor_pointer().text_size(12)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.menu = null; action(cx); cx.notify(); }).child(label);
    return v_flex().id("issue-menu").absolute().top(y).left(Math.max(4, Math.min(x, (this.width ?? w) - w - 4))).w(w).p(4).gap(1)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_e, cx) => { this.menu = null; cx.notify(); })
      // The menu floats over issue rows: without this the press falls through to the row below and opens Jira.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(item("menu-copy-key", "Copy task ID", (cx) => cx.write_to_clipboard(key)))
      .child(item("menu-session", `Start ${this.settings().agentName ?? "Claude Code"} session…`, () => this.openStart(key)));
  }

  saveFilters() {
    localStorage.setItem("current", this.current ? "1" : "0");
    localStorage.setItem("statuses", JSON.stringify([...this.statuses]));
  }

  // The filter popover under the filter button. `statuses`: [{ name, cat, count }] of the shown issues.
  filterView(t, statuses) {
    const box = (on) => div().size(14).flex_none().flex().items_center().justify_center().rounded(3).border_1()
      .border_color(on ? t.accent : t.muted).when(on, (s) => s.bg(t.accent).text_color(t.background))
      .when(on, (s) => s.child(svg("mods/jira/check.svg").size(10)));
    const row = (id, on, label, color, count, toggle) => h_flex().id(id).h(26).px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { toggle(cx); this.saveFilters(); cx.notify(); })
      .child(box(on))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(label))
      .when(count !== null, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(String(count))));
    const title = (text) => div().px(8).pt(6).pb(2).text_size(10).font_semibold().text_color(t.dim).child(text);
    const catColor = (cat) => cat === "indeterminate" ? t.working : cat === "done" ? t.done : t.foreground;
    const s = this.settings(), sort = s.sort === "created" ? "created" : "updated", backlogOn = s.backlog !== false;
    const set = (patch) => setShared(SETTINGS, { ...this.settings(), ...patch });
    return v_flex().id("filter-menu").absolute().top(82).right(8).w(230).max_h(360).overflow_y_scroll().p(4).gap(1)
      .rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down_out((_e, cx) => { this.filterOpen = false; this.filterClosedAt = Date.now(); cx.notify(); })
      // The popover floats over issue rows: without this the press falls through and opens Jira.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(title("SORT (NEWEST FIRST)"))
      .children([["updated", "Updated"], ["created", "Created"]].map(([key, label]) =>
        row(`filter-sort-${key}`, sort === key, label, t.foreground, null, () => set({ sort: key }))))
      .child(title("GROUP BY"))
      .children([["sprint", "Sprint"], ["status", "Status"], ["parent", "Parent (epic, story)"], ["none", "None"]].map(([key, label]) =>
        row(`filter-group-${key}`, (s.groupBy ?? "sprint") === key, label, t.foreground, null, () => set({ groupBy: key }))))
      .child(title("BACKLOG"))
      // A separate request: shown again → fetch it; hidden → render() just leaves it out.
      .child(row("filter-backlog", backlogOn, "Show project backlog", t.foreground, null,
        (cx) => { set({ backlog: !backlogOn }); if (!backlogOn) this.refresh(cx); }))
      .child(title("SPRINT"))
      .child(row("filter-current", this.current, "Current sprint only", t.foreground, null, () => { this.current = !this.current; }))
      .child(title("STATUS"))
      .when(!statuses.length, (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("No issues loaded yet")))
      .children(statuses.map((s, i) => row(`filter-status-${i}`, this.statuses.has(s.name), s.name, catColor(s.cat), s.count,
        () => { this.statuses.has(s.name) ? this.statuses.delete(s.name) : this.statuses.add(s.name); })))
      .when(this.current || this.statuses.size > 0, (e) => e
        .child(div().my(3).mx(4).h(1).bg(t.border))
        .child(div().id("filter-clear").h(26).px(8).flex().items_center().rounded(5).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.current = false; this.statuses.clear(); this.saveFilters(); cx.notify(); })
          .child("Clear filters")));
  }

  groupHeader(name, count, t) {
    return h_flex().h(24).flex_none().px(8).pt(6).gap(6).items_center().justify_center().text_size(10)
      .child(div().min_w(0).truncate().font_bold().text_color(t.foreground).child(name.toUpperCase()))
      .child(div().text_color(t.dim).child(String(count)));
  }

  // `section` keeps ids unique: an issue of mine can also sit in the backlog.
  issueRow(issue, t, section) {
    const f = issue.fields, cat = f.status?.statusCategory?.key;
    const color = cat === "indeterminate" ? t.working : cat === "done" ? t.done : t.muted;
    const hotfix = (f.labels ?? []).some((l) => l.toLowerCase() === "hotfix");
    return h_flex().id(`issue-${section}-${issue.key}`).flex_none().px(8).py(3).gap(6).items_center().rounded(5).cursor_pointer().relative()
      // Label "hotfix": a red bar on the row's left edge.
      .when(hotfix, (e) => e.child(div().absolute().left(1).top(4).bottom(4).w(3).rounded(2).bg(t.ansi1)))
      .when(this.selected === issue.key || this.menu?.key === issue.key, (s) => s.bg(t.selected))
      .hover((s) => s.bg(t.hover)).tooltip(`${issue.key} · ${f.issuetype?.name ?? ""}\n${f.summary}`)
      // on_click fires for the right button too (ClickEvent has no button), so the left press is used.
      .on_mouse_down("left", (_e, cx) => { this.selected = issue.key; exec("open", [this.url(issue.key)]); cx.notify(); })
      // The root's own right-press handler (it runs next) places the menu.
      .on_mouse_down("right", () => { this.menuKey = issue.key; })
      // Two lines: the summary, then the type icon, the key (dim), the status (its category's color), the age and the session button, small.
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().child(f.summary ?? ""))
        .child(h_flex().gap(6).items_center().text_size(10)
          .child(image(this.typeIcons.get(f.issuetype?.id) ?? typeIcon(f.issuetype)).size(12).flex_none())
          .child(div().flex_none().text_color(t.dim).child(issue.key))
          .child(div().min_w(0).truncate().text_color(color).child(f.status?.name ?? ""))
          .when(Boolean(f.created), (e) => e.child(div().flex_none().text_color(t.dim).child(daysAgo(f.created))))
          .child(div().flex_1())
          // Start a Claude session for this task; the press stops here, so the row doesn't open Jira.
          .child(div().id(`session-${section}-${issue.key}`).flex_none().size(16).flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Start a ${this.settings().agentName ?? "Claude Code"} session for ${issue.key}`)
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.openStart(issue.key); })
            .child(svg("mods/jira/session.svg").size(12)))));
  }

  render(cx) {
    if (this.st) return this.startView(theme());
    const t = theme(), q = this.query, form = this.setup || this.editing;
    const picked = this.statuses, filtered = this.current || picked.size > 0;
    const byStatus = (issue) => !picked.size || picked.has(issue.fields.status?.name ?? "");
    const match = (issue) => byStatus(issue) && (!q || issue.key.toLowerCase().includes(q) || (issue.fields.summary ?? "").toLowerCase().includes(q));
    const s = this.settings(), view = `${s.groupBy}|${s.sort}|${s.project}`;
    if (this.view !== view) { this.view = view; this.regroup(); }
    const inCurrent = (issue) => !this.current || issue.sprint?.state === "active";
    const groups = this.groups.map((g) => ({ ...g, issues: g.issues.filter((i) => inCurrent(i) && match(i)) })).filter((g) => g.issues.length);
    const showBacklog = !this.current && s.backlog !== false;
    const backlogGroups = !showBacklog ? [] : this.backlogGroups.map((g) => ({ ...g, issues: g.issues.filter(match) })).filter((g) => g.issues.length);
    const empty = form ? null : this.error || (this.loading && !this.mine.length ? "Loading…"
      : q && !groups.length && !backlogGroups.length ? "No matches" : !this.mine.length ? "No open issues assigned to you"
      : !groups.length ? (picked.size ? "None of your issues match the filter" : "No issues in the current sprint") : null);
    // The popover's statuses: those of the issues the sprint filter leaves (in Jira's board order), with
    // counts, plus picked ones no issue has now so they can be unpicked. At most ~150 issues, only while it's open.
    let statuses = [];
    if (this.filterOpen && !form) {
      const seen = new Map();
      for (const issue of [...this.mine.filter(inCurrent), ...(showBacklog ? this.backlog : [])]) {
        const st = issue.fields.status, name = st?.name;
        if (!name) continue;
        if (!seen.has(name)) seen.set(name, { name, cat: st.statusCategory?.key, pos: this.statusPos(st), count: 0 });
        seen.get(name).count++;
      }
      for (const name of picked) if (!seen.has(name)) seen.set(name, { name, cat: null, pos: this.statusPos(null), count: 0 });
      // As Jira's board shows them (see statusPos).
      statuses = [...seen.values()].sort((a, b) => a.pos - b.pos || a.name.localeCompare(b.name));
    }
    const filterTip = !filtered ? "Sort, grouping, backlog, sprint and status filters"
      : [this.current ? "Current sprint only" : null, picked.size ? `Status: ${[...picked].join(", ")}` : null].filter(Boolean).join("\n");
    const iconButton = (id, icon, tip, onClick, spin = false) => div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick).child(svg(icon).size(14).when(spin, (s) => s.spin(900)));
    return v_flex().id("jira").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      // Redraw only when the width really changed: a notify on every report could redraw forever.
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
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
        .when(!this.setup, (e) => e.child(h_flex().id("auto").h(24).px(5).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(this.auto ? "Auto-sync every 5 minutes: on" : "Auto-sync: off (default) · refresh by hand").on_click((_e, cx) => this.toggleAuto(cx))
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.auto ? t.accent : t.border).bg(this.auto ? t.accent : t.background).text_color(t.accent_foreground).child(this.auto ? "✓" : ""))
          .child(div().text_size(10).text_color(t.muted).child("Auto"))))
        .when(!this.setup, (e) => e.child(iconButton("settings", "mods/jira/settings.svg", "Settings", (_e, cx) => this.openSettings(cx))))
        .child(iconButton("refresh", "mods/jira/refresh.svg", "Refresh", (_e, cx) => this.refresh(cx), this.loading)))
      .when(!form, (e) => e.child(h_flex().flex_none().px(8).pt(8).gap(6).items_center()
        .child(div().id("search").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
        // Opens the filter popover; filled while a filter is on, with the number of filters.
        .child(h_flex().id("filter").flex_none().h(28).min_w(28).px(7).gap(4).items_center().justify_center().rounded(7).border_1().cursor_pointer()
          .border_color(this.filterOpen ? t.accent : t.border).text_color(filtered ? t.foreground : t.muted)
          .when(filtered, (s) => s.bg(t.selected)).when(!filtered, (s) => s.hover((st) => st.bg(t.hover)))
          .tooltip(filterTip)
          .on_click((_e, cx) => {
            // A press on the button while open already closed it (mouse down outside the popover): don't reopen.
            if (Date.now() - (this.filterClosedAt ?? 0) < 300) return;
            this.filterOpen = !this.filterOpen; this.menu = null; cx.notify();
          })
          .child(svg("mods/jira/filter.svg").size(14))
          .when(filtered, (e) => e.child(div().text_size(10).child(String((this.current ? 1 : 0) + picked.size)))))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("jira-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(form, (e) => e.child(this.formView(t)))
          .when(Boolean(empty), (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(!form, (e) => e
            .children(groups.flatMap((g) => [this.groupHeader(g.name, g.issues.length, t), ...g.issues.map((issue) => this.issueRow(issue, t, "mine"))]))
            // The project backlogs, set apart from my issues by a rule.
            .when(backlogGroups.length > 0, (e) => e
              .child(div().flex_none().mt(8).mx(8).h(1).bg(t.border))
              .children(backlogGroups.flatMap((g) => [this.groupHeader(g.name, g.issues.length, t), ...g.issues.map((issue) => this.issueRow(issue, t, "backlog"))])))))
        .child(Scrollbar.vertical("jira-list").absolute().inset_0()))
      .when(this.filterOpen && !form, (e) => e.child(this.filterView(t, statuses)))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(t)));
  }
}
