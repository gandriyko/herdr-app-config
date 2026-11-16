// Pure parsers for replying from the board: they read the plain text of `hc read <address>`.
// No state here; the view keeps only the parsed result (suggestion, options), never the screen.

import { FOOTER, isAsking } from "./asking.js";

const BORDER = /^\s*[─━]{10,}\s*$/;
const OPTION = /^\s*[❯>]?\s*(\d{1,2})\.\s+(\S.*?)\s*$/;
const PROMPT = /^\s*[❯>]\s?(.*)$/;
const MENU_LINES = 14;
const MAX_OPTIONS = 12;
const TAB_MARK = /[☐✔☑■✓]/;
const FREE_TEXT = /^(?:type something|other)\b[.…]*$/i;
const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.+?)\s*$/;
const MAX_FOOTER_TAIL = 8;

const isTabBar = (l) => TAB_MARK.test(l) && /[←→]/.test(l);

// "←  ☐ A  ☐ B  ✔ Submit  →" -> [{ label, done }].
function parseTabs(line) {
  return line
    .replace(/[←→]/g, " ")
    .split(/(?=[☐✔☑■✓])/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ label: p.slice(1).trim(), done: p[0] !== "☐" }))
    .filter((t) => t.label);
}

// A menu found by its footer ("Enter to select/confirm", "Esc to cancel"): scans upward over option lines,
// their indented descriptions, blank lines and rules, up to the question or the tab bar.
// -> { options } or null.
function findMenu(lines) {
  const footer = lines.findLastIndex((l) => FOOTER.test(l));
  if (footer < 1) return null;
  if (lines.slice(footer + 1).filter((l) => l.trim()).length > MAX_FOOTER_TAIL) return null;
  const options = [];
  let pending = [];
  for (let i = footer - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.trim() || BORDER.test(l)) continue;
    if (isTabBar(l)) break;
    const m = OPTION_RE.exec(l);
    if (m) {
      options.unshift({ n: Number(m[1]), label: m[2], desc: pending.join(" "), freeText: FREE_TEXT.test(m[2]) });
      pending = [];
      continue;
    }
    if (/^\s{4,}/.test(l) && options.length) {
      pending.unshift(l.trim());
      continue;
    }
    break;
  }
  if (options.length < 2 || options[0].n !== 1 || options.some((o, i) => o.n !== i + 1)) return null;
  return { options: options.slice(0, MAX_OPTIONS) };
}

// True for the picker where a digit only moves the cursor and Enter selects ("Enter to select").
export const isSelectMenu = (text) => Boolean(text) && /Enter to select/.test(text);

// The two border lines around the input box, counted from the bottom: [upper, lower] or fewer.
function boxBorders(lines) {
  const found = [];
  for (let i = lines.length - 1; i >= 0 && found.length < 2; i--) if (BORDER.test(lines[i])) found.push(i);
  return found.reverse();
}

// The numbered options of a choice menu drawn above the input box (or at the screen bottom): [{ n, label }].
// Empty when the screen shows no menu. Only the last run of options counts, and it must start at 1.
export function parseOptions(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const menu = findMenu(lines);
  if (menu) return menu.options;
  if (!isAsking(text)) return [];
  const b = boxBorders(lines);
  const end = b.length ? b[0] : lines.length;
  const near = lines.slice(0, end).filter((l) => l.trim()).slice(-MENU_LINES);
  let run = [];
  for (const l of near) {
    const m = OPTION.exec(l);
    if (m) {
      const n = Number(m[1]);
      if (n === 1) run = [];
      if (n === run.length + 1) run.push({ n, label: m[2], desc: "", freeText: FREE_TEXT.test(m[2]) });
    }
  }
  return run.length >= 2 ? run.slice(0, MAX_OPTIONS) : [];
}

// The text on the input line between the two border rules: Claude's gray suggestion, or a draft the
// person typed (plain text cannot tell them apart). null when empty.
export function parseSuggestion(text) {
  if (!text) return null;
  const lines = text.split("\n");
  const b = boxBorders(lines);
  if (b.length !== 2) return null;
  for (let i = b[0] + 1; i < b[1]; i++) {
    const m = PROMPT.exec(lines[i]);
    if (m) {
      const s = m[1].replace(/ /g, " ").trim();
      return s && !/^[❯>]$/.test(s) ? s : null;
    }
  }
  return null;
}

// True when `a` and `b` show the same menu (same numbers and labels).
export const sameOptions = (a, b) => a.length === b.length && a.every((o, i) => o.n === b[i].n && o.label === b[i].label);

const MARK = /^\s*[⏺●]\s?/;
const STATUS = /^\s*[✻✶✳✢·*]\s.*\bdone\b/i;
const BOX_CHARS = /[─━│┃┌┐└┘├┤┬┴┼╭╮╰╯═║]/g;
const QUESTION_LINES = 60;
const QUESTION_CHARS = 8000;

const clean = (l) => l.replace(BOX_CHARS, "").replace(/ /g, " ").trimEnd();

// What the agent is asking: a choice menu's heading and description (the lines between the rule above
// the menu and its first option), else the agent's last reply (after the last ⏺/● line, up to the
// status line or the input-box rule). Capped to the end of the text. "" when nothing is found.
export function parseQuestion(text) {
  if (!text) return { question: "" };
  const lines = text.split("\n");
  const b = boxBorders(lines);
  const end = b.length ? b[0] : lines.length;
  let out = [];
  let first = -1;
  let tabs = null;
  // A menu shows its own footer ("Esc to cancel", "Enter to select"); its first option sits right above it.
  const footer = lines.findLastIndex((l) => FOOTER.test(l));
  if (footer > 0 || isAsking(text)) {
    for (let i = (footer > 0 ? footer : lines.length) - 1; i >= Math.max(0, lines.length - 40); i--) {
      const m = OPTION.exec(lines[i]);
      if (m && Number(m[1]) === 1) {
        first = i;
        break;
      }
    }
  }
  if (first > 0) {
    let top = first - 1;
    while (top >= 0 && !BORDER.test(lines[top]) && !isTabBar(lines[top])) top--;
    if (top >= 0 && isTabBar(lines[top])) tabs = parseTabs(lines[top]);
    out = lines.slice(top + 1, first).map(clean);
  } else {
    let start = -1;
    for (let i = end - 1; i >= 0; i--) {
      if (MARK.test(lines[i])) {
        start = i;
        break;
      }
    }
    if (start >= 0) {
      let stop = start + 1;
      while (stop < end && !STATUS.test(lines[stop]) && !BORDER.test(lines[stop]) && !MARK.test(lines[stop])) stop++;
      out = lines.slice(start, stop).map((l, i) => clean(i === 0 ? l.replace(MARK, "") : l));
    }
  }
  out = out.map((l) => l.trim() === "" ? "" : l.trim());
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  let cut = out.length > QUESTION_LINES;
  let s = out.slice(-QUESTION_LINES).join("\n");
  if (s.length > QUESTION_CHARS) {
    s = s.slice(-QUESTION_CHARS);
    cut = true;
  }
  s = cut ? "…" + s : s;
  if (first <= 0) return { question: s };
  const nl = s.indexOf("\n");
  return { tabs, question: nl < 0 ? s : s.slice(0, nl).trim(), detail: nl < 0 ? "" : s.slice(nl + 1).trim() };
}
