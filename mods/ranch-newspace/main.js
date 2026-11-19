// New-space dialog: machine, folder, worktree, branch. Opened by the sidebar's
// New space buttons (the Projects header, the rail and the empty state) with
// openOverlay({ mod: "ranch-newspace", kind: "dialog", width: 560,
//   props: { machine, folder } }); props are the active space's machine and
// folder. What Enter does is decided by lib/newspace.js (pure, tested in Node).

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, machines, exec, home, pickFolder } from "herdr";
import {
  expandHome,
  firstLine,
  parseWorktrees,
  parseBranches,
  repoInfo,
  tilde,
  pickDefaultBranch,
  branchSuggestions,
  newSpacePlan,
  planLabel,
  planLines,
} from "./lib/newspace.js";
import { homeCache } from "./lib/home.js";

const ICON = (name) => `mods/ranch-newspace/${name}.svg`;
const LABEL_W = 64; // field-label column, so every control starts on one line
const FIELD_H = 30;

/**
 * One git read: `{ ok, out, err }`, trimmed. A failed command is an answer
 * (a folder that is not a repo); only an unreachable machine rejects.
 */
async function git(machine, cwd, args, timeout) {
  const r = await exec("git", args, { cwd, on: machine, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

export default class RanchNewSpace extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null;
    this.handle = cx.focus_handle();

    // Machine: the active space's, unless the machine list says otherwise.
    this.folderInput = InputState.new({ value: p.folder ?? "", placeholder: "~/code/repo or /absolute/path" });
    this.folderFocused = false;
    this.folderInput.on("change", (_e, cx) => {
      this.error = "";
      this.scheduleProbe(cx);
    });
    this.folderInput.on("submit", (_e, cx) => this.submit(cx));
    this.folderInput.on("focus", (_e, cx) => { this.folderFocused = true; cx.notify(); });
    this.folderInput.on("blur", (_e, cx) => { this.folderFocused = false; cx.notify(); });

    this.branchInput = InputState.new({ value: "", placeholder: "branch name" });
    this.branchFocused = false;
    this.branchInput.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => this.submit(cx));
    this.branchInput.on("focus", (_e, cx) => { this.branchFocused = true; cx.notify(); });
    this.branchInput.on("blur", (_e, cx) => { this.branchFocused = false; cx.notify(); });

    this.nameInput = InputState.new({ value: "", placeholder: "Named automatically when empty" });
    this.nameFocused = false;
    this.nameInput.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.nameInput.on("submit", (_e, cx) => this.submit(cx));
    this.nameInput.on("focus", (_e, cx) => { this.nameFocused = true; cx.notify(); });
    this.nameInput.on("blur", (_e, cx) => { this.nameFocused = false; cx.notify(); });

    this.probe = "pending"; // pending | repo | none | error
    this.probeGen = 0;
    this.folderPath = "";
    this.repo = null; // { top, main, name }
    this.checkouts = []; // parseWorktrees() rows, main first
    this.branches = { local: [], remote: [], default: null };
    this.base = null; // branch a new branch is cut from
    this.worktree = "new"; // "new" or an existing checkout path
    this.homeDir = null; // the target machine's home; null while unknown
    this.more = false;
    this.busy = false;
    this.error = "";

    // The home lookup for the target machine, cached per view (lib/home.js):
    // sh first, cmd.exe on a Windows remote, failures remembered for a while.
    this.homeFor = homeCache(exec, () => home());

    // The keyboard starts in the folder field: that is the field to change.
    this.folderInput.focus();
    cx.timer.after(150, () => this.folderInput.focus());
    this.scheduleProbe(cx);
  }

  // ---- probing ----

  /** Probes the folder after a short pause, so a typed path runs one git call. */
  scheduleProbe(cx) {
    const gen = ++this.probeGen;
    this.probe = "pending";
    cx.notify();
    // The timer hands its own context: the event handler's one is gone by then.
    cx.timer.after(300, (cx) => {
      if (gen === this.probeGen) this.probeNow(cx, gen);
    });
  }

  /**
   * Reads the folder's repo (toplevel + primary checkout), then its worktrees
   * and branches. The generation token drops a completion from an older run,
   * so a stale probe never decides for a newer folder.
   */
  probeNow(cx, gen) {
    cx.spawn(async (cx) => {
      try {
        const userHome = this.machine ? await this.homeFor(this.machine) : home();
        if (gen !== this.probeGen) return;
        this.homeDir = userHome ?? null;
        const folder = expandHome(this.folderInput.value(), this.homeDir);
        this.folderPath = folder;
        if (!folder) {
          this.repo = null;
          this.checkouts = [];
          this.branches = { local: [], remote: [], default: null };
          this.probe = "none";
          cx.notify();
          return;
        }
        const top = await git(this.machine, folder, ["rev-parse", "--show-toplevel"]);
        const common = top.ok ? await git(this.machine, folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) : null;
        if (gen !== this.probeGen) return;
        const repo = repoInfo(top.out, common?.out ?? "");
        if (!repo) {
          this.repo = null;
          this.checkouts = [];
          this.branches = { local: [], remote: [], default: null };
          this.base = null;
          this.probe = "none";
          cx.notify();
          return;
        }
        const list = await git(this.machine, repo.main, ["worktree", "list", "--porcelain"]);
        const refs = await git(this.machine, repo.main, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads", "refs/remotes"]);
        if (gen !== this.probeGen) return;
        const checkouts = parseWorktrees(list.ok ? list.out : "")
          .filter((c) => !c.bare && !c.prunable)
          .sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
        const current = checkouts.find((c) => c.path === repo.top)?.branch ?? null;
        this.repo = repo;
        this.checkouts = checkouts;
        this.branches = parseBranches(refs.ok ? refs.out : "");
        this.base = pickDefaultBranch(this.branches, current);
        // Keep a chosen checkout that still exists; anything else starts at "new".
        if (this.worktree !== "new" && !checkouts.some((c) => c.path === this.worktree)) this.worktree = "new";
        this.probe = "repo";
      } catch {
        if (gen !== this.probeGen) return;
        this.repo = null;
        this.checkouts = [];
        this.branches = { local: [], remote: [], default: null };
        this.probe = "error";
      }
      cx.notify();
    });
  }

  // ---- state ----

  /** The machines to offer: null is this computer, unavailable ones are out. */
  machineOptions() {
    const list = machines() ?? [];
    const out = list.map((m) => ({
      name: m.name ?? null,
      label: m.name ?? "This computer",
      disabled: m.layout === "unavailable",
    }));
    if (!out.some((m) => m.name === null)) out.unshift({ name: null, label: "This computer", disabled: false });
    // A space can name a machine the list does not know (a core not connected
    // yet): keep it selectable so the dialog does not silently move the target.
    if (this.machine && !out.some((m) => m.name === this.machine)) {
      out.unshift({ name: this.machine, label: this.machine, disabled: false });
    }
    return out;
  }

  local() {
    return !this.machine;
  }

  machineLabel() {
    return this.machine ?? "This computer";
  }

  /** Folders of the existing spaces on this machine, for one-click reuse. */
  recents() {
    const folder = this.folderNow();
    const seen = new Set();
    const out = [];
    for (const s of spaces() ?? []) {
      if ((s.machine ?? null) !== (this.machine ?? null)) continue;
      const dir = String(s.folder ?? "").trim();
      if (!dir || dir === folder || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
      if (out.length === 4) break;
    }
    return out;
  }

  /** What the folder field means right now, with a typed ~ resolved. */
  folderNow() {
    return expandHome(this.folderInput.value(), this.homeDir);
  }

  /** The worktree/branch summaries, for `tilde`. */
  homeForDisplay() {
    return this.homeDir ?? (this.local() ? home() : null);
  }

  /** What pressing Enter does; lib/newspace.js decides, the view only knows
   * its own inputs. */
  plan() {
    if (this.probe === "repo" && this.worktree === "new" && !this.homeDir) {
      return { action: "error", error: "Couldn't get the machine's home folder, so no worktree can be made there." };
    }
    return newSpacePlan({
      probe: this.probe,
      folder: this.folderNow(),
      repoTop: this.repo?.main ?? null,
      worktree: this.worktree,
      checkouts: this.checkouts,
      branch: this.branchInput.value(),
      localBranches: this.branches?.local ?? [],
      defaultBranch: this.base,
      home: this.homeDir,
    });
  }

  selectMachine(name, cx) {
    if (this.machine === name) return;
    this.machine = name;
    this.homeDir = null;
    this.repo = null;
    this.checkouts = [];
    this.branches = { local: [], remote: [], default: null };
    this.base = null;
    this.worktree = "new";
    this.error = "";
    this.scheduleProbe(cx);
  }

  chooseFolder(dir, cx) {
    this.folderInput.set_value(dir);
    this.error = "";
    this.scheduleProbe(cx);
  }

  browse(cx) {
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder({ prompt: "Choose folder" });
        if (dir) this.chooseFolder(dir, cx);
      } catch (error) {
        this.error = firstLine(String(error).replace(/^Error: /, ""));
        cx.notify();
      }
    });
  }

  // ---- actions ----

  submit(cx) {
    if (this.busy) return;
    if (this.probe === "pending") {
      // Enter right after typing: probe now instead of waiting out the pause,
      // then Enter again opens the space the fresh answer allows.
      this.probeNow(cx, ++this.probeGen);
      return;
    }
    const plan = this.plan();
    if (plan.action === "wait" || plan.action === "error") {
      this.error = plan.error ?? "";
      cx.notify();
      return;
    }
    const name = this.nameInput.value().trim();
    const open = (folder) => {
      closeOverlay(props().overlay);
      run("space.new", { folder, machine: this.machine ?? "", ...(name ? { name } : {}) });
    };
    if (plan.action !== "create-worktree") {
      open(plan.folder);
      return;
    }

    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let opened = false;
      try {
        const add = (args) => git(this.machine, this.repo.main, args, 600000);
        let result = await add(plan.args);
        // The branch appeared since the probe: check it out instead of creating it.
        if (!result.ok && plan.createsBranch && /already exists/.test(result.err)) {
          result = await add(["worktree", "add", plan.path, plan.branch]);
        }
        if (!result.ok) {
          this.error = firstLine(result.err) || "git worktree add failed.";
        } else {
          opened = true;
          open(plan.path);
        }
      } catch (error) {
        this.error = firstLine(String(error).replace(/^Error: /, "")) || "Couldn't create the worktree.";
      }
      this.busy = false;
      if (!opened) cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") {
      closeOverlay(props().overlay);
      cx.stop_propagation();
    }
  }

  // ---- pieces ----

  /** One labelled field: a fixed label column and the control beside it. */
  row(t, label, body, { start = false } = {}) {
    return h_flex().w_full().gap(12).when(start, (e) => e.items_start()).when(!start, (e) => e.items_center())
      .child(div().flex_none().w(LABEL_W).text_size(11).text_color(t.muted).child(label))
      .child(div().flex_1().min_w(0).child(body));
  }

  /** A small text/icon button; `primary` is the dialog's one filled control. */
  button(t, id, body, action, { disabled = false, primary = false } = {}) {
    return h_flex().id(id).flex_none().h(FIELD_H).px(10).gap(6).items_center().rounded(7)
      .border_1()
      .when(primary, (e) => e.bg(t.solid).border_color(t.solid).text_color(t.solid_foreground).font_medium())
      .when(!primary, (e) => e.border_color(t.border).text_color(t.muted))
      .when(disabled, (e) => e.opacity(0.45))
      .when(!disabled, (e) => e.cursor_pointer()
        .when(primary, (el) => el.hover((h) => h.opacity(0.88)))
        .when(!primary, (el) => el.hover((h) => h.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
        .on_click(action))
      .child(body);
  }

  /** A selectable row in the worktree list. */
  optionRow(t, id, selected, on, body) {
    return h_flex().id(id).flex_none().h(26).px(6).gap(6).items_center().rounded(5).cursor_pointer()
      .when(selected, (e) => e.bg(t.selected))
      .when(!selected, (e) => e.hover((h) => h.bg(t.hover)))
      .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
      .on_click(on)
      .child(body);
  }

  machineField(t) {
    const options = this.machineOptions();
    return this.row(t, "Machine", h_flex().gap(1).p(1).rounded(7).flex_wrap()
      .bg(t.input).border_1().border_color(t.border)
      .children(options.map((m) => div().id(`machine-${m.name ?? "_local"}`)
        .flex_none().h(24).px(9).flex().items_center().rounded(5).text_size(11.5)
        .when(m.name === this.machine, (e) => e.bg(t.selected).text_color(t.foreground))
        .when(m.name !== this.machine, (e) => e.text_color(t.muted)
          .when(m.disabled, (el) => el.opacity(0.55).tooltip("This machine is unavailable"))
          .when(!m.disabled, (el) => el.cursor_pointer().hover((h) => h.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.selectMachine(m.name, cx))))
        .child(m.label))));
  }

  folderField(t) {
    const field = Input.new(this.folderInput)
      .h(FIELD_H).px(9).flex_1().min_w(0).rounded(7).border_1()
      .border_color(this.folderFocused ? t.accent : t.input)
      .bg(t.background).text_size(12.5).text_color(t.foreground);
    const controls = h_flex().w_full().gap(6).items_center()
      .child(field)
      .when(this.local(), (e) => e.child(this.button(t, "folder-browse",
        h_flex().gap(6).items_center()
          .child(svg(ICON("folder")).size(12).flex_none())
          .child("Browse…"),
        (_e, cx) => this.browse(cx))));

    const recents = this.probe === "repo" ? [] : this.recents();
    const hint = this.folderHint(t);
    return this.row(t, "Folder", v_flex().w_full().gap(6).items_start()
      .child(controls)
      .when(Boolean(hint), (e) => e.child(hint))
      .when(recents.length > 0, (e) => e.child(v_flex().w_full().gap(1)
        .children(recents.map((dir, i) => h_flex().id(`recent-${i}`).w_full().h(22).px(6).gap(6).items_center()
          .rounded(5).cursor_pointer().text_color(t.dim)
          .hover((h) => h.bg(t.hover).text_color(t.muted))
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.chooseFolder(dir, cx))
          .child(svg(ICON("folder")).size(11).flex_none())
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(tilde(dir, this.homeForDisplay()))))))));
  }

  /** The line under the folder field: what the folder turned out to be. */
  folderHint(t) {
    if (this.probe === "pending") {
      return this.folderInput.value().trim()
        ? div().text_size(11).text_color(t.dim).child("Checking the folder…")
        : null;
    }
    if (this.probe === "error") {
      return div().text_size(11).text_color(t.muted)
        .child(this.local() ? "Couldn't read that folder." : `Couldn't read that folder on ${this.machineLabel()}.`);
    }
    if (this.probe === "none" && this.folderPath) {
      return div().text_size(11).text_color(t.dim).child("Not a git repository — the space opens in this folder.");
    }
    return null;
  }

  worktreeField(t) {
    const rows = this.checkouts.map((c, i) => this.optionRow(t, `worktree-${i}`, this.worktree === c.path,
      (_e, cx) => { this.worktree = c.path; this.error = ""; cx.notify(); },
      h_flex().w_full().min_w(0).gap(6).items_center()
        .child(svg(ICON("git-branch")).size(11).flex_none().text_color(t.dim))
        .child(div().flex_none().max_w(190).truncate().text_size(11.5)
          .when(this.worktree === c.path, (e) => e.font_semibold().text_color(t.foreground))
          .when(this.worktree !== c.path, (e) => e.text_color(t.muted))
          .child(c.branch ?? "detached"))
        .when(c.main, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("primary")))
        .child(div().flex_1().min_w(0))
        .child(div().flex_none().max_w(230).truncate().text_size(10.5).text_color(t.dim)
          .child(tilde(c.path, this.homeForDisplay())))));

    const newRow = this.optionRow(t, "worktree-new", this.worktree === "new",
      (_e, cx) => {
        this.worktree = "new";
        this.error = "";
        cx.notify();
        this.branchInput.focus();
      },
      h_flex().gap(6).items_center()
        .child(svg(ICON("plus")).size(11).flex_none().text_color(this.worktree === "new" ? t.foreground : t.dim))
        .child(div().text_size(11.5)
          .when(this.worktree === "new", (e) => e.font_semibold().text_color(t.foreground))
          .when(this.worktree !== "new", (e) => e.text_color(t.muted))
          .child("New worktree…")));

    return this.row(t, "Worktree", v_flex().w_full().gap(1).max_h(26 * 6 + 2).overflow_y_scrollbar()
      .children(rows).child(newRow), { start: true });
  }

  branchField(t) {
    const query = this.branchInput.value().trim();
    const suggestions = query ? branchSuggestions(this.branches, query, 4) : [];
    return this.row(t, "Branch", v_flex().w_full().gap(5).items_start()
      .child(Input.new(this.branchInput)
        .w_full().h(FIELD_H).px(9).rounded(7).border_1()
        .border_color(this.branchFocused ? t.accent : t.input)
        .bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(this.branchState(t, query))
      .when(suggestions.length > 0, (e) => e.child(v_flex().w_full().gap(1)
        .children(suggestions.map((name, i) => h_flex().id(`branch-suggestion-${i}`).w_full().h(22).px(6).gap(6).items_center()
          .rounded(5).cursor_pointer().text_color(t.muted)
          .hover((h) => h.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            this.branchInput.set_value(name);
            this.error = "";
            cx.notify();
          })
          .child(svg(ICON("git-branch")).size(10).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(name)))))), { start: true });
  }

  /** What the typed branch means: existing, new (from which base), or taken. */
  branchState(t, query) {
    const line = (body) => h_flex().gap(6).items_center().text_size(11).child(body);
    if (!query) {
      return line(div().text_color(t.dim).child(`New or existing branch, cut from ${this.base ?? "HEAD"}.`));
    }
    const taken = this.checkouts.find((c) => c.branch === query);
    if (taken) {
      return h_flex().gap(8).items_center().text_size(11)
        .child(div().text_color(t.muted).child(`Already checked out in ${tilde(taken.path, this.homeForDisplay())}`))
        .child(div().id("branch-select-worktree").flex_none().text_size(11).text_color(t.accent)
          .cursor_pointer().hover((h) => h.opacity(0.85))
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.worktree = taken.path; this.error = ""; cx.notify(); })
          .child("Select that worktree"));
    }
    if (this.branches.local.includes(query)) {
      return line(div().text_color(t.muted).child("Existing branch — checked out in the new worktree."));
    }
    return line(div().text_color(t.muted).child(`Will create branch ${query} from ${this.base ?? "HEAD"}.`));
  }

  moreOptions(t) {
    const toggle = h_flex().id("more-options").flex_none().gap(6).items_center().cursor_pointer()
      .text_color(t.dim).hover((h) => h.text_color(t.muted))
      .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.more = !this.more; cx.notify(); })
      .child(svg(ICON(this.more ? "chevron-down" : "chevron-right")).size(10).flex_none())
      .child(div().text_size(11.5).child("More options"));
    if (!this.more) return toggle;
    return v_flex().w_full().gap(8).items_start()
      .child(toggle)
      .child(this.row(t, "Name", Input.new(this.nameInput)
        .w_full().h(28).px(9).rounded(7).border_1()
        .border_color(this.nameFocused ? t.accent : t.input)
        .bg(t.background).text_size(12).text_color(t.foreground)));
  }

  confirmBlock(t, plan) {
    // A branch already checked out elsewhere says so under the branch field;
    // the button next to this names the move.
    const lines = plan.action === "select" ? [] : planLines(plan, this.homeForDisplay());
    const message = this.error || (plan.action === "error" ? plan.error : "");
    // A failure is red; a still-incomplete field is a quiet prompt, not an alarm.
    const color = this.error ? t.blocked : t.muted;
    if (lines.length === 0 && !message) return null;
    return v_flex().w_full().gap(4)
      .children(lines.map((line, i) => h_flex().gap(6).items_center()
        .child(div().flex_none().size(4).rounded(2).bg(i === 0 ? t.accent : t.dim))
        .child(div().text_size(11.5).text_color(i === 0 ? t.foreground : t.muted).child(line))))
      .when(Boolean(message), (e) => e.child(div().text_size(11.5).text_color(color).child(message)));
  }

  render() {
    const t = theme();
    const plan = this.plan();
    const inRepo = this.probe === "repo" && Boolean(this.repo);
    const label = this.busy
      ? plan.action === "create-worktree" ? "Creating…" : "Opening…"
      : planLabel(plan);
    const blocked = this.busy || plan.action === "error" || plan.action === "wait";
    const confirm = this.confirmBlock(t, plan);

    return v_flex()
      .id("ranch-newspace")
      .w_full()
      .min_h(0)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(18)
      .gap(14)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex().items_center().gap(8).w_full()
          .child(div().flex_1().min_w(0).text_size(13.5).font_semibold().child("New space"))
          .when(Boolean(this.repo?.name), (e) =>
            e.child(div().flex_none().truncate().max_w(260).text_size(11.5).text_color(t.dim).child(this.repo.name))),
      )
      .child(v_flex().w_full().gap(10)
        .child(this.machineField(t))
        .child(this.folderField(t))
        .when(inRepo, (e) => e.child(this.worktreeField(t)))
        .when(inRepo && this.worktree === "new", (e) => e.child(this.branchField(t))))
      .child(
        v_flex().w_full().gap(8).pt(11).border_t(1).border_color(t.border)
          .when(Boolean(confirm), (e) => e.child(confirm))
          .child(this.moreOptions(t))
          .child(
            h_flex().w_full().items_center().gap(10)
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
                .child("↵ open · esc close"))
              .child(this.button(t, "newspace-go", div().text_size(12.5).child(label),
                (_e, cx) => this.submit(cx),
                { primary: true, disabled: blocked })),
          ),
      );
  }
}
