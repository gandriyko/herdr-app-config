import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, theme, notify, playSound, props, openOverlay, closeOverlay, shared, setShared } from "herdr";
import { migrate, modelFor, settingsFor, projectKey, projectName, languageLine, runModel, describe } from "./ai.js";

// My open pull requests in the repo of the focused folder, via the `gh` CLI. Click opens the PR in a popup
// (description, who approved, comments and reviews); the popup has Open (browser) and Copy link.
// The header switches between open PRs I authored plus those waiting for my review (Mine) and every open PR
// of the repo (All); first 100.
// A mod pane (a wb-diff tab) has no cwd: keep the last terminal folder of that space (`places`, per
// instance) instead of the space folder, which may not be a repo.
const PLACES_MAX = 50;
function location(places) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd;
  if (cwd) {
    places.delete(space?.id); places.set(space?.id, { cwd, on });
    if (places.size > PLACES_MAX) places.delete(places.keys().next().value);
    return { cwd, on };
  }
  return places.get(space?.id) ?? { cwd: space?.folder, on };
}

// CI of the PR: "fail" if any check failed, "wait" if any is still running, else "ok" (or "" without checks).
function ci(rollup) {
  if (!rollup?.length) return "";
  const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (rollup.some((c) => bad.includes(c.conclusion) || c.state === "FAILURE" || c.state === "ERROR")) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "wait";
  return "ok";
}

// Copilot: "asked" while its request is pending (also a re-request after an earlier review: it is reviewing),
// "clean" if its latest review left no comments, "done" if it left some, else "".
// ponytail: matches the login by /copilot/i (its review login is copilot-pull-request-reviewer, the request's is Copilot).
// ponytail: "no comments" is read from the review text: "No open issues" (ccr-overview-v2), or the older
// "...generated no (new) comments."; gh gives no comment count. A new Copilot wording needs a new pattern here.
const isCopilot = (x) => /copilot/i.test(x?.login ?? x?.name ?? "");
// `gh pr list --json reviewRequests` leaves bots out, so the request comes from GraphQL as `pr.cpAsked` (copilotGql).
const copilot = (pr) => {
  if (pr.cpAsked || pr.reviewRequests?.some(isCopilot)) return "asked";
  const last = pr.reviews?.filter((r) => isCopilot(r.author)).pop();
  return !last ? "" : /no open issues|generated no (new )?comments/i.test(last.body ?? "") ? "clean" : "done";
};
const reviewed = (state) => state === "done" || state === "clean";

// Per PR number: `asked` = Copilot is among the pending review requests (it is reviewing), `me` = my review is
// requested, `urls` = unresolved Copilot threads as their first comments' URLs (a thread is Copilot's by its first
// comment); one GraphQL call per repo.
// ponytail: first 50 PRs × 100 threads; a failed call leaves the map empty (the row falls back to gh's fields).
// ponytail: a request to a team I'm in doesn't count as mine; add `... on Team{members}` if that's wanted.
async function copilotGql(repo, numbers, cwd, on) {
  const out = new Map(), [owner, name] = repo.split("/");
  if (!numbers.length) return out;
  const prs = numbers.slice(0, 50).map((n) => `p${n}:pullRequest(number:${n}){reviewRequests(first:20){nodes{requestedReviewer{... on Bot{login} ... on User{login}}}} reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} url}}}}}`).join(" ");
  const r = await exec("gh", ["api", "graphql", "-f", `query={viewer{login} repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${prs}}}`], { cwd, on, timeout: 60000 }).catch(() => null);
  try {
    const data = JSON.parse(r.stdout).data;
    out.ok = Boolean(data.repository);
    out.viewer = data.viewer?.login; // my login: whose PRs get the Copilot sound in the "All" list
    for (const [k, pr] of Object.entries(data.repository ?? {}))
      if (pr) out.set(Number(k.slice(1)), {
        asked: pr.reviewRequests.nodes.some((n) => isCopilot(n.requestedReviewer)),
        me: Boolean(out.viewer) && pr.reviewRequests.nodes.some((n) => n.requestedReviewer?.login === out.viewer),
        urls: pr.reviewThreads.nodes.filter((t) => !t.isResolved && isCopilot(t.comments.nodes[0]?.author)).map((t) => t.comments.nodes[0].url),
      });
  } catch {}
  return out;
}

