import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, InputState, Input } from "gpui-base";
import { exec, home, theme, spaces, panes, run, notify, props, closeOverlay } from "herdr";

// Past agent sessions (Claude, Codex, OpenCode, ...) from human-history (`human-history`, github.com/gandriyko/human-history).
// Typing searches prompts and answers; an empty query lists the latest sessions. Results are limited to the
// active space's project (git repo, all its worktrees). Click opens the conversation as Markdown, with
// Resume (a new tab in the session's folder); right-click copies the session id.
const LIMIT = 50;
const PAGE = 30; // messages rendered per "Show more": long sessions have hundreds

// How each agent reopens a session: human-history's own table (src/resume.rs, resume_argv).
// ponytail: a Hermes session from a profile database also needs `-p <profile>`; add it if one shows up.
const RESUME = {
  claude: (id) => ["claude", "--resume", id],
  codex: (id) => ["codex", "resume", id],
  opencode: (id) => ["opencode", "--session", id],
  copilot: (id) => ["copilot", `--resume=${id}`], // the value is optional: `--resume <id>` may not bind
  pi: (id) => ["pi", "--session", id],
  hermes: (id) => ["hermes", "--resume", id, "--no-restore-cwd"],
};
const BIN = "human-history"; // the human-history CLI binary (src/cli.rs: name = "human-history")
// Herdr started from the Dock/Finder has a short PATH without ~/.cargo/bin, where `cargo install` puts it.
const CARGO_BIN = "/.cargo/bin/" + BIN;
const REPO ="https://github.com/gandriyko/human-history";
const INSTALL = `cargo install --git ${REPO}`; // README: built from source, needs a Rust toolchain
const SAFE_ID =/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // as human-history: never an option-looking id in argv

// The agent's logo, copied from Herdr's icons/ (LobeHub, Lucide; see icons/LICENSES.md there). Claude and Codex
// keep their colors; the rest are one-color glyphs tinted with the text color (pi's is white, so never as-is).
const COLOR_ICONS = new Set(["claude", "codex"]);
const TINT_ICONS = new Set(["opencode", "copilot", "pi", "hermes"]);
const agentIcon = (agent, size) => COLOR_ICONS.has(agent) ? image(`mods/history/icons/agents/${agent}.svg`).size(size)
  : svg(`mods/history/icons/agents/${TINT_ICONS.has(agent) ? agent : "agent"}.svg`).size(size);

async function resume(s) {
  const argv = RESUME[s.agent]?.(s.session_id);
  if (!argv || !SAFE_ID.test(s.session_id)) {
    notify({ title: "Can't resume", body: `${s.agent} session ${s.session_id}`, level: "error" });
    return false;
  }
  // The session's own folder, so the agent finds its history; the active space keeps it with this project.
  let folder = s.cwd || null;
  // A removed worktree leaves sessions whose folder is gone (tab.new then fails with "cannot start /bin/zsh"):
  // resume in the main checkout of the active space's repo instead.
  if (folder && !(await ok("test", ["-d", folder]))) {
    const moved = await mainCheckout();
    if (!moved) {
      notify({ title: "Can't resume: folder is gone", body: folder, level: "error" });
      return false;
    }
    // Claude looks a session up only under its folder's project dir (~/.claude/projects/<path, non-alnum → "-">),
    // so copy the conversation there; other agents find a session by id from anywhere.
    // ponytail: ignores CLAUDE_CONFIG_DIR; subagent transcripts (<id>/) are not copied.
    if (s.agent === "claude" && !(await ok("/bin/sh", ["-c",
      'src=$(ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n 1); [ -n "$src" ] || exit 1; ' +
      'dst="$HOME/.claude/projects/$2"; mkdir -p "$dst" && { [ -e "$dst/$1.jsonl" ] || cp "$src" "$dst/"; }',
      "sh", s.session_id, moved.replace(/[^A-Za-z0-9]/g, "-")]))) {
      notify({ title: "Can't resume: conversation file not found", body: `claude session ${s.session_id}`, level: "error" });
      return false;
    }
    notify({ title: "Resumed in the main checkout", body: `${folder} is gone; opened in ${moved}. Its uncommitted changes are lost.` });
    folder = moved;
  }
  // Named after the session: an unnamed tab shows its number until the agent sets a terminal title, if ever.
  const t = (s.title ?? "").trim().replace(/\s+/g, " ");
  const name = t.length > 40 ? t.slice(0, 40).replace(/\s+\S*$/, "") + "…" : t;
  run("tab.new", { argv, ...(name ? { name } : {}), ...(folder ? { folder } : {}) });
  // Opened as a dialog (e.g. the jira mod's "Find in history"): the new tab is what the user wanted, so get out of its way.
  if (props()?.overlay) closeOverlay(props().overlay);
  return true;
}

