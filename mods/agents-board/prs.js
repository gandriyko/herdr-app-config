// Open PRs per repo through gh. Pure helpers: the instance keeps the state from newPrState().

export const CHECKS_WORD = { fail: "failing", pass: "passing", pending: "pending", none: "none" };
const MAX_COMMON = 200;
const MAX_REPOS = 30;
const PR_EVERY = 60000;
const NO_PR_EVERY = 5 * 60000;
const DEFAULT_EVERY = 30 * 60000;
const GH_DOWN = 10 * 60000;
const FAIL_RETRY = 5 * 60000;

// One PR's checks as "fail" | "pending" | "pass" | "none" from gh's statusCheckRollup.
export function checksOf(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const c of rollup) {
    const concl = String(c.conclusion ?? "").toUpperCase();
    const state = String(c.state ?? "").toUpperCase();
    if (["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "STARTUP_FAILURE"].includes(concl) || state === "FAILURE" || state === "ERROR") return "fail";
    if ((c.status && String(c.status).toUpperCase() !== "COMPLETED") || state === "PENDING" || state === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "pass";
}

export function newPrState() {
  return {
    common: new Map(), // cwd -> git common dir ("" when not a repo)
    repos: new Map(), // common dir -> { cwd, at, next, asked: Set, def, defAt, prs: { branch: { n, c } } }
    ghDownUntil: 0,
  };
}

// { common dir: { branch: { n, c } } } of what is known, to compare and to lookup.
export function prMap(st) {
  const out = {};
  for (const [k, r] of st.repos) if (Object.keys(r.prs).length) out[k] = r.prs;
  return out;
}

export function prOf(st, place) {
  if (!place) return null;
  const c = st.common.get(place.cwd);
  return (c && place.branch && st.repos.get(c)?.prs[place.branch]) || null;
}

// places: [{ cwd, branch }]. `exec` is herdr's; `alive()` says whether to go on.
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
    const e = byRepo.get(c) ?? { cwd: p.cwd, branches: new Set() };
    if (p.branch) e.branches.add(p.branch);
    byRepo.set(c, e);
  }
  const now = Date.now();
  for (const [key, e] of byRepo) {
    if (!alive() || now < st.ghDownUntil) return;
    let r = st.repos.get(key);
    if (!r) {
      if (st.repos.size >= MAX_REPOS) st.repos.delete(st.repos.keys().next().value);
      r = { cwd: e.cwd, at: 0, next: 0, asked: new Set(), prs: {}, def: null, defAt: 0 };
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
    // Only a feature branch can have a PR; no candidates, no gh call.
    const cands = [...e.branches].filter((b) => b && b !== "HEAD" && b !== "main" && b !== "master" && b !== r.def);
    if (!cands.length) {
      r.prs = {};
      r.asked = new Set();
      r.next = 0;
      continue;
    }
    const novel = cands.some((b) => !r.asked.has(b));
    if (!novel && now < r.next) continue;
    const start = Date.now();
    const res = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,statusCheckRollup"], { cwd: r.cwd, timeout: 15000 }).catch(() => null);
    const at = Date.now();
    r.at = at;
    r.asked = new Set(cands);
    if (!res) {
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
      r.next = at + FAIL_RETRY;
      continue;
    }
    try {
      const prs = {};
      for (const pr of JSON.parse(res.stdout)) prs[pr.headRefName] = { n: pr.number, c: checksOf(pr.statusCheckRollup) };
      r.prs = prs;
      // From when gh started, with slack so the 30 s tick lands on the mark; a PR on a candidate branch is checked every 60 s, none every 5 min.
      r.next = start + (cands.some((b) => prs[b]) ? PR_EVERY : NO_PR_EVERY) - 2000;
    } catch {
      r.next = at + FAIL_RETRY;
    }
  }
}
