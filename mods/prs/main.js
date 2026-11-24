import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, InputState, Input, TextareaState, Textarea } from "gpui-base";
import * as fs from "fs/promises";
import { spaces, panes, focused, exec, readTextFile, theme, notify, props, openOverlay, closeOverlay, shared, setShared, run, knownAgents, layout, appHome } from "herdr";
import { migrate, modelFor, settingsFor, projectKey, projectName, languageLine, runModel, describe } from "./ai.js";
import { ci, isCopilot, copilot, reviewed, openPrs, STALE, FORCE, copilotBadge, copilotTip, approval, copilotOverview, repoOfUrl } from "./pr-badges.js";

// My open pull requests in the repo of the focused folder, via the `gh` CLI. Click opens the PR in a popup
// (description, who approved, comments and reviews); the popup has Open (browser) and Copy link.
// The header switches between open PRs I authored plus those waiting for my review (Mine) and every open PR
// of the repo (All); first 100.
// A mod pane (a wb-diff tab) has no cwd: keep the last terminal folder of that space (`places`, per
// instance) instead of the space folder, which may not be a repo.
const PLACES_MAX = 50;
const POLL_EVERY = 2 * 60 * 1000;
function location(places) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd;
  if (cwd) {
    // The branch only for a terminal pane (a layout terminal block has no PaneInfo: no branch).
    const branch = pane?.cwd ? pane.branch ?? null : null;
    places.delete(space?.id); places.set(space?.id, { cwd, on, branch });
    if (places.size > PLACES_MAX) places.delete(places.keys().next().value);
    return { cwd, on, branch };
  }
  return places.get(space?.id) ?? { cwd: space?.folder, on, branch: space?.branch ?? null };
}

// Is the "prs" block shown in the layout tree: not hidden itself, no hidden ancestor, and the active child of
// every stack above it. null when no block shows prs (a pane mod, a dialog): the caller treats that as shown.
// ponytail: the first prs block found; a prs pane in another tab can't be told apart and counts as shown.
function shownIn(node) {
  if (!node) return null;
  if (node.content?.mod === "prs") return !node.hidden;
  for (const c of node.children ?? []) {
    const r = shownIn(c);
    if (r !== null) return r && !node.hidden && (node.type !== "stack" || !node.active || node.active === c.id);
  }
  return null;
}

// CI, approval and Copilot badges: ./pr-badges.js (copy of lib/pr-badges.js, shared with jira).

// `all`: every open PR of the repo; else mine, then those waiting for my review. One call either way: openPrs
// (pr-badges.js), the same cached query the jira mod sends, filtered here.
// `ttl`: STALE to show what gh has cached (no wait) before a fresh call.
async function list(repo, cwd, on, all, ttl) {
  if (!repo) throw new Error("Not a GitHub repo (no origin on github.com)");
  const { viewer, prs } = await openPrs(repo, cwd, on, ttl);
  if (all || !viewer) return { viewer, prs };
  const mine = prs.filter((pr) => pr.author?.login === viewer), asked = prs.filter((pr) => pr.needMe && pr.author?.login !== viewer);
  return { viewer, prs: [...mine, ...asked] };
}