// ---- AI mode: Claude Code answers a question about past sessions through `human-history mcp` ----
// No built-in tools (--tools ""), only these MCP tools (query: read-only SQL over the index, enforced by human-history),
// and no user settings (--setting-sources ""): no hooks or CLAUDE.md, so a question costs cents, not dimes.
const AI_TOOLS = ["mcp__human-history__search_sessions", "mcp__human-history__read_session", "mcp__human-history__query"];
const AI_SESSIONS = 8; // sessions listed under an answer
const AI_TIMEOUT = 600000;
const aiPrompt = (q, where) => [
  "Answer the user's question about their past conversations with coding agents, using the human-history tools.",
  where ? `The user is working in ${where}. Search this project first (search_sessions with project_dir="${where}", ` +
    "or sessions.repo / sessions.cwd in query); other projects only when the question asks for them." : null,
  `Today is ${new Date().toISOString().slice(0, 10)}.`,
  "Use query for what plain search can't do: FTS5 OR, NEAR, word-form prefixes (word*), counts, dates. " +
    "Read a session with read_session before you quote it.",
  "Answer briefly, in Markdown, in the language of the question. Name the sessions you rely on.",
  `End with one line exactly: SESSIONS: <session_id> <session_id> ... (full ids, at most ${AI_SESSIONS}, most relevant first; ` +
    "only \"SESSIONS:\" when none).",
  "",
  `Question: ${q}`,
].filter((l) => l !== null).join("\n");
// claude with stdin closed (else -p waits 3 s for piped input). Herdr started from the Dock has a short PATH, so
// a claude that isn't on it is run through the interactive shell, as lib/ai.js does (fish keeps its own syntax).
const NO_STDIN = 'exec "$0" "$@" </dev/null';
const VIA_SHELL = `case "\${SHELL##*/}" in fish) exec "$SHELL" -ic '$argv </dev/null' "$0" "$@" ;; *) exec "\${SHELL:-/bin/sh}" -ic '"$0" "$@" </dev/null' "$0" "$@" ;; esac`;
async function runClaude(args, cwd) {
  const r = await exec("/bin/sh", ["-c", NO_STDIN, "claude", ...args], { cwd, timeout: AI_TIMEOUT });
  if (r.code !== 127) return r;
  const s = await exec("/bin/sh", ["-c", VIA_SHELL, "claude", ...args], { cwd, timeout: AI_TIMEOUT });
  if (s.code === 127) throw new Error("`claude` isn't installed (not even in your interactive shell): AI mode runs Claude Code");
  return s;
}

const ok = async (cmd, args) =>(await exec(cmd, args, { timeout: 5000 }).catch(() => ({ code: 1 }))).code === 0;

// The active space's repo, its main worktree (the parent of the shared .git dir); else the active folder.
async function mainCheckout() {
  const at = place();
  if (!at) return null;
  const r = await exec("git", ["-C", at, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 }).catch(() => null);
  const git = r?.code === 0 ? r.stdout.trim() : "";
  return git.endsWith("/.git") ? git.slice(0, -5) : at;
}

// Where the active space works now: its focused terminal's folder, else the first known one (as tabs-copy).
// ponytail: a space on another machine still searches this machine's history with its remote path.
// props().folder (a block in another mod's dialog, e.g. jira's Start session) pins it to that folder instead.
function place() {
  if (props()?.folder) return props().folder;
  const sp = spaces().find((p) => p.active), ps = panes();
  const tabs = new Set((sp?.tabs ?? []).map((c) => c.id));
  return ps.find((p) => p.focused && tabs.has(p.tab))?.cwd ?? ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? sp?.folder ?? null;
}

