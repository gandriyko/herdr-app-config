import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, theme, notify, playSound } from "herdr";

// My open pull requests in the repo of the focused folder, via the `gh` CLI. Click opens the PR in the browser.
// ponytail: only open PRs I authored (first 100); add `--search "review-requested:@me"` as a second list if wanted.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

// CI of the PR: "fail" if any check failed, "wait" if any is still running, else "ok" (or "" without checks).
function ci(rollup) {
  if (!rollup?.length) return "";
  const bad = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (rollup.some((c) => bad.includes(c.conclusion) || c.state === "FAILURE" || c.state === "ERROR")) return "fail";
  if (rollup.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "wait";
  return "ok";
}

// Copilot: "done" once it left a review, "asked" while its request is pending, else "".
// ponytail: matches the login by /copilot/i (its review login is copilot-pull-request-reviewer, the request's is Copilot).
const isCopilot = (x) => /copilot/i.test(x?.login ?? x?.name ?? "");
const copilot = (pr) => pr.reviews?.some((r) => isCopilot(r.author)) ? "done" : pr.reviewRequests?.some(isCopilot) ? "asked" : "";

// "approved" if a human's latest review approves, "changes" if it requests changes, else "".
// By reviews, not only reviewDecision: that one stays empty in repos that don't require reviews.
function approval(pr) {
  const last = new Map();
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  const states = [...last.values()];
  return pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED") ? "changes"
    : pr.reviewDecision === "APPROVED" || states.includes("APPROVED") ? "approved" : "";
}

const FIELDS ="number,title,headRefName,isDraft,reviewDecision,url,statusCheckRollup,reviewRequests,reviews";
async function list(cwd, on) {
  // exec rejects when the program can't start (gh not installed); gh itself says "gh auth login" when not logged in.
  const setup = (message) => Object.assign(new Error(message), { setup: true });
  const r = await exec("gh", ["pr", "list", "--author", "@me", "--state", "open", "--limit", "100", "--json", FIELDS], { cwd, on })
    .catch(() => { throw setup("GitHub CLI (gh) is not installed · install it (brew install gh), then run gh auth login"); });
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    if (/gh auth login|not logged in/i.test(text)) throw setup("GitHub CLI is not logged in · run gh auth login");
    throw new Error(text.split("\n").pop() || "gh failed");
  }
  return JSON.parse(r.stdout);
}

// "owner/name" from a git remote URL (https or ssh), or null.
const repoName = (url) => /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null;

export default class Prs extends View {
  init(_props, cx) {
    this.prs = []; this.error = null; this.loading = false; this.key = key(); this.repo = "";
    this.byRepo = new Map(); // repo key -> { name, prs, error }: one gh call per repo, whatever folders point at it
    this.remotes = new Map(); // folder -> its repo, from the local git remote (no API call)
    this.focusRepo = null;
    this.seen = null; // PR url -> copilot state at the last poll; null until the first one (no sound for what already was)
    // Auto-sync (the minute poll and its sound) can be switched off; remembered. Refresh still works by hand.
    this.auto = (() => { try { return localStorage.getItem("auto") !== "0"; } catch { return true; } })();
    this.poll(cx);
    // The folder follows focus: check it often (cheap); a repo already polled is shown from memory.
    cx.timer.every(2000, (cx) => { const k = key(); if (k !== this.key) { this.key = k; this.focus(cx); } });
    cx.timer.every(60 * 1000, (cx) => { if (this.auto) this.poll(cx); });
  }

