// History tab: commits → files → diff, plus the commit context menu.
// Plain functions over the panel view instance (main.js owns the state).
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { openOverlay } from "herdr";
import { LOG_FORMAT, parseLog, parseNumstatZ } from "./lib/git.js";
import { relativeTime } from "./lib/format.js";
import { openMenu } from "./lib/popup-menu.js";

// Commits per page; one extra is asked for to know whether a next page exists.
export const PAGE = 50;
// The next page starts loading when the visible rows come this close to the end.
const PREFETCH = 8;
const ROW = { commit: 44, file: 24, more: 32 };

/** Reads the first page (fresh), or the next page after what is shown (`more`). */
export function loadHistory(view, cx, { more = false } = {}) {
  if (!view.root || view.historyLoading) return;
  if (!view.hasHead) { view.history = []; view.historyMore = false; view.historyHead = null; return; }
  const context = view.context, head = view.head, skip = more ? view.history.length : 0;
  view.historyLoading = true;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      // Paged from the HEAD the first page was read at, so a page never repeats or skips commits.
      const from = more && view.historyHead ? view.historyHead : "HEAD";
      const r = await view.gitRead(["log", "-n", String(PAGE + 1), `--skip=${skip}`, `--format=${LOG_FORMAT}`, from]);
      if (view.context !== context) return;
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
      const page = parseLog(r.stdout);
      view.historyMore = page.length > PAGE;
      const commits = page.slice(0, PAGE);
      view.history = more ? [...view.history, ...commits] : commits;
      if (!more) view.historyHead = head;
      if (view.histOpen && !view.history.some((c) => c.sha === view.histOpen)) {
        view.histOpen = null; view.historyFiles = []; view.histFile = null; view.setLines([]);
      }
      if (view.histOpen && !more) await loadCommitFiles(view, view.histOpen, context);
    } catch (e) {
      if (view.context === context) view.note = `History failed: ${view.brief(e?.message ?? e)}`;
    } finally {
      if (view.context === context) view.historyLoading = false;
      cx.notify();
    }
  });
}

async function loadCommitFiles(view, sha, context) {
  const r = await view.gitRead(["show", "--numstat", "-z", "--no-renames", "--format=", sha]);
  if (view.context !== context || view.histOpen !== sha) return;
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  view.historyFiles = parseNumstatZ(r.stdout);
}

/** Coming back to the tab: show the file diff that was open, without re-reading the log. */
export function restoreHistory(view, cx) {
  const commit = view.history.find((c) => c.sha === view.histOpen);
  const file = commit && view.historyFiles.find((f) => f.path === view.histFile);
  if (file) pickCommitFile(view, commit, file, cx);
}

export function toggleCommit(view, sha, cx) {
  if (view.histOpen === sha) {
    view.histOpen = null; view.historyFiles = []; view.histFile = null; view.setLines([]);
    cx.notify();
    return;
  }
  view.histOpen = sha; view.historyFiles = []; view.histFile = null; view.setLines([]);
  const context = view.context;
  cx.notify();
  cx.spawn(async (cx) => {
    try { await loadCommitFiles(view, sha, context); }
    catch (e) { if (view.context === context) view.note = `History failed: ${view.brief(e?.message ?? e)}`; }
    cx.notify();
  });
}

export function pickCommitFile(view, commit, file, cx) {
  view.histFile = file.path;
  view.setLines([]);
  const context = view.context;
  cx.spawn(async (cx) => {
    try {
      const r = await view.gitRead(["show", "--no-ext-diff", "--no-color", "--format=", commit.sha, "--", file.path]);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
      view.showDiff(r.stdout, () => view.context === context && view.tab === "history" && view.histFile === file.path);
    } catch (e) {
      if (view.context === context) view.note = `Cannot preview this diff: ${view.brief(e?.message ?? e)}`;
    }
    cx.notify();
  });
}

export function commitMenu(view, commit, cx) {
  if (view.busy) return;
  const root = view.root, on = view.on;
  const items = [
    { label: "Copy hash", icon: view.icon("copy"), action: { type: "copy", text: commit.sha } },
    { label: "Copy short hash", icon: view.icon("copy"), action: { type: "copy", text: commit.short } },
    { label: "Copy message", icon: view.icon("copy"), action: { type: "copy", text: commit.subject } },
  ];
  const newest = view.history[0]?.sha === commit.sha;
  const branch = view.branch;
  // Only the newest commit, only when it has a parent, and only while it is
  // ahead of (or not on) the upstream: never rewrite a pushed commit here.
  if (newest && view.history.length > 1 && (branch.ahead > 0 || !branch.upstream)) {
    items.push({ separator: true });
    items.push({
      label: "Undo commit (keep changes)", icon: view.icon("undo-2"), danger: true,
      action: {
        type: "many",
        actions: [
          { type: "exec", cmd: "git", args: ["reset", "--soft", "HEAD~1"], cwd: root, on },
          { type: "request", key: "ranch.changes.refresh-req", value: {} },
        ],
      },
    });
  }
  openMenu({ openOverlay, mod: "ranch-changes", items });
}

