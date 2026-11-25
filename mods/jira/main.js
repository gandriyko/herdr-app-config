import { View, div, svg, image } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { exec, theme, shared, setShared, spaces, panes, agents, focused, run, knownAgents, props, openOverlay, closeOverlay, appHome, notify } from "herdr";
import { Buffer } from "buffer";
import { Voice, asQuery } from "./voice.js";
import { ci, approval, openPrs, STALE, FORCE, copilotBadge, copilotTip, repoOfUrl } from "./pr-badges.js";

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
// The last loaded issues (see loadCache), under the app home.
const CACHE_FILE = "data/jira/issues.json";
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
// A fresh branch: prepare, then work. An existing branch (a PR's): prepare, then read and wait (readAndWait).
const worktreeTask = ({ key, summary, description, path, branch, base, main, fresh, pr }) =>
  `${key}: ${summary}${about(description)} — You are in ${fresh ? "a new" : "an existing"} git worktree ${path} on branch ${branch}${fresh ? `, created from origin/${base}` : ""}; the main checkout is ${main}. ` +
  `First prepare this worktree as the repo's own docs say (CLAUDE.md, AGENTS.md, .claude/, README): copy the gitignored files it needs from the main checkout ` +
  `(env files, certificates, local config) unless they are already there, install dependencies, and list what you copied; don't change the main checkout. ` +
  (fresh ? `Then work on ${key}.` : `Then: ${readAndWait({ key, pr })}`);

const lastLine = (r) => (r.stderr || r.stdout).trim().split("\n").pop();

// ── Open pull requests of every space's repo (openPrs, gh), each shown under the issue whose key is in its title or head branch ──
const REMOTES_MAX = 50;
// Every key-like word of the title and head branch ("DA-123: …", "feature/DA-123-…"), upper-cased. Words that are no
// issue key (UTF-8) match no issue, so they cost nothing.
const prKeys = (pr) => new Set([...`${pr.title ?? ""} ${pr.headRefName ?? ""}`.matchAll(/[A-Za-z][A-Za-z0-9_]*-\d+/g)].map((m) => m[0].toUpperCase()));
// ── Past sessions (human-history, github.com/gandriyko/human-history): before a new agent starts on an issue, its
// latest past session in the folder's repo is resumed instead, so the context isn't lost ──
// How each agent reopens a session: human-history's table (src/resume.rs), as the history mod has it.
const RESUME = {
  claude: (id) => ["claude", "--resume", id],
  codex: (id) => ["codex", "resume", id],
  opencode: (id) => ["opencode", "--session", id],
  copilot: (id) => ["copilot", `--resume=${id}`],
  pi: (id) => ["pi", "--session", id],
  hermes: (id) => ["hermes", "--resume", id, "--no-restore-cwd"],
};
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // never an option-looking id in argv
// Herdr started from the Dock has a short PATH without ~/.cargo/bin, where `cargo install` puts human-history.
// human-history takes the project from HH_CWD before its working directory: set to ours ($PWD, the exec's cwd).
const HH = 'HH_CWD="$PWD" PATH="$PATH:$HOME/.cargo/bin" exec human-history "$@"';

// The latest past session on the issue in the folder's repo (all its worktrees), or null: one whose title or branch
// names the key first, else one whose own prompt does (jira's sessions start with "<key>: …"). Local folders only.
// ponytail: an assistant's passing mention doesn't count; without human-history (or on failure) none is found.
// `scope` "all": every project (to find which repo the issue was worked in), from `folder` (any, e.g. home).
// pastSessions: the ranked list (at most `max`); pastSession: the best one. `byDate`: newest day first (the day the
// card shows, "today" / "3d ago"), the rank only within a day.
async function pastSession(key, folder, scope = "repository") { return (await pastSessions(key, folder, scope, 1))[0] ?? null; }
async function pastSessions(key, folder, scope = "repository", max = 5, byDate = false) {
  const r = await exec("/bin/sh", ["-c", HH, "sh", "search", key, "--json", "-f", scope, "--limit", "20"],
    { cwd: folder, timeout: 30000 }).catch(() => null);
  let list = [];
  try { if (r?.code === 0) list = JSON.parse(r.stdout); } catch {}
  // Best first: the key in both the session's title and its branch, then in the title only (work on the issue from
  // another branch), then in the branch only (often a side task, e.g. a worklog, run while on the issue's branch), then
  // in my own prompt. Within each: more messages naming the key (`hits`), then the latest activity.
  const rank = (s) => {
    const br = mentions((s.branch ?? "").toUpperCase(), key), ti = mentions((s.title ?? "").toUpperCase(), key);
    return br && ti ? 0 : ti ? 1 : br ? 2 : s.hit_role === "user" ? 3 : 9;
  };
  const ok = list.filter((s) => RESUME[s.agent] && SAFE_ID.test(s.session_id ?? "") && rank(s) < 9);
  const day = (s) => byDate ? Math.floor((Date.now() - timeOf(s.updated_at)) / 86400000) : 0;
  return ok.sort((a, b) => day(a) - day(b) || rank(a) - rank(b) || (b.hits ?? 0) - (a.hits ?? 0)
    || String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, max);
}

// The argv that resumes `past` in `folder`, or null when it can't. Claude finds a session only under its folder's
// project dir (~/.claude/projects/<path, non-alnum → "-">), so for another folder its conversation file is copied
// there first (as the history mod does); the other agents find a session by id from anywhere.
// ponytail: ignores CLAUDE_CONFIG_DIR; subagent transcripts (<id>/) are not copied.
async function resumeArgv(past, folder) {
  if (past.agent === "claude" && past.cwd !== folder) {
    const copied = await exec("/bin/sh", ["-c",
      'src=$(ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n 1); [ -n "$src" ] || exit 1; ' +
      'dst="$HOME/.claude/projects/$2"; mkdir -p "$dst" && { [ -e "$dst/$1.jsonl" ] || cp "$src" "$dst/"; }',
      "sh", past.session_id, folder.replace(/[^A-Za-z0-9]/g, "-")], { timeout: 15000 }).catch(() => null);
    if (copied?.code !== 0) return null;
  }
  return RESUME[past.agent](past.session_id);
}

