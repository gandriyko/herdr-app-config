// Copy of lib/prs.js (agents-copy, agents-board): edit lib/prs.js, then run scripts/sync-lib.
// Open PRs per repo through gh, and the Jira keys that pick an agent's PR. Pure helpers: the instance
// keeps the state from newPrState().

export const CHECKS_WORD = { fail: "failing", pass: "passing", pending: "pending", none: "none" };
const MAX_COMMON = 200;
const MAX_REPOS = 30;
const PR_EVERY = 60000;
const NO_PR_EVERY = 5 * 60000;
export const RECHECK = 60000; // after an agent stops: past gh's 55 s cache
const DEFAULT_EVERY = 30 * 60000;
const GH_DOWN = 10 * 60000;
const FAIL_RETRY = 5 * 60000;

// The open PRs of the cwd's repo with the head commit's rollup state. gh caches the answer on disk
// for 55 s keyed by the request, so every copy sending this exact query shares one GitHub call.
const PRS_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{number headRefName commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}";
const PRS_ARGS = ["api", "graphql", "--cache", "55s", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${PRS_QUERY}`];
// GitHub's StatusState of the rollup as "fail" | "pending" | "pass"; no rollup is "none".
const CHECKS = { FAILURE: "fail", ERROR: "fail", PENDING: "pending", EXPECTED: "pending", SUCCESS: "pass" };

// Jira keys: DA-20457, also in an upper-cased branch name (da-20457-fix -> DA-20457).
const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/;
// The key a branch names, or null.
export const branchKey = (branch) => branch?.toUpperCase().match(JIRA_KEY)?.[0] ?? null;
// Every key in a text (upper-case it first).
export const keysIn = (text) => text.match(new RegExp(JIRA_KEY.source, "g")) ?? [];
// The projects from the jira mod's settings ({ project: "DA, OPS" }) as ["DA", "OPS"]; [] means any.
export const jiraProjects = (settings) => String(settings?.project ?? "").toUpperCase().split(/[\s,]+/).filter(Boolean);
// The first key in a text that belongs to one of the projects (so UTF-8 or GPT-4 is not a key), or null.
export const projectKey = (text, projects) =>
  keysIn(text).find((k) => !projects.length || projects.includes(k.split("-")[0])) ?? null;
// The key an agent names: its branch's key when any of its texts mentions it (a stale title may name an
// older task first), else the first project key.
export const namedKey = (text, projects, branch) => {
  const b = branchKey(branch);
  return b && keysIn(text).includes(b) ? b : projectKey(text, projects);
};
// Whether a branch names the Jira key as a whole (DA-2049 is not in da-20493-fix).
const keyIn = (branch, key) => {
  const up = branch.toUpperCase(), i = up.indexOf(key);
  return i >= 0 && !/[A-Z0-9]/.test(up[i - 1] ?? "") && !/\d/.test(up[i + key.length] ?? "");
};

export function newPrState() {
  return {
    common: new Map(), // cwd -> git common dir ("" when not a repo)
    repos: new Map(), // common dir -> { cwd, at, next, recheckAt, asked: Set, def, defAt, prs: { branch: { n, c } } }
    ghDownUntil: 0,
  };
}

// { common dir: { branch: { n, c } } } of what is known, to compare and to lookup.
export function prMap(st) {
  const out = {};
  for (const [k, r] of st.repos) if (Object.keys(r.prs).length) out[k] = r.prs;
  return out;
}

// A place with a Jira key (the agent names it) takes the open PR whose branch has that key; without one,
// the folder's branch PR, unless that branch names another key.
export function prOf(st, place) {
  if (!place) return null;
  const c = st.common.get(place.cwd);
  const prs = c && st.repos.get(c)?.prs;
  if (!prs) return null;
  if (place.key) {
    const b = Object.keys(prs).find((b) => keyIn(b, place.key));
    if (b) return prs[b];
    if (branchKey(place.branch)) return null;
  }
  return (place.branch && prs[place.branch]) || null;
}

// An agent with no PR that stopped working may have just opened one: its repo is asked on the next
// refresh, and once more RECHECK later (gh's 55 s cache can answer the first ask from before the PR).
// One recheck per repo: agents stopping in the same minute share it. Whether a repo was marked.
export function askAgain(st, place) {
  const r = place && !prOf(st, place) && st.repos.get(st.common.get(place.cwd));
  if (!r) return false;
  r.next = 0;
  r.recheckAt = Date.now() + RECHECK;
  return true;
}

// places: [{ cwd, branch, key }]. `exec` is herdr's; `alive()` says whether to go on.
export async function refreshPrs(st, places, exec, alive) {
  const byRepo = new Map();
  for (const p of places) {
    if (!alive()) return;
    let c = st.common.get(p.cwd);
    if (c === undefined) {
      const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: p.cwd, timeout: 5000 }).catch(() => null);
      c = r?.code === 0 ? r.stdout.trim() : "";
      if (st.common.size >= MAX_COMMON) st.common.delete(st.common.keys().next().value);
      st.common.set(p.cwd, c);
    }
    if (!c) continue;
    const e = byRepo.get(c) ?? { cwd: p.cwd, branches: new Set(), keys: new Set() };
    if (p.branch) e.branches.add(p.branch);
    if (p.key) e.keys.add(p.key);
    byRepo.set(c, e);
  }
  const now = Date.now();
  for (const [key, e] of byRepo) {
    if (!alive() || now < st.ghDownUntil) return;
    const keys = [...e.keys];
    let r = st.repos.get(key);
    if (!r) {
      if (st.repos.size >= MAX_REPOS) st.repos.delete(st.repos.keys().next().value);
      r = { cwd: e.cwd, at: 0, next: 0, recheckAt: 0, asked: new Set(), prs: {}, def: null, defAt: 0 };
      st.repos.set(key, r);
    }
    r.cwd = e.cwd;
    // The repo's default branch (git's origin/HEAD), re-read every 30 min; a failure means main/master only.
    if (!r.defAt || now - r.defAt > DEFAULT_EVERY) {
      const d = await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: r.cwd, timeout: 5000 }).catch(() => null);
      if (!alive()) return;
      r.def = d?.code === 0 ? d.stdout.trim().replace(/^origin\//, "") || null : null;
      r.defAt = Date.now();
    }
    // Only a feature branch, or a Jira key an agent names (its PR may be on another branch), can have a PR; none, no gh call.
    const cands = [...e.branches].filter((b) => b && b !== "HEAD" && b !== "main" && b !== "master" && b !== r.def);
    if (!cands.length && !keys.length) {
      r.prs = {};
      r.asked = new Set();
      r.next = 0;
      continue;
    }
    const novel = [...cands, ...keys].some((b) => !r.asked.has(b));
    if (!novel && now < r.next) continue;
    const start = Date.now();
    if (r.recheckAt && start >= r.recheckAt) r.recheckAt = 0; // this ask is the recheck
    const res = await exec("gh", PRS_ARGS, { cwd: r.cwd, timeout: 15000 }).catch(() => null);
    if (!alive()) return;
    const at = Date.now();
    r.at = at;
    r.asked = new Set([...cands, ...keys]);
    if (!res) {
      // gh isn't installed (or the folder is gone): no chips, ask again in 10 minutes.
      st.ghDownUntil = at + GH_DOWN;
      for (const x of st.repos.values()) x.prs = {};
      return;
    }
    if (res.code !== 0) {
      if (/auth login|not logged|GH_TOKEN|authenticat/i.test(res.stderr)) {
        st.ghDownUntil = at + GH_DOWN;
        for (const x of st.repos.values()) x.prs = {};
        return;
      }
      // Not a GitHub repo, offline: keep the last good answer, try again later.
      r.next = at + FAIL_RETRY;
      continue;
    }
    try {
      const prs = {};
      for (const pr of JSON.parse(res.stdout).data.repository.pullRequests.nodes)
        prs[pr.headRefName] = { n: pr.number, c: CHECKS[pr.commits.nodes[0]?.commit.statusCheckRollup?.state] ?? "none" };
      r.prs = prs;
      // From when gh started, with slack so the 30 s tick lands on the mark; a PR on a candidate branch is checked every 60 s, none every 5 min.
      const found = cands.some((b) => prs[b]) || keys.some((k) => Object.keys(prs).some((b) => keyIn(b, k)));
      r.next = start + (found ? PR_EVERY : NO_PR_EVERY) - 2000;
      if (r.recheckAt) r.next = Math.min(r.next, r.recheckAt);
    } catch {
      r.next = at + FAIL_RETRY;
    }
  }
}
