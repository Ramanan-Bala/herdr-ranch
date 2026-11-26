// The Ranch Changes panel: staged / unstaged / conflict groups with stage,
// unstage and discard; a branch bar (switch/create, fetch, pull, push/publish);
// History (commits → files → diff) and Stashes tabs; and right-click menus.
// The same mod renders two popups: a context menu (props().menu) and the
// branch picker (props().branches), each as a separate copy.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, home, run, props, openOverlay, closeOverlay, shared, setShared, layout } from "herdr";
import {
  headerLabel, requestGate, STATUS_ARGS, parseStatusV2, parseBranches, STASH_FORMAT,
  parseStashList, commitPlan, branchNameError, fileActions, actionArgs,
} from "./model.js";
import { parseNumstatZ } from "./lib/git.js";
import { openMenu, renderMenu, runAction, menuKey, normalizeItems } from "./lib/popup-menu.js";
import { EdgeGrip } from "./lib/edge-grip.js";
import { VIEWER_KEY, stableLocation, viewerRequest } from "./lib/file-viewer.js";
import { diffRows, diffWidth, hunkLines } from "./lib/diff.js";
import { blockShown, PanelVisibility } from "./lib/panels.js";
import { loadHistory, renderHistory, restoreHistory } from "./history.js";
import { renderStashes, pickStash } from "./stashes.js";

// The last terminal location per space: a focused mod pane (the file viewer
// tab) has no folder, and must not re-root this panel (lib/file-viewer.js).
const lastLocation = new Map();
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return stableLocation({ cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id }, pane, lastLocation);
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const ICON = (name) => `mods/ranch-changes/icons/${name}.svg`;

// numstat rows keyed by path, with binary (null) counted as zero lines.
function statsMap(rows) {
  const map = {};
  for (const row of rows) map[row.path] = { add: row.add ?? 0, del: row.del ?? 0, binary: row.add === null };
  return map;
}
const withStats = (list, map) => list.map((entry) => ({ ...entry, ...(map[entry.path] ?? { add: 0, del: 0, binary: false }) }));

