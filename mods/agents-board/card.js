// Copy of lib/card.js (agents-copy, agents-board): edit lib/card.js, then run scripts/sync-lib.
// Pieces of an agent card: time in state, program icon, status glyph, PR colours and filters.
import { div, svg, image } from "gpui-kit";

// The PR filter's choices; "failing" means the head commit's checks fail.
export const PR_FILTERS = [
  { id: "any", label: "Any" },
  { id: "with", label: "Has PR" },
  { id: "failing", label: "Checks failing" },
  { id: "none", label: "No PR" },
];

// A PR chip's colour by its checks state (prs.js: fail | pass | pending | none).
export const prColor = (t) => ({ fail: t.blocked, pass: t.done, pending: t.working, none: t.muted });

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
export function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The card's status glyph: spinner (working), pulsing "?" (blocked), check (unseen done), nothing (idle).
// dir: the mod's own folder ("mods/<name>/") holding spinner.svg and check.svg.
export function glyph(t, status, dir) {
  if (status === "working") return svg(dir + "spinner.svg").size(13).flex_none().text_color(t.working).spin(900);
  if (status === "blocked") return div().flex_none().size(16).rounded(8).bg(t.blocked).text_color(t.background).text_size(11).font_bold().flex().items_center().justify_center().loop("opacity", { from: 1, to: 0.55, period: 1400 }).child("?");
  // Unread: a check in an accent circle (same size as the "?"), the only mark that sets it apart from a seen card.
  if (status === "done") return div().flex_none().size(16).rounded(8).bg(t.accent).text_color(t.background).flex().items_center().justify_center().tooltip("Finished, not seen yet").child(svg(dir + "check.svg").size(11));
  return null;
}
