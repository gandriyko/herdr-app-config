// Copy of lib/find.js (files-copy, wb-diff): edit lib/find.js, then run scripts/sync-lib.
// Find in a tab: the search box's query as a RegExp and its hits in a text.

export const FIND_CAP = 1000;
// The search as a global RegExp (null when q is empty or an invalid regular expression). o: { case, word, regex }.
export function findRegex(q, o) {
  if (!q) return null;
  try {
    let src = o.regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (o.word) src = `\\b(?:${src})\\b`;
    return new RegExp(src, "gm" + (o.case ? "" : "i"));
  } catch { return null; }
}
// Every hit of re in text as [start, end) pairs (at most FIND_CAP + 1: the extra one says "capped"); empty matches are skipped.
export function findAll(text, re) {
  const out = []; re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length <= FIND_CAP; m = re.exec(text)) {
    if (m[0] === "") re.lastIndex++; else out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