  toggleAuto(cx) {
    this.auto = !this.auto;
    try { localStorage.setItem("auto", this.auto ? "1" : "0"); } catch {}
    if (this.auto) this.poll(cx); else cx.notify();
  }

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
    this.error = e?.error ?? (!location().cwd ? "No folder" : !e && !this.auto ? "Auto-sync is off · press refresh" : null);
  }

  focus(cx) {
    cx.spawn(async (cx) => {
      const r = await this.repoOf(location());
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
    const focus = location(), places = new Map();
    for (const p of [focus, ...spaces().map((s) => ({ cwd: s.folder, on: s.machine ?? null }))]) if (p.cwd) places.set(`${p.on}|${p.cwd}`, p);
    cx.spawn(async (cx) => {
      try {
        const repos = new Map();
        for (const p of places.values()) { const r = await this.repoOf(p); if (!repos.has(r.key)) repos.set(r.key, { ...r, ...p }); }
        const next = new Map(), done = [];
        await Promise.all([...repos].map(async ([k, r]) => {
          const old = this.byRepo.get(k);
          try {
            const prs = await list(r.cwd, r.on);
            this.byRepo.set(k, { name: r.name, prs, error: null });
            for (const pr of prs) next.set(pr.url, { state: copilot(pr), pr });
          } catch (e) {
            this.byRepo.set(k, { name: r.name, prs: old?.prs ?? [], error: String(e.message ?? e) });
            // One toast per session: the panel is often closed, and a minute-by-minute toast would nag.
            if (e.setup && !this.warned) { this.warned = true; notify({ title: "Pull requests", body: e.message, level: "warning" }); }
          }
        }));
        for (const [url, { state, pr }] of next) if (this.seen?.get(url) !== undefined && this.seen.get(url) !== "done" && state === "done") done.push(pr);
        // A failed repo drops out of `next`; keep its old states so a later success isn't mistaken for news.
        this.seen = new Map([...(this.seen ?? []), ...[...next].map(([url, { state }]) => [url, state])]);
        this.focusRepo = (await this.repoOf(focus)).key; this.show();
        for (const pr of done) notify({ title: "Copilot reviewed", body: `#${pr.number} ${pr.title}`, level: "info" });
        if (done.length) playSound("done");
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.poll(cx); }
      }
    });
  }

  row(pr, t) {
    const state = ci(pr.statusCheckRollup);
    const dot = { ok: t.done, fail: t.ansi1, wait: t.working }[state];
    const dotTip = { ok: "CI: all checks passed", fail: "CI: a check failed", wait: "CI: checks are running" }[state] ?? "CI: no checks";
    // Review icon: green check = someone approved, red cross = changes requested, grey check = not approved yet.
    const ap = approval(pr);
    const [apIcon, apColor, apTip] = ap === "approved" ? ["approved", t.done, "Approved by a reviewer"]
      : ap === "changes" ? ["changes", t.ansi1, "Changes requested"] : ["approved", t.border, "Not approved yet"];
    const cp = copilot(pr);
    return v_flex().id(`pr-${pr.number}`).flex_none().px(8).py(4).gap(2).rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).tooltip(`#${pr.number} ${pr.title}\n${pr.headRefName}`)
      .on_click(() => exec("open", [pr.url]))
      .child(h_flex().gap(6).items_center()
        .child(div().id(`ci-${pr.number}`).flex_none().size(9).flex().items_center().justify_center().tooltip(dotTip)
          .child(div().size(7).rounded(4).bg(dot ?? t.border)))
        // Copilot badge "C": filled green = reviewed, yellow outline = requested, faint = not asked.
        .child(div().id(`cp-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().rounded(4).border_1().text_size(10).font_semibold()
          .border_color(cp === "done" ? t.done : cp === "asked" ? t.working : t.border)
          .bg(cp === "done" ? t.done : t.background)
          .text_color(cp === "done" ? t.background : cp === "asked" ? t.working : t.dim)
          .tooltip(cp === "done" ? "Copilot reviewed" : cp === "asked" ? "Copilot review requested, no answer yet" : "Copilot not requested").child("C"))
        .child(div().id(`ap-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().tooltip(apTip)
          .child(svg(`mods/prs/${apIcon}.svg`).size(14).text_color(apColor)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.number}`))
        .child(div().flex_1().min_w(0).truncate().child(pr.title))
        // Draft: a purple "draft pull request" icon (theme's ansi5, a colour no other mark here uses).
        .when(pr.isDraft, (e) => e.child(div().id(`draft-${pr.number}`).flex_none().size(15).flex().items_center().justify_center().tooltip("Draft: not ready for review")
          .child(svg("mods/prs/draft.svg").size(14).text_color(t.ansi5)))))
      .child(div().pl(13).truncate().text_size(10).text_color(t.dim).child(pr.headRefName));
  }

  render(cx) {
    const t = theme();
    const empty = this.error || (this.loading && !this.prs.length ? "Loading…" : !this.prs.length ? "No open pull requests" : null);
    const refresh = div().id("refresh").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip("Refresh").on_click((_e, cx) => this.poll(cx))
      .child(svg("mods/prs/refresh.svg").size(14).when(this.loading, (s) => s.spin(900)));
    return v_flex().id("prs").size_full().min_h(0).relative().rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Pull requests"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(this.prs.length)))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.repo))
        .child(h_flex().id("auto").h(24).px(5).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(this.auto ? "Auto-sync every minute (with Copilot sound): on" : "Auto-sync: off · refresh by hand").on_click((_e, cx) => this.toggleAuto(cx))
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().text_size(10).font_semibold()
            .border_color(this.auto ? t.accent : t.border).bg(this.auto ? t.accent : t.background).text_color(t.accent_foreground).child(this.auto ? "✓" : ""))
          .child(div().text_size(10).text_color(t.muted).child("Auto")))
        .child(refresh))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .when(Boolean(empty), (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .children(this.prs.map((pr) => this.row(pr, t))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()));
  }
}
