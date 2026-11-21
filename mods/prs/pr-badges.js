// Copy of lib/pr-badges.js (prs, jira): edit lib/pr-badges.js, then run scripts/sync-lib.
// A PR's badges, worked out the same way in every mod that shows one: CI state, approval and Copilot's review
// (requested, reviewing, open threads by severity). Pure helpers plus one gh GraphQL call; the mod keeps the state.
import { exec } from "herdr";

// CI of the PR: "fail" if any check failed, "wait" if any is still running, else "ok" (or "" without checks).
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
// `gh pr list --json reviewRequests` leaves bots out, so the request comes from GraphQL as `pr.cpAsked` (copilotGql).
// `pr.reviews` may be gh's `reviews` or `latestReviews` (each reviewer's latest; enough for the state).
export const copilot = (pr) => {
  if (pr.cpAsked || pr.reviewRequests?.some(isCopilot)) return "asked";
  const last = pr.reviews?.filter((r) => isCopilot(r.author)).pop();
  return !last ? "" : /no open issues|generated no (new )?comments/i.test(last.body ?? "") ? "clean" : "done";
};
export const reviewed = (state) => state === "done" || state === "clean";

// Per PR number: `asked` = Copilot is among the pending review requests (it is reviewing), `me` = my review is
// requested, `urls` = unresolved Copilot threads as their first comments' URLs (a thread is Copilot's by its first
// comment); one GraphQL call per repo. `ok` is false when the call failed, `viewer` is my login.
// ponytail: first 50 PRs × 100 threads; a failed call leaves the map empty (the row falls back to gh's fields).
// ponytail: a request to a team I'm in doesn't count as mine; add `... on Team{members}` if that's wanted.
export async function copilotGql(repo, numbers, cwd, on) {
  const out = new Map(), [owner, name] = repo.split("/");
  if (!numbers.length) return out;
  const prs = numbers.slice(0, 50).map((n) => `p${n}:pullRequest(number:${n}){reviewRequests(first:20){nodes{requestedReviewer{... on Bot{login} ... on User{login}}}} reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} url}}}}}`).join(" ");
  const r = await exec("gh", ["api", "graphql", "-f", `query={viewer{login} repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){${prs}}}`], { cwd, on, timeout: 60000 }).catch(() => null);
  try {
    const data = JSON.parse(r.stdout).data;
    out.ok = Boolean(data.repository);
    out.viewer = data.viewer?.login; // my login: whose PRs get the Copilot toast in the "All" list
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
