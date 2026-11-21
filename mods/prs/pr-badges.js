// Copy of lib/pr-badges.js (prs, jira): edit lib/pr-badges.js, then run scripts/sync-lib.
// A PR's badges, worked out the same way in every mod that shows one: CI state, approval and Copilot's review
// (requested, reviewing, open threads by severity). Pure helpers plus one cached gh GraphQL call (openPrs); the mod keeps the state.
import { exec } from "herdr";

// CI of the PR: "fail" if any check failed, "wait" if any is still running, else "ok" (or "" without checks).
// `rollup`: check runs / status contexts, or (openPrs) one { state } with the rollup's state.
export function ci(rollup) {
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
export const isCopilot = (x) => /copilot/i.test(x?.login ?? x?.name ?? "");
// The request comes as `pr.cpAsked` (openPrs). `pr.reviews` is each reviewer's latest (enough for the state).
export const copilot = (pr) => {
  if (pr.cpAsked || pr.reviewRequests?.some(isCopilot)) return "asked";
  const last = pr.reviews?.filter((r) => isCopilot(r.author)).pop();
  return !last ? "" : /no open issues|generated no (new )?comments/i.test(last.body ?? "") ? "clean" : "done";
};
export const reviewed = (state) => state === "done" || state === "clean";

// The open PRs of a repo ("owner/name"), the newest-updated 100, with all that the badges and rows of every mod need,
// in one GraphQL call. gh keeps the answer on disk for CACHE keyed by the exact request, so the mods sending this
// query (prs, jira) share one GitHub call: whichever asks first fetches, the other reads it until it expires.
// Each PR comes in `gh pr list --json` shape (reviews = each reviewer's latest, statusCheckRollup = the head commit's
// checks), plus `cpAsked` (Copilot's review is requested: it is reviewing), `needMe` (my review is requested) and
// `cpUrls` (unresolved Copilot threads as their first comments' URLs). Returns { viewer, prs }; throws on failure,
// with `setup` set when gh is missing or not logged in.
// gh keeps one entry per request whatever the TTL (the TTL is only the age it accepts), so a mod that has nothing to
// show yet asks with STALE first (any answer from the last day, ~0.2 s, no network when there is one), shows it,
// then asks again with the default CACHE, which fetches when the entry is older and so refreshes it for every mod.
// A Refresh asks with FORCE: an entry is never that young, so GitHub is asked, and the new answer replaces the entry
// for every mod (measured: 2s and 3s rewrite the same cache file, 1h then reads it).
// GraphQL rate limit (5000 points an hour, shared with every gh user of the account): GitHub charges by the
// connections a query may fetch, not by what comes back. Measured: 100 PRs with threads × first comment and
// checks × contexts cost ~106 points a call and ran the limit out within the hour. So the list query asks only
// one-level connections and the rollup's single state (~2 points), and the threads come in a second query only for
// the PRs Copilot left comments on (each ~0.5 point), cached the same way.
// ponytail: 50 PRs, 30 threads each; a request to a team I'm in doesn't count as mine.
const CACHE = "60s";
export const STALE = "24h";
export const FORCE = "1s";
const PRS_QUERY = `query($owner:String!,$name:String!){viewer{login} repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{
number title url body isDraft mergeable headRefName baseRefName isCrossRepository reviewDecision author{login} labels(first:10){nodes{name}}
latestReviews(first:20){nodes{author{login} state body}}
reviewRequests(first:10){nodes{requestedReviewer{... on Bot{login} ... on User{login}}}}
commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
// Unresolved Copilot threads of the given PRs, by alias p<number>.
const threadsQuery = (numbers) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((n) =>
  `p${n}:pullRequest(number:${n}){reviewThreads(first:30){nodes{isResolved comments(first:1){nodes{author{login} url}}}}}`).join(" ")}}}`;

async function gql(query, owner, name, cwd, on, ttl) {
  const setup = (message) => Object.assign(new Error(message), { setup: true });
  const r = await exec("gh", ["api", "graphql", "--cache", ttl, "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `query=${query}`], { cwd, on, timeout: 60000 })
    .catch(() => { throw setup("GitHub CLI (gh) is not installed · install it (brew install gh), then run gh auth login"); });
  if (r.code !== 0) {
    const text = (r.stderr || r.stdout).trim();
    if (/gh auth login|not logged in/i.test(text)) throw setup("GitHub CLI is not logged in · run gh auth login");
    throw new Error(text.split("\n").pop() || "gh failed");
  }
  return JSON.parse(r.stdout).data;
}

export async function openPrs(repo, cwd, on, ttl = CACHE) {
  const [owner, name] = repo.split("/");
  const data = await gql(PRS_QUERY, owner, name, cwd, on, ttl), viewer = data.viewer?.login ?? null;
  const prs = (data.repository?.pullRequests.nodes ?? []).map(({ labels, latestReviews, reviewRequests, commits, ...pr }) => {
    const asked = reviewRequests.nodes.map((n) => n.requestedReviewer).filter(Boolean);
    // The rollup's one state stands in for the checks list: ci() reads FAILURE/ERROR, PENDING/EXPECTED, SUCCESS.
    const state = commits.nodes[0]?.commit.statusCheckRollup?.state;
    return { ...pr, labels: labels.nodes, reviews: latestReviews.nodes, reviewRequests: asked,
      statusCheckRollup: state ? [{ state }] : [],
      cpAsked: asked.some(isCopilot), needMe: Boolean(viewer) && asked.some((x) => x.login === viewer), cpUrls: [] };
  });
  // Threads only where Copilot's latest review left comments ("done"); a failed call leaves the count unknown.
  const withComments = prs.filter((pr) => copilot(pr) === "done").map((pr) => pr.number);
  if (withComments.length) {
    try {
      const t = await gql(threadsQuery(withComments), owner, name, cwd, on, ttl);
      for (const pr of prs) {
        const nodes = t.repository?.[`p${pr.number}`]?.reviewThreads.nodes;
        if (nodes) pr.cpUrls = nodes.filter((x) => !x.isResolved && isCopilot(x.comments.nodes[0]?.author)).map((x) => x.comments.nodes[0].url);
      }
    } catch { for (const pr of prs) if (withComments.includes(pr.number)) pr.cpUrls = undefined; }
  }
  return { viewer, prs };
}

// The list's Copilot badge, worked out once per poll: "high" = an open Copilot thread that is High or Medium (or of
// unknown severity), "low" = only Low ones open, "ok" = reviewed and none open, else copilot()'s "asked" / "".
// Severity comes from Copilot's overview reviews in `pr.reviews`, matched by thread URL (with latestReviews only the
// latest overview, so a thread from an older one counts as High). `urls` is undefined when the count is unknown.
export function copilotBadge(pr, urls) {
  const cp = copilot(pr);
  if (!reviewed(cp)) return { level: cp, open: 0 };
  if (!urls) return { level: cp === "clean" ? "ok" : "high", open: null };
  if (!urls.length) return { level: "ok", open: 0 };
  const sev = new Map((pr.reviews ?? []).filter((r) => isCopilot(r.author)).flatMap((r) => copilotOverview(r.body)?.issues ?? []).map((i) => [i.url, i.severity.toLowerCase()]));
  return { level: urls.every((u) => sev.get(u) === "low") ? "low" : "high", open: urls.length };
}

// The badge's tooltip.
export function copilotTip({ level, open }) {
  const s = open === 1 ? "" : "s";
  return level === "high" ? (open ? `Copilot: ${open} open thread${s}, High or Medium among them` : "Copilot reviewed: left comments")
    : level === "low" ? `Copilot: ${open} open thread${s}, all Low` : level === "ok" ? "Copilot reviewed: no open threads"
    : level === "asked" ? "Copilot is reviewing (requested, no answer yet)" : "Copilot not run yet";
}

// "approved" if a human's latest review approves, "changes" if it requests changes, else "".
// By reviews, not only reviewDecision: that one stays empty in repos that don't require reviews.
export function approval(pr) {
  const last = new Map();
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r.state);
  const states = [...last.values()];
  return pr.reviewDecision === "CHANGES_REQUESTED" || states.includes("CHANGES_REQUESTED") ? "changes"
    : pr.reviewDecision === "APPROVED" || states.includes("APPROVED") ? "approved" : "";
}

// Copilot's overview review (<!-- ccr-overview-v2 -->): verdict, summary, issues { severity, title, url, note },
// "What changed" (markdown) and the review effort. Null for any other text (an older overview stays a plain comment).
// ponytail: parsed from Copilot's markdown; a new layout falls back to the plain comment.
export function copilotOverview(body) {
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

// The repo name ("dokka-backend") from a PR's URL, or undefined.
export const repoOfUrl = (url) => /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(url ?? "")?.[1];
