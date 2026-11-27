// New-space dialog: machine and folder (a repository opens at its main
// checkout; worktrees are listed and opened from the sidebar). Opened by the sidebar's
// New space buttons (the Projects header, the rail and the empty state) with
// openOverlay({ mod: "ranch-newspace", kind: "dialog", width: 560,
//   props: { machine, folder } }); props are the active space's machine and
// folder. What Enter does is decided by lib/newspace.js (pure, tested in Node).
// Reading a folder happens on the selected machine (never with a local cwd on
// a remote), and the in-dialog browser lists folders there too.

import { View, div, svg } from "gpui-kit";
import { Popover, h_flex, v_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, settings, spaces, machines, exec, home, pickFolder, checking } from "herdr";
import {
  expandHome,
  firstLine,
  parseWorktrees,
  repoInfo,
  tilde,
  newSpacePlan,
  planLabel,
  planLines,
  machineChoices,
  folderForMachine,
  recentFolders,
  listDirsArgs,
  windowsDirArgs,
  parseFolderListing,
  filterFolders,
  browseTarget,
  parentFolder,
  childFolder,
  trimFolder,
  classifyFailure,
  classifyExecFailure,
  failureMessage,
} from "./lib/newspace.js";
import { homeCache } from "./lib/home.js";

const ICON = (name) => `mods/ranch-newspace/${name}.svg`;
const LABEL_W = 64; // field-label column, so every control starts on one line
const FIELD_H = 30;
const ROW_H = 28; // one machine row in the picker
const BROWSER_ROW_H = 26; // one folder row in the browser
const LIST_H = 7 * BROWSER_ROW_H + 8; // the browser scrolls past this instead of growing the dialog

/**
 * One git read: `{ ok, code, out, err }`, trimmed. A failed command is an
 * answer (a folder that is not a repo); only an unreachable machine rejects.
 */
async function git(machine, cwd, args, timeout) {
  const r = await exec("git", args, { cwd, on: machine, ...(timeout === undefined ? {} : { timeout }) });
  return {
    ok: r.code === 0,
    code: r.code,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? r.stdout ?? "").trim(),
  };
}

/**
 * Whether `folder` is a folder on `machine`, so git is never started with a
 * cwd that machine does not have (the old cross-machine failure). `sh` first;
 * a machine without sh (Windows) answers "unknown" and the git call decides.
 */
async function folderExists(machine, folder) {
  try {
    const r = await exec(
      "sh",
      ["-c", 'if [ -d "$1" ]; then exit 0; fi; if [ -e "$1" ]; then exit 5; fi; exit 1', "sh", folder],
      { on: machine, timeout: 15000 },
    );
    if (r.code === 0) return { ok: true };
    if (r.code === 5) return { ok: false, kind: "other", reason: "that is a file, not a folder" };
    if (r.code === 1) return { ok: false, kind: "missing" };
  } catch {}
  return { ok: true, unknown: true };
}

/**
 * Lists the folders inside `folder` on `machine`: `sh` with the path as a
 * positional argument, then `cmd.exe dir /b /ad` on a Windows machine without
 * sh. Answers `{ dirs, truncated, error }`, where `error` is
 * `{ kind, message }` with the machine's own reason (lib/newspace.js).
 */
async function readFolders(machine, folder) {
  const fail = (kind, reason = "") => ({
    dirs: [],
    truncated: false,
    error: { kind, message: failureMessage(kind, { path: folder, machine, reason }) },
  });
  try {
    const r = await exec("sh", listDirsArgs(folder), { on: machine, timeout: 20000 });
    if (r.code === 0) return { ...parseFolderListing(r.stdout), error: null };
    // 127 is "no sh here": try cmd.exe. Anything else is the folder's own answer.
    if (r.code !== 127) return fail(classifyFailure({ stage: "list", stderr: r.stderr, code: r.code }), firstLine(r.stderr));
  } catch {}
  const winArgs = windowsDirArgs(folder);
  if (winArgs) {
    try {
      const r = await exec("cmd.exe", winArgs, { on: machine, timeout: 20000 });
      if (r.code === 0) return { ...parseFolderListing(r.stdout), error: null };
      const said = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
      if (!/not recognized|is not recognized/i.test(said)) {
        return fail(classifyFailure({ stage: "list", stderr: said, code: r.code }), firstLine(r.stderr || r.stdout));
      }
    } catch {}
  }
  return fail("unreachable");
}

