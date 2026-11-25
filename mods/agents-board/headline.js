// An agent card's two texts, by one rule for the agents and agents-board mods.
// head: the tab's name when it was given one (not the program's name or key), else the agent's
// report or title. report: that report or title only when it says more than head. When one starts
// with the other (a tab name cut with "…") they become one: the longer text, as head. A Jira key
// that head starts with is dropped from report; the key the Jira chip shows is dropped from both.
// Inputs: tab (named tab's name or ""), text (report or title, cleaned), prog/progKey (program name
// and key), jiraKey (the chip's key or null). Both outputs may be "".
const KEY = /^[A-Z][A-Z0-9]+-\d+\b/;
const norm = (s) => s.toLowerCase().replace(/(…|\.\.\.)$/, "").trim();
// The text without a leading Jira key (and the separator after it); for any other text the chip repeats.
export const dropKey = (s, key) => (key && s.startsWith(key) ? s.slice(key.length).replace(/^[\s:\u2014-]+/, "") : s);

export function headline({ tab = "", text = "", prog = "", progKey = "", jiraKey = null }) {
  const isProg = (s) => [prog, progKey].some((p) => p && norm(s) === norm(p));
  tab = isProg(tab) ? "" : tab.trim();
  let report = isProg(text) ? "" : text.trim();
  let head = tab || report;
  if (head === report) report = "";
  else if (report) {
    const h = norm(head), r = norm(report);
    if (r.startsWith(h) || h.startsWith(r)) { head = r.length > h.length ? report : head; report = ""; }
    else report = dropKey(report, KEY.exec(head)?.[0]);
  }
  return { head: dropKey(head, jiraKey), report: dropKey(report, jiraKey) };
}