// How long ago, for the list: "<1m", "40m", "5h" within a day, else "3d".
const ago = (iso) => {
  const min = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 1 ? "<1m" : min < 60 ? `${min}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
};

// Local time: today as "13:04", else "2026-10-20" (or "2026-10-20 13:04" with `time`).
const day = (iso, time = false) => {
  const d = new Date(iso), pad = (n) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${date} ${hm}` : date;
};

export default class History extends View {
  init(_props, cx) {
    this.bin = BIN; this.found = false;
    this.results = []; this.error = null; this.loading = false; this.seq = 0;
    this.open = null; // { session, messages, shown, error }
    // human-history -s: titles only, or prompts + answers; "ai": a question for Claude instead of a search.
    const scope = localStorage.getItem("scope");
    this.scope = scope === "title" || scope === "ai" ? scope : "both";
    this.ai = null; this.aiSeq = 0; // { q, loading, answer, sessions, error, cost, turns } of the last question
    this.question = InputState.new({ placeholder: "Ask about past sessions, press Enter" });
    this.question.on("submit", (_e, cx) => this.ask(cx));
    this.where = undefined; // the folder the results were asked for; render re-asks when the space moves
    // Opened as a dialog with props().query (the jira mod passes a task key): start with that search.
    this.search = InputState.new({ value: String(props()?.query ?? ""), placeholder: "Search sessions" });
    this.search.on("change", (_e, cx) => {
      const seq = ++this.seq;
      cx.timer.after(250, (cx) => { if (seq === this.seq) this.find(cx); });
    });
    this.search.on("submit", (_e, cx) => this.find(cx));
    this.reindex(cx);
    cx.timer.every(5 * 60 * 1000, (cx) => this.reindex(cx));
    // Another space (or its terminal moved to another folder): search there. Not from render():
    // a task spawned with render's cx never ran, which left the spinner on until the next re-index.
    // ponytail: a 2 s string compare, no exec; nothing to subscribe to for "the place changed".
    // Each tick copies spaces/panes from the host, so not every 500 ms.
    cx.timer.every(2000, (cx) => { if (!this.missing && place() !== this.where) this.find(cx); });
  }

  // PATH first, then ~/.cargo/bin; this.bin is what every call runs, this.found says one of them exists.
  async locate() {
    const test = async (sh) => (await exec("/bin/sh", ["-c", sh]).catch(() => ({ code: 1 }))).code === 0;
    this.found = true;
    // this.binPath: the full path, for the MCP server claude starts (its PATH may differ from ours).
    const r = await exec("/bin/sh", ["-c", `command -v ${BIN}`]).catch(() => null);
    if (r?.code === 0) { this.bin = BIN; this.binPath = r.stdout.trim(); return; }
    const path = home() + CARGO_BIN;
    if (await test(`test -x '${path}'`)) { this.bin = this.binPath = path; return; }
    this.bin = this.binPath = BIN; this.found = false;
  }