export function renderHistory(view, t, cx) {
  const rows = [];
  for (const commit of view.history) {
    rows.push({ kind: "commit", commit });
    if (view.histOpen === commit.sha) {
      for (const file of view.historyFiles) rows.push({ kind: "file", commit, file });
    }
  }
  if (view.historyMore) rows.push({ kind: "more" });
  const sizes = rows.map((row) => ROW[row.kind]);
  const empty = !view.root ? "No folder" : view.historyLoading ? "Loading history…" : !view.hasHead ? "No commits yet" : "No commits";
  const keyOf = (row) => row.kind === "commit" ? `c:${row.commit.sha}` : row.kind === "file" ? `f:${row.commit.sha}:${row.file.path}` : "more";
  const byKey = new Map(rows.map((row) => [keyOf(row), row]));

  return v_flex().flex_1().min_h(0).overflow_hidden()
    .child(div().flex_1().min_h(44).max_h(Math.max(ROW.commit, sizes.reduce((n, h) => n + h, 0)) + 12).relative().border_b(1).border_color(t.border)
      .when(rows.length > 0, (e) => e.child(div().id("history-scroll").absolute().inset_0().px(6).py(6)
        // Scroll pagination: the list only reports how far down it shows; a
        // scroll that reaches the last loaded commits reads the next page.
        .on_scroll_wheel((ev, cx) => {
          if (view.historyMore && view.histRangeEnd >= rows.length - PREFETCH) loadHistory(view, cx, { more: true });
        })
        // Rows are built during layout, where per-row handlers throw: one
        // handler for the list, keyed by row.
        .child(v_virtual_list("history-list", rows.length, sizes, (i) => keyOf(rows[i]), (range) => {
          view.histRangeEnd = range.end;
          return rows.slice(range.start, range.end).map((row) => row.kind === "commit" ? commitRow(view, t, row.commit)
            : row.kind === "more" ? moreRow(view, t) : commitFileRow(view, t, row.commit, row.file));
        }).size_full()
          .on_item_click((key, cx) => {
            const row = byKey.get(key);
            if (row?.kind === "commit") toggleCommit(view, row.commit.sha, cx);
            else if (row?.kind === "file") pickCommitFile(view, row.commit, row.file, cx);
          })
          .on_item_secondary_click((key, _ev, cx) => {
            const row = byKey.get(key);
            if (row?.kind === "commit") { cx.stop_propagation(); commitMenu(view, row.commit, cx); }
          }))))
      .when(!rows.length, (e) => e.child(div().p(14).text_color(t.dim).child(empty)))
      .child(Scrollbar.vertical("history-list").absolute().inset_0()))
    .child(view.diffArea(t, cx, view.histFile ? null : view.histOpen ? "Select a file to view its changes" : "Select a commit to view its files"));
}

function commitRow(view, t, commit) {
  const open = view.histOpen === commit.sha;
  return h_flex().h(44).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
    .when(open, (e) => e.bg(t.selected))
    .child(svg(view.icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().truncate().text_color(t.foreground).child(commit.subject))
      .child(div().text_size(11).text_color(t.dim).truncate()
        .child(`${commit.short} · ${commit.author} · ${relativeTime(Date.now() - commit.time)}`)));
}

function commitFileRow(view, t, commit, file) {
  const parts = file.path.split("/"), name = parts.pop();
  return h_flex().h(24).flex_none().pl(28).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
    .when(view.histFile === file.path, (e) => e.bg(t.selected))
    .child(h_flex().flex_1().min_w(0)
      .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
      .child(div().max_w(260).min_w(0).truncate().text_size(12).child(name)))
    .when(file.add === null && file.del === null, (e) => e.child(div().text_size(11).text_color(t.dim).child("binary")))
    .when(file.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
    .when(file.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${file.del}`)));
}

// The list's last row while a next page exists: a quiet loading line.
function moreRow(view, t) {
  return h_flex().h(ROW.more).flex_none().px(8).items_center().justify_center()
    .text_size(11).text_color(t.dim).child("Loading older commits…");
}