// The list's Copilot badge, worked out once per poll: "high" = an open Copilot thread that is High or Medium (or of
// unknown severity), "low" = only Low ones open, "ok" = reviewed and none open, else copilot()'s "asked" / "".
// Severity comes from Copilot's overview reviews, matched by thread URL. `urls` is undefined when the count is unknown.
function copilotBadge(pr, urls) {
  const cp = copilot(pr);
  if (!reviewed(cp)) return { level: cp, open: 0 };
  if (!urls) return { level: cp === "clean" ? "ok" : "high", open: null };
  if (!urls.length) return { level: "ok", open: 0 };
  const sev = new Map((pr.reviews ?? []).filter((r) => isCopilot(r.author)).flatMap((r) => copilotOverview(r.body)?.issues ?? []).map((i) => [i.url, i.severity.toLowerCase()]));
  return { level: urls.every((u) => sev.get(u) === "low") ? "low" : "high", open: urls.length };
}

// "approved" if a human's latest review approves, "changes" if it requests changes, else "".
// By reviews, not only reviewDecision: that one stays empty in repos that don't require reviews.
function approval(pr) {
  const last = new Map();
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  const states = [...last.values()];
  return pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED") ? "changes"
    : pr.reviewDecision === "APPROVED" || states.includes("APPROVED") ? "approved" : "";
}

const FIELDS ="number,title,headRefName,isDraft,reviewDecision,url,statusCheckRollup,reviewRequests,reviews,body,author";
// `all`: every open PR of the repo; else mine, then those waiting for my review (a second gh call), by number.
async function list(cwd, on, all) {
  if (all) return listBy(cwd, on, []);
  const [mine, asked] = await Promise.all([listBy(cwd, on, ["--author", "@me"]), listBy(cwd, on, ["--search", "review-requested:@me"])]);
  const have = new Set(mine.map((pr) => pr.number));
  return [...mine, ...asked.filter((pr) => !have.has(pr.number))];
}
async function listBy(cwd, on, filter) {
  // exec rejects when the program can't start (gh not installed); gh itself says "gh auth login" when not logged in.
  const setup = (message) => Object.assign(new Error(message), { setup: true });
  const r = await exec("gh", ["pr", "list", ...filter, "--state", "open", "--limit", "100", "--json", FIELDS], { cwd, on })
    .catch(() => { throw setup("GitHub CLI (gh) is not installed · install it (brew install gh), then run gh auth login"); });
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    if (/gh auth login|not logged in/i.test(text)) throw setup("GitHub CLI is not logged in · run gh auth login");
    throw new Error(text.split("\n").pop() || "gh failed");
  }
  return JSON.parse(r.stdout);
}