// A new session's first message on a branch that already has work (a PR's, or one naming the issue): read and wait.
const readAndWait = ({ key, pr }) =>
  (pr ? `Read the issue and pull request #${pr.number} (${pr.url}): description, diff, open review threads`
    : `Read the issue and what the branch changed so far for ${key} (git log and diff against its base)`) +
  `, give a short summary, then wait for my instructions: don't run tests, builds or change code until I ask.`;
const existingTask = ({ key, summary, description, branch, pr }) =>
  `${key}: ${summary}${about(description)} — This folder is on branch ${branch}, which already has work. ${readAndWait({ key, pr })}`;

// Whether an upper-cased text names the issue key as a whole (DA-2049 is not in DA-20493).
const mentions = (text, key) => new RegExp(`(^|[^A-Z0-9])${key}(?!\\d)`).test(text);
const repoName = (url) => /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;
// CI, approval and Copilot badges: ./pr-badges.js (copy of lib/pr-badges.js, shared with prs, so both show the same).

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

// Branch -> folder of every worktree of the repo (`git worktree list --porcelain` in any of its folders).
async function worktreesOf(folder, on) {
  const r = await exec("git", ["worktree", "list", "--porcelain"], { cwd: folder, on, timeout: 15000 }).catch(() => null);
  const out = new Map();
  for (const block of (r?.stdout ?? "").split(/\n\s*\n/)) {
    const lines = block.split("\n"), path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"))?.slice(18);
    if (path && branch) out.set(branch, path);
  }
  return out;
}

// The Start session dialog's choice card: a radio dot and a title, a one-line note under it; min_w(0)
// lets two share the row. And their button.
const choiceCard = (t, id, on, title, about, pick) => h_flex().id(id).flex_1().min_w(0).p(10).gap(10).items_start().rounded(8).border_1().cursor_pointer()
  .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).hover((s) => s.border_color(t.accent))
  .on_click((_e, cx) => { pick(); cx.notify(); })
  .child(div().mt(2).size(14).flex_none().flex().items_center().justify_center().rounded(7).border_1().border_color(on ? t.accent : t.muted)
    .child(div().size(6).rounded(3).bg(on ? t.accent : t.background)))
  .child(v_flex().flex_1().min_w(0).gap(2)
    .child(div().text_size(12).font_semibold().child(title))
    .child(div().text_size(11).text_color(t.dim).truncate().child(about)));
