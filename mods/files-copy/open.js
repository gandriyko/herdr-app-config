// Opening a file in the space's file tab, shared by the panel (main.js pick) and the terminal link handler (link.js).
import { spaces, panes, run, shared, setShared } from "herdr";

export const REQUEST = "files-copy.open"; // { space, root, on, path, line?, col?, ts, from }: written here, read by the tab
export const PLACE = "files-copy.place"; // "tab" | "pane": the viewer's last tab ⇄ pane move, used for the next new viewer

// One file tab per space: an existing one gets the request through shared state, else a new tab (or a pane beside
// the `from` tab's terminal when the last move was to a pane) gets it as props.
export function openFile(req) {
  const space = spaces().find(s => s.id === req.space);
  const ids = new Set((space?.tabs ?? []).map(t => t.id));
  const existing = panes().find(p => p.mod === "files-copy" && ids.has(p.tab));
  const name = req.path.split("/").pop();
  setShared(REQUEST, req);
  if (existing) {
    run("tab.select", { id: existing.tab });
    // A viewer pane beside terminals: their tab keeps its name.
    if (!panes().some(p => p.tab === existing.tab && p.pane !== existing.pane)) run("tab.rename", { id: existing.tab, name });
    return;
  }
  const terms = shared(PLACE) === "pane" ? panes().filter(p => p.tab === req.from && p.terminal) : [];
  const target = terms.find(p => p.focused) ?? terms[0];
  if (target) run("pane.split", { pane: target.pane, direction: "right", mod: "files-copy", props: req });
  else run("tab.new", { name, mod: "files-copy", props: req, space: space?.id ?? undefined });
}