export default class RanchNewSpace extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.machine = p.machine ?? null;
    this.handle = cx.focus_handle();

    // Machine picker (a Popover-anchored list under the field): open state,
    // the keyboard-highlighted machine name, and the field width the list
    // matches (measured, so the dropdown lines up with its trigger).
    this.machineOpen = false;
    this.machineHl = null;
    this.machineHandle = cx.focus_handle();
    this.listHandle = cx.focus_handle(); // the open list's own, so Escape/↑↓ land there
    this.fieldW = 0;

    // Folder: a typed path, plus the in-dialog browser that lists folders on
    // the selected machine (local or remote — the same exec call either way).
    this.folderInput = InputState.new({ value: p.folder ?? "", placeholder: "~/code/repo or /absolute/path" });
    this.folderFocused = false;
    this.folderInput.on("change", (_e, cx) => {
      this.error = "";
      this.onFolderTyped(cx);
    });
    this.folderInput.on("submit", (_e, cx) => this.submitOrPick(cx));
    this.folderInput.on("focus", (_e, cx) => { this.folderFocused = true; cx.notify(); });
    this.folderInput.on("blur", (_e, cx) => { this.folderFocused = false; cx.notify(); });

    this.nameInput = InputState.new({ value: "", placeholder: "Named automatically when empty" });
    this.nameFocused = false;
    this.nameInput.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.nameInput.on("submit", (_e, cx) => this.submit(cx));
    this.nameInput.on("focus", (_e, cx) => { this.nameFocused = true; cx.notify(); });
    this.nameInput.on("blur", (_e, cx) => { this.nameFocused = false; cx.notify(); });

    this.probe = "pending"; // pending | repo | none | error
    this.probeGen = 0;
    this.probeError = ""; // why the folder could not be read, in words
    this.folderPath = "";
    this.repo = null; // { top, main, name }
    this.checkouts = []; // parseWorktrees() rows, main first
    this.worktree = "new"; // "new" or an existing checkout path
    this.homeDir = null; // the target machine's home; null while unknown
    this.more = false;
    this.busy = false;
    this.error = "";
    // The in-dialog folder browser: which folder it shows, the name filter it
    // took from the field, its rows and the reading state.
    this.browse = { open: false, path: "", filter: "", state: "idle", dirs: [], truncated: false, error: null, hl: null, gen: 0 };
    // Scroll position of the browser list, so ↑/↓ can keep the highlighted row
    // on screen (track_scroll on #browser-list).
    this.browserScroll = ScrollHandle.new();
    this.typedSeq = 0; // drops a listing a keystroke queued before the last one

    // The home lookup for the target machine, cached per view (lib/home.js):
    // sh first, cmd.exe on a Windows remote, failures remembered for a while.
    this.homeFor = homeCache(exec, () => home());

    // The keyboard starts in the folder field: that is the field to change.
    this.folderInput.focus();
    cx.timer.after(150, () => this.folderInput.focus());
    this.settleMachine(cx, false);
  }

  // ---- probing ----

  /** Probes the folder after a short pause, so a typed path runs one git call. */
  scheduleProbe(cx) {
    if (checking()) return; // `herdr-app check` must not run git for real
    const gen = ++this.probeGen;
    this.probe = "pending";
    cx.notify();
    // The timer hands its own context: the event handler's one is gone by then.
    cx.timer.after(300, (cx) => {
      if (gen === this.probeGen) this.probeNow(cx, gen);
    });
  }

  /**
   * Reads the folder's repo (toplevel + primary checkout), then its worktrees.
   * The folder is checked first (`test -d` on that machine), so
   * a path from another machine gets its own answer instead of git's, and git
   * is only ever started with a cwd that machine has. The generation token
   * drops a completion from an older run, so a stale probe never decides for a
   * newer folder or another machine.
   */
  probeNow(cx, gen) {
    const machine = this.machine;
    cx.spawn(async (cx) => {
      const clear = () => {
        this.repo = null;
        this.checkouts = [];
      };
      try {
        const userHome = machine ? await this.homeFor(machine) : home();
        if (gen !== this.probeGen) return;
        this.homeDir = userHome ?? null;
        const folder = expandHome(this.folderInput.value(), this.homeDir);
        this.folderPath = folder;
        this.probeError = "";
        clear();
        if (!folder) {
          this.probe = "none";
          cx.notify();
          return;
        }
        const exists = await folderExists(machine, folder);
        if (gen !== this.probeGen) return;
        if (!exists.ok) {
          this.probe = "error";
          this.probeError = failureMessage(exists.kind, { path: folder, machine, reason: exists.reason });
          cx.notify();
          return;
        }
        const top = await git(machine, folder, ["rev-parse", "--show-toplevel"]);
        if (gen !== this.probeGen) return;
        if (!top.ok) {
          // A readable folder that is not a repo is an answer, not a failure;
          // permission trouble and a machine that went away are not.
          const kind = classifyFailure({ stage: "repo", stderr: top.err, code: top.code });
          if (kind === "missing" || kind === "denied" || kind === "other") {
            this.probe = "error";
            this.probeError = failureMessage(kind, { path: folder, machine, reason: top.err });
          } else {
            this.probe = "none";
          }
          cx.notify();
          return;
        }
        const common = await git(machine, folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (gen !== this.probeGen) return;
        const repo = repoInfo(top.out, common?.out ?? "");
        if (!repo) {
          this.probe = "none";
          cx.notify();
          return;
        }
        const list = await git(machine, repo.main, ["worktree", "list", "--porcelain"]);
        if (gen !== this.probeGen) return;
        const checkouts = parseWorktrees(list.ok ? list.out : "")
          .filter((c) => !c.bare && !c.prunable)
          .sort((a, b) => Number(b.main) - Number(a.main) || a.path.localeCompare(b.path));
        this.repo = repo;
        this.checkouts = checkouts;
        // Keep a chosen checkout that still exists; anything else starts at "new".
        if (this.worktree !== "new" && !checkouts.some((c) => c.path === this.worktree)) this.worktree = "new";
        this.probe = "repo";
      } catch (error) {
        if (gen !== this.probeGen) return;
        clear();
        const text = String(error?.stderr ?? error?.message ?? error ?? "");
        this.probe = "error";
        this.probeError = failureMessage(classifyExecFailure(text), {
          path: this.folderPath,
          machine,
          reason: text,
        });
      }
      cx.notify();
    });
  }

  // ---- state ----

  /** The machines to offer: this computer first, unavailable ones marked. */
  machineOptions() {
    return machineChoices({ machines: machines() ?? [], current: this.machine });
  }

  /** The option the picker shows as current, offline or not. */
  machineOption() {
    return this.machineOptions().find((m) => m.name === (this.machine ?? null)) ?? null;
  }

  local() {
    return !this.machine;
  }

  machineLabel() {
    return this.machine ?? "This computer";
  }

  /** Folders of the existing spaces on this machine, newest first. */
  recents() {
    return recentFolders({ spaces: spaces() ?? [], machine: this.machine ?? null, current: this.folderNow() });
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
    // A repository always opens at its main checkout: the dialog no longer
    // picks or creates worktrees (the sidebar lists every worktree of the
    // repo, and a worktree is opened from there).
    const main = this.checkouts.find((c) => c.main)?.path ?? this.repo?.main ?? null;
    return newSpacePlan({
      probe: this.probe,
      folder: this.folderNow(),
      repoTop: this.repo?.main ?? null,
      worktree: this.probe === "repo" && main ? main : this.worktree,
      checkouts: this.checkouts,
      home: this.homeDir,
      error: this.probeError,
    });
  }

  /**
   * Points the dialog at that machine and starts over there: the folder goes to
   * the machine's newest space folder, or its home once the lookup answers, so
   * a path from another machine is never left in the field (git would run with
   * a cwd that machine does not have). Everything read for the old machine —
   * repo, checkouts, branches, the browser — is dropped.
   */
  selectMachine(name, cx) {
    if ((this.machine ?? null) === (name ?? null)) return;
    this.machine = name ?? null;
    this.settleMachine(cx, true);
  }

  /** The reset half of a machine change (and of the dialog's first render). */
  settleMachine(cx, changed) {
    const machine = this.machine;
    if (checking()) {
      // A check loads and renders the dialog but reads nothing.
      this.probe = "none";
      cx.notify();
      return;
    }
    // Drop answers still in flight for the machine we just left.
    ++this.probeGen;
    this.homeDir = null;
    this.repo = null;
    this.checkouts = [];
    this.worktree = "new";
    this.probeError = "";
    this.error = "";
    this.browse = { open: false, path: "", filter: "", state: "idle", dirs: [], truncated: false, error: null, hl: null, gen: ++this.browse.gen };
    this.typedSeq += 1;
    const known = folderForMachine({ spaces: spaces() ?? [], machine, home: null });
    const typed = String(this.folderInput.value() ?? "").trim();
    if (changed || !typed) this.writeFolder((changed ? known : typed || known) ?? "");
    this.probe = "pending";
    cx.notify();
    // The machine's home fills an empty field and resolves a typed `~`.
    cx.spawn(async (cx) => {
      const dir = machine ? await this.homeFor(machine) : home();
      if ((this.machine ?? null) !== (machine ?? null)) return;
      this.homeDir = dir ?? null;
      if (!String(this.folderInput.value() ?? "").trim() && dir) this.writeFolder(dir);
      this.probeNow(cx, ++this.probeGen);
    });
  }

  chooseFolder(dir, cx) {
    this.writeFolder(dir);
    this.error = "";
    this.browse = { ...this.browse, open: false, hl: null };
    this.scheduleProbe(cx);
  }

  /**
   * The folder field changed: probe it, and while the browser is open let the
   * typed text drive it — `~/code/Pro` lists `~/code` filtered to `Pro`, and a
   * trailing `/` lists that folder itself (what clicking a row writes).
   */
  onFolderTyped(cx) {
    this.scheduleProbe(cx);
    if (this.syncing || !this.browse.open) return;
    // One listing per pause in typing, not one per key.
    const seq = ++this.typedSeq;
    cx.timer.after(250, (cx) => {
      if (seq !== this.typedSeq || !this.browse.open) return;
      const target = browseTarget(this.folderInput.value(), this.homeDir, this.browse.path);
      this.loadFolders(cx, target.path, target.filter);
    });
  }

  // ---- the in-dialog folder browser ----

  toggleBrowser(cx) {
    if (this.browse.open) {
      this.browse = { ...this.browse, open: false, hl: null };
      cx.notify();
      return;
    }
    this.loadFolders(cx, trimFolder(this.folderNow() || this.homeDir || ""), "");
  }

  /** Lists `path` on the selected machine (stale answers are dropped). */
  loadFolders(cx, path, filter = "") {
    const machine = this.machine;
    const gen = ++this.browse.gen;
    this.browse = { ...this.browse, open: true, path: String(path ?? ""), filter, state: "loading", error: null, hl: null };
    cx.notify();
    if (!this.browse.path) {
      this.browse = { ...this.browse, state: "error", error: { kind: "missing", message: "Type a folder first." } };
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      const result = await readFolders(machine, path);
      if (gen !== this.browse.gen || (this.machine ?? null) !== (machine ?? null)) return;
      this.browse = {
        ...this.browse,
        state: result.error ? "error" : "ready",
        dirs: result.dirs ?? [],
        truncated: Boolean(result.truncated),
        error: result.error ?? null,
      };
      cx.notify();
    });
  }

  /** Enters a folder in the browser; the field follows so both agree. */
  descend(name, cx) {
    const path = childFolder(this.browse.path, name);
    // The trailing slash is what makes the field mean "this folder" to the
    // browser, so the next render lists what is inside it.
    this.writeFolder(path.endsWith("/") ? path : `${path}/`);
    this.error = "";
    this.loadFolders(cx, path, "");
    // The field now names this folder, so the hint and the worktree rows follow
    // it; the timer means a burst of clicks runs one probe, not one each.
    this.scheduleProbe(cx);
  }

  /** Writes the field without it counting as typing (the browser already
   * knows where it is). */
  writeFolder(value) {
    this.syncing = true;
    this.folderInput.set_value(value);
    this.syncing = false;
  }

  goUp(cx) {
    this.loadFolders(cx, parentFolder(this.browse.path), "");
  }

  /** Takes the browser's folder as the space's folder. */
  useFolder(path, cx) {
    this.chooseFolder(trimFolder(path), cx);
  }

  /** The rows the browser shows: the listing, filtered by what was typed. */
  browseRows() {
    return filterFolders(this.browse.dirs, this.browse.filter);
  }

  /** The system folder picker (this computer only), beside the browser. */
  pickNative(cx) {
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
      // A folder that could not be read already says why under the field.
      this.error = this.probe === "error" ? "" : plan.error ?? "";
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

  /**
   * Enter: with the browser open it takes the highlighted folder (or the one
   * being browsed), otherwise it opens the space. Outside the folder field the
   * dialog's own keys drive both surfaces, so the picker and the browser work
   * without hunting for focus.
   */
  submitOrPick(cx) {
    if (this.browse.open) {
      const rows = this.browseRows();
      const picked = this.browse.hl === null ? null : rows[this.browse.hl];
      this.useFolder(picked ? childFolder(this.browse.path, picked.name) : this.browse.path, cx);
      return;
    }
    this.submit(cx);
  }

  key(e, cx) {
    if (this.machineOpen && ["down", "up", "enter", "escape"].includes(e.key)) {
      this.machineKey(e, cx);
      return;
    }
    if (this.browse.open) {
      const rows = this.browseRows();
      if (e.key === "down" || e.key === "up") {
        const at = this.browse.hl;
        const step = e.key === "down" ? 1 : -1;
        const next = at === null
          ? (step > 0 ? 0 : rows.length - 1)
          : (at + step + rows.length) % rows.length;
        this.browse = { ...this.browse, hl: rows.length ? next : null };
        // Keep the highlighted row visible. The Up row is the scroll area's
        // first direct child, so folder i sits at child i + 1.
        if (rows.length) this.browserScroll.scroll_to_item(next + 1);
        cx.stop_propagation();
        cx.notify();
        return;
      }
      if (e.key === "enter" && !this.folderFocused) {
        this.submitOrPick(cx);
        cx.stop_propagation();
        return;
      }
      if (e.key === "escape") {
        this.browse = { ...this.browse, open: false, hl: null };
        cx.stop_propagation();
        cx.notify();
        return;
      }
    }
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

  // ---- machine picker ----

  /** The dropdown: a full-width field (icon, name, state, chevron) and a list. */
  machineField(t) {
    const current = this.machineOption();
    const offline = !current || current.disabled;
    const hint = current?.hint ?? (current ? "" : "offline");
    const trigger = h_flex().id("machine-trigger").h(FIELD_H).w_full().px(9).gap(7).items_center().rounded(7)
      .bg(t.input).border_1().border_color(this.machineOpen ? t.accent : t.border)
      .cursor_pointer().text_size(12.5).track_focus(this.machineHandle).tab_index(0)
      .hover((h) => h.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => this.machineHandle.focus())
      .on_key_down((e, cx) => {
        if (e.key !== "enter" && e.key !== " " && e.key !== "down") return;
        this.setMachineOpen(true, cx);
        cx.stop_propagation();
      })
      .child(svg(ICON(this.local() ? "laptop" : "server")).size(12).flex_none()
        .text_color(offline ? t.dim : t.muted))
      .child(div().flex_none().max_w(300).truncate()
        .text_color(offline ? t.muted : t.foreground).child(this.machineLabel()))
      .when(Boolean(hint), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(hint)))
      .child(div().flex_1().min_w(0))
      .child(svg(ICON("chevron-down")).size(10).flex_none().text_color(t.dim));

    const list = v_flex().id("machine-list").w(this.fieldW || 300).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .track_focus(this.listHandle)
      .on_key_down((e, cx) => this.machineKey(e, cx))
      .children(this.machineOptions().map((m) => this.machineOptionRow(t, m)));
    return this.machineRow(t, Popover.new("machine-popover").anchor("top_left")
      .open(this.machineOpen)
      .track_focus(this.listHandle)
      .on_open_change((open, cx) => this.setMachineOpen(open, cx))
      .trigger(trigger)
      .content(list));
  }

  /** The labelled row around the picker; the field's width rides along for the
   * list, so the dropdown lines up with the field it drops from. */
  machineRow(t, control) {
    return h_flex().w_full().gap(12).items_center()
      .child(div().flex_none().w(LABEL_W).text_size(11).text_color(t.muted).child("Machine"))
      .child(div().flex_1().min_w(0)
        .on_size_change((size, cx) => {
          const zoom = Number(settings()?.zoom) || 1;
          const width = Math.round((size.width ?? 0) / zoom);
          if (width > 0 && Math.abs(width - this.fieldW) > 1) {
            this.fieldW = width;
            cx.notify();
          }
        })
        .child(control));
  }

  /** One machine: icon, name, and why it is not reachable, or a tick. */
  machineOptionRow(t, m) {
    const selected = m.name === (this.machine ?? null);
    const lit = this.machineHl === (m.name ?? "__local");
    return h_flex().id(`machine-${m.name ?? "_local"}`).h(ROW_H).flex_none().px(7).gap(8).items_center().rounded(5)
      .when(selected, (e) => e.bg(t.selected))
      .when(lit, (e) => e.border_1().border_color(t.accent))
      .when(m.disabled, (e) => e.opacity(0.45))
      .when(!m.disabled, (e) => e.cursor_pointer().hover((h) => h.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          this.setMachineOpen(false, cx);
          this.selectMachine(m.name, cx);
        }))
      .child(svg(ICON(m.local ? "laptop" : "server")).size(12).flex_none().text_color(m.disabled ? t.dim : t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(12)
        .when(selected, (e) => e.font_medium().text_color(t.foreground))
        .when(!selected, (e) => e.text_color(m.disabled ? t.dim : t.muted))
        .child(m.label))
      .when(Boolean(m.hint), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(m.hint)))
      .when(selected, (e) => e.child(svg(ICON("check")).size(11).flex_none().text_color(t.accent)));
  }

  /** Opens or closes the picker, starting the keyboard on the current machine. */
  setMachineOpen(open, cx) {
    this.machineOpen = Boolean(open);
    this.machineHl = this.machineOpen ? (this.machine ?? "__local") : null;
    cx.notify();
  }

  /** The picker's keys: ↑/↓ move, Enter takes, Esc puts it away. */
  machineKey(e, cx) {
    if (!this.machineOpen) return;
    if (e.key === "down" || e.key === "up") {
      this.moveMachineHl(e.key === "down" ? 1 : -1);
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (e.key === "enter") {
      const pick = this.machineOptions().find((m) => (m.name ?? "__local") === this.machineHl && !m.disabled);
      this.setMachineOpen(false, cx);
      if (pick) this.selectMachine(pick.name, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "escape") {
      this.setMachineOpen(false, cx);
      cx.stop_propagation();
    }
  }

  /** Moves the picker's highlight by one reachable machine. */
  moveMachineHl(step) {
    const options = this.machineOptions().filter((m) => !m.disabled);
    if (!options.length) return;
    const at = options.findIndex((m) => (m.name ?? "__local") === this.machineHl);
    const next = at === -1 ? 0 : (at + step + options.length) % options.length;
    this.machineHl = options[next].name ?? "__local";
  }

  // ---- folder ----

  folderField(t) {
    // The input's own keys bubble through this wrapper: with the browser open
    // the arrows walk its list, not the caret. Enter is the input's submit and
    // takes the folder (see submitOrPick).
    const field = h_flex().flex_1().min_w(0)
      .on_key_down((e, cx) => {
        if (!this.browse.open || this.machineOpen) return;
        if (e.key === "up" || e.key === "down" || e.key === "escape") this.key(e, cx);
      })
      .child(Input.new(this.folderInput)
        .w_full().h(FIELD_H).px(9).rounded(7).border_1()
        .border_color(this.folderFocused ? t.accent : t.input)
        .bg(t.background).text_size(12.5).text_color(t.foreground));
    const controls = h_flex().w_full().gap(6).items_center()
      .child(field)
      .child(this.button(t, "folder-browse-toggle",
        h_flex().gap(6).items_center()
          .child(svg(ICON(this.browse.open ? "chevron-down" : "folder")).size(12).flex_none())
          .child("Folders"),
        (_e, cx) => this.toggleBrowser(cx)))
      // The system picker only knows this computer; the browser above works
      // everywhere, so local keeps both.
      .when(this.local(), (e) => e.child(this.button(t, "folder-browse",
        h_flex().gap(6).items_center()
          .child(svg(ICON("folder")).size(12).flex_none())
          .child("Browse…"),
        (_e, cx) => this.pickNative(cx))));

    const recents = this.browse.open || this.probe === "repo" ? [] : this.recents();
    const hint = this.folderHint(t);
    return this.row(t, "Folder", v_flex().w_full().gap(6).items_start()
      .child(controls)
      .when(Boolean(hint), (e) => e.child(hint))
      .when(this.browse.open, (e) => e.child(this.folderBrowser(t)))
      .when(recents.length > 0, (e) => e.child(v_flex().w_full().gap(1)
        .children(recents.map((dir, i) => h_flex().id(`recent-${i}`).w_full().h(22).px(6).gap(6).items_center()
          .rounded(5).cursor_pointer().text_color(t.dim)
          .hover((h) => h.bg(t.hover).text_color(t.muted))
          .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
          .on_click((_e, cx) => this.chooseFolder(dir, cx))
          .child(svg(ICON("folder")).size(11).flex_none())
          .child(div().flex_1().min_w(0).truncate().text_size(11).child(tilde(dir, this.homeForDisplay()))))))));
  }

  /**
   * The in-dialog browser: the folder it is showing, an Up row, the folders
   * inside (git repos marked), and one action that takes the folder. It reads
   * the selected machine, so it browses asus-book the way it browses this
   * laptop, and it scrolls instead of growing the dialog.
   */
  folderBrowser(t) {
    const b = this.browse;
    const rows = this.browseRows();
    const header = h_flex().id("browser-head").w_full().h(28).flex_none().px(8).gap(6).items_center()
      .border_b(1).border_color(t.border)
      .child(svg(ICON(this.local() ? "laptop" : "server")).size(10).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
        .child(tilde(b.path, this.homeForDisplay()) || "…"))
      .when(Boolean(b.filter), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`“${b.filter}”`)))
      .child(h_flex().id("browser-use").flex_none().h(20).px(6).items_center().rounded(4)
        .text_size(11).text_color(t.accent).cursor_pointer().hover((h) => h.bg(t.hover))
        .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.useFolder(b.path, cx))
        .child("Use this folder"));

    const up = h_flex().id("browser-up").w_full().h(BROWSER_ROW_H).flex_none().px(7).gap(7).items_center().rounded(5)
      .cursor_pointer().text_color(t.dim).hover((h) => h.bg(t.hover).text_color(t.muted))
      .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.goUp(cx))
      .child(div().flex_none().w(11).text_size(11).child(".."))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5)
        .child(tilde(parentFolder(b.path), this.homeForDisplay()) || "/"));

    const row = (d, i) => {
      const lit = b.hl === i;
      return h_flex().id(`browser-${i}`).w_full().h(BROWSER_ROW_H).flex_none().px(7).gap(7).items_center().rounded(5)
        .cursor_pointer()
        .when(lit, (e) => e.bg(t.selected))
        .when(!lit, (e) => e.hover((h) => h.bg(t.hover)))
        .on_mouse_down("left", (_ev, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.descend(d.name, cx))
        .child(svg(ICON(d.git ? "git-branch" : "folder")).size(11).flex_none()
          .text_color(d.git ? t.muted : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5)
          .when(d.git, (e) => e.text_color(t.muted))
          .when(!d.git, (e) => e.text_color(t.foreground))
          .child(d.name));
    };

    const line = (id, text, color) => h_flex().id(`browser-${id}`).w_full().h(BROWSER_ROW_H).flex_none()
      .px(7).items_center().text_size(11).text_color(color).child(text);

    let body;
    if (b.state === "loading") body = [line("loading", "Reading folders…", t.dim)];
    else if (b.state === "error") body = [line("state", b.error?.message ?? "Couldn't read that folder.", t.blocked)];
    else if (rows.length === 0) {
      body = [line("state", b.filter ? `No folders match “${b.filter}”` : "No folders here", t.dim)];
    } else body = rows.map(row);

    // The list gets a height of its own: content height while the rows fit,
    // then LIST_H so it scrolls instead of growing the dialog. overflow_hidden
    // and overflow_y_scroll on the inner area, with a named Scrollbar beside
    // it, because overflow_y_scrollbar() wraps the element and its sizing
    // never reaches the rows (see ranch-changes renderChanges).
    const count = 1 + body.length + (b.truncated ? 1 : 0);
    const listH = Math.min(LIST_H, count * BROWSER_ROW_H + Math.max(0, count - 1) * 1 + 8);
    return v_flex().id("folder-browser").w_full().rounded(8).border_1().border_color(t.border)
      .bg(t.surface).overflow_hidden()
      .child(header)
      .child(v_flex().relative().w_full().h(listH).flex_none()
        .child(v_flex().id("browser-list").absolute().inset_0().overflow_y_scroll().p(4).gap(1)
          .track_scroll(this.browserScroll)
          .child(up)
          .children(body)
          .when(b.truncated, (e) => e.child(line("more", "Showing the first 500 folders", t.dim))))
        .child(Scrollbar.vertical("browser-list").absolute().inset_0()));
  }

  /** The line under the folder field: what the folder turned out to be. */
  folderHint(t) {
    if (this.probe === "pending") {
      return this.folderInput.value().trim()
        ? div().text_size(11).text_color(t.dim).child("Checking the folder…")
        : null;
    }
    if (this.probe === "error") {
      // The machine's own answer: a missing folder, a permission, an offline host.
      return div().text_size(11).text_color(t.blocked).child(this.probeError || failureMessage("other", {
        path: this.folderPath,
        machine: this.machine,
      }));
    }
    if (this.probe === "none" && this.folderPath) {
      return div().text_size(11).text_color(t.dim).child("Not a git repository — the space opens in this folder.");
    }
    return null;
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
    // The button next to this names the move.
    const lines = plan.action === "select" ? [] : planLines(plan, this.homeForDisplay());
    // A folder that could not be read already says so under the field.
    const message = this.error || (plan.action === "error" && this.probe !== "error" ? plan.error : "");
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
        .child(this.folderField(t)))
      .child(
        v_flex().w_full().gap(8).pt(11).border_t(1).border_color(t.border)
          .when(Boolean(confirm), (e) => e.child(confirm))
          .child(this.moreOptions(t))
          .child(
            h_flex().w_full().items_center().gap(10)
              .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
                .child(this.browse.open
                  ? "↵ use folder · ↑↓ choose · esc close"
                  : this.machineOpen ? "↑↓ choose machine · ↵ pick · esc close" : "↵ open · esc close"))
              .child(this.button(t, "newspace-go", div().text_size(12.5).child(label),
                (_e, cx) => this.submit(cx),
                { primary: true, disabled: blocked })),
          ),
      );
  }
}
