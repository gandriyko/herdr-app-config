// The last message on an agent's screen (plain text of `hc read`): the person's prompt (a `❯ ` line at
// column 0) or the agent's reply (a `⏺`/`●` block, tool calls like `⏺ Bash(…)` skipped), whichever is
// lower above the input box. Pure; used by the card hover preview.

const BORDER = /^\s*[─━]{10,}\s*$/;
const MARK = /^[⏺●] ?/;
const TOOL = /^[⏺●]\s*[A-Z][\w-]*\(/;
const PROMPT = /^[❯>] (?=\S)/;
const STOP = /^\s*[✻✶✳✢✽·*] /; // spinner / "done" status line
const MAX_LINES = 12;

// { who: "you" | "agent", text } or null.
export function lastMessage(text) {
  if (!text) return null;
  const lines = text.split("\n");
  // The input box is the last two borders; the transcript ends above the upper one.
  const borders = [];
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) if (BORDER.test(lines[i])) borders.push(i);
  const end = borders.length === 2 ? borders[1] : lines.length;
  let start = -1;
  let who = null;
  for (let i = end - 1; i >= 0; i--) {
    if (PROMPT.test(lines[i])) { start = i; who = "you"; break; }
    if (MARK.test(lines[i]) && !TOOL.test(lines[i])) { start = i; who = "agent"; break; }
  }
  if (start < 0) return null;
  let out = [lines[start].replace(who === "you" ? PROMPT : MARK, "")];
  for (let i = start + 1; i < end; i++) {
    const l = lines[i];
    if (MARK.test(l) || PROMPT.test(l) || STOP.test(l) || BORDER.test(l)) break;
    if (who === "you" && !l.trim()) break; // a prompt ends at its first blank line
    out.push(l);
  }
  out = out.map((l) => l.trim());
  while (out.length && !out[out.length - 1]) out.pop();
  const cut = out.length > MAX_LINES;
  out = out.slice(0, MAX_LINES);
  if (cut) out.push("…");
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return s ? { who, text: s } : null;
}