export default class Changes extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.menu ? "menu" : p.branches ? "branches" : "panel";
    this.handle = cx.focus_handle();
    if (this.mode === "menu") {
      this.active = -1;
      this.handle.focus();
      return;
    }
    if (this.mode === "branches") {
      this.initBranches(p, cx);
      return;
    }

    // No repo yet: the panel can be drawn (hidden) before its first read.
    this.root = null; this.on = null; this.context = null;
    this.staged = []; this.unstaged = []; this.conflicts = []; this.remotes = []; this.stashes = [];
    this.branch = { head: null, detached: false, upstream: null, ahead: 0, behind: 0 };
    this.history = []; this.histOpen = null; this.historyFiles = []; this.histFile = null; this.historyLoading = false;
    this.historyHead = null; this.historyMore = false;
    this.selected = null; this.selectedStash = null;
    this.tab = "changes"; this.tabByContext = new Map(); this.folded = new Set();
    this.hovered = null; this.hoverGroup = null; this.confirm = null; this.op = null;
    this.diffWidth = 0; this.message = ""; this.amend = false;
    this.gate = requestGate(); this.loading = 0; this.label = null;

    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });

    this.stashInput = InputState.new({ placeholder: "Stash message (optional)" });
    this.stashInput.on("submit", (_e, cx) => this.stash(cx));

    // Signals already handled before this copy started must not replay.
    const refresh = shared("ranch.changes.refresh");
    this.sig = {
      refresh: typeof refresh === "number" ? refresh : null,
      req: shared("ranch.changes.refresh-req")?.nonce ?? null,
      error: shared("ranch.changes.error")?.nonce ?? null,
      select: shared("ranch.changes.select")?.nonce ?? null,
    };

    // Closed (or another panel on top): no git reads; the first render after
    // it is shown again catches up at once (lib/panels.js).
    this.vis = new PanelVisibility(() => blockShown(layout(), { id: "changes", mod: "ranch-changes" }));
    this.refreshIfShown(cx);
    cx.timer.every(10000, (cx) => this.refreshIfShown(cx));
  }

  /** refresh() while the panel is on screen; otherwise remember it for the next show. */
  refreshIfShown(cx) {
    if (this.vis.check()) this.refresh(cx);
    else this.vis.skip();
  }

  brief(text) {
    return String(text ?? "").trim().split("\n").slice(0, 3).join("\n");
  }

  icon(name) {
    return ICON(name);
  }

  gitRead(args) {
    return exec("git", [...READ, ...args], { cwd: this.root, on: this.on });
  }

  // ---- branch picker popup ----

  initBranches(p, cx) {
    this.root = p.root; this.on = p.on ?? null;
    this.branches = []; this.filter = ""; this.at = 0; this.error = null;
    this.input = InputState.new({ placeholder: "Switch or create branch" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      this.error = null;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.chooseBranch(this.at, cx));
    this.input.focus();
    cx.timer.after(16, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", [...READ, "for-each-ref",
          "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(committerdate:unix)",
          "refs/heads", "refs/remotes"], { cwd: this.root, on: this.on });
        if (r.code !== 0) throw new Error(r.stderr || r.stdout);
        this.branches = parseBranches(r.stdout);
      } catch (e) {
        this.error = this.brief(e?.message ?? e);
      }
      cx.notify();
    });
  }

  branchRows() {
    const text = this.filter.trim();
    const local = new Set(this.branches.filter((b) => !b.remote).map((b) => b.name));
    const visible = (text ? this.branches.filter((b) => b.name.toLowerCase().includes(text.toLowerCase())) : this.branches)
      .map((b) => ({ ...b, create: false, invalid: null }));
    const rows = [];
    if (text && !local.has(text)) rows.push({ create: true, name: text, invalid: branchNameError(text) });
    return rows.concat(visible);
  }

  chooseBranch(index, cx) {
    const row = this.branchRows()[index];
    if (!row || row.invalid) return;
    let args;
    if (row.create) args = ["switch", "-c", row.name];
    else if (row.remote) {
      const local = row.name.slice(row.name.indexOf("/") + 1);
      args = this.branches.some((b) => !b.remote && b.name === local) ? ["switch", local] : ["switch", "--track", row.name];
    } else args = ["switch", row.name];
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: this.root, on: this.on });
        if (r.code !== 0) { this.error = this.brief(r.stderr || r.stdout); cx.notify(); return; }
        setShared("ranch.changes.refresh", Date.now());
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = this.brief(e?.message ?? e);
        cx.notify();
      }
    });
  }

  renderBranches(cx) {
    const t = theme(), rows = this.branchRows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const row = (r, i) => {
      if (r.create) {
        return h_flex().id(`branch-create-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7)
          .when(!r.invalid, (e) => e.cursor_pointer().on_click((_e, cx) => this.chooseBranch(i, cx)))
          .when(i === this.at, (e) => e.bg(t.hover))
          .child(svg(ICON("plus")).size(13).flex_none().text_color(r.invalid ? t.dim : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_color(r.invalid ? t.dim : t.foreground).child(`Create branch ‘${r.name}’`))
          .when(Boolean(r.invalid), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(r.invalid)));
      }
      return h_flex().id(`branch-row-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (e) => e.bg(t.hover))
        .on_click((_e, cx) => this.chooseBranch(i, cx))
        .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
        .child(svg(ICON("git-branch")).size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().when(r.remote, (e) => e.text_color(t.dim)).child(r.name))
        .when(r.current, (e) => e.child(svg(ICON("check")).size(13).flex_none().text_color(t.accent)));
    };
    return v_flex().size_full().min_h(0).bg(t.popover).border(1).border_color(t.border).rounded(8).p(6).gap(4)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); return; }
        if (e.key === "down") this.at = Math.min(this.at + 1, rows.length - 1);
        else if (e.key === "up") this.at = Math.max(this.at - 1, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().h(32).flex_none().px(9).gap(6).items_center().rounded(8).border_1().border_color(t.border).bg(t.input)
        .child(svg(ICON("search")).size(13).flex_none().text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(this.error), (e) => e.child(div().px(6).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(v_flex().id("branch-list").flex_1().min_h(0).overflow_y_scroll().gap(1)
        .children(rows.map(row))
        .when(!rows.length, (e) => e.child(div().p(6).text_color(t.dim).child(this.error ? "" : "Loading branches…"))));
  }

  // ---- panel refresh ----

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refreshIfShown(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    const { cwd, on } = location(), context = key();
    // Wipe the old context's data BEFORE anything else, so a switch never
    // shows A's files/diff/message while B is loading or queued.
    if (context !== this.context) {
      this.context = context; this.root = null; this.staged = []; this.unstaged = []; this.conflicts = [];
      this.branch = { head: null, detached: false, upstream: null, ahead: 0, behind: 0 };
      this.remotes = []; this.stashes = []; this.history = []; this.histOpen = null; this.historyFiles = []; this.histFile = null;
      this.historyHead = null; this.historyMore = false;
      this.selected = null; this.selectedStash = null; this.label = null; this.tab = this.tabByContext.get(context) ?? "changes";
      this.setLines([]); this.message = ""; this.input.set_value(""); this.stashInput?.set_value(""); this.amend = false;
      this.error = null; this.note = null; this.watched = null; this.limited = false; this.historyLoading = false;
      this.folded = new Set(); this.hovered = null; this.hoverGroup = null; this.confirm = null; this.op = null;
    }
    if (!cwd) { this.loading = 0; return; }
    const plan = this.gate.plan(context, this.busy);
    if (plan.action !== "start") {
      // Loading or queued: keep the loading state of the read that will apply.
      if (plan.token) this.loading = plan.token;
      return;
    }
    const token = plan.token;
    this.loading = token;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) {
          this.root = null; this.staged = []; this.unstaged = []; this.conflicts = []; this.setLines([]);
          this.selected = null; this.label = null; this.error = "Not a git repository"; return;
        }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        // Independent read-only calls, at most 4 processes at once.
        const [status, head, stagedDiff, unstagedDiff] = await Promise.all([
          git(STATUS_ARGS),
          git(["rev-parse", "--verify", "HEAD"]),
          git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          git(["diff", "--numstat", "-z", "--no-renames"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        const parsed = parseStatusV2(status.stdout);
        if (stagedDiff.code !== 0) throw new Error(stagedDiff.stderr);
        if (unstagedDiff.code !== 0) throw new Error(unstagedDiff.stderr);
        const [stashOut, remoteOut] = await Promise.all([
          git(["stash", "list", `--format=${STASH_FORMAT}`]),
          git(["remote"]),
        ]);
        if (key() !== context) return;
        const stagedStats = statsMap(parseNumstatZ(stagedDiff.stdout));
        const unstagedStats = statsMap(parseNumstatZ(unstagedDiff.stdout));
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.head = this.hasHead ? head.stdout.trim() : null;
        this.branch = parsed.branch;
        this.staged = withStats(parsed.staged, stagedStats);
        this.unstaged = withStats(parsed.unstaged, unstagedStats);
        this.conflicts = withStats(parsed.conflicts, {});
        this.stashes = stashOut.code === 0 ? parseStashList(stashOut.stdout) : [];
        this.remotes = remoteOut.code === 0 ? remoteOut.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
        this.limited = parsed.limited; this.error = null;
        this.label = headerLabel(root, on, home());
        this.watch(root, cx);
        this.keepSelection();

        if (this.tab === "history" && this.historyHead !== this.head) loadHistory(this, cx);
        if (this.tab === "stashes") {
          if (this.selectedStash && !this.stashes.some((s) => s.ref === this.selectedStash)) {
            this.selectedStash = null; this.setLines([]);
          } else if (this.selectedStash) pickStash(this, this.selectedStash, cx);
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        // Only the latest token applies results and clears loading; an older
        // completion must not touch a newer request's state.
        const { apply, restart } = this.gate.settle(token, key());
        if (apply) this.loading = 0;
        if (restart) this.refresh(cx);
        cx.notify();
      }
    });
  }

  changeKeys() {
    return [
      ...this.conflicts.map((e) => `conflicts:${e.path}`),
      ...this.staged.map((e) => `staged:${e.path}`),
      ...this.unstaged.map((e) => `unstaged:${e.path}`),
    ];
  }

  // Diffs open in the viewer tab on a click, so nothing is picked automatically.
  keepSelection() {
    if (this.selected && !this.changeKeys().includes(this.selected)) this.selected = null;
  }

  findChange(sel) {
    if (!sel) return null;
    const split = sel.indexOf(":");
    const group = sel.slice(0, split), path = sel.slice(split + 1);
    const list = group === "staged" ? this.staged : group === "conflicts" ? this.conflicts : this.unstaged;
    return { group, path, entry: list.find((e) => e.path === path) };
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = diffWidth(this.rows);
  }

  // Diff output without its file header, from the first hunk (as before).
  showDiff(text, valid) {
    if (valid()) this.setLines(hunkLines(text));
  }

  // ---- signals from other mods ----

  handleSignals(cx) {
    if (this.mode !== "panel") return;
    const refresh = shared("ranch.changes.refresh");
    if (typeof refresh === "number" && refresh !== this.sig.refresh) {
      this.sig.refresh = refresh;
      this.refresh(cx);
    }
    const req = shared("ranch.changes.refresh-req");
    if (typeof req?.nonce === "number" && req.nonce !== this.sig.req) {
      this.sig.req = req.nonce;
      this.refresh(cx);
    }
    const error = shared("ranch.changes.error");
    if (typeof error?.nonce === "number" && error.nonce !== this.sig.error) {
      this.sig.error = error.nonce;
      this.note = String(error.message ?? error);
    }
    const select = shared("ranch.changes.select");
    if (typeof select?.nonce === "number" && select.nonce !== this.sig.select) {
      this.sig.select = select.nonce;
      if (this.root && select.root === this.root) {
        const group = this.unstaged.some((e) => e.path === select.path)
          ? "unstaged"
          : this.staged.some((e) => e.path === select.path) ? "staged" : null;
        if (group) {
          this.setTab("changes", cx);
          this.pickChange(group, select.path, cx);
        }
      }
    }
  }

  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab;
    if (this.context) this.tabByContext.set(this.context, tab);
    this.note = null;
    this.setLines([]);
    if (tab === "history") { if (this.historyHead !== this.head || !this.history.length) loadHistory(this, cx); else restoreHistory(this, cx); }
    else if (tab === "stashes") { if (this.selectedStash) pickStash(this, this.selectedStash, cx); }
    cx.notify();
  }

  // A changed file's diff opens in the top bar's viewer tab (lib/file-viewer.js),
  // the same single tab files open in; the list keeps the whole panel.
  pickChange(group, path, cx) {
    const found = this.findChange(`${group}:${path}`);
    if (!found?.entry || !this.root) return;
    this.selected = `${group}:${path}`;
    this.note = null;
    setShared(VIEWER_KEY, { ...viewerRequest(`${this.root}/${path}`, this.on), diff: { root: this.root, path, group, fresh: Boolean(found.entry.fresh) } });
    cx.notify();
  }

  // ---- mutations ----

  // Every mutating git call: serialised on this.busy, first failure in the note.
  mutate(label, argLists, cx, done) {
    if (!this.root || this.busy || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      let failure = null;
      try {
        for (const args of argLists) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim() || `git ${args[0]} failed`);
        }
      } catch (e) { failure = e; }
      this.busy = false; this.op = null;
      if (key() === context && failure) this.note = `${label} failed: ${this.brief(failure?.message ?? failure)}`;
      if (!failure && done) done();
      cx.notify();
      this.refresh(cx);
    });
    cx.notify();
  }

  commit(cx) {
    const plan = commitPlan({ message: this.message, amend: this.amend, staged: this.staged, unstaged: this.unstaged });
    if (!plan || this.busy) return;
    this.mutate("Commit", plan, cx, () => {
      this.message = ""; this.input.set_value(""); this.amend = false;
    });
  }

  stageAll(cx) {
    this.mutate("Stage all", [["add", "-A"]], cx);
  }

  unstageAll(cx) {
    this.mutate("Unstage all", [this.hasHead ? ["restore", "--staged", "--", "."] : ["rm", "--cached", "-r", "-q", "--", "."]], cx);
  }

  discardAll(cx) {
    const entries = this.unstaged;
    if (!entries.length) return;
    this.mutate("Discard all", entries.flatMap((entry) => actionArgs("discard", entry)), cx);
  }

  fileAction(action, entry, cx) {
    const label = action === "stage" ? "Stage" : action === "unstage" ? "Unstage" : "Discard";
    const args = action === "unstage" && !this.hasHead
      ? [["rm", "--cached", "-q", "--", entry.path]]
      : actionArgs(action, entry);
    this.mutate(label, args, cx);
  }

  stash(cx) {
    if (!this.root || this.busy) return;
    if (!this.conflicts.length && !this.staged.length && !this.unstaged.length) return;
    const message = this.stashInput.value().trim();
    const args = ["stash", "push", "--include-untracked"];
    if (message) args.push("-m", message);
    this.mutate("Stash", [args], cx, () => this.stashInput.set_value(""));
  }

  // ---- branch bar ----

  openBranches(cx) {
    if (!this.root || this.busy) return;
    openOverlay({
      mod: "ranch-changes", kind: "popup", frame: "none", at: "pointer", width: 300, height: 360,
      props: { branches: true, root: this.root, on: this.on },
    });
  }

  sync(kind, cx) {
    if (!this.root || this.busy || this.context !== key()) return;
    this.op = kind === "fetch" ? "Fetching…" : kind === "pull" ? "Pulling…" : "Pushing…";
    const args = kind === "fetch" ? ["fetch", "--prune"] : kind === "pull" ? ["pull", "--ff-only"] : ["push"];
    const label = kind === "fetch" ? "Fetch" : kind === "pull" ? "Pull" : "Push";
    this.mutate(label, [args], cx);
  }

  publish(cx) {
    if (!this.root || this.busy || this.context !== key()) return;
    const remote = this.remotes.includes("origin") ? "origin" : this.remotes[0];
    if (!remote) return;
    this.op = "Pushing…";
    this.mutate("Publish", [["push", "-u", remote, "HEAD"]], cx);
  }

  // ---- two-step confirm (never a modal) ----

  confirming(id) {
    return this.confirm?.id === id && Date.now() < this.confirm.until;
  }

  askConfirm(id, cx) {
    this.confirm = { id, until: Date.now() + 4000 };
    cx.timer.after(4000, (cx) => {
      if (this.confirm?.id === id) { this.confirm = null; cx.notify(); }
    });
    cx.notify();
  }

  // ---- row menus ----

  changeMenu(group, entry, cx) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, abs = `${root}/${entry.path}`;
    const gitAction = (args) => ({
      type: "many",
      actions: [
        { type: "exec", cmd: "git", args, cwd: root, on },
        { type: "request", key: "ranch.changes.refresh-req", value: {} },
      ],
    });
    const items = [];
    for (const action of fileActions(group)) {
      if (action === "stage") items.push({ label: "Stage", icon: ICON("plus"), action: gitAction(actionArgs("stage", entry)[0]) });
      if (action === "unstage") {
        const args = !this.hasHead ? ["rm", "--cached", "-q", "--", entry.path] : actionArgs("unstage", entry)[0];
        items.push({ label: "Unstage", icon: ICON("minus"), action: gitAction(args) });
      }
      if (action === "discard") items.push({ label: "Discard changes", icon: ICON("undo-2"), danger: true, action: gitAction(actionArgs("discard", entry)[0]) });
    }
    items.push({ separator: true });
    items.push({
      label: "Open file", icon: ICON("file"),
      // The top bar opens it in the file viewer tab (lib/file-viewer.js).
      action: { type: "request", key: VIEWER_KEY, value: { abs, on } },
    });
    items.push({
      label: "Open in pane beside", icon: ICON("panel-right"),
      action: { type: "run", name: "pane.split", args: { direction: "right", mod: "ranch-files", props: { file: abs, on } } },
    });
    items.push({ separator: true });
    items.push({ label: "Copy path", icon: ICON("copy"), action: { type: "copy", text: abs } });
    items.push({ label: "Copy relative path", icon: ICON("copy"), action: { type: "copy", text: entry.path } });
    openMenu({ openOverlay, mod: "ranch-changes", items });
  }

  // ---- rendering ----

  render(cx) {
    if (this.mode === "menu") return this.renderMenu(cx);
    if (this.mode === "branches") return this.renderBranches(cx);
    // Left-edge drag strip on the panel column with a hover cue (lib/edge-grip.js).
    this.grip ??= new EdgeGrip({
      id: "panel", side: "left", min: 280, max: 640, div, theme, run,
      width: () => this.grip.measured ?? 360,
    });
    return this.grip.wrap(this.renderBody(cx), theme().surface);
  }

  renderMenu(cx) {
    const items = props()?.menu ?? [];
    return renderMenu({
      items, active: this.active, theme, div, h_flex, v_flex, svg,
      onPick: (i, cx) => this.chooseMenu(i, cx),
      onHover: (i, cx) => { if (this.active !== i) { this.active = i; cx.notify(); } },
    })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const result = menuKey(e.key, items, this.active);
        if (result.close) { closeOverlay(props().overlay); return; }
        if (result.pick !== undefined) return this.chooseMenu(result.pick, cx);
        if (result.active !== undefined) { this.active = result.active; cx.notify(); }
      });
  }

  async chooseMenu(index, cx) {
    const items = normalizeItems(props()?.menu ?? []);
    const item = items[index];
    if (!item || item.separator || item.disabled) return;
    try {
      await runAction(item.action, { run, setShared, exec, copy: (text) => cx.write_to_clipboard(text) });
    } catch (e) {
      setShared("ranch.changes.error", { message: String(e), nonce: Date.now() });
    }
    closeOverlay(props().overlay);
  }

  renderBody(cx) {
    // Reads wait while hidden (a hidden copy may still be drawn); once shown,
    // a skipped read or a new location refreshes now.
    if (!this.vis.check()) { if (key() !== this.context) this.vis.skip(); }
    else if (this.vis.takeMissed() || key() !== this.context) this.refresh(cx);
    this.handleSignals(cx);
    const t = theme();
    return v_flex().id("changes").size_full().min_h(0).overflow_hidden().bg(t.surface).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(this.renderHeader(t, cx))
      .when(Boolean(this.root), (e) => e.child(this.renderBranchBar(t, cx)))
      .child(this.tab === "changes" ? this.renderChanges(t, cx) : this.tab === "history" ? renderHistory(this, t, cx) : renderStashes(this, t, cx))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(this.tab === "changes", (e) => e.child(this.renderCommit(t, cx)));
  }

  renderHeader(t, cx) {
    const count = new Set([...this.conflicts, ...this.staged, ...this.unstaged].map((e) => e.path)).size;
    const seg = (id, label, active, click) => h_flex().id(id).h(24).px(9).items_center().rounded(6).text_size(12).cursor_pointer()
      .when(active, (e) => e.bg(t.selected).text_color(t.foreground))
      .when(!active, (e) => e.text_color(t.muted).hover((s) => s.text_color(t.foreground)))
      .on_click((_e, cx) => click(cx))
      .child(label);
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(h_flex().gap(2).items_center()
        .child(seg("tab-changes", `Changes${count ? ` ${count}` : ""}`, this.tab === "changes", (c) => this.setTab("changes", c)))
        .child(seg("tab-history", "History", this.tab === "history", (c) => this.setTab("history", c)))
        .child(seg("tab-stashes", `Stashes${this.stashes.length ? ` ${this.stashes.length}` : ""}`, this.tab === "stashes", (c) => this.setTab("stashes", c))))
      .child(div().flex_1())
      .when(Boolean(this.label), (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(this.label)));
  }

  renderBranchBar(t, cx) {
    const b = this.branch, busy = this.busy;
    const remote = this.remotes.includes("origin") ? "origin" : this.remotes[0] ?? null;
    const noUpstream = !b.upstream && Boolean(b.head);
    const publish = noUpstream && Boolean(remote);
    const syncButton = (id, icon, title, count, click) => h_flex().id(id).h(24).flex_none().items_center().rounded(6)
      .when(count > 0, (e) => e.px(5).gap(3))
      .when(!(count > 0), (e) => e.w(24).justify_center())
      .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)))
      .child(svg(ICON(icon)).size(14).flex_none().text_color(busy ? t.dim : t.muted))
      .when(count > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(String(count))))
      .tooltip(title);
    return h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(h_flex().id("branch-pick").h(24).px(6).gap(5).flex_none().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.openBranches(cx))
        .child(svg(ICON("git-branch")).size(14).flex_none().text_color(t.muted))
        .child(div().max_w(220).truncate().text_color(b.head ? t.foreground : t.dim).child(b.head ?? "detached"))
        .child(svg(ICON("chevron-down")).size(12).flex_none().text_color(t.dim)))
      .when(Boolean(b.upstream), (e) => e.child(div().max_w(260).min_w(0).truncate().text_size(11).text_color(t.dim).child(b.upstream)))
      .child(div().flex_1())
      .when(Boolean(this.op), (e) => e.child(div().text_size(11).text_color(t.dim).child(this.op)))
      .child(syncButton("fetch", "refresh-cw", "Fetch", 0, (c) => this.sync("fetch", c)))
      .when(!noUpstream, (e) => e
        .child(syncButton("pull", "arrow-down-to-line", "Pull", b.behind, (c) => this.sync("pull", c)))
        .child(syncButton("push", "arrow-up-from-line", "Push", b.ahead, (c) => this.sync("push", c))))
      .when(publish, (e) => e.child(div().id("publish").h(24).px(8).flex().items_center().rounded(6).text_size(12)
        .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .text_color(busy ? t.dim : t.foreground)
        .on_click((_e, cx) => this.publish(cx))
        .child("Publish")));
  }

  actionButton(t, id, icon, title, click) {
    return h_flex().id(id).size(24).flex_none().items_center().justify_center().rounded(6)
      .when(!this.busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); click(cx); }))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(svg(ICON(icon)).size(14).flex_none().text_color(t.muted))
      .tooltip(title);
  }

  discardButton(t, id, label, title, run_, cx, icon = "undo-2") {
    if (this.confirming(id)) {
      return h_flex().id(id).h(20).px(6).flex_none().items_center().rounded(5).bg(t.ansi1 + "22").cursor_pointer()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.confirm = null; run_(cx); })
        .child(div().text_size(11).text_color(t.ansi1).child(label));
    }
    return this.actionButton(t, id, icon, title, (c) => this.askConfirm(id, c));
  }

  changeRows() {
    if (!this.root) return [];
    const out = [];
    const add = (id, title, entries, actions) => {
      out.push({ kind: "group", id, title, entries, actions });
      if (!this.folded.has(id)) for (const entry of entries) out.push({ kind: "file", group: id, entry });
    };
    if (this.conflicts.length) add("conflicts", "Merge conflicts", this.conflicts, []);
    if (this.staged.length) add("staged", "Staged", this.staged, ["unstage"]);
    add("unstaged", "Changes", this.unstaged, ["stage", "discard"]);
    if (!this.conflicts.length && !this.staged.length && !this.unstaged.length) out.push({ kind: "empty" });
    return out;
  }

  statusColor(t, status) {
    return status === "A" ? t.ansi2 : status === "D" || status === "U" ? t.ansi1 : t.blocked;
  }

  groupRow(t, row, cx) {
    const folded = this.folded.has(row.id), hovered = this.hoverGroup === row.id;
    return h_flex().id(`group-${row.id}`).h(28).flex_none().px(8).gap(6).items_center().rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        if (folded) this.folded.delete(row.id); else this.folded.add(row.id);
        cx.notify();
      })
      .on_hover((hover, cx) => {
        if (hover && this.hoverGroup !== row.id) { this.hoverGroup = row.id; cx.notify(); }
        else if (!hover && this.hoverGroup === row.id) { this.hoverGroup = null; cx.notify(); }
      })
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(12).flex_none().text_color(t.dim))
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(row.title))
      .child(h_flex().h(16).px(5).items_center().rounded(4).bg(t.raised).text_size(10).text_color(t.dim).child(String(row.entries.length)))
      .child(div().flex_1())
      .when(hovered, (e) => e.children([
        row.actions.includes("stage") ? this.actionButton(t, "stage-all", "plus", "Stage all", (c) => this.stageAll(c)) : null,
        row.actions.includes("unstage") ? this.actionButton(t, "unstage-all", "minus", "Unstage all", (c) => this.unstageAll(c)) : null,
        row.actions.includes("discard") ? this.discardButton(t, "discard-all", "Discard?", "Discard all", (c) => this.discardAll(c), cx) : null,
      ].filter(Boolean)));
  }

  changeRow(t, row, cx) {
    const { group, entry } = row, id = `${group}:${entry.path}`, actions = fileActions(group);
    const parts = entry.path.split("/"), name = parts.pop();
    const show = this.hovered === id || this.selected === id;
    return h_flex().id(`change-${id}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
      .when(this.selected === id, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.pickChange(group, entry.path, cx))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.changeMenu(group, entry, cx); })
      .on_hover((hover, cx) => {
        if (hover && this.hovered !== id) { this.hovered = id; cx.notify(); }
        else if (!hover && this.hovered === id) { this.hovered = null; cx.notify(); }
      })
      .child(div().w(14).text_size(11).text_color(this.statusColor(t, entry.status)).child(entry.status))
      .child(h_flex().flex_1().min_w(0)
        .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(entry.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${entry.add}`)))
      .when(entry.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${entry.del}`)))
      .when(show, (e) => e.children(actions.map((action) => action === "discard"
        ? this.discardButton(t, `discard-${id}`, "Discard?", "Discard changes", (c) => this.fileAction("discard", entry, c), cx)
        : this.actionButton(t, `${action}-${id}`, action === "stage" ? "plus" : "minus", action === "stage" ? "Stage" : "Unstage",
          (c) => this.fileAction(action, entry, c)))));
  }

  renderChanges(t, cx) {
    // The row whose diff the viewer tab shows stays highlighted.
    const shown = shared(VIEWER_KEY)?.diff;
    if (shown?.root === this.root && this.changeKeys().includes(`${shown.group}:${shown.path}`)) this.selected = `${shown.group}:${shown.path}`;
    const rows = this.changeRows();
    return v_flex().flex_1().min_h(0).overflow_hidden()
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().flex_1().min_h(44).relative()
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(rows.map((row) => {
          if (row.kind === "group") return this.groupRow(t, row, cx);
          if (row.kind === "empty") return div().h(28).flex_none().px(8).flex().items_center().text_color(t.dim)
            .child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"));
          return this.changeRow(t, row, cx);
        })))
        .when(!rows.length, (e) => e.child(div().p(8).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")));
  }

  diffArea(t, cx, placeholder) {
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
          (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
      .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
      .when(Boolean(placeholder), (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child(placeholder)));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderCommit(t, cx) {
    const staged = this.staged.length, unstaged = this.unstaged.length;
    const plan = commitPlan({ message: this.message, amend: this.amend, staged: this.staged, unstaged: this.unstaged });
    const enabled = Boolean(plan) && !this.busy;
    const label = this.amend && !staged && !unstaged ? "Amend" : staged ? "Commit" : unstaged ? "Commit all" : "Commit";
    return h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
      .child(h_flex().id("amend").h(24).px(6).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
        .when(this.amend, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (this.busy) return; this.amend = !this.amend; cx.notify(); })
        .when(this.amend, (e) => e.child(svg(ICON("check")).size(12).flex_none().text_color(t.foreground)))
        .child(div().text_size(11).text_color(this.amend ? t.foreground : t.muted).child("Amend")))
      .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1()
        .border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
      .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised)
        .text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer())
        .on_click((_e, cx) => this.commit(cx)).child(label));
  }
}