const dialogButton = (t, id, label, primary, onClick) => div().id(id).h(28).px(14).flex().items_center().justify_center().rounded(7).text_size(12)
  .cursor_pointer().bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);

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
    // Mic button (voice.js): the spoken text goes into the search box, which filters the list as typing does.
    this.voice = new Voice({ icons: { mic: "mods/jira/mic.svg", spin: "mods/jira/refresh.svg" }, onText: (text, cx) => {
      this.search.set_value(asQuery(text)); this.query = this.search.value().trim().toLowerCase(); this.search.focus(); cx.notify();
    } }, cx);
    // Auto-sync is off until switched on (jira.auto = "1"); the list loads once on open either way.
    this.auto = (() => { try { return localStorage.getItem("jira.auto") === "1"; } catch { return false; } })();
    // PRs: repo key -> (issue key -> [PR rows]) for the repos of every space; prIndex merges them by issue key (what rows
    // read); folder -> repo (git remote, no API call).
    this.prsByRepo = new Map(); this.prIndex = new Map(); this.remotes = new Map();
    // Issues whose PR lines are shown (the PR icon toggles them); closed by default, not saved.
    this.prOpen = new Set();
    // The last list from disk first (shown while the fresh load runs), then the fresh load.
    cx.spawn((cx) => this.loadCache(cx));
    this.refresh(cx);
    cx.timer.every(5 * 60 * 1000, (cx) => { if (this.auto) this.refresh(cx); });
    // contract: prs.refreshed ({ ts }) is set by the prs mod after its Refresh replaced gh's cached PR list; the cache
    // is fresh then, so a plain load shows it with no GitHub call. Optional: without the prs mod nothing comes.
    // A cheap compare every 2 s: render() can't start the load (a task spawned with render's cx never runs).
    this.started = Date.now();
    cx.timer.every(2000, (cx) => {
      const r = shared("prs.refreshed");
      if (r && r.ts !== this.prsTs) { this.prsTs = r.ts; if (r.ts > this.started) this.loadPrs(cx); }
    });
  }

  // The repo of a folder by its origin remote: `{ key, name }`, or null outside a repo. Worktrees of one repo share it.
  async repoOf(folder, on) {
    const id = `${on}|${folder}`;
    if (!this.remotes.has(id)) {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd: folder, on, timeout: 15000 }).catch(() => null);
      const name = r?.code === 0 ? repoName(r.stdout.trim()) : null;
      this.remotes.set(id, name ? { key: `${on}|${name}`, name } : null);
      if (this.remotes.size > REMOTES_MAX) this.remotes.delete(this.remotes.keys().next().value);
    }
    return this.remotes.get(id);
  }

  // Where PRs load from: every terminal folder of every space, one per folder. Not the focus: the list is the same
  // whichever terminal is focused.
  places() {
    const out = new Map(), machineOf = new Map();
    for (const s of spaces()) for (const tb of s.tabs ?? []) machineOf.set(tb.id, s.machine ?? null);
    for (const p of panes()) if (p.cwd && machineOf.has(p.tab)) out.set(`${machineOf.get(p.tab)}|${p.cwd}`, { folder: p.cwd, on: machineOf.get(p.tab) });
    return [...out.values()];
  }

  // The open PRs of every space's repo (on open, Refresh, auto-sync), one gh call per repo in parallel; repos no space
  // points at any more leave memory. Redraws only when the merged index changed.
  // `force` (Refresh): GitHub is asked past gh's cache (FORCE), and the new answer replaces the cached one every mod reads.
  // ponytail: a repo of a space opened later shows its PRs after the next Refresh / auto-sync.
  loadPrs(cx, force = false) {
    if (this.prLoading) { this.prAgain = true; this.prAgainForce ||= force; return; }
    this.prLoading = true;
    const places = this.places();
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places) { const r = await this.repoOf(p.folder, p.on); if (r && !repos.has(r.key)) repos.set(r.key, { ...p, name: r.name }); }
        // Merges the repos' lists by issue key; redraws only when that changed. Called after a repo's cached answer
        // (so lines show at once) and once all fresh answers are in.
        const publish = () => {
          for (const key of [...this.prsByRepo.keys()]) if (!repos.has(key)) this.prsByRepo.delete(key);
          const index = new Map();
          for (const byKey of this.prsByRepo.values()) for (const [k, rows] of byKey) index.set(k, [...(index.get(k) ?? []), ...rows]);
          const sig = JSON.stringify([...index]);
          if (sig !== this.prSig) { this.prSig = sig; this.prIndex = index; cx.notify(); }
        };
        await Promise.all([...repos].map(([key, p]) => this.fetchPrs(key, p, publish, force)));
        publish();
      } catch {}
      finally {
        this.prLoading = false;
        // A Refresh replaced gh's cached PR list: tell the other panels (prs reads jira.refreshed and shows it from the cache).
        if (force) setShared("jira.refreshed", { ts: Date.now() });
        if (this.prAgain) { const f = this.prAgainForce; this.prAgain = false; this.prAgainForce = false; this.loadPrs(cx, f); }
      }
    });
  }

  // One repo's open PRs (the newest-updated 100) by issue key; rows keep only what the PR line and the prs mod's
  // dialog use. openPrs (pr-badges.js) is the cached query the prs mod sends too: a repo not shown yet gets gh's
  // cached answer first (STALE, at once, published through `publish`), then the fresh one.
  // No gh or a failed call: that repo keeps its last good list (none at first).
  async fetchPrs(key, { folder, on, name }, publish, force) {
    const apply = ({ prs }) => {
      const byKey = new Map();
      for (const pr of prs) {
        const row = { number: pr.number, title: pr.title, url: pr.url, headRefName: pr.headRefName, baseRefName: pr.baseRefName,
          isDraft: pr.isDraft, mergeable: pr.mergeable, ci: ci(pr.statusCheckRollup), approval: approval(pr), author: pr.author?.login ?? "",
          copilot: copilotBadge(pr, pr.cpUrls), repo: { cwd: folder, on } };
        for (const k of prKeys(pr)) byKey.set(k, [...(byKey.get(k) ?? []), row]);
      }
      this.prsByRepo.set(key, byKey);
    };
    if (!name) return;
    if (!this.prsByRepo.has(key)) try { apply(await openPrs(name, folder, on, STALE)); publish(); } catch {}
    try { apply(await openPrs(name, folder, on, force ? FORCE : undefined)); } catch {}
  }

  // The focused terminal's branch; for a mod pane (wb-diff), a terminal's of the focused tab. Null when none.
  focusBranch() {
    const f = focused(), all = panes();
    const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
    return pane?.branch || all.find((p) => p.branch && p.tab === f?.tab)?.branch || null;
  }

  // "<machine>|<branch>" -> the terminal panes on that branch, each { pane, space, agent, text, seq }: where a PR
  // line's go-to button leads (see paneFor). `text` is an agent's tab name and titles, upper-cased. Built once per render.
  branchPanes() {
    const spaceOf = new Map(), out = new Map(), agentOf = new Map(agents().map((a) => [a.pane, a]));
    for (const s of spaces()) for (const tb of s.tabs ?? []) spaceOf.set(tb.id, s);
    for (const p of panes()) {
      const s = spaceOf.get(p.tab), k = `${s?.machine ?? null}|${p.branch}`, a = agentOf.get(p.pane);
      if (!s || !p.branch) continue;
      const text = a ? [a.tab_name, a.title, p.title].filter(Boolean).join("\n").toUpperCase() : "";
      out.set(k, [...(out.get(k) ?? []), { pane: p.pane, space: s, cwd: p.cwd, branch: p.branch, agent: Boolean(a), text, seq: a?.seq ?? 0 }]);
    }
    return out;
  }

  // The agent already working on the issue in any space: one whose tab name or title names the key (a session jira
  // starts or resumes is named "<key> <title>"), the latest active one; on `branch` first when given (a PR's go-to).
  // Null when none: then the Start session dialog asks what to do.
  agentFor(issueKey, branch = null) {
    const named = [...this.branchPanes().values()].flat().filter((p) => p.agent && mentions(p.text, issueKey)).sort((a, b) => b.seq - a.seq);
    return (branch && named.find((p) => p.branch === branch)) || named[0] || null;
  }

  // For the go-to button's color: an agent on the issue sits on the PR's branch (from the render's byBranch).
  paneFor(pr, issueKey) {
    return (this.byBranch?.get(`${pr.repo?.on ?? null}|${pr.headRefName}`) ?? []).find((p) => p.agent && mentions(p.text, issueKey)) ?? null;
  }

  // A PR line's go-to: as the session button, for that PR (openStart).
  goToPr(pr, issueKey) { return this.openStart(issueKey, pr); }

  // A PR line's click: the prs mod's PR dialog (its props().pr: number, url, isDraft, repo { cwd, on }) when that mod is
  // installed here, else the PR in the browser.
  async openPr(pr) {
    const prs = await fs.exists(`${appHome()}/mods/prs/main.js`).catch(() => false);
    if (prs) openOverlay({ mod: "prs", kind: "dialog", width: 780, height: 0.85, props: { pr } }); else exec("open", [pr.url]);
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

  // `force` (the Refresh button): PRs past gh's cache (see loadPrs); Jira itself is always asked.
  refresh(cx, force = false) {
    this.loadPrs(cx, force);
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
        this.fresh = true;
        icons = { auth: creds.auth, base, site: s.site, issues: [...issues, ...backlog] };
        this.saveCache(s);
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
  // The last loaded list, kept on disk (CACHE_FILE) so a new copy of the panel (another tab, a reload) shows it at
  // once while the fresh load runs; the fresh list replaces it without a "Loading…" in between. Only the fields the
  // rows, groups and sorting read; written only when it changed. Shown only for the same site.
  async loadCache(cx) {
    try {
      const c = JSON.parse(await fs.readFile(`${appHome()}/${CACHE_FILE}`, "utf8"));
      if (this.fresh || c.site !== this.settings().site) return;
      this.mine = c.mine ?? []; this.backlog = c.backlog ?? []; this.count = this.mine.length; this.view = null;
      this.statusOrder ??= new Map(c.statusOrder ?? []); this.cacheText = JSON.stringify(c);
      cx.notify();
      await this.loadIcons(cx, { issues: [...this.mine, ...this.backlog], savedOnly: true });
    } catch {}
  }

  async saveCache(s) {
    const slim = (i) => ({ key: i.key, sprint: i.sprint ? { id: i.sprint.id, name: i.sprint.name, state: i.sprint.state } : null, fields: {
      summary: i.fields.summary, labels: i.fields.labels, updated: i.fields.updated, created: i.fields.created,
      status: i.fields.status && { id: i.fields.status.id, name: i.fields.status.name, statusCategory: { key: i.fields.status.statusCategory?.key } },
      issuetype: i.fields.issuetype && { id: i.fields.issuetype.id, name: i.fields.issuetype.name, iconUrl: i.fields.issuetype.iconUrl, subtask: i.fields.issuetype.subtask },
      parent: i.fields.parent && { key: i.fields.parent.key, fields: { summary: i.fields.parent.fields?.summary } } } });
    const text = JSON.stringify({ site: s.site, mine: this.mine.map(slim), backlog: this.backlog.map(slim), statusOrder: [...(this.statusOrder ?? [])] });
    if (text === this.cacheText) return;
    this.cacheText = text;
    try {
      await fs.mkdir(`${appHome()}/data/jira`, { recursive: true });
      await fs.writeFile(`${appHome()}/${CACHE_FILE}`, text);
    } catch {}
  }

  // `savedOnly` (the cached list, no credentials yet): only icons already on disk; the others wait for the fresh load.
  async loadIcons(cx, { auth, base, site, issues, savedOnly = false }) {
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
          if (savedOnly) { this.typeIcons.delete(ty.id); return; }
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

  // The focused folder and the machine of the active space: where a session for an issue starts and whose repo's PRs show.
  // A mod pane (wb-diff) has no folder: then a terminal of the focused tab, else of the space; space.folder last (it can
  // be stale, e.g. home).
  startPlace() {
    const space = spaces().find((s) => s.active), f = focused(), all = panes();
    const tabs = new Set((space?.tabs ?? []).map((tb) => tb.id));
    const pane = f?.pane ? all.find((p) => p.pane === f.pane) : null;
    const near = pane?.cwd || f?.cwd || all.find((p) => p.cwd && p.tab === f?.tab)?.cwd || all.find((p) => p.cwd && tabs.has(p.tab))?.cwd;
    return { folder: near || space?.folder || null, on: space?.machine ?? null };
  }

  summaryOf(key) {
    return [...this.mine, ...this.backlog].find((i) => i.key === key)?.fields.summary ?? "";
  }

  // The session button and a PR line's go-to (with that PR; the session button takes the issue's PR when it has
  // exactly one). An agent already on the issue gets the focus (never a second copy of it). Otherwise always the
  // Start session dialog, which asks where (worktree or here) and how (resume the past session or a new one).
  openStart(key, pr = null) {
    const prs = this.prIndex?.get(key) ?? [];
    pr ??= prs.length === 1 ? prs[0] : null;
    const hit = this.agentFor(key, pr?.headRefName);
    if (hit) { run("space.select", { id: hit.space.id }); run("pane.focus", { pane: hit.pane }); return; }
    return this.openStartDialog(key, pr);
  }

  // The folder the dialog works from, so it lands in the issue's repo whichever space is active:
  // 1. a terminal already on the issue's branch (the PR's, else one naming the key);
  // 2. a PR: the focused folder when it is in the PR's repo, else the folder the PR was loaded from;
  // 3. the issue's latest past session in any project (human-history, this machine): its worktree when it still
  //    exists, else its repo's main checkout (that session comes along as `past`);
  // 4. the focused folder.
  async startFolder(key, pr) {
    const terms = [...this.branchPanes().values()].flat().filter((p) => p.cwd);
    const on = (t) => (t.space.machine ?? null);
    const onBranch = pr ? terms.find((t) => t.branch === pr.headRefName) : terms.find((t) => mentions(t.branch.toUpperCase(), key));
    if (onBranch) return { folder: onBranch.cwd, on: on(onBranch) };
    const place = this.startPlace();
    if (pr) {
      const { cwd, on: prOn } = pr.repo ?? {};
      const same = place.folder && (place.on ?? null) === (prOn ?? null)
        && (await this.repoOf(place.folder, prOn))?.key === (await this.repoOf(cwd, prOn))?.key;
      return same ? place : { folder: cwd, on: prOn ?? null };
    }
    this.home ??= (await exec("sh", ["-c", 'printf %s "$HOME"']).catch(() => null))?.stdout.trim() || null;
    const past = this.home ? await pastSession(key, this.home, "all") : null;
    for (const dir of [past?.worktree, past?.cwd, past?.repo?.replace(/\/\.git\/?$/, "")].filter(Boolean)) {
      if ((await exec("test", ["-d", dir]).catch(() => null))?.code === 0) return { folder: dir, on: null };
    }
    return place;
  }

  // Opens the Start session dialog (its own past sessions list replaces the history mod's panel it used to hold).
  async openStartDialog(key, pr = null) {
    const place = await this.startFolder(key, pr);
    const start = { key, summary: this.summaryOf(key), ...place, pr: pr ? { number: pr.number, url: pr.url, headRefName: pr.headRefName } : null };
    openOverlay({ mod: "jira", kind: "dialog", width: 620, height: 640, props: { start } });
  }

  // The dialog's facts, read once it opens: the repo (main checkout, default branch), its worktrees by branch, its
  // branches (local and origin's), the folder's branch and whether it has uncommitted changes, and the issue's latest
  // past session (human-history, local folders only). The branch field starts with the PR's branch, else an existing
  // branch naming the key (local first), else a new name. "Here" is picked when the folder is already on that branch.
  initStart(cx) {
    const s = props().start;
    // sessions: undefined while searching; pick: the index of the session to resume, -1 = a new one.
    this.st = { ...s, mode: "worktree", git: null, sessions: undefined, pick: -1, error: null, busy: false };
    this.stBranch = InputState.new({ value: s.pr?.headRefName ?? branchFor(s.key, s.summary), placeholder: "branch name" });
    this.stBase = InputState.new({ value: "", placeholder: "base branch, e.g. master" });
    for (const i of [this.stBranch, this.stBase]) i.on("submit", (_e, cx) => this.start(cx));
    this.stBranch.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      const git = (args) => exec("git", args, { cwd: s.folder, on: s.on, timeout: 15000 }).catch(() => null);
      const info = s.folder ? await gitInfo(s.folder, s.on) : null;
      if (!info) { this.st.git = false; this.st.sessions = []; cx.notify(); return; }
      const [home, wts, refs, cur, status] = await Promise.all([
        exec("sh", ["-c", 'printf %s "$HOME"'], { on: s.on }).catch(() => null),
        worktreesOf(s.folder, s.on),
        git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]),
        git(["rev-parse", "--abbrev-ref", "HEAD"]),
        git(["status", "--porcelain", "-uno"]),
      ]);
      const names = (refs?.stdout ?? "").split("\n").filter(Boolean);
      const local = new Set(names.filter((n) => !n.startsWith("origin/")));
      const remote = new Set(names.filter((n) => n.startsWith("origin/") && n !== "origin/HEAD").map((n) => n.slice(7)));
      this.st.git = { main: info.main, repo: info.main.split("/").pop(), home: home?.stdout.trim() || "~", wts, local, remote,
        cur: cur?.stdout.trim() ?? "", dirty: Boolean(status?.stdout.trim()) };
      this.stBase.set_value(info.base);
      if (!s.pr) {
        const named = [...local, ...remote].find((n) => mentions(n.toUpperCase(), s.key));
        if (named) this.stBranch.set_value(named);
      }
      if (this.st.git.cur === this.stBranch.value().trim()) this.st.mode = "here";
      cx.notify();
      // The issue's past sessions in this repo (all worktrees), best first; a new session stays picked.
      this.st.sessions = s.on ? [] : await pastSessions(s.key, info.main, "repository", 5, true);
      cx.notify();
    });
  }

  // Start: put the branch in place, then the agent there, in the space that already shows that folder (a new tab),
  // else a new space (worktree) or the active one (here).
  // - Worktree: the branch's worktree when it has one; else `git worktree add` next to the main checkout, from the
  //   local branch, else origin's (fetched, tracked), else a new branch from origin/<base>.
  // - Here: the folder switches to the branch (local, origin's tracked, or new from origin/<base>); refused while it
  //   has uncommitted changes or another worktree has the branch. Nothing to do when it is already on it.
  // - The agent: the past session resumed there (Claude's conversation file copied over when it ran in another
  //   folder), or a new one with a task (a fresh worktree: prepare it; an existing branch: read and wait; a new branch
  //   here: work on it). Outside a git repo only a new agent starts in the folder.
  // ponytail: origin only; a PR from a fork fails at the fetch with git's message. `gh pr checkout` if forks matter.
  start(cx) {
    const st = this.st, g = st.git;
    if (st.busy || g === null) return;
    const past = st.sessions?.[st.pick] ?? null;
    const branch = this.stBranch.value().trim(), base = this.stBase.value().trim().replace(/^origin\//, "");
    const fail = (m) => { st.error = m; st.busy = false; cx.notify(); };
    if (g && (!branch || /\s/.test(branch))) return fail("Branch name without spaces");
    if (g && !g.local.has(branch) && !g.remote.has(branch) && !base) return fail("Base branch for the new branch, e.g. master");
    const elsewhere = g && g.wts.get(branch);
    if (g && st.mode === "here" && g.cur !== branch) {
      if (g.dirty) return fail("This folder has uncommitted changes: commit or stash them, or pick Worktree");
      if (elsewhere) return fail(`${branch} is checked out in ${elsewhere}: pick Worktree to go there`);
    }
    st.busy = true; st.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = (cwd, args, timeout = 30000) => exec("git", args, { cwd, on: st.on, timeout });
        let folder = st.folder, fresh = false;
        if (g) {
          const isLocal = g.local.has(branch);
          let isRemote = g.remote.has(branch);
          // The newest of origin's branch (also one created since the dialog opened).
          if (!isLocal) { const f = await git(g.main, ["fetch", "origin", branch], 120000); isRemote = f.code === 0; }
          const from = async (args) => {
            if (isLocal) return [branch];
            if (isRemote) return ["--track", "-b", branch, ...args, `origin/${branch}`];
            const f = await git(g.main, ["fetch", "origin", base], 120000);
            if (f.code !== 0) throw new Error(`git fetch origin ${base}: ${lastLine(f)}`);
            fresh = true;
            return ["-b", branch, ...args, `origin/${base}`];
          };
          if (st.mode === "worktree") {
            folder = elsewhere ?? worktreePath(g.main, branch);
            if (!elsewhere) {
              const how = await from([folder]);
              const added = await git(g.main, ["worktree", "add", ...(isLocal ? [folder, branch] : how)]);
              if (added.code !== 0) throw new Error(`git worktree add: ${lastLine(added)}`);
            }
          } else if (g.cur !== branch) {
            const done = await git(folder, ["checkout", ...(await from([]))]);
            if (done.code !== 0) throw new Error(`git checkout: ${lastLine(done)}`);
          }
        }
        const name = tabName(st.key, st.summary);
        let launch = null;
        if (past) {
          // A session that can't be resumed is an error in the dialog, never a silent new session.
          const argv = await resumeArgv(past, folder);
          if (!argv) throw new Error(`Can't resume "${past.title || past.session_id}": its conversation file wasn't copied into this folder's project; pick New session`);
          launch = { name, argv };
          notify({ title: `Resumed ${st.key}`, body: past.title || past.session_id, level: "info" });
        }
        if (!launch) {
          const [argv, description] = await Promise.all([
            agentArgv(this.settings().agent ?? "claude", st.on),
            withTimeout(cx, describeIssue(this.settings(), st.key), 15000, ""),
          ]);
          const facts = { key: st.key, summary: st.summary, description, branch, base, pr: st.pr };
          const task = !g ? `${st.key}: ${st.summary}${about(description)}`
            : st.mode === "worktree" && (fresh || !elsewhere) ? worktreeTask({ ...facts, path: folder, main: g.main, fresh })
            : fresh ? `${st.key}: ${st.summary}${about(description)} — You are on the new branch ${branch}, created from origin/${base}. Work on ${st.key}.`
            : existingTask(facts);
          launch = { name, argv, task };
        }
        // The space that already shows this folder (its own folder, or a terminal there).
        const tabSpace = new Map();
        for (const s of spaces()) if ((s.machine ?? null) === (st.on ?? null)) for (const tb of s.tabs ?? []) tabSpace.set(tb.id, s);
        const shown = [...new Set(tabSpace.values())].find((s) => s.folder === folder)
          ?? tabSpace.get(panes().find((p) => p.cwd === folder && tabSpace.has(p.tab))?.tab);
        if (shown) { run("space.select", { id: shown.id }); run("tab.new", { ...launch, folder }); }
        else if (st.mode === "worktree" && g) run("space.new", { ...launch, folder, machine: st.on ?? "" });
        else run("tab.new", { ...launch, ...(folder ? { folder } : {}) });
        closeOverlay(props().overlay);
      } catch (e) { fail(String(e.message ?? e)); }
    });
  }

  startView(t) {
    const st = this.st, g = st.git, agentName = this.settings().agentName ?? "Claude Code";
    const branch = this.stBranch.value().trim();
    const button = (...a) => dialogButton(t, ...a);
    const tilde = (p) => g?.home && p?.startsWith(g.home) ? "~" + p.slice(g.home.length) : p;
    const choice = (id, on, title, about, pick) => choiceCard(t, id, on, title, about, () => { pick(); st.error = null; });
    const wt = g ? g.wts.get(branch) : null;
    const known = g && (g.local.has(branch) || g.remote.has(branch));
    const kind = !g ? "" : st.pr && branch === st.pr.headRefName ? `PR #${st.pr.number} branch` : g.local.has(branch) ? "Existing branch"
      : g.remote.has(branch) ? "Existing branch on origin" : `New branch from origin/${this.stBase.value().trim() || "…"}`;
    const hereAbout = !g ? "" : g.cur === branch ? `${tilde(st.folder)} is on this branch`
      : g.dirty ? `${tilde(st.folder)} has uncommitted changes` : wt ? `Checked out in ${tilde(wt)}` : `Switch ${tilde(st.folder)} to it`;
    const sessions = st.sessions;
    // A past session's line: agent, age, branch, folder.
    const sessAbout = (s) => [s.agent, s.updated_at ? daysAgo(s.updated_at) : "", s.branch, tilde(s.cwd)].filter(Boolean).join(" · ");
    const section = (label) => div().text_size(10).font_semibold().text_color(t.dim).child(label.toUpperCase());
    return v_flex().id("start").size_full().bg(t.background).text_color(t.foreground).text_size(12)
      .child(v_flex().flex_none().px(16).pt(14).pb(12).gap(4).border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(14).child(`Start ${agentName} session`))
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(st.key))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(st.summary))))
      .child(v_flex().id("start-body").flex_1().min_h(0).overflow_y_scroll().px(16).py(12).gap(12)
        .child(g === null ? div().text_color(t.dim).child("Checking the folder…")
          : g === false ? div().text_color(t.dim).child(`${tilde(st.folder) ?? "No folder"} is not a git repository: the agent starts there.`)
          : v_flex().gap(12)
            .child(h_flex().gap(8).items_end()
              .child(div().flex_1().min_w(0).child(this.field("st-branch", `Branch · ${kind}`, this.stBranch, t)))
              .when(!known, (e) => e.child(div().w(150).flex_none().child(this.field("st-base", "From origin/", this.stBase, t)))))
            .child(section("Where: the folder and branch the agent works in"))
            .child(h_flex().gap(8).items_stretch()
              .child(choice("mode-worktree", st.mode === "worktree", wt ? "Its worktree" : "New worktree",
                tilde(wt ?? worktreePath(g.main, branch || "…")), () => { st.mode = "worktree"; }))
              .child(choice("mode-here", st.mode === "here", `Here · ${g.repo}`, hereAbout, () => { st.mode = "here"; }))))
        // The session: a new one (first, picked) or one of the issue's past sessions to resume, best first, one card each.
        .child(div().h(1).bg(t.border))
        .child(section("Session: the conversation the agent starts with"))
        .child(sessions === undefined ? div().text_size(11).text_color(t.dim).child("Looking for past sessions…")
          : v_flex().gap(6)
            .child(choice("sess-new", st.pick === -1, `New ${agentName} session`,
              sessions.length ? "Without the past context" : "No past session mentions this issue", () => { st.pick = -1; }))
            .children(sessions.map((s, i) => choice(`sess-${i}`, st.pick === i, s.title || s.session_id, sessAbout(s), () => { st.pick = i; }))))
        .when(Boolean(st.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(st.error))))
      .child(h_flex().flex_none().px(16).py(12).gap(8).justify_end().border_t(1).border_color(t.border)
        .child(button("st-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("st-start", st.busy ? "Starting…" : st.pick >= 0 ? "Resume" : "Start", true, (_e, cx) => this.start(cx))));
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
      .child(item("menu-session", `Start ${this.settings().agentName ?? "Claude Code"} session…`, () => { const prs = this.prIndex?.get(key) ?? []; this.openStartDialog(key, prs.length === 1 ? prs[0] : null); }));
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
    const prs = this.prIndex.get(issue.key) ?? [], open = prs.length > 0 && this.prOpen.has(issue.key);
    // The PR icon's color: red when a PR has failed CI, conflicts or requested changes; yellow while CI runs; green when
    // every PR is approved with CI passed; else dim.
    const prColor = prs.some((p) => p.ci === "fail" || p.mergeable === "CONFLICTING" || p.approval === "changes") ? t.ansi1
      : prs.some((p) => p.ci === "wait") ? t.working
      : prs.every((p) => p.approval === "approved" && p.ci !== "fail") ? t.done : t.dim;
    // Two parts side by side in one group: the issue (hover, click, menu, tooltip) and its PR lines below it (shown by
    // the PR icon), each with its own hover, so pointing at a PR doesn't light up the issue. The group carries the
    // highlights and the hotfix bar.
    return v_flex().id(`issue-${section}-${issue.key}`).flex_none().rounded(5).relative().when(open, (e) => e.pb(3))
      // Label "hotfix": a red bar on the row's left edge.
      .when(hotfix, (e) => e.child(div().absolute().left(1).top(4).bottom(4).w(3).rounded(2).bg(t.ansi1)))
      // The last opened issue: a faint background, so it isn't taken for the current worktree's (below); the right-click menu's row: selected.
      .when(this.selected === issue.key, (s) => s.bg(t.hover))
      .when(this.menu?.key === issue.key, (s) => s.bg(t.selected))
      // The focused terminal's branch is this issue's (as prs marks the PR of the current branch).
      .when(Boolean(this.currentKeys?.has(issue.key)), (s) => s.bg(t.selected).border_l_2().border_color(t.accent))
      .child(v_flex().id(`issue-body-${section}-${issue.key}`).px(8).py(3).rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover)).tooltip(`${issue.key} · ${f.issuetype?.name ?? ""}\n${f.summary}`)
        // on_click fires for the right button too (ClickEvent has no button), so the left press is used.
        .on_mouse_down("left", (_e, cx) => { this.selected = issue.key; exec("open", [this.url(issue.key)]); cx.notify(); })
        // The root's own right-press handler (it runs next) places the menu.
        .on_mouse_down("right", () => { this.menuKey = issue.key; })
        // Two lines, as prs lays out a PR: the type icon, the key (dim), the status (its category's color), the age, the PR
        // icon and the session button; then the summary, under the key. Icon sizes as in prs (14 in a 15 box, buttons 18).
        .child(h_flex().gap(6).items_center()
          .child(div().size(15).flex_none().flex().items_center().justify_center()
            .child(image(this.typeIcons.get(f.issuetype?.id) ?? typeIcon(f.issuetype)).size(14)))
          .child(div().flex_none().text_color(t.dim).child(issue.key))
          .child(div().min_w(0).truncate().text_color(color).child(f.status?.name ?? ""))
          .when(Boolean(f.created), (e) => e.child(div().flex_none().text_color(t.dim).child(daysAgo(f.created))))
          .child(div().flex_1())
          // The issue has open PRs: their icon (with the count from two on) shows or hides their lines; the press
          // stops here, so the row doesn't open Jira.
          .when(prs.length > 0, (e) => e.child(h_flex().id(`prs-${section}-${issue.key}`).flex_none().h(18).px(3).gap(2).items_center().rounded(4)
            .text_color(prColor).when(open, (s) => s.bg(t.hover)).hover((s) => s.bg(t.hover))
            .tooltip(`${prs.length === 1 ? "1 pull request" : `${prs.length} pull requests`}: ${prs.map((p) => `#${p.number}`).join(", ")}\nClick to ${open ? "hide" : "show"}`)
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); if (!this.prOpen.delete(issue.key)) this.prOpen.add(issue.key); cx.notify(); })
            .child(svg("mods/jira/pr.svg").size(14))
            .when(prs.length > 1, (e) => e.child(div().text_size(11).font_semibold().child(String(prs.length))))))
          // Start a Claude session for this task; the press stops here, so the row doesn't open Jira.
          .child(div().id(`session-${section}-${issue.key}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Go to the agent on ${issue.key} in any space; else start or resume a session (asks where)`)
            .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.openStart(issue.key); })
            .child(svg("mods/jira/session.svg").size(12))))
        .child(div().pl(21).truncate().child(f.summary ?? "")))
      .children(open ? prs.map((pr) => this.prLine(pr, t, issue.key, `${section}-${issue.key}`, new Set(prs.map((p) => repoOfUrl(p.url))).size > 1)) : []);
  }

  // A PR of any space's repo under its issue: CI dot, approval, conflict, draft, number and head branch. Click opens it.
  // `repos`: the issue's PRs are in more than one repo, so the line names its repo before the number.
  prLine(pr, t, issueKey, row, repos) {
    const dot = { ok: t.done, fail: t.ansi1, wait: t.working }[pr.ci] ?? t.border;
    const [apIcon, apColor] = pr.approval === "approved" ? ["approved", t.done] : pr.approval === "changes" ? ["changes", t.ansi1] : ["approved", t.border];
    const repo = repoOfUrl(pr.url);
    // Two repos can both have a PR #n: the element ids carry the repo too.
    const id = `${row}-${repo ?? ""}`;
    const here = this.paneFor(pr, issueKey);
    const tip = [repo ? `${repo} #${pr.number}` : `#${pr.number}`, pr.title, `${pr.headRefName} → ${pr.baseRefName}`, pr.author ? `By ${pr.author}` : null,
      { ok: "CI: passed", fail: "CI: a check failed", wait: "CI: running" }[pr.ci] ?? "CI: no checks",
      pr.approval === "approved" ? "Approved" : pr.approval === "changes" ? "Changes requested" : "Not approved yet",
      pr.mergeable === "CONFLICTING" ? "Merge conflicts" : null, pr.isDraft ? "Draft" : null].filter(Boolean).join("\n");
    const icon = (name, color) => svg(`mods/jira/${name}.svg`).size(14).flex_none().text_color(color);
    // Copilot badge "C", as prs: filled red = open High/Medium threads; filled blue = only Low ones open; filled green =
    // reviewed, none open; yellow spinner = reviewing (requested); faint = not run yet.
    const { level } = pr.copilot ?? { level: "", open: 0 }, cpTip = copilotTip(pr.copilot ?? { level: "", open: 0 });
    const fill = { high: t.ansi1, low: t.accent, ok: t.done }[level];
    return h_flex().id(`pr-${id}-${pr.number}`).mx(6).mt(1).px(2).py(1).gap(6).items_center().rounded(4).text_size(12).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.openPr(pr); })
      .child(div().size(9).flex_none().flex().items_center().justify_center().child(div().size(7).rounded(4).bg(dot)))
      .child(div().id(`cp-${id}-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().rounded(4).border_1().text_size(10).font_semibold()
        .border_color(fill ?? (level === "asked" ? t.working : t.border)).bg(fill ?? t.background)
        .text_color(fill ? t.background : level === "asked" ? t.working : t.dim)
        .tooltip(cpTip).child(level === "asked" ? svg("mods/jira/spinner.svg").size(11).text_color(t.working).spin(900) : "C"))
      .child(icon(apIcon, apColor))
      .when(pr.mergeable === "CONFLICTING", (e) => e.child(icon("conflict", t.ansi1)))
      .when(Boolean(pr.isDraft), (e) => e.child(icon("draft", t.ansi5)))
      .child(div().flex_none().max_w(140).truncate().text_color(t.muted).child(repos && repo ? `${repo} #${pr.number}` : `#${pr.number}`))
      // Head branch, then the target as "→ base" (kept short, the head truncates first), then the author on the right, as prs shows them.
      .child(div().min_w(0).truncate().child(pr.headRefName ?? ""))
      .when(Boolean(pr.baseRefName), (e) => e.child(div().flex_none().max_w(110).truncate().text_color(t.muted).child(`→ ${pr.baseRefName}`)))
      .child(div().flex_1())
      .when(Boolean(pr.author), (e) => e.child(div().flex_none().max_w(120).truncate().text_color(t.muted).child(pr.author)))
      // Go to where the branch is checked out (accent while a terminal is on it); the press stops here, so the line doesn't open the PR.
      .child(div().id(`goto-${id}-${pr.number}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
        .text_color(here?.agent ? t.accent : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(here?.agent ? `Go to the agent on ${issueKey} in ${here.space.name}`
          : `Start or resume a session on ${pr.headRefName} (asks where)`)
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.goToPr(pr, issueKey); })
        .child(svg("mods/jira/goto.svg").size(12)));
  }

  // The panel goes: a running recording stops.
  async close() { await this.voice?.close(); }

  render(cx) {
    if (this.st) return this.startView(theme());
    const t = theme(), q = this.query, form = this.setup || this.editing;
    const picked = this.statuses, filtered = this.current || picked.size > 0;
    const byStatus = (issue) => !picked.size || picked.has(issue.fields.status?.name ?? "");
    const match = (issue) => byStatus(issue) && (!q || issue.key.toLowerCase().includes(q) || (issue.fields.summary ?? "").toLowerCase().includes(q));
    const s = this.settings(), view = `${s.groupBy}|${s.sort}|${s.project}`;
    if (this.view !== view) { this.view = view; this.regroup(); }
    // Only while some PR line shows (render reruns when panes change, so it stays current).
    this.byBranch = this.prIndex.size ? this.branchPanes() : null;
    // The issue(s) of the focused terminal's branch (a worktree's "DPM-1143-…"), highlighted; render reruns on focus moves.
    const branch = this.focusBranch();
    this.currentKeys = new Set(branch ? [...branch.matchAll(/[A-Za-z][A-Za-z0-9_]*-\d+/g)].map((m) => m[0].toUpperCase()) : []);
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
      .on_mouse_up("left", (_e, cx) => this.voice.up(cx)) // hold-to-talk: a release anywhere in the panel ends the recording
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
        // Right-click switches auto-sync; the icon is in the accent colour while it is on.
        .child(iconButton("refresh", "mods/jira/refresh.svg", this.setup ? "Refresh" : `Refresh\nRight-click: auto-sync every 5 minutes (${this.auto ? "on" : "off"})`,
          (_e, cx) => this.refresh(cx, true), this.loading)
          .when(!this.setup && this.auto, (s) => s.text_color(t.accent))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (!this.setup) this.toggleAuto(cx); })))
      .when(!form, (e) => e.child(h_flex().flex_none().px(8).pt(8).gap(6).items_center()
        .child(div().id("search").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.search).h_full().text_size(12).text_color(t.foreground)))
        .child(this.voice.button(t))
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
      .when(!form && Boolean(this.voice.state), (e) => e.child(this.voice.status(t)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("jira-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(form, (e) => e.child(this.formView(t)))
          .when(!form && Boolean(this.voice.setup), (e) => e.child(this.voice.setupCard(t)))
          .when(Boolean(empty) && !this.voice.setup, (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(!form && !this.voice.setup, (e) => e
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