// Who approved: each reviewer's latest review that counts, those that are APPROVED.
function approvedBy(reviews) {
  const last = new Map();
  for (const r of reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  return [...last].filter(([, st]) => st === "APPROVED").map(([login]) => login).filter(Boolean);
}
// A PR's line-comment threads with their comments. ponytail: first 100 threads, 30 comments each.
const THREADS = "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:30){nodes{author{login} body createdAt url}}}}}}}";

// a toward b by w (0..1), both "#rrggbb"; a when either isn't. (Same as files-copy's mixHex.)
function mixHex(a, b, w) {
  const p = (c) => /^#[0-9a-f]{6}/i.test(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null, x = p(a), y = p(b);
  return x && y ? "#" + x.map((v, i) => Math.round(v * w + y[i] * (1 - w)).toString(16).padStart(2, "0")).join("") : a;
}
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

// The repo's own rules for a PR, as "### path\n<text>" blocks: the GitHub PR template, then tracked agent docs
// (.claude rules/skills/commands, .github instructions, AGENTS.md) that mention pull requests most, then CLAUDE.md.
// ponytail: found by grep, capped at 6 files × 8000 chars; a repo that keeps PR rules elsewhere needs its path here.
const PR_TEMPLATES = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/*.md"];
async function prRules(root, on) {
  const git = (args) => exec("git", args, { cwd: root, on, timeout: 10000 }).catch(() => null);
  const [tpl, hits] = await Promise.all([git(["ls-files", "--", ...PR_TEMPLATES]),
    git(["grep", "-c", "-i", "-I", "-E", "pull request|gh pr create", "--", "CLAUDE.md", "AGENTS.md", ".claude/*.md", ".github/*.md", ".cursor/*"])]);
  const lines = (r) => r?.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  const ranked = lines(hits).map((l) => l.split(/:(\d+)$/)).sort((a, b) => b[1] - a[1]).map(([p]) => p);
  const paths = [...new Set([...lines(tpl).slice(0, 1), ...ranked.filter((p) => !PR_TEMPLATES.includes(p)), "CLAUDE.md"])].slice(0, 6);
  const texts = await Promise.all(paths.map((p) => readTextFile(`${root}/${p}`, { on }).catch(() => null)));
  return paths.map((p, i) => texts[i]?.trim() ? `### ${p}\n${texts[i].trim().slice(0, 8000)}` : "").filter(Boolean).join("\n\n");
}

// "owner/name" from a git remote URL (https or ssh), or null.
const repoName = (url) => /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;

// "Work in a worktree": one worktree per PR branch, next to the main checkout (<parent>/<repo>-<branch slug>,
// the same scheme as other mods use), with an agent started there.
const worktreeSlug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const worktreePath = (main, branch) => `${main.replace(/\/[^/]+$/, "")}/${main.split("/").pop()}-${worktreeSlug(branch)}`;
// Space name: "#123 First words of the title" (whole words, about 30 chars of title).
const spaceName = (n, title) => {
  let s = "";
  for (const w of (title ?? "").trim().split(/\s+/).filter(Boolean)) { if (s && (s + " " + w).length > 30) break; s = s ? s + " " + w : w; }
  return s ? `#${n} ${s.slice(0, 40)}` : `#${n}`;
};
// The agent's first message. One line: a newline could send it early.
// ponytail: body capped at 3000 chars; the setup steps are left to the agent and the repo's own docs.
const worktreeTask = ({ pr, body, path, branch, main, fork }) => {
  const text = (body ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\s+/g, " ").trim();
  const cut = text.length > 3000 ? text.slice(0, 3000) + "…" : text;
  return `PR #${pr.number}: ${(pr.title ?? "").replace(/\s+/g, " ")} — Description: ${cut || "(none)"} — ` +
    `You are in a git worktree ${path} on branch ${branch}, the head of PR #${pr.number} (${pr.url}); the main checkout is ${main}. ` +
    `First prepare this worktree as the repo's own docs say (CLAUDE.md, AGENTS.md, .claude/, README): copy the gitignored files it needs from the main checkout ` +
    `(env files, certificates, local config), install dependencies, and list what you copied; don't change the main checkout. ` +
    `Then read the PR's review comments and unresolved threads with gh and address them; ask before pushing.` +
    (fork ? " This PR comes from a fork: don't push unless I ask." : "");
};
const lastLine = (r) => (r.stderr || r.stdout || "").trim().split("\n").pop();

export default class Prs extends View {
  // Installed agents per machine (knownAgents), cached; the one a worktree starts is claude if installed, else the first.
  async loadAgents(on, cx) {
    const k = on ?? "";
    if (this.agents.has(k)) return this.agents.get(k);
    let list = [];
    try { list = (await knownAgents({ on })).filter((a) => a.installed); } catch {}
    const a = list.find((x) => x.key === "claude") ?? list[0];
    const pick = { argv: a?.run ?? ["claude"], name: a?.name ?? a?.key ?? "claude" };
    if (list.length) { this.agents.set(k, pick); cx.notify(); }
    return pick;
  }

  // One click: worktree on the PR's branch (or the existing one) and an agent there with the PR as prompt.
  startWorktree(pr, cx) {
    if (this.starting.has(pr.url)) return;
    this.starting.add(pr.url); cx.notify();
    const { cwd, on } = pr.repo ?? {};
    const fail = (m) => notify({ title: "Pull requests", body: `#${pr.number}: ${m}`, level: "error" });
    cx.spawn(async (cx) => {
      try {
        const rev = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on, timeout: 30000 });
        if (rev.code !== 0) return fail(lastLine(rev));
        const main = rev.stdout.trim().replace(/\/\.git\/?$/, "");
        const git = (args, timeout = 30000) => exec("git", args, { cwd: main, on, timeout });
        const head = pr.headRefName, fork = Boolean(pr.isCrossRepository);
        // A fork's branch name may clash with a local one: a local name of its own.
        const branch = fork ? `pr-${pr.number}-${worktreeSlug(head)}` : head;
        const path = worktreePath(main, branch);
        const agent = await this.loadAgents(on, cx);
        const start = async (dir) => {
          let body = pr.body;
          const v = await exec("gh", ["pr", "view", String(pr.number), "--json", "body"], { cwd, on, timeout: 60000 }).catch(() => null);
          try { body = JSON.parse(v.stdout).body ?? body; } catch {}
          run("space.new", { name: spaceName(pr.number, pr.title), folder: dir, machine: on ?? "", argv: agent.argv,
            task: worktreeTask({ pr, body, path: dir, branch, main, fork }) });
        };
        const list = await git(["worktree", "list", "--porcelain"]);
        if (list.code !== 0) return fail(lastLine(list));
        // Idempotent: the branch already has a worktree (its path is in the line above its "branch" line).
        let existing = null, cur = null;
        for (const line of list.stdout.split("\n")) {
          if (line.startsWith("worktree ")) cur = line.slice(9);
          else if (line === `branch refs/heads/${branch}`) existing = cur;
        }
        if (existing) {
          const sp = spaces().find((s) => s.folder === existing && (s.machine ?? "") === (on ?? ""));
          if (sp) run("space.select", { id: sp.id }); else await start(existing);
          return;
        }
        const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        let added;
        if (local.code === 0) {
          await git(["fetch", "origin", fork ? `pull/${pr.number}/head` : head], 120000).catch(() => null); // failure is fine: the local branch is used as is
          added = await git(["worktree", "add", path, branch]);
        } else if (!fork) {
          const f = await git(["fetch", "origin", head], 120000);
          if (f.code !== 0) return fail(lastLine(f));
          added = await git(["worktree", "add", "--track", "-b", branch, path, `origin/${head}`]);
        } else {
          const f = await git(["fetch", "origin", `pull/${pr.number}/head`], 120000);
          if (f.code !== 0) return fail(lastLine(f));
          added = await git(["worktree", "add", "-b", branch, path, "FETCH_HEAD"]);
        }
        if (added.code !== 0) return fail(lastLine(added));
        await start(path);
      } catch (e) { fail(String(e.message ?? e)); }
      finally { this.starting.delete(pr.url); cx.notify(); }
    });
  }

  // The session button of a row and of the popup: the jira mod's Start session dialog (where: worktree or here; how: a
  // new session or a past one resumed), as its own session button opens it. Documented contract: jira's props().start
  // ({ key, summary, folder, on, pr: { number, url, headRefName } }). The task key comes from the title, else the
  // branch; without one the PR number stands in. Without the jira mod, or for a fork PR (jira's dialog fetches from
  // origin only), the one-click worktree (startWorktree).
  async work(pr, cx) {
    const jira = !pr.isCrossRepository && await fs.exists(`${appHome()}/mods/jira/main.js`).catch(() => false);
    if (!jira) return this.startWorktree(pr, cx);
    const key = (/\b[A-Z][A-Z0-9]+-\d+/.exec(pr.title ?? "") ?? /\b[A-Z][A-Z0-9]+-\d+/.exec(pr.headRefName ?? ""))?.[0] ?? `#${pr.number}`;
    const summary = (pr.title ?? "").replace(new RegExp(`^\\[?${key.replace("#", "#?")}\\]?[\\s:—-]*`), "").trim();
    const { cwd, on } = pr.repo ?? {};
    openOverlay({ mod: "jira", kind: "dialog", width: 620, height: 640,
      props: { start: { key, summary, folder: cwd, on: on ?? null, pr: { number: pr.number, url: pr.url, headRefName: pr.headRefName } } } });
  }

  // The button of a row and of the popup: spinner while starting, else the session icon.
  worktreeTip(pr) { return `Start or resume a session on #${pr.number} (asks where)`; }

  init(_props, cx) {
    this.starting = new Set(); // PR urls whose worktree is being made
    this.agents = new Map(); // machine -> { argv, name } (see loadAgents)
    // Opened as a popup for one PR (click on a row): its description, approvals, comments and reviews.
    if (props()?.pr) { this.detailPr = props().pr; this.cpOpen = new Set(); this.loadDetail(cx); return; }
    // Opened as a dialog from the header's + : a new pull request for the branch of that folder.
    if (props()?.create) { this.initCreate(cx); return; }
    this.started = Date.now();
    this.loadAgents(null, cx);
    // Search: by title, description, branch or number; the list is cut as you type.
    this.query = "";
    this.search = InputState.new({ placeholder: "Search pull requests: title, description" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.places = new Map(); // space id -> last terminal folder there (see location)
    this.prs = []; this.error = null; this.loading = false; this.key = this.locKey(); this.repo = "";
    this.byRepo = new Map(); // repo key -> { name, prs, error }: one gh call per repo, whatever folders point at it
    this.remotes = new Map(); // folder -> its repo, from the local git remote (no API call)
    this.focusRepo = null;
    this.seen = null; // PR url -> copilot state at the last poll; null until the first one (no toast for what already was)
    // Auto-sync (the 2-minute poll while the panel is shown) can be switched off; remembered. Refresh still works by hand.
    this.auto = (() => { try { return (localStorage.getItem("prs.auto") ?? localStorage.getItem("auto")) === "1"; } catch { return false; } })();
    this.all = (() => { try { return localStorage.getItem("prs.all") === "1"; } catch { return false; } })();
    this.poll(cx);
    // One 2 s tick for two checks. The folder follows focus: a repo already polled is shown from memory.
    // A PR approved or created elsewhere: poll now. From a timer, not render(): a task spawned with
    // render's cx never runs. poll() has its own loading/again guard.
    // Also: the panel just came into view with auto on and the list stale (older than a poll) or missing: poll now.
    this.wasShown = this.shown();
    cx.timer.every(2000, (cx) => {
      const k = this.locKey(); if (k !== this.key) { this.key = k; this.focus(cx); }
      const changed = shared("prs.changed");
      if (changed && changed.ts !== this.changedTs) { this.changedTs = changed.ts; if (changed.ts > (this.started ?? 0)) this.poll(cx, true); }
      // contract: jira.refreshed ({ ts }) is set by the jira mod after its Refresh replaced gh's cached PR list; the
      // cache is fresh then, so a plain poll shows it with no GitHub call. Optional: without the jira mod nothing comes.
      const other = shared("jira.refreshed");
      if (other && other.ts !== this.otherTs) { this.otherTs = other.ts; if (other.ts > (this.started ?? 0)) this.poll(cx); }
      const shown = this.shown();
      if (shown && !this.wasShown && this.auto && (Date.now() - (this.polledAt ?? 0) >= POLL_EVERY || !this.byRepo.has(this.focusRepo))) this.poll(cx);
      this.wasShown = shown;
    });
    // ponytail: 2 min, since it costs 3 gh calls per repo of every space; 1 min if Copilot news feels late.
    cx.timer.every(POLL_EVERY, (cx) => { if (this.auto && this.shown()) this.poll(cx); });
  }

  // The panel is on screen (see shownIn); auto-sync runs only then.
  shown() { return shownIn(layout()) !== false; }

  toggleAuto(cx) {
    this.auto = !this.auto;
    try { localStorage.setItem("prs.auto", this.auto ? "1" : "0"); } catch {}
    if (this.auto) this.poll(cx); else cx.notify();
  }

  // Mine (authored by me) or All open PRs of the repo; remembered.
  setAll(all, cx) {
    if (all === this.all) return;
    // The old list stays (with the refresh spinner) until the new one arrives; no blank flash.
    this.all = all; this.byRepo.clear();
    try { localStorage.setItem("prs.all", all ? "1" : "0"); } catch {}
    this.poll(cx); cx.notify();
  }

  loc() { return location(this.places); }
  // Also keeps the focused branch for the row highlight; a branch switch changes the key, so the tick redraws.
  locKey() { const l = this.loc(); this.branch = l.branch; return JSON.stringify(l); }

  // The repo a place belongs to: `{ key, name }`. Folders (and worktrees) of one repo share the key.
  async repoOf({ cwd, on }) {
    const id = `${on}|${cwd}`;
    if (!this.remotes.has(id)) {
      const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on }).catch(() => null);
      const name = r?.code === 0 ? repoName(r.stdout.trim()) : null;
      if (!name) return { key: id, name: null };
      this.remotes.set(id, { key: `${on}|${name}`, name });
    }
    return this.remotes.get(id);
  }

  show() {
    const e = this.byRepo.get(this.focusRepo);
    this.prs = e?.prs ?? []; this.repo = e?.name ?? "";
    this.error = e?.error ?? (!this.loc().cwd ? "No folder" : !e && !this.auto ? "Auto-sync is off · press refresh" : null);
  }

  focus(cx) {
    cx.spawn(async (cx) => {
      const r = await this.repoOf(this.loc());
      // With auto-sync off, a repo not loaded yet still shows gh's cached answer (peek), if there is one.
      if (!this.byRepo.has(r.key) && !this.auto) { this.focusRepo = r.key; await this.peek(r.key, { ...r, ...this.loc() }, cx); }
      if (this.byRepo.has(r.key) || !this.auto || !this.shown()) { this.focusRepo = r.key; this.show(); cx.notify(); } else this.poll(cx);
    });
  }

  // A repo's list as kept in memory: only what a row, the search and the popup use. Reviews, checks and full bodies
  // (Copilot's reviews are long) are reduced to their badges here, once per answer. `prs` keeps the full PRs (toasts).
  entry(r, viewer, listed) {
    // Opened by me (null when my login is unknown: the list isn't grouped).
    const prs = listed.map((pr) => ({ ...pr, mine: viewer ? pr.author?.login === viewer : null }));
    return { prs, entry: { name: r.name, prs: prs.map(({ statusCheckRollup, reviews, reviewRequests, body, labels, cpUrls, ...pr }) => ({ ...pr,
      hotfix: (labels ?? []).some((l) => /hotfix/i.test(l.name ?? "")),
      ciState: ci(statusCheckRollup), approvalState: approval({ reviews, reviewDecision: pr.reviewDecision }), body: (body ?? "").slice(0, 500),
      cpBadge: copilotBadge({ ...pr, reviews, reviewRequests }, cpUrls),
      repo: { cwd: r.cwd, on: r.on } })), error: null } };
  }

  // gh's cached answer for a repo (up to a day old, STALE), shown at once while nothing is; the fresh call replaces it.
  // No toasts from it (the `seen` baseline comes from fresh calls). A miss or failure shows nothing.
  async peek(k, r, cx) {
    try {
      const all = this.all, { viewer, prs } = await list(r.name, r.cwd, r.on, all, STALE);
      if (all !== this.all || this.byRepo.has(k)) return;
      this.byRepo.set(k, this.entry(r, viewer, prs).entry);
      if (k === this.focusRepo || !this.byRepo.has(this.focusRepo)) { this.focusRepo = (await this.repoOf(this.loc())).key; this.show(); cx.notify(); }
    } catch {}
  }

  // Every 2 minutes (and on demand): the open PRs of every repo among all spaces' folders and the focused one,
  // one gh call per repo. A toast when Copilot's review shows up on a PR that was already there.
  // The timers call it only while the panel is shown; refresh, prs.changed and the Mine/All switch call it any time.
  // `force` (Refresh, prs.changed): past gh's cache (FORCE): GitHub is asked, and the cached answer every mod reads is
  // replaced with the new one. Else gh's cache answers when it is under a minute old.
  // ponytail: in memory only (a reload re-baselines).
  poll(cx, force = false) {
    if (this.loading) { this.again = true; this.againForce ||= force; return; }
    this.loading = true; this.polledAt = Date.now(); cx.notify();
    const focus = this.loc(), places = new Map();
    for (const p of [focus, ...spaces().map((s) => ({ cwd: s.folder, on: s.machine ?? null }))]) if (p.cwd) places.set(`${p.on}|${p.cwd}`, p);
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places.values()) { const r = await this.repoOf(p); if (!repos.has(r.key)) repos.set(r.key, { ...r, ...p }); }
        const next = new Map(), done = [];
        await Promise.all([...repos].map(async ([k, r]) => {
          // Nothing shown for this repo yet: gh's cached answer first (peek), so the list appears at once.
          if (!this.byRepo.has(k)) await this.peek(k, r, cx);
          const old = this.byRepo.get(k);
          try {
            const all = this.all, { viewer, prs: listed } = await list(r.name, r.cwd, r.on, all, force ? FORCE : undefined);
            if (all !== this.all) return; // switched while loading: the `again` poll fills it
            const { prs, entry } = this.entry(r, viewer, listed);
            this.byRepo.set(k, entry);
            // Copilot toast only for PRs I opened (when my login is unknown: everything in Mine, nothing in All).
            for (const pr of prs) if (viewer ? pr.author?.login === viewer : !all) next.set(pr.url, { state: copilot(pr), pr });
          } catch (e) {
            // A failed refresh keeps the last good list as it was; the error shows only when there is none.
            this.byRepo.set(k, old?.prs?.length ? old : { name: r.name, prs: [], error: String(e.message ?? e) });
            // One toast per session: the panel is often closed, and a minute-by-minute toast would nag.
            if (e.setup && !this.warned) { this.warned = true; notify({ title: "Pull requests", body: e.message, level: "warning" }); }
          }
        }));
        // Repos no space points at any more (a closed space) leave memory.
        for (const k of this.byRepo.keys()) if (!repos.has(k)) this.byRepo.delete(k);
        for (const [url, { state, pr }] of next) if (this.seen?.get(url) !== undefined && !reviewed(this.seen.get(url)) && reviewed(state)) done.push(pr);
        // A failed repo drops out of `next`; keep its old states so a later success isn't mistaken for news.
        this.seen = new Map([...(this.seen ?? []), ...[...next].map(([url, { state }]) => [url, state])]);
        this.focusRepo = (await this.repoOf(focus)).key; this.show();
        for (const pr of done) notify({ title: copilot(pr) === "clean" ? "Copilot reviewed: no comments" : "Copilot reviewed", body: `#${pr.number} ${pr.title}`, level: "info" });
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        // A Refresh replaced gh's cached list: tell the other panels (jira reads prs.refreshed and shows it from the cache).
        if (force) setShared("prs.refreshed", { ts: Date.now() });
        if (this.again) { const f = this.againForce; this.again = false; this.againForce = false; this.poll(cx, f); }
      }
    });
  }

  // ── the PR popup ──
  loadDetail(cx) {
    const pr = this.detailPr, r = pr.repo ?? {};
    const [, owner, name] = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(pr.url ?? "") ?? [];
    cx.spawn(async (cx) => {
      try {
        const [x, th] = await Promise.all([
          exec("gh", ["pr", "view", String(pr.number), "--json", "title,body,author,url,headRefName,baseRefName,createdAt,comments,reviews"], { cwd: r.cwd, on: r.on })
            .catch(() => { throw new Error("GitHub CLI (gh) is not installed"); }),
          owner ? exec("gh", ["api", "graphql", "-f", `query=${THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${pr.number}`], { cwd: r.cwd, on: r.on, timeout: 60000 }).catch(() => null) : null]);
        if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim().split("\n").pop() || "gh failed");
        const v = JSON.parse(x.stdout);
        // Line comments: only the threads nobody resolved yet are shown (a failed call just shows none).
        let all = [];
        try { all = th?.code === 0 ? JSON.parse(th.stdout).data.repository.pullRequest.reviewThreads.nodes : []; } catch {}
        const threads = all.filter((n) => !n.isResolved);
        const resolved = new Set(all.filter((n) => n.isResolved).map((n) => n.comments?.nodes?.[0]?.url).filter(Boolean));
        // Copilot's latest overview becomes a card (issues whose thread is resolved are left out); its older ones are dropped.
        const cpReview = (v.reviews ?? []).filter((rv) => isCopilot(rv.author) && copilotOverview(rv.body)).pop();
        const cp = cpReview ? { ...copilotOverview(cpReview.body), at: cpReview.submittedAt } : null;
        // Each open issue gets its thread (matched by the first comment's URL), so the card can unfold it.
        const byUrl = new Map(threads.map((th) => [th.comments?.nodes?.[0]?.url, th]));
        if (cp) { const n = cp.issues.length; cp.issues = cp.issues.filter((i) => !resolved.has(i.url)).map((i) => ({ ...i, thread: byUrl.get(i.url) })); cp.resolved = n - cp.issues.length; }
        // A thread already unfolded in the Copilot card isn't repeated under OPEN THREADS.
        const inCard = new Set(cp?.issues.map((i) => i.thread).filter(Boolean));
        const rest = threads.filter((th) => !inCard.has(th));
        const items = [...(v.comments ?? []).map((c) => ({ author: c.author?.login, at: c.createdAt, body: c.body })),
          ...(v.reviews ?? []).filter((rv) => (rv.body || rv.state !== "COMMENTED") && !(cp && rv.state === "COMMENTED" && isCopilot(rv.author))).map((rv) => ({ author: rv.author?.login, at: rv.submittedAt, body: rv.body, extra: rv.state.toLowerCase().replace("_", " ") }))]
          .sort((p, q) => String(p.at).localeCompare(String(q.at))).map((c, i) => ({ ...c, id: i }));
        // My login barely changes: gh's disk cache answers it for a day.
        const me = await exec("gh", ["api", "user", "--cache", "24h", "--jq", ".login"], { cwd: r.cwd, on: r.on }).then((m) => m.code === 0 ? m.stdout.trim() : null).catch(() => null);
        const by = approvedBy(v.reviews);
        this.detail = { me, mineApproved: Boolean(me && by.includes(me)), title: v.title, body: v.body ?? "", author: v.author?.login, from: v.headRefName, to: v.baseRefName, created: v.createdAt,
          approvedBy: by, comments: items, threads: rest, copilot: cp };
        this.detailError = null;
      } catch (e) { this.detailError = String(e.message ?? e); }
      cx.notify();
    });
  }

  approve(cx) {
    if (this.approving) return;
    const pr = this.detailPr, r = pr.repo ?? {};
    this.approving = true; this.approveError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const x = await exec("gh", ["pr", "review", String(pr.number), "--approve"], { cwd: r.cwd, on: r.on });
        if (x.code !== 0) throw new Error((x.stderr || x.stdout).trim().split("\n").pop() || "gh failed");
        setShared("prs.changed", { ts: Date.now() }); // the panel's list re-asks
        this.loadDetail(cx);
      } catch (e) { this.approveError = String(e.message ?? e); }
      this.approving = false; cx.notify();
    });
  }

  // ── the "new pull request" dialog ──
  initCreate(cx) {
    const c = props().create; // { cwd, on }
    migrate();
    this.cr = { loading: true, error: null, root: null, branch: null, base: "main", commits: [], ahead: 0, pushed: false, existing: null, draft: false, generating: false, creating: false, note: null, preview: false, rev: 0 };
    this.crTitle = InputState.new({ placeholder: "Title" });
    this.crBase = InputState.new({ placeholder: "Base branch" });
    this.crBody = TextareaState.new({ placeholder: "Description (write it, or let the AI draft it)" });
    this.crBody.set_rows(14);
    for (const s of [this.crTitle, this.crBase]) s.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      const cr = this.cr;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: c.cwd, on: c.on }).catch(() => null);
        if (!top || top.code !== 0) throw new Error("This folder is not in a git repository");
        const root = top.stdout.trim(), git = (args) => exec("git", args, { cwd: root, on: c.on });
        // The base is the repository's default branch: GitHub's own answer first, then origin/HEAD, then main.
        const [br, def, sym, up] = await Promise.all([git(["rev-parse", "--abbrev-ref", "HEAD"]),
          exec("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { cwd: root, on: c.on }).catch(() => null),
          git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]), git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])]);
        const branch = br.stdout.trim();
        const base = (def?.code === 0 && def.stdout.trim()) || (sym.code === 0 ? sym.stdout.trim().replace(/^origin\//, "") : "main");
        Object.assign(cr, { root, branch, base, on: c.on });
        cr.pk = await projectKey({ cwd: root, on: c.on }); // per-project AI settings (wb-ai)
        if (branch === "HEAD") throw new Error("HEAD is detached: switch to a branch first");
        if (branch === base) throw new Error(`You are on ${base}: switch to a feature branch to open a pull request`);
        const log = await git(["log", "--format=%s", "-n", "30", `origin/${base}..HEAD`]);
        cr.commits = log.code === 0 ? log.stdout.split("\n").filter(Boolean) : [];
        if (up.code === 0) { const n = await git(["rev-list", "--count", "@{u}..HEAD"]); cr.ahead = Number(n.stdout) || 0; cr.pushed = cr.ahead === 0; }
        else cr.ahead = cr.commits.length;
        const ex = await exec("gh", ["pr", "view", "--json", "url,number,state"], { cwd: root, on: c.on }).catch(() => null);
        if (ex?.code === 0) { const pr = JSON.parse(ex.stdout); if (pr.state === "OPEN") cr.existing = pr; } // a closed or merged one doesn't block a new one
        this.crTitle.set_value(branch); // the branch name as it is; the AI can write a real title
        this.crBase.set_value(base);
      } catch (e) { cr.error = String(e.message ?? e); }
      cr.loading = false; cx.notify();
    });
  }

  // The title and description, drafted with this project's "mr" settings (wb-ai), from the branch's commits and diff against its base.
  // Line 1 must stay the title (parsed below), so only the description's shape comes from the template.
  crGenerate(cx) {
    const cr = this.cr;
    if (!cr.root || cr.generating || cr.creating) return;
    const base = this.crBase.value().trim() || cr.base, cfg = settingsFor("mr", cr.pk), model = cfg.model;
    cr.generating = true; cr.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", args, { cwd: cr.root, on: cr.on });
        const [log, diff] = await Promise.all([git(["log", "--format=- %s", "-n", "30", `origin/${base}..HEAD`]), git(["diff", "--no-color", `origin/${base}...HEAD`])]);
        if (diff.code !== 0) throw new Error((diff.stderr || "git diff failed").trim().split("\n").pop());
        const rules = await prRules(cr.root, cr.on);
        const prompt = "Write a pull request for these changes. Line 1: the title, up to 72 characters, imperative mood, plain text (no quotes, no markdown, no trailing period). "
          + `Then one blank line, then the description. The description: ${cfg.template} `
          + `${rules ? `The project's own files below take precedence over the description format above: follow what they say about pull request titles and descriptions, and keep the sections of the PR template if there is one (fill them, don't add new checklist items). Ignore their steps for running commands (push, gh, reviewers, labels): only the title and description are wanted.\n\n${rules}\n\n` : ""}Reply with the title and the description only, nothing else. ${languageLine(cfg.language)}`;
        const text = `Branch ${cr.branch} into ${base}.\n\nCommits:\n${log.stdout}\n\nDiff:\n${(diff.stdout || "").slice(0, 60000)}`;
        const out = await runModel(model, `${prompt}\n\n${text}`, { cwd: cr.root, on: cr.on });
        if (!out) throw new Error("the model returned nothing");
        // First line: the title (stray markdown or quotes dropped); the rest: the description.
        const lines = out.split("\n"), title = lines.shift().replace(/^[#>\s*"'`]+|["'`\s*]+$/g, "").replace(/^title:\s*/i, "").trim();
        this.crTitle.set_value(title.slice(0, 120));
        this.crBody.set_value(lines.join("\n").trim());
        cr.preview = true; cr.rev++; // show what the AI wrote as rendered markdown; Write edits it
      } catch (e) { cr.note = `Generate failed: ${e.message ?? e}`; }
      cr.generating = false; cx.notify();
    });
  }

  // Pushes the branch when it isn't on the remote yet, then opens the pull request.
  crCreate(cx) {
    const cr = this.cr, title = this.crTitle.value().trim(), base = this.crBase.value().trim() || cr.base, body = this.crBody.value().trim();
    if (!title || !cr.root || cr.creating || cr.generating || cr.existing || cr.error) return;
    cr.creating = true; cr.note = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!cr.pushed) {
          const push = await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: cr.root, on: cr.on, timeout: 180000 });
          if (push.code !== 0) throw new Error(`push failed: ${(push.stderr || push.stdout).trim().split("\n").slice(-3).join(" ")}`);
        }
        const args = ["pr", "create", "--base", base, "--head", cr.branch, "--title", title, "--body", body, ...(cr.draft ? ["--draft"] : [])];
        const r = await exec("gh", args, { cwd: cr.root, on: cr.on, timeout: 120000 });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").slice(-3).join(" "));
        const url = r.stdout.trim().split("\n").pop();
        notify({ title: "Pull request created", body: url, level: "info" });
        setShared("prs.changed", { ts: Date.now() }); // the panel's list re-asks
        closeOverlay(props()?.overlay);
      } catch (e) { cr.note = `Create failed: ${e.message ?? e}`; }
      cr.creating = false; cx.notify();
    });
  }

  createView(t) {
    const cr = this.cr, title = this.crTitle.value().trim();
    const ready = Boolean(title && cr.root && !cr.loading && !cr.error && !cr.existing && !cr.creating && !cr.generating);
    const btn = (id, label, act, { primary = false, enabled = true } = {}) => div().id(id).h(28).px(12).flex().items_center().justify_center().rounded(6).border_1().text_size(12)
      .border_color(primary && enabled ? t.accent : t.border).text_color(!enabled ? t.dim : primary ? t.accent : t.foreground)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))).on_click((_e, cx) => { if (enabled) act(cx); }).child(label);
    const field = (label, child) => v_flex().gap(4).child(div().text_size(11).text_color(t.dim).child(label)).child(child);
    const box = (state, h) => div().h(h).flex_none().px(10).flex().items_center().rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(state).h_full().w_full().text_size(12).text_color(t.foreground));
    const model = modelFor("mr", cr.pk);
    return v_flex().id("pr-create").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("New pull request"))
        .when(Boolean(cr.branch), (e) => e.child(div().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${cr.branch} → ${this.crBase.value().trim() || cr.base}`)))
        .child(div().flex_1())
        .child(div().id("cr-close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(v_flex().id("cr-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(12)
        .when(cr.loading, (e) => e.child(div().text_color(t.dim).child("Loading…")))
        .when(Boolean(cr.error), (e) => e.child(div().text_color(t.ansi1).child(cr.error)))
        .when(Boolean(cr.existing), (e) => e.child(h_flex().gap(8).items_center().p(10).rounded(8).bg(t.raised)
          .child(div().flex_1().child(`A pull request for this branch already exists: #${cr.existing.number}`))
          .child(btn("cr-open", "Open", () => exec("open", [cr.existing.url])))))
        .when(Boolean(cr.root && !cr.error), (e) => e
          .child(field("Title", box(this.crTitle, 32)))
          .child(field("Base branch", box(this.crBase, 32)))
          .when(cr.commits.length > 0, (e2) => e2.child(field(`Commits (${cr.commits.length})`, v_flex().gap(2).text_size(11.5).text_color(t.muted)
            .children(cr.commits.slice(0, 6).map((s) => div().truncate().child(`· ${s}`)))
            .when(cr.commits.length > 6, (e3) => e3.child(div().text_color(t.dim).child(`… and ${cr.commits.length - 6} more`))))))
          .child(field("Description (the AI writes the title above too)", v_flex().gap(6)
            .child(h_flex().gap(8).items_center()
              .child(btn("cr-gen", cr.generating ? "Generating…" : "✦ Generate title and description", (cx) => this.crGenerate(cx), { primary: true, enabled: !cr.generating && !cr.creating }))
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(describe(model)))
              .child(h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
                .children([["write", "Write", false], ["preview", "Preview", true]].map(([id, label, v]) => div().id(`cr-${id}`).h(26).px(10).flex().items_center().cursor_pointer().text_size(12)
                  .bg(cr.preview === v ? t.selected : t.background).text_color(cr.preview === v ? t.foreground : t.muted)
                  .when(cr.preview !== v, (e) => e.hover((s) => s.bg(t.hover)))
                  .on_click((_e, cx) => { if (cr.preview !== v) { cr.preview = v; cr.rev++; cx.notify(); } }).child(label))))
              .child(btn("cr-models", "MR settings…", () => cr.pk
                ? openOverlay({ mod: "wb-ai", kind: "dialog", width: 560, props: { use: "mr", project: cr.pk, projectName: projectName(cr.pk) } })
                : openOverlay({ mod: "wb-ai", kind: "window", key: "wb-ai", width: 580 }))))
            .child(cr.preview
              ? v_flex().id("cr-preview").h(240).flex_none().px(12).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).overflow_y_scrollbar()
                .child(this.crBody.value().trim() ? TextView.markdown(`cr-md-${cr.rev}`, this.crBody.value()) : div().text_color(t.dim).child("Nothing to preview yet"))
              : div().id("cr-desc").h(240).flex_none().px(10).py(8).rounded(7).border_1().border_color(t.border).bg(t.background).cursor_text()
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Textarea.new(this.crBody).w_full().h(224).text_size(12).text_color(t.foreground)))))
          .child(h_flex().id("cr-draft").gap(8).items_center().cursor_pointer().on_click((_e, cx) => { cr.draft = !cr.draft; cx.notify(); })
            .child(div().size(14).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
              .border_color(cr.draft ? t.accent : t.border).bg(cr.draft ? t.accent : t.background).text_color(t.accent_foreground).child(cr.draft ? "✓" : ""))
            .child(div().text_size(12).child("Create as draft")))
          .when(!cr.pushed, (e2) => e2.child(div().p(10).rounded(8).bg(t.raised).text_size(11.5).text_color(t.muted)
            .child(`${cr.branch} is not on the remote yet: creating the pull request first runs git push -u origin HEAD (${cr.ahead} commit${cr.ahead === 1 ? "" : "s"}).`)))
          .when(Boolean(cr.note), (e2) => e2.child(div().text_size(12).text_color(t.ansi1).child(cr.note)))))
      .child(h_flex().h(52).flex_none().px(16).gap(8).items_center().justify_end().border_t(1).border_color(t.border)
        .child(btn("cr-cancel", "Cancel", () => closeOverlay(props()?.overlay)))
        .child(btn("cr-create", cr.creating ? (cr.pushed ? "Creating…" : "Pushing…") : cr.pushed ? "Create pull request" : "Push and create pull request", (cx) => this.crCreate(cx), { primary: true, enabled: ready })));
  }

  detailView(t) {
    const pr = this.detailPr, d = this.detail;
    // The repo (the popup also opens from other mods, e.g. jira, where the repo isn't on screen).
    const repo = repoOfUrl(pr.url);
    const btn = (id, label, act) => div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(act).child(label);
    const meta = (label, value) => !value ? null : h_flex().gap(8).items_center().text_size(12)
      .child(div().w(80).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value));
    return v_flex().id("pr-detail").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(repo), (e) => e.child(div().min_w(0).truncate().text_size(12).font_semibold().child(repo)))
        .child(div().flex_none().text_size(12).text_color(t.dim).child(`#${pr.number}`))
        .when(Boolean(d?.approvedBy?.length), (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.done).text_size(11).text_color(t.done).child(`✓ approved · ${d.approvedBy.length}`)))
        .when(pr.isDraft, (e) => e.child(div().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.dim).child("draft")))
        .child(div().flex_1())
        // Approve: grey and inert on my own PR (GitHub refuses it), green otherwise.
        .when(Boolean(d && !d.mineApproved), (e) => {
          const own = Boolean(d.me && d.author === d.me);
          return e.child(div().id("approve").h(26).px(10).flex().items_center().rounded(6).border_1().text_size(12)
            .border_color(own ? t.border : t.done).text_color(own ? t.dim : t.done)
            .tooltip(own ? "You can't approve your own pull request" : "Approve this pull request")
            .when(!own, (s) => s.cursor_pointer().hover((h) => h.bg(t.hover)).on_click((_e, cx) => this.approve(cx)))
            .child(this.approving ? "Approving…" : "Approve"));
        })
        // Open is the main action: inverted (foreground fill, background text).
        .child(div().id("open").h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.foreground).bg(t.foreground)
          .text_size(12).font_medium().text_color(t.background).cursor_pointer().hover((s) => s.opacity(0.85))
          .on_click(() => exec("open", [pr.url])).child("Open"))
        .child(btn("copy", "Copy link", (_e, cx) => cx.write_to_clipboard(pr.url)))
        .child(btn("worktree", this.starting.has(pr.url) ? "Starting…" : "Start session…",(_e, cx) => this.work(pr, cx)))
        .child(div().id("close").size(26).flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => closeOverlay(props()?.overlay)).child("✕")))
      .child(v_flex().id("pr-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).gap(14)
        .when(Boolean(this.approveError), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.approveError)))
        .when(!d, (e) => e.child(div().text_color(this.detailError ? t.ansi1 : t.dim).child(this.detailError ?? "Loading…")))
        .when(Boolean(d), (e) => e
          // Selectable, so part of the title can be copied; HTML-escaped so * _ ` stay literal.
          .child(div().text_size(17).font_semibold().child(TextView.html(`pr-title-${pr.number}`, d.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).selectable(true)))
          .child(v_flex().gap(5).children([meta("Author", d.author), meta("Branches", `${d.from} → ${d.to}`), meta("Opened", when(d.created)),
            meta("Approved by", d.approvedBy.length ? d.approvedBy.join(", ") : "nobody yet")].filter(Boolean)))
          .child(div().h(1).bg(t.border))
          .child(d.body.trim() ? TextView.markdown(`pr-desc-${pr.number}`, d.body) : div().text_color(t.dim).child("No description"))
          .when(Boolean(d.copilot), (e) => e.child(div().h(1).bg(t.border)).child(this.copilotCard(d.copilot, t)))
          .when(d.comments.length > 0, (e) => e
            .child(div().h(1).bg(t.border))
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`COMMENTS · ${d.comments.length}`))
            .children(d.comments.map((c) => v_flex().gap(4).p(10).rounded(8).bg(t.raised)
              .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(c.author ?? "")).child(div().text_color(t.dim).child(when(c.at)))
                .when(Boolean(c.extra), (e) => e.child(div().text_color(t.muted).child(c.extra))))
              .when(Boolean(c.body), (e) => e.child(TextView.markdown(`pr-c-${c.id}`, c.body))))))
          .when(d.threads.length > 0, (e) => e
            .child(div().h(1).bg(t.border))
            .child(div().text_size(11).font_semibold().text_color(t.dim).child(`OPEN THREADS · ${d.threads.length}`))
            .children(d.threads.map((th, i) => v_flex().gap(8).p(10).rounded(8).bg(t.raised)
              .child(h_flex().gap(8).text_size(11).text_color(t.muted)
                .child(div().flex_1().min_w(0).truncate().child(`${th.path}${th.line ?? th.originalLine ? `:${th.line ?? th.originalLine}` : ""}`))
                .when(th.isOutdated, (e) => e.child(div().flex_none().text_color(t.dim).child("outdated"))))
              .children((th.comments?.nodes ?? []).map((c, j) => v_flex().gap(4)
                .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(c.author?.login ?? "")).child(div().text_color(t.dim).child(when(c.createdAt))))
                .when(Boolean(c.body), (e) => e.child(TextView.markdown(`pr-t-${i}-${j}`, c.body))))))))));
  }

  // Copilot's overview, laid out like GitHub's: verdict, summary, open issues with a severity pill (click opens the thread),
  // "What changed" folded, review effort.
  copilotCard(cp, t) {
    const sev = { high: t.ansi1, medium: t.working, low: t.accent };
    const n = cp.issues.length;
    return v_flex().gap(10).p(12).rounded(8).border_1().border_color(t.border)
      .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child("Copilot")).child(div().text_color(t.dim).child(`commented ${when(cp.at)}`)))
      .child(div().text_size(15).font_semibold().child(cp.verdict))
      .when(Boolean(cp.summary), (e) => e.child(TextView.markdown(`pr-cp-sum-${this.detailPr.number}`, cp.summary)))
      .child(div().text_size(12).font_semibold().child(`${n} open issue${n === 1 ? "" : "s"}${cp.resolved ? ` · ${cp.resolved} resolved` : ""}`))
      // Click unfolds the issue's thread (Copilot's explanation and replies); without a loaded thread it opens GitHub.
      .children(cp.issues.map((i, k) => {
        const open = this.cpOpen.has(k), th = i.thread;
        return v_flex().gap(6)
          .child(h_flex().id(`pr-cp-i-${k}`).gap(8).items_center().text_size(12).cursor_pointer()
            .on_click((_e, cx) => { if (!th) return exec("open", [i.url]); open ? this.cpOpen.delete(k) : this.cpOpen.add(k); cx.notify(); })
            .child(div().flex_none().w(10).text_color(t.dim).child(th ? (open ? "▾" : "▸") : "↗"))
            .child(div().flex_none().px(8).py(1).rounded(9).border_1().text_size(10.5).font_semibold()
              .border_color(sev[i.severity.toLowerCase()] ?? t.border).text_color(sev[i.severity.toLowerCase()] ?? t.muted).child(i.severity))
            .child(div().flex_1().min_w(0).truncate().text_color(t.accent).hover((s) => s.underline()).child(i.title))
            .when(Boolean(i.note), (e) => e.child(div().flex_none().text_color(t.dim).child(i.note))))
          .when(open && Boolean(th), (e) => e.child(v_flex().ml(18).gap(8).p(10).rounded(8).bg(t.raised)
            .child(h_flex().gap(8).text_size(11).text_color(t.muted)
              .child(div().flex_1().min_w(0).truncate().child(`${th.path}${th.line ?? th.originalLine ? `:${th.line ?? th.originalLine}` : ""}`))
              .when(th.isOutdated, (e) => e.child(div().flex_none().text_color(t.dim).child("outdated")))
              .child(div().id(`pr-cp-gh-${k}`).flex_none().text_color(t.accent).cursor_pointer().hover((s) => s.underline())
                .on_click(() => exec("open", [i.url])).child("Open on GitHub ↗")))
            .children((th.comments?.nodes ?? []).map((c, j) => v_flex().gap(4)
              .child(h_flex().gap(8).text_size(11).child(div().font_semibold().child(c.author?.login ?? "")).child(div().text_color(t.dim).child(when(c.createdAt))))
              .when(Boolean(c.body), (e) => e.child(TextView.markdown(`pr-cp-c-${k}-${j}`, c.body)))))));
      }))
      .when(Boolean(cp.what), (e) => e
        .child(h_flex().id("pr-cp-what").gap(6).items_center().text_size(12).font_semibold().cursor_pointer()
          .on_click((_e, cx) => { this.cpWhat = !this.cpWhat; cx.notify(); })
          .child(div().w(10).text_color(t.dim).child(this.cpWhat ? "▾" : "▸")).child("What changed in this PR"))
        .when(Boolean(this.cpWhat), (e2) => e2.child(TextView.markdown(`pr-cp-what-${this.detailPr.number}`, cp.what))))
      .when(Boolean(cp.effort), (e) => e.child(div().text_size(11).text_color(t.dim).child(cp.effort)));
  }

  row(pr, t) {
    const state = pr.ciState;
    const dot = { ok: t.done, fail: t.ansi1, wait: t.working }[state];
    const dotTip = { ok: "CI: all checks passed", fail: "CI: a check failed", wait: "CI: checks are running" }[state] ?? "CI: no checks";
    // Review icon: green check = someone approved, red cross = changes requested, grey check = not approved yet.
    const ap = pr.approvalState;
    const [apIcon, apColor, apTip] = ap === "approved" ? ["approved", t.done, "Approved by a reviewer"]
      : ap === "changes" ? ["changes", t.ansi1, "Changes requested"] : ["approved", t.border, "Not approved yet"];
    const { level, open } = pr.cpBadge;
    const taskKey = /^[A-Za-z]+-\d+/.exec(pr.title ?? "")?.[0];
    const fill = { high: t.ansi1, low: t.accent, ok: t.done }[level];
    const cpTip = copilotTip(pr.cpBadge);
    // The PR of the focused folder's branch (a fork PR's local branch is pr-<n>-<branch>, see startWorktree).
    const b = this.branch;
    const current = Boolean(b) && (b === pr.headRefName || b === `pr-${pr.number}-${worktreeSlug(pr.headRefName ?? "")}`);
    return v_flex().id(`pr-${pr.number}`).flex_none().px(8).py(4).gap(2).rounded(5).cursor_pointer()
      .when(current, (e) => e.bg(t.selected).border_l_2().border_color(t.accent))
      .hover((s) => s.bg(t.hover)).tooltip(`#${pr.number} ${pr.title}\n${pr.headRefName} → ${pr.baseRefName}${pr.hotfix ? "\nLabel: hotfix" : ""}${current ? "\nCurrent branch" : ""}`)
      .on_click(() => openOverlay({ mod: "prs", kind: "dialog", width: 780, height: 0.85, props: { pr } }))
      .child(h_flex().gap(6).items_center()
        .child(div().id(`ci-${pr.number}`).flex_none().size(9).flex().items_center().justify_center().tooltip(dotTip)
          .child(div().size(7).rounded(4).bg(dot ?? t.border)))
        // Copilot badge "C": filled red = open High/Medium threads; filled blue = only Low ones open;
        // filled green = reviewed, none open; yellow spinner = reviewing (requested); faint = not run yet.
        .child(div().id(`cp-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().rounded(4).border_1().text_size(10).font_semibold()
          .border_color(fill ?? (level === "asked" ? t.working : t.border)).bg(fill ?? t.background)
          .text_color(fill ? t.background : level === "asked" ? t.working : t.dim)
          .tooltip(cpTip).child(level === "asked" ? svg("mods/prs/spinner.svg").size(11).text_color(t.working).spin(900) : "C"))
        .child(div().id(`ap-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().tooltip(apTip)
          .child(svg(`mods/prs/${apIcon}.svg`).size(14).text_color(apColor)))
        // Merge conflicts with the base branch (gh's mergeable; UNKNOWN while GitHub works it out shows nothing).
        .when(pr.mergeable === "CONFLICTING", (e) => e.child(div().id(`conflict-${pr.number}`).flex_none().size(15).flex().items_center().justify_center()
          .tooltip(`Conflicts with ${pr.baseRefName ?? "the base branch"}`).child(svg("mods/prs/conflict.svg").size(13).text_color(mixHex(t.ansi1, t.foreground, 0.6)))))
        // My review is requested: an eye in the theme's "working" colour, so the PR stands out as one to look at.
        .when(Boolean(pr.needMe), (e) => e.child(div().id(`me-${pr.number}`).flex_none().size(15).flex().items_center().justify_center()
          .tooltip("Your review is requested").child(svg("mods/prs/review.svg").size(14).text_color(t.working))))
        // A "hotfix" label: the title in the theme's red, softened toward the text colour (ansi1 alone glares).
        .child(div().flex_1().min_w(0).truncate().when(pr.hotfix, (e) => e.text_color(mixHex(t.ansi1, t.foreground, 0.6))).child(pr.title))
        // Copy the task key that starts the title (DA-20323: …); the row's own click doesn't fire.
        .when(Boolean(taskKey), (e) => e.child(div().id(`key-${pr.number}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Copy ${taskKey}`)
          .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(taskKey); })
          .child(svg("mods/prs/copy.svg").size(12))))
        // The Start session dialog (see work); without the jira mod one click starts a worktree (startWorktree).
        .child(div().id(`wt-${pr.number}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(this.worktreeTip(pr))
          .on_click((_e, cx) => { cx.stop_propagation(); this.work(pr, cx); })
          .child(this.starting.has(pr.url) ? svg("mods/prs/spinner.svg").size(12).spin(900) : svg("mods/prs/session.svg").size(12)))
        // Draft: a purple "draft pull request" icon (theme's ansi5, a colour no other mark here uses).
        .when(pr.isDraft, (e) => e.child(div().id(`draft-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().tooltip("Draft: not ready for review")
          .child(svg("mods/prs/draft.svg").size(14).text_color(t.ansi5)))))
      .child(h_flex().pl(13).gap(6).text_size(10).text_color(t.dim)
        .child(div().min_w(0).truncate().child(pr.headRefName))
        // Target branch: "→ base", kept short; the head branch truncates first.
        .when(Boolean(pr.baseRefName), (e) => e.child(div().id(`base-${pr.number}`).flex_none().max_w(110).truncate().text_color(t.muted)
          .tooltip(`Merges into ${pr.baseRefName}`).child(`→ ${pr.baseRefName}`)))
        .child(div().flex_none().child(`#${pr.number}`))
        .child(div().flex_1())
        .when(Boolean(pr.author?.login), (e) => e.child(div().flex_none().max_w(120).truncate().text_color(t.muted).child(pr.author.login))));
  }

  // My PRs on top, then everyone else's (those waiting for my review first), each under a small heading.
  // Not grouped while my login is unknown or when one group is empty.
  grouped(shown, t) {
    const mine = shown.filter((pr) => pr.mine), rest = shown.filter((pr) => !pr.mine);
    if (!mine.length || !rest.length) return shown.map((pr) => this.row(pr, t));
    rest.sort((a, b) => Number(Boolean(b.needMe)) - Number(Boolean(a.needMe)));
    const head = (id, label, n) => h_flex().id(id).flex_none().px(8).pt(id === "g-mine" ? 2 : 10).pb(2).gap(6).items_center()
      .text_size(10).font_semibold().text_color(t.muted).child(label).child(div().text_color(t.dim).child(String(n)));
    return [head("g-mine", "Mine", mine.length), ...mine.map((pr) => this.row(pr, t)),
      head("g-rest", "Others", rest.length), ...rest.map((pr) => this.row(pr, t))];
  }

  render(cx) {
    if (this.detailPr) return this.detailView(theme());
    if (this.cr) return this.createView(theme());
    const t = theme();
    const q = this.query;
    const shown = !q ? this.prs : this.prs.filter((pr) => [pr.title, pr.body, pr.headRefName, pr.author?.login, `#${pr.number}`].some((s) => (s ?? "").toLowerCase().includes(q)));
    const empty = this.error || (this.loading && !this.prs.length ? "Loading…" : !this.prs.length ? "No open pull requests" : !shown.length ? "No matches" : null);
    const refresh = div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => this.poll(cx, true))
      .child(svg("mods/prs/refresh.svg").size(14).when(this.loading, (s) => s.spin(900)));
    return v_flex().id("prs").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Pull requests"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(q ? `${shown.length}/${this.prs.length}` : String(this.prs.length)))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.repo))
        .child(h_flex().flex_none().h(24).p(2).gap(2).items_center().rounded(6).border_1().border_color(t.border)
          .children([["mine", "Mine", false, "Pull requests I opened and those waiting for my review"], ["all", "All", true, "Every open pull request of the repo"]].map(([id, label, all, tip]) =>
            div().id(`show-${id}`).h_full().px(6).flex().items_center().rounded(4).text_size(10).cursor_pointer().tooltip(tip)
              .bg(this.all === all ? t.hover : t.background).text_color(this.all === all ? t.foreground : t.muted)
              .on_click((_e, cx) => this.setAll(all, cx)).child(label))))
        .child(h_flex().id("auto").h(24).px(5).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(this.auto ? "Auto-sync every 2 minutes while the panel is shown: on" : "Auto-sync: off (default) · refresh by hand").on_click((_e, cx) => this.toggleAuto(cx))
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.auto ? t.accent : t.border).bg(this.auto ? t.accent : t.background).text_color(t.accent_foreground).child(this.auto ? "✓" : ""))
          .child(div().text_size(10).text_color(t.muted).child("Auto")))
        .child(div().id("new-pr").size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().bg(t.solid).text_color(t.solid_foreground)
          .hover((s) => s.opacity(0.85)).tooltip("New pull request from this folder's branch")
          .on_click((_e, cx) => { cx.stop_propagation(); const l = this.loc(); if (l.cwd) openOverlay({ mod: "prs", kind: "dialog", width: 660, height: 720, props: { create: l } }); })
          .child(svg("mods/prs/plus.svg").size(14)))
        .child(refresh))
      .when(Boolean(this.prs.length), (e) => e.child(div().flex_none().px(8).pt(8)
        .child(div().id("search").h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .child(Input.new(this.search).h_full().w_full().text_size(12).text_color(t.foreground)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(Boolean(empty), (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .children(this.grouped(shown, t)))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()));
  }
}