// Who approved: each reviewer's latest review that counts, those that are APPROVED.
function approvedBy(reviews) {
  const last = new Map();
  for (const r of reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  return [...last].filter(([, st]) => st === "APPROVED").map(([login]) => login).filter(Boolean);
}
// A PR's line-comment threads with their comments. ponytail: first 100 threads, 30 comments each.
const THREADS = "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:30){nodes{author{login} body createdAt url}}}}}}}";

// Copilot's overview review (<!-- ccr-overview-v2 -->): verdict, summary, issues { severity, title, url, note },
// "What changed" (markdown) and the review effort. Null for any other text (an older overview stays a plain comment).
// ponytail: parsed from Copilot's markdown; a new layout falls back to the plain comment.
function copilotOverview(body) {
  if (!/ccr-overview/.test(body ?? "")) return null;
  const verdict = /^###\s+(.+)$/m.exec(body)?.[1]?.trim();
  if (!verdict) return null;
  const summary = body.split(/^###.+$/m)[1]?.split("<details")[0].trim() ?? "";
  const issues = [...body.matchAll(/^- .*?alt="(\w+) severity".*?\[([^\]]+)\]\(([^)]+)\)(.*)$/gm)]
    .map(([, severity, title, url, rest]) => ({ severity, title, url, note: rest.replace(/^\s*·\s*/, "").trim() }));
  const what = /<summary><strong>What changed in this PR<\/strong><\/summary>([\s\S]*?)<\/details>/.exec(body)?.[1]?.trim() ?? "";
  const effort = /<sub>([^<]+)<\/sub>/.exec(body)?.[1]?.trim() ?? "";
  return { verdict, summary, issues, what, effort };
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

export default class Prs extends View {
  init(_props, cx) {
    // Opened as a popup for one PR (click on a row): its description, approvals, comments and reviews.
    if (props()?.pr) { this.detailPr = props().pr; this.loadDetail(cx); return; }
    // Opened as a dialog from the header's + : a new pull request for the branch of that folder.
    if (props()?.create) { this.initCreate(cx); return; }
    this.started = Date.now();
    // Search: by title, description, branch or number; the list is cut as you type.
    this.query = "";
    this.search = InputState.new({ placeholder: "Search pull requests: title, description" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.places = new Map(); // space id -> last terminal folder there (see location)
    this.prs = []; this.error = null; this.loading = false; this.key = this.locKey(); this.repo = "";
    this.byRepo = new Map(); // repo key -> { name, prs, error }: one gh call per repo, whatever folders point at it
    this.remotes = new Map(); // folder -> its repo, from the local git remote (no API call)
    this.focusRepo = null;
    this.seen = null; // PR url -> copilot state at the last poll; null until the first one (no sound for what already was)
    // Auto-sync (the minute poll and its sound) can be switched off; remembered. Refresh still works by hand.
    this.auto = (() => { try { return (localStorage.getItem("prs.auto") ?? localStorage.getItem("auto")) !== "0"; } catch { return true; } })();
    this.all = (() => { try { return localStorage.getItem("prs.all") === "1"; } catch { return false; } })();
    this.poll(cx);
    // The folder follows focus: check it often (cheap); a repo already polled is shown from memory.
    cx.timer.every(2000, (cx) => { const k = this.locKey(); if (k !== this.key) { this.key = k; this.focus(cx); } });
    // A PR approved or created elsewhere: poll now. From a timer, not render(): a task spawned with
    // render's cx never runs. poll() has its own loading/again guard.
    cx.timer.every(2000, (cx) => {
      const changed = shared("prs.changed");
      if (changed && changed.ts !== this.changedTs) { this.changedTs = changed.ts; if (changed.ts > (this.started ?? 0)) this.poll(cx); }
    });
    cx.timer.every(60 * 1000, (cx) => { if (this.auto) this.poll(cx); });
  }

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
  locKey() { return JSON.stringify(this.loc()); }

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
      if (this.byRepo.has(r.key) || !this.auto) { this.focusRepo = r.key; this.show(); cx.notify(); } else this.poll(cx);
    });
  }

  // Every minute (and on demand): the open PRs of every repo among all spaces' folders and the focused one,
  // one gh call per repo. A sound and a toast when Copilot's review shows up on a PR that was already there.
  // Runs even while the panel is hidden.
  // ponytail: in memory only (a reload re-baselines).
  poll(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true; cx.notify();
    const focus = this.loc(), places = new Map();
    for (const p of [focus, ...spaces().map((s) => ({ cwd: s.folder, on: s.machine ?? null }))]) if (p.cwd) places.set(`${p.on}|${p.cwd}`, p);
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places.values()) { const r = await this.repoOf(p); if (!repos.has(r.key)) repos.set(r.key, { ...r, ...p }); }
        const next = new Map(), done = [];
        await Promise.all([...repos].map(async ([k, r]) => {
          const old = this.byRepo.get(k);
          try {
            const all = this.all, listed = await list(r.cwd, r.on, all);
            const gql = r.name ? await copilotGql(r.name, listed.map((pr) => pr.number), r.cwd, r.on) : new Map();
            if (all !== this.all) return; // switched while loading: the `again` poll fills it
            // A failed GraphQL call keeps each PR's last Copilot state instead of flipping the badges.
            const was = new Map((old?.prs ?? []).map((pr) => [pr.number, pr]));
            const prs = listed.map((pr) => ({ ...pr,
              cpAsked: gql.ok ? gql.get(pr.number)?.asked ?? false : was.get(pr.number)?.cpAsked ?? false,
              needMe: gql.ok ? gql.get(pr.number)?.me ?? false : was.get(pr.number)?.needMe ?? false,
              // Opened by me (null when my login is unknown: the list isn't grouped).
              mine: gql.viewer ? pr.author?.login === gql.viewer : was.get(pr.number)?.mine ?? null }));
            this.byRepo.set(k, { name: r.name, prs: prs.map((pr) => ({ ...pr, cpBadge: gql.ok || !was.has(pr.number) ? copilotBadge(pr, gql.get(pr.number)?.urls) : was.get(pr.number).cpBadge, repo: { cwd: r.cwd, on: r.on } })), error: null });
            // Copilot sound only for PRs I opened (when my login is unknown: everything in Mine, nothing in All).
            for (const pr of prs) if (gql.viewer ? pr.author?.login === gql.viewer : !all) next.set(pr.url, { state: copilot(pr), pr });
          } catch (e) {
            // A failed refresh keeps the last good list as it was; the error shows only when there is none.
            this.byRepo.set(k, old?.prs?.length ? old : { name: r.name, prs: [], error: String(e.message ?? e) });
            // One toast per session: the panel is often closed, and a minute-by-minute toast would nag.
            if (e.setup && !this.warned) { this.warned = true; notify({ title: "Pull requests", body: e.message, level: "warning" }); }
          }
        }));
        for (const [url, { state, pr }] of next) if (this.seen?.get(url) !== undefined && !reviewed(this.seen.get(url)) && reviewed(state)) done.push(pr);
        // A failed repo drops out of `next`; keep its old states so a later success isn't mistaken for news.
        this.seen = new Map([...(this.seen ?? []), ...[...next].map(([url, { state }]) => [url, state])]);
        this.focusRepo = (await this.repoOf(focus)).key; this.show();
        for (const pr of done) notify({ title: copilot(pr) === "clean" ? "Copilot reviewed: no comments" : "Copilot reviewed", body: `#${pr.number} ${pr.title}`, level: "info" });
        if (done.length) playSound("done");
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.poll(cx); }
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
        if (cp) { const n = cp.issues.length; cp.issues = cp.issues.filter((i) => !resolved.has(i.url)); cp.resolved = n - cp.issues.length; }
        const items = [...(v.comments ?? []).map((c) => ({ author: c.author?.login, at: c.createdAt, body: c.body })),
          ...(v.reviews ?? []).filter((rv) => (rv.body || rv.state !== "COMMENTED") && !(cp && rv.state === "COMMENTED" && isCopilot(rv.author))).map((rv) => ({ author: rv.author?.login, at: rv.submittedAt, body: rv.body, extra: rv.state.toLowerCase().replace("_", " ") }))]
          .sort((p, q) => String(p.at).localeCompare(String(q.at))).map((c, i) => ({ ...c, id: i }));
        const me = await exec("gh", ["api", "user", "--jq", ".login"], { cwd: r.cwd, on: r.on }).then((m) => m.code === 0 ? m.stdout.trim() : null).catch(() => null);
        const by = approvedBy(v.reviews);
        this.detail = { me, mineApproved: Boolean(me && by.includes(me)), title: v.title, body: v.body ?? "", author: v.author?.login, from: v.headRefName, to: v.baseRefName, created: v.createdAt,
          approvedBy: by, comments: items, threads, copilot: cp };
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
    const btn = (id, label, act) => div().id(id).h(26).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(12).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(act).child(label);
    const meta = (label, value) => !value ? null : h_flex().gap(8).items_center().text_size(12)
      .child(div().w(80).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().child(value));
    return v_flex().id("pr-detail").size_full().min_h(0).relative().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(12).text_color(t.dim).child(`#${pr.number}`))
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
      .children(cp.issues.map((i, k) => h_flex().id(`pr-cp-i-${k}`).gap(8).items_center().text_size(12).cursor_pointer().on_click(() => exec("open", [i.url]))
        .child(div().flex_none().px(8).py(1).rounded(9).border_1().text_size(10.5).font_semibold()
          .border_color(sev[i.severity.toLowerCase()] ?? t.border).text_color(sev[i.severity.toLowerCase()] ?? t.muted).child(i.severity))
        .child(div().flex_1().min_w(0).truncate().text_color(t.accent).hover((s) => s.underline()).child(i.title))
        .when(Boolean(i.note), (e) => e.child(div().flex_none().text_color(t.dim).child(i.note)))))
      .when(Boolean(cp.what), (e) => e
        .child(h_flex().id("pr-cp-what").gap(6).items_center().text_size(12).font_semibold().cursor_pointer()
          .on_click((_e, cx) => { this.cpWhat = !this.cpWhat; cx.notify(); })
          .child(div().w(10).text_color(t.dim).child(this.cpWhat ? "▾" : "▸")).child("What changed in this PR"))
        .when(Boolean(this.cpWhat), (e2) => e2.child(TextView.markdown(`pr-cp-what-${this.detailPr.number}`, cp.what))))
      .when(Boolean(cp.effort), (e) => e.child(div().text_size(11).text_color(t.dim).child(cp.effort)));
  }

  row(pr, t) {
    const state = ci(pr.statusCheckRollup);
    const dot = { ok: t.done, fail: t.ansi1, wait: t.working }[state];
    const dotTip = { ok: "CI: all checks passed", fail: "CI: a check failed", wait: "CI: checks are running" }[state] ?? "CI: no checks";
    // Review icon: green check = someone approved, red cross = changes requested, grey check = not approved yet.
    const ap = approval(pr);
    const [apIcon, apColor, apTip] = ap === "approved" ? ["approved", t.done, "Approved by a reviewer"]
      : ap === "changes" ? ["changes", t.ansi1, "Changes requested"] : ["approved", t.border, "Not approved yet"];
    const { level, open } = pr.cpBadge ?? copilotBadge(pr);
    const taskKey = /^[A-Za-z]+-\d+/.exec(pr.title ?? "")?.[0];
    const fill = { high: t.ansi1, low: t.accent, ok: t.done }[level];
    const s = open === 1 ? "" : "s";
    const cpTip = level === "high" ? (open ? `Copilot: ${open} open thread${s}, High or Medium among them` : "Copilot reviewed: left comments")
      : level === "low" ? `Copilot: ${open} open thread${s}, all Low` : level === "ok" ? "Copilot reviewed: no open threads"
      : level === "asked" ? "Copilot is reviewing (requested, no answer yet)" : "Copilot not run yet";
    return v_flex().id(`pr-${pr.number}`).flex_none().px(8).py(4).gap(2).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`#${pr.number} ${pr.title}\n${pr.headRefName}`)
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
        // My review is requested: an eye in the theme's "working" colour, so the PR stands out as one to look at.
        .when(Boolean(pr.needMe), (e) => e.child(div().id(`me-${pr.number}`).flex_none().size(15).flex().items_center().justify_center()
          .tooltip("Your review is requested").child(svg("mods/prs/review.svg").size(14).text_color(t.working))))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        // Copy the task key that starts the title (DA-20323: …); the row's own click doesn't fire.
        .when(Boolean(taskKey), (e) => e.child(div().id(`key-${pr.number}`).flex_none().size(18).flex().items_center().justify_center().rounded(4)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Copy ${taskKey}`)
          .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(taskKey); })
          .child(svg("mods/prs/copy.svg").size(12))))
        // Draft: a purple "draft pull request" icon (theme's ansi5, a colour no other mark here uses).
        .when(pr.isDraft, (e) => e.child(div().id(`draft-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().tooltip("Draft: not ready for review")
          .child(svg("mods/prs/draft.svg").size(14).text_color(t.ansi5)))))
      .child(h_flex().pl(13).gap(6).text_size(10).text_color(t.dim)
        .child(div().min_w(0).truncate().child(pr.headRefName))
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
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => this.poll(cx))
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
          .tooltip(this.auto ? "Auto-sync every minute (with Copilot sound): on" : "Auto-sync: off · refresh by hand").on_click((_e, cx) => this.toggleAuto(cx))
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