  reindex(cx) {
    if (this.indexing) return; // one human-history index at a time: clicks or the timer while one runs wait for it
    this.indexing = true; this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      // exec rejects when human-history can't start (or times out); `command -v` tells "not installed" apart.
      await this.locate();
      const r = await exec(this.bin, ["index"], { timeout: 120000 }).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      this.indexing = false;
      this.missing = r.code === -1 && !this.found;
      if (this.missing || r.code !== 0) {
        this.error = this.missing ? null : `human-history index: ${(r.stderr || r.stdout).trim()}`;
        this.results = []; this.loading = false; cx.notify(); return;
      }
      this.find(cx);
    });
  }

  find(cx) {
    // AI mode searches only on Enter (ask); keep the folder current for the project line and the next question.
    if (this.scope === "ai") {
      const where = place();
      if (where !== this.where) { this.where = where; cx.notify(); }
      return;
    }
    const seq = ++this.seq, query = this.search.value().trim();
    // Never global: human-history -f repository takes the project (git repo, all its worktrees; else that folder)
    // from its working directory, the active space's folder. No folder: nothing to search.
    const where = place();
    // Another project: never leave the old one's sessions under the new folder while this one loads.
    if (where !== this.where) this.results = [];
    this.where = where;
    if (this.missing) return; // the install hint stays until refresh finds human-history
    if (!where) { this.results = []; this.error = null; this.loading = false; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      cx.notify();
      try {
        // human-history takes the project from HH_CWD before its working directory (cli.rs cwd()); the human-history Herdr
        // plugin sets HH_CWD, so a stray one would pick another project. Set it to ours.
        const r = await exec("/usr/bin/env", [`HH_CWD=${where}`, this.bin, "search", query, "--json", "-s", this.scope, "-f", "repository", "--limit", String(LIMIT)], { cwd: where, timeout: 120000 });
        if (seq !== this.seq) return; // a newer query is on its way
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        this.results = JSON.parse(r.stdout); this.error = null;
      } catch (e) {
        if (seq === this.seq) { this.error = String(e.message ?? e); this.results = []; }
      } finally {
        if (seq === this.seq) { this.loading = false; cx.notify(); }
      }
    });
  }

  // AI mode: Claude answers the question with the human-history MCP tools; the sessions it names (last line
  // "SESSIONS: <id> ...") are listed under the answer, opened like search results. A newer question wins.
  // ponytail: an older claude still runs to its end (exec can't be cancelled); only its answer is dropped.
  ask(cx) {
    const q = this.question.value().trim(), where = place();
    if (!q || this.missing) return;
    const seq = ++this.aiSeq;
    const ai = this.ai = { q, loading: true, answer: "", sessions: [], error: null };
    this.open = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const mcp = JSON.stringify({ mcpServers: { "human-history": { command: this.binPath || this.bin, args: ["mcp"] } } });
        const r = await runClaude(["-p", aiPrompt(q, where), "--mcp-config", mcp, "--strict-mcp-config", "--tools", "",
          "--setting-sources", "", "--output-format", "json", "--allowedTools", ...AI_TOOLS], where || home());
        if (seq !== this.aiSeq) return;
        let out;
        try { out = JSON.parse(r.stdout); } catch { throw new Error((r.stderr || r.stdout || "claude gave no answer").trim().slice(-300)); }
        if (out.is_error || r.code !== 0) throw new Error(String(out.result || r.stderr || "claude failed").trim().slice(0, 300));
        const text = String(out.result ?? "").trim();
        const m = text.match(/^\s*SESSIONS:(.*)$/m);
        ai.answer = (m ? text.slice(0, m.index) : text).trim() || "(no answer)";
        ai.cost = out.total_cost_usd; ai.turns = out.num_turns;
        cx.notify();
        const ids = [...new Set((m?.[1] ?? "").split(/[\s,]+/).filter((id) => SAFE_ID.test(id)))].slice(0, AI_SESSIONS);
        for (const id of ids) {
          // Only the session row is kept; the messages `show` returns are dropped here.
          const s = await exec(this.bin, ["show", id, "--json"], { timeout: 30000 }).catch(() => null);
          if (seq !== this.aiSeq) return;
          try { if (s?.code === 0) ai.sessions.push(JSON.parse(s.stdout).session); } catch { /* a bad id: skip it */ }
        }
      } catch (e) {
        if (seq === this.aiSeq) ai.error = String(e.message ?? e);
      }
      if (seq === this.aiSeq) { ai.loading = false; cx.notify(); }
    });
  }

  aiView(t) {
    const ai = this.ai;
    if (!ai) return div().p(8).text_color(t.dim).child("Ask about past sessions in your own words and press Enter. "
      + "Claude searches the history (full text and SQL over the index) and answers with the sessions it used.");
    return v_flex().gap(6)
      .child(div().px(4).pt(2).text_size(11).text_color(t.muted).child(ai.q))
      .when(ai.loading && !ai.answer, (e) => e.child(h_flex().p(8).gap(6).items_center().text_color(t.dim)
        .child(svg("mods/history/icons/refresh.svg").size(12).spin(900)).child("Claude is searching the history…")))
      .when(Boolean(ai.error), (e) => e.child(div().p(8).text_color(t.ansi1).child(ai.error)))
      .when(Boolean(ai.answer), (e) => e.child(div().p(8).rounded(8).bg(t.raised).border_1().border_color(t.border)
        .child(TextView.markdown(`ai-answer-${this.aiSeq}`, ai.answer).selectable(true))))
      .when(ai.cost != null, (e) => e.child(div().px(4).text_size(10).text_color(t.dim)
        .child([`${ai.turns} turns`, `$${Number(ai.cost).toFixed(2)}`, ai.loading ? "loading sessions…" : null].filter(Boolean).join(" · "))))
      .children(ai.sessions.map((s) => this.row(s, t)));
  }

  show(session, cx) {
    this.open = { session, messages: [], shown: PAGE, loading: true };
    cx.notify();
    cx.spawn(async (cx) => {
      const open = this.open;
      try {
        // {"session": {...}, "messages": [{role: "user" | "assistant", ts, text}]}, text as the agent wrote it.
        const r = await exec(this.bin, ["show", session.session_id, "--json"], { timeout: 120000 });
        if (r.code !== 0) {
          const message = (r.stderr || r.stdout).trim();
          // human-history before `show --json` (human-history 33a0d84) rejects the flag.
          throw new Error(/--json/.test(message) ? `This human-history is too old for the panel: update it (${INSTALL})` : message);
        }
        open.messages = JSON.parse(r.stdout).messages.filter((m) => m.text?.trim());
      } catch (e) { open.error = String(e.message ?? e); }
      open.loading = false; cx.notify();
    });
  }

  // Favorite star, on every session: filled when it's a favorite (human-history lists those first), an outline
  // otherwise; a click toggles it. Its own mouse down stops there, so the row doesn't open.
  star(s, t, id) {
    return div().id(id).size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(s.favorite ? t.ansi3 : t.dim).hover((st) => st.bg(t.hover).text_color(t.ansi3))
      .tooltip(s.favorite ? "Remove from favorites" : "Add to favorites")
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggleFavorite(s, cx); })
      .child(svg(`mods/history/icons/${s.favorite ? "star" : "star-outline"}.svg`).size(12));
  }

  // human-history favorite / unfavorite (idempotent, exit 1 on no or an ambiguous match). The star flips at once;
  // a failure flips it back. Then the list is asked again: favorites move to the top.
  toggleFavorite(s, cx) {
    const want = !s.favorite;
    const set = (v) => { for (const x of [s, ...this.results, ...(this.ai?.sessions ?? []), this.open?.session]) if (x?.key === s.key) x.favorite = v; };
    set(want); cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec(this.bin, [want ? "favorite" : "unfavorite", s.session_id]).catch((e) => ({ code: -1, stderr: String(e.message ?? e) }));
      if (r.code !== 0) {
        set(!want);
        notify({ title: `Couldn't ${want ? "add to" : "remove from"} favorites`, body: (r.stderr || r.stdout || "").trim(), level: "error" });
      }
      this.find(cx);
    });
  }

  row(s, t) {
    const snippet = (s.snippet ?? "").replace(/\s+/g, " ").trim();
    const where = s.worktree ?? s.cwd ?? "";
    // Left: agent, title, snippet, details. Right: how long ago, the favorite star under it.
    return h_flex().id(`s-${s.key}`).flex_none().px(8).py(6).gap(8).items_start().rounded(6).cursor_pointer()
      .hover((st) => st.bg(t.hover)).tooltip(`${s.agent} · ${where}${s.branch ? ` · ${s.branch}` : ""}`)
      .on_mouse_down("left", (_e, cx) => this.show(s, cx))
      .on_mouse_down("right", (_e, cx) => cx.write_to_clipboard(s.session_id))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_none().text_color(t.muted).child(agentIcon(s.agent, 14)))
          .child(div().flex_1().min_w(0).truncate().child(s.title || "(untitled)")))
        // At most two lines of the snippet: gpui has no line_clamp, so cap the height.
        .when(Boolean(snippet), (e) => e.child(div().text_size(11).text_color(t.muted).max_h(31).overflow_hidden().child(snippet)))
        .child(div().text_size(10).text_color(t.dim).truncate()
          // The project is the panel's own (shown above the list), so only what differs per session.
          .child([s.branch, `${s.user_count}↔${s.assistant_count}`, s.hits ? `${s.hits} hits` : null].filter(Boolean).join(" · "))))
      .child(v_flex().flex_none().gap(2).items_end()
        .child(div().text_size(10).text_color(t.dim).tooltip(day(s.updated_at, true)).child(ago(s.updated_at)))
        .child(this.star(s, t, `star-${s.key}`)));
  }

  detail(t) {
    const { session: s, messages: list, shown } = this.open;
    const message = (m, i) => {
      const user = m.role === "user";
      return v_flex().flex_none().gap(4).p(8).rounded(8)
        .bg(user ? t.raised : t.background).border_1().border_color(t.border)
        .child(h_flex().gap(6).text_size(10)
          .child(div().font_semibold().text_color(user ? t.accent : t.muted).child(user ? "USER" : s.agent.toUpperCase()))
          .when(Boolean(m.ts), (e) => e.child(div().text_color(t.dim).child(day(m.ts, true)))))
        .child(TextView.markdown(`msg-${s.key}-${i}`, m.text.trim()).selectable(true));
    };
    return v_flex().gap(6)
      .child(v_flex().gap(2).px(2)
        .child(h_flex().gap(4).items_center()
          .child(this.star(s, t, "star-open"))
          .child(div().flex_1().min_w(0).font_semibold().text_size(13).child(s.title || "(untitled)")))
        .child(div().text_size(10).text_color(t.dim).child(`${s.agent} · ${s.cwd ?? ""}${s.branch ? ` · ${s.branch}` : ""} · ${day(s.updated_at)}`)))
      .when(this.open.loading, (e) => e.child(div().p(8).text_color(t.dim).child("Loading…")))
      .when(Boolean(this.open.error), (e) => e.child(div().p(8).text_color(t.ansi1).child(this.open.error)))
      .children(list.slice(0, shown).map(message))
      .when(list.length > shown, (e) => e.child(div().id("more").h(28).flex().items_center().justify_center().rounded(7).cursor_pointer()
        .bg(t.raised).hover((st) => st.bg(t.hover)).text_size(12)
        .on_click((_e, cx) => { this.open.shown += PAGE; cx.notify(); })
        .child(`Show more (${list.length - shown} left)`)));
  }

  // human-history isn't on PATH: where to get it. Refresh checks again after installing.
  installHint(t) {
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().items_center().justify_center().rounded(7).cursor_pointer().text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.9)).on_click(onClick).child(label);
    return v_flex().p(8).gap(8).text_color(t.muted)
      .child(div().text_color(t.foreground).font_semibold().child("human-history is not installed"))
      .child(div().child("This panel searches past agent sessions with the human-history command. Install it (needs a Rust toolchain from rustup.rs):"))
      .child(div().p(8).rounded(7).bg(t.raised).border_1().border_color(t.border)
        .child(TextView.markdown("install-cmd", "`" + INSTALL + "`").selectable(true)))
      .child(h_flex().gap(6)
        .child(button("open-repo", "Open repository", true, () => exec("open", [REPO])))
        .child(button("copy-install", "Copy command", false, (_e, cx) => cx.write_to_clipboard(INSTALL))))
      .child(div().text_size(11).text_color(t.dim).child("Then press the refresh button above to look for human-history again."));
  }

  render(cx) {
    const t = theme(), open = this.open;
    // Header icon button, the PR panel's look; `spin` turns the icon while loading.
    const iconButton = (id, icon, tip, onClick, spin = false) => div().id(id).size(24).flex().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick)
      .child(svg(`mods/history/icons/${icon}.svg`).size(14).when(spin, (s) => s.spin(900)));
    // Icon toggle, the same look as the Changes panel's (changes-copy segment()).
    const iconSegment = (key, options) => h_flex().flex_none().rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(options.map(([value, icon, tip]) => div().id(`${key}-${value}`).w(26).h(20).flex().items_center().justify_center().cursor_pointer().tooltip(tip)
        .text_color(this[key] === value ? t.foreground : t.muted)
        .when(this[key] === value, (e) => e.bg(t.selected)).when(this[key] !== value, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { if (this[key] === value) return; this[key] = value; localStorage.setItem(key, value); this.find(cx); cx.notify(); })
        .child(svg(`mods/history/icons/${icon}.svg`).size(13))));
    const aiMode = this.scope === "ai";
    const empty = aiMode ? null : this.error ?? (!this.where ? "No project folder in this space"
      : !this.results.length ? (this.loading ? "Loading…" : "No sessions found") : null);
    // props().embedded: a block inside another mod's dialog (jira's Start session), so no frame of its own, only a top rule.
    const embedded = Boolean(props()?.embedded);
    return v_flex().id("history").size_full().min_h(0).overflow_hidden().bg(t.background).border_color(t.border).text_color(t.foreground).text_size(12)
      .when(embedded, (e) => e.border_t(1)).when(!embedded, (e) => e.rounded(10).border_1())
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(open), (e) => e.child(iconButton("back", "back", "Back to results", (_e, cx) => { this.open = null; cx.notify(); })))
        .child(div().font_semibold().text_size(13).child("History"))
        .when(!open, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(String(aiMode ? this.ai?.sessions.length ?? 0 : this.results.length))))
        .child(div().flex_1())
        .when(Boolean(open), (e) => e
          .child(iconButton("copy-id", "copy", "Copy the session id", (_e, cx) => cx.write_to_clipboard(open.session.session_id)))
          .when(Boolean(RESUME[open.session.agent]), (e) => e.child(div().id("resume").h(24).px(10).flex().items_center().rounded(6).cursor_pointer()
            .bg(t.solid).text_color(t.solid_foreground).hover((s) => s.opacity(0.9))
            .tooltip(`Resume in a new tab: ${RESUME[open.session.agent](open.session.session_id).join(" ")}`)
            .on_click(async (_e, cx) => {
              // Resumed: back to the plain list, search cleared (set_value fires "change", which asks again).
              if (!(await resume(open.session))) return;
              this.open = null; this.search.set_value(""); this.find(cx); cx.notify();
            }).child("Resume"))))
        .when(!open, (e) => e.child(iconButton("refresh", "refresh", "Re-index and search again", (_e, cx) => this.reindex(cx), this.loading))))
      .when(!open, (e) => e.child(h_flex().flex_none().px(8).pt(8).gap(6).items_center()
        .child(div().id("search").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(aiMode ? this.question : this.search).h_full().text_size(12).text_color(t.foreground)))
        .child(iconSegment("scope", [
          ["both", "messages", "Search prompts and answers"],
          ["title", "title", "Search session titles only"],
          ["ai", "sparkles", "Ask Claude about past sessions (Enter sends the question)"]]))))
      .when(!open && Boolean(this.where), (e) => e.child(div().flex_none().px(10).pt(6).truncate().text_size(11).text_color(t.dim)
        .child(this.where.replace(/^\/Users\/[^/]+/, "~"))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(open ? `session-${open.session.key}` : "results").absolute().inset_0().overflow_y_scroll().p(6).gap(2)
          .when(Boolean(open), (e) => e.child(this.detail(t)))
          .when(!open && this.missing, (e) => e.child(this.installHint(t)))
          .when(!open && !this.missing && Boolean(empty), (e) => e.child(div().p(8).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(!open && !this.missing && aiMode, (e) => e.child(this.aiView(t)))
          .when(!open && !aiMode, (e) => e.children(this.results.map((s) => this.row(s, t)))))
        .child(Scrollbar.vertical(open ? `session-${open.session.key}` : "results").absolute().inset_0()));
  }
}
