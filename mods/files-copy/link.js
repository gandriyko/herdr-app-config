// Cmd-click (Ctrl-click) on a file path in a terminal: a text file opens in the space's file tab, at `path:line:col`
// when given; a binary one with an extension (pictures, PDF, Office, archives, media) in its macOS app.
import { spaces, exec } from "herdr";
import { openFile } from "./open.js";

export async function handleLink({ link, source }) {
  // link.path is null for another machine's file; those, folders and missing files go to Herdr's usual opener.
  if (link.kind !== "file" || !link.path) return "pass";
  let path = link.path.replace(/:\d+(:\d+)?$/, "");
  if (!path.startsWith("/")) path = `${source.cwd}/${path}`;
  // "<type>; charset=<enc>": charset=binary for non-text content; an empty file (inode/x-empty) stays text.
  const mime = (await exec("file", ["-b", "--mime", path]).catch(() => null))?.stdout?.trim() ?? "";
  if (!mime.includes("charset=") || mime.startsWith("inode/directory")) return "pass";
  if (mime.endsWith("charset=binary") && !mime.startsWith("inode/x-empty")) {
    // macOS picks the app by the extension; a binary without one (an executable, a PDF named "invoice") is left to Herdr.
    if (!/\/[^/]*\.[A-Za-z0-9]+$/.test(path)) return "pass";
    await exec("open", [path]);
    return "handled";
  }
  const pos = /:(\d+)(?::(\d+))?\D*$/.exec(link.raw);
  // Root: the space's folder when the file is inside it (go-to-definition searches the project), else the terminal's cwd.
  const folder = spaces().find(s => s.id === source.space)?.folder;
  const root = [folder, source.cwd].find(r => r && path.startsWith(r + "/")) ?? path.replace(/\/[^/]*$/, "");
  openFile({
    space: source.space, root, on: null, path: path.slice(root.length + 1),
    line: pos ? Number(pos[1]) : null, col: pos?.[2] ? Number(pos[2]) : null, ts: Date.now(), from: source.tab,
  });
  return "handled";
}
