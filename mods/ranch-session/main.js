// Ranch Session Details (requirements.md §6): the right panel for the focused
// tab — Git, Pull request, Sub-agents and one Tasks card per agent.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  exec,
  home,
  readTextFile,
  watchFolder,
  spaces,
  agents,
  panes,
  terminals,
  focused,
  theme,
  run,
  shared,
  setShared,
  window as appWindow,
} from "herdr";
import {
  STATUS_LABEL,
  relativeTime,
  truncateMiddle,
} from "./lib/format.js";
import {
  repoSnapshot,
  links,
  parsePr,
  runGh,
  createTtlCache,
  createLimiter,
  PR_JSON_FIELDS,
} from "./lib/git.js";
import { GitContexts, ageLabel } from "./gitctx.js";
import { createWatchLoops } from "./lib/watch.js";
import { TASKS_DIR, SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { PRS_FILE, parsePrRegistry, prsFor } from "./lib/prs.js";
import {
  listLifecycle,
  listVisible,
  parseStore,
  orderTasks,
  progress,
  storeCandidates,
} from "./lib/tasks.js";
import { tasksCommand, looksWindows } from "./lib/tasks-command.js";
import {
  pickAgent,
  checksSummary,
  checksGlyph,
  reviewPill,
  stateWord,
  subtitle,
  totalsOf,
  unfinishedCount,
  defaultBranchLine,
  taskEmptyState,
  adapterKey,
  remoteText,
  fileRow,
  herdrSubStatus,
  activityStatus,
  prStateToken,
  prStateLabel,
  prRepoText,
} from "./model.js";
import { isWinHome, whereFirstPath, editorLaunch, windowsHome } from "./win.js";

const MAX_FILES = 20;

// Windows can't exec the POSIX sh launcher: locally Herdr's platform tells the
// OS; on a remote machine, the home dir we probed does.
const tasksCmd = (dir, args, machine) =>
  tasksCommand(dir, args, machine ? looksWindows(dir) : appWindow()?.platform === "windows");

// This computer is Windows (fixes doc F14: "This PC").
const isWin = () => appWindow()?.platform === "windows";

// Store files gc'd once per app start per machine (fixes F5): the mod runs
// `ranch-tasks gc` in the background; install also gc's. Module-level so
// re-instantiating the view mid-session does not repeat the sweep.
const gcDone = new Set(); // machine key ("", machine name)

// The Session panel's share of the 4-gh budget (requirements §Performance:
// sidebar 3 + session 1); module-level so every copy of this view shares it.
const ghLimit = createLimiter(1);

// Repo metadata (default branch, compare ref, web host) rarely changes.
const GIT_META_TTL_MS = 600000;

/** Friendly name for a detected editor CLI, for tooltips. */
const EDITOR_NAMES = { cursor: "Cursor", code: "VS Code", zed: "Zed", subl: "Sublime Text" };

function editorName(path) {
  const base = (path.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd)$/i, "");
  return EDITOR_NAMES[base] ?? base;
}

/** How long a task-store read may run before a new one replaces it. */
const TASKS_READ_STALL_MS = 5000;

export default class RanchSession extends View {
  init(_props, cx) {
    this.remembered = new Map(); // tabId -> chosen agent address
    this.homes = new Map(); // machine (null excepted) -> its home dir
    this.tasks = { key: null, parsed: null, read: false, startedAt: null };
    this.tasksBusy = false;
    this.tasksPending = false;
    this.tasksWatchGen = 0;
    this.terminals = new Map(); // "addr@machine" -> { state, startedAt, at, busy }
    this.subTasks = new Map(); // sub address -> { parsed, read, at, busy, due }
    this.ctx = new GitContexts(); // per machine|cwd|branch Git/PR cache
    this.gitMeta = createTtlCache(GIT_META_TTL_MS, { max: 50 }); // repo metadata
    this.recordedPrCache = createTtlCache(60000, { max: 100 }); // url -> parsePr() of a recorded PR
    this.recordedPrTtl = 60000; // recreated when refresh.prSec changes
    this.recordedPrBusy = new Set(); // URLs with a lookup in flight
    this.prRegistry = { key: null, parsed: null, at: 0, busy: false, dirty: true };
    this.agentKey = null; // `${address}@${machine}` of the last seen chosen agent (I2)
    this.sessionKey = null;
    this.commitsOpen = localStorage.getItem("commitsOpen") === "1";
    this.filesOpen = false;
    this.ciOpen = null; // null: follow the default (open when checks failed)
    this.tasksOpen = new Map(); // agent address -> collapsed?
    this.settingUp = false;
    this.setupResult = null; // string output, "missing", or null
    this.editors = new Map(); // machine key -> { path: string|null, busy }
    this.copyAt = 0; // ms epoch of the last "Copy branch" click
    this.size = null;
    // Local repo watches: at most one loop per root, no matter how often the
    // folder changes (there is no way to cancel a pending watchFolder).
    this.gitWatch = createWatchLoops({
      watch: (root) => watchFolder(root),
      onChange: (root) => {
        const e = this.ctx.gitEntry();
        if (this.ctx.current.machine == null && e?.top === root) this.ctx.markGitDirty();
      },
      sleep: (ms) => cx.sleep(ms),
    });
    cx.timer.every(1000, (cx) => this.pump(cx));
    // Keep sub-agent activity statuses (store-based) fresh on screen.
    cx.timer.every(3000, (cx) => {
      const s = this.session();
      if (s.chosen && this.subTerminals(s).some((k) => this.subAgentStatus(k) === "working")) cx.notify();
    });
    this.watchTasks(cx);
    this.pump(cx);
    // Sweep stale store files once per app start (fixes F5).
    this.gcTasks(null, cx);
  }

  // ---- session ----------------------------------------------------------

  /** The focused tab, its agents and the agent this copy shows. */
  session() {
    const focus = focused();
    const tabId = focus?.tab ?? null;
    const space = spaces().find((sp) => sp.id === focus?.space) ?? null;
    const tab = space?.tabs.find((tb) => tb.id === tabId) ?? null;
    let inTab = tabId ? agents().filter((a) => a.tab === tabId) : [];
    // A Claude/Codex/OpenCode pane whose status report was cleared (Herdr shows
    // status null) is still that agent's session: use it so tasks still show.
    if (!inTab.length && tabId) {
      inTab = panes()
        .filter((p) => p.tab === tabId && p.terminal && (p.app || p.program?.agent))
        .map((p) => ({ address: p.terminal, pane: p.pane, tab: tabId, app: p.app, program: p.program, status: p.status ?? "idle" }));
    }
    const chosen = pickAgent(inTab, tabId ? this.remembered.get(tabId) ?? null : null);
    const inPane = tabId ? panes().filter((p) => p.tab === tabId) : [];
    // The chosen agent's pane cwd, else the tab's first pane cwd.
    const pane = (chosen ? inPane.find((p) => p.pane === chosen.pane) ?? inPane[0] : inPane[0]) ?? null;
    return {
      tab,
      space,
      machine: space?.machine ?? null,
      machineLabel: space?.machine ?? (isWin() ? "This PC" : "This Mac"),
      inTab,
      chosen,
      cwd: pane?.cwd ?? null,
    };
  }

  /** Home dir on a machine: home() locally; asked once per remote machine. */
  async homeFor(machine) {
    if (!machine) return home();
    const hit = this.homes.get(machine);
    if (hit) return hit;
    try {
      const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
      const out = r.code === 0 ? r.stdout.trim() : "";
      if (out) {
        this.homes.set(machine, out);
        return out;
      }
    } catch {}
    // Windows remote (F12): sh answered nothing, so ask cmd.exe. Backslashes
    // are normalized so the store path joins work like on Unix.
    try {
      const r = await exec("cmd.exe", ["/c", "echo %USERPROFILE%"], { on: machine });
      const out = windowsHome(r.code === 0 ? r.stdout : "");
      if (out) {
        this.homes.set(machine, out);
        return out;
      }
    } catch {}
    return null;
  }

  choose(agent, cx) {
    const tabId = focused()?.tab;
    if (!tabId || this.remembered.get(tabId) === agent.address) return;
    this.remembered.set(tabId, agent.address);
    this.filesOpen = false;
    this.loadTasks(cx);
    this.ctx.markGitDirty(); // the branch may change with the agent
    cx.notify();
  }

  // ---- tasks ------------------------------------------------------------

  /** Watches the local tasks dir (it may not exist yet: 3 s fallback). */
  watchTasks(cx) {
    const gen = ++this.tasksWatchGen;
    const dir = `${home()}/${TASKS_DIR}`;
    cx.spawn(async (cx) => {
      while (this.tasksWatchGen === gen) {
        try {
          await watchFolder(dir);
        } catch {
          await cx.sleep(3000);
          continue;
        }
        if (this.tasksWatchGen !== gen) return;
        // Debounce: adapters write pointer + session file back to back.
        await cx.sleep(150);
        if (this.tasksWatchGen !== gen) return;
        this.prRegistry.dirty = true; // a hook may have shared a PR too
        this.loadTasks(cx);
      }
    });
  }

  /**
   * Reads one agent's store file through the schema-2 layout (fixes 3.3):
   * terminals/<address>.json (possibly a pointer) → sessions/<session>.json,
   * falling back to the legacy flat <address>.json. Returns { parsed, text }.
   */
  async readStoreText(machine, homeDir, address) {
    const [terminal, legacy] = storeCandidates(address);
    if (!homeDir || !terminal) return { parsed: { ok: false, reason: "missing" }, text: null };
    try {
      const text = await readTextFile(`${homeDir}/${TASKS_DIR}/${terminal}`, { on: machine });
      if (text != null) {
        const [session] = storeCandidates(address, text);
        if (session) {
          try {
            const sessionText = await readTextFile(`${homeDir}/${TASKS_DIR}/${session}`, { on: machine });
            if (sessionText != null) return { parsed: parseStore(sessionText), text: sessionText };
          } catch {}
          return { parsed: { ok: false, reason: "missing" }, text: null };
        }
        return { parsed: parseStore(text), text };
      }
      // No terminal file: try the legacy flat store.
      const legacyText = await readTextFile(`${homeDir}/${TASKS_DIR}/${legacy}`, { on: machine });
      return { parsed: parseStore(legacyText), text: legacyText };
    } catch {
      return { parsed: { ok: false, reason: "missing" }, text: null };
    }
  }

  /** Reads the chosen agent's store file (one read in flight). */
  async loadTasks(cx) {
    // A read that never settles (seen across a mod reload) must not leave
    // tasksBusy set forever: after TASKS_READ_STALL_MS a new read takes over
    // and the stalled one's result is ignored by its generation.
    if (this.tasksBusy && Date.now() - (this.tasksBusyAt ?? 0) < TASKS_READ_STALL_MS) {
      this.tasksPending = true;
      return;
    }
    const gen = (this.tasksGen = (this.tasksGen ?? 0) + 1);
    this.tasksBusy = true;
    this.tasksBusyAt = Date.now();
    try {
      const s = this.session();
      const agent = s.chosen;
      if (!agent) {
        this.tasks = { key: null, parsed: null, read: true };
        cx.notify();
        return;
      }
      const key = `${agent.address}@${s.machine ?? ""}`;
      const homeDir = await this.homeFor(s.machine);
      const { parsed } = await this.readStoreText(s.machine, homeDir, agent.address);
      if (gen !== this.tasksGen) return; // superseded after a stall
      // Stale read (I2): the focused agent changed while the file was read.
      const now = this.session();
      if (now.chosen?.address !== agent.address || (now.machine ?? null) !== (s.machine ?? null)) return;
      if (this.tasks.key !== key) this.filesOpen = false;
      this.tasks = { key, parsed, read: true };
      // The terminal's own start time, for the identity check (fixes F4).
      this.terminalInfo(key, agent.address, s.machine, cx);
      cx.notify();
      this.publishTaskCount(s);
      this.loadSubTasks(s, cx);
      return;
    } finally {
      // A newer read (after a stall) owns the flags.
      if (gen === this.tasksGen) {
        this.tasksBusy = false;
        if (this.tasksPending) {
          this.tasksPending = false;
          this.loadTasks(cx);
        }
      }
    }
  }

  /**
   * Terminal identity info (fixes F4): state and start time from
   * `hc get --json`, cached for a minute per address@machine; seeded from the
   * terminals() snapshot so the first render already knows liveness.
   */
  terminalInfo(key, addr, machine, cx) {
    if (!this.terminals) this.terminals = new Map();
    let info = this.terminals.get(key);
    if (!info) {
      info = { state: terminals().find((k) => k.address === addr)?.state ?? null, startedAt: null, at: 0, busy: false };
      this.terminals.set(key, info);
    }
    if (info.busy || Date.now() - info.at < 60000) return info;
    info.busy = true;
    cx?.spawn(async (cx) => {
      let state = info.state;
      let startedAt = info.startedAt;
      try {
        const r = await exec("hc", ["get", "--json", addr], { on: machine, timeout: 5000 });
        if (r.code === 0) {
          const raw = JSON.parse(r.stdout);
          state = typeof raw?.state === "string" ? raw.state : state;
          if (typeof raw?.created_ms === "number" && raw.created_ms > 0) startedAt = raw.created_ms;
        }
      } catch {}
      info.state = state;
      info.startedAt = startedAt;
      info.at = Date.now();
      info.busy = false;
      cx.notify();
    });
    return info;
  }

  /** The F4 identity triple for one agent's terminal: { state, app, startedAt }. */
  liveFor(agent, machine) {
    if (!agent) return null;
    const key = `${agent.address}@${machine ?? ""}`;
    const info = this.terminals?.get(key)
      ?? { state: terminals().find((k) => k.address === agent.address)?.state ?? null, startedAt: null };
    return { state: info.state, app: adapterKey(agent.app), startedAt: info.startedAt };
  }

  /** Sweep stale store files on this machine (or a remote one), once per start. */
  gcTasks(machine, cx) {
    const key = machine ?? "";
    if (gcDone.has(key)) return;
    gcDone.add(key);
    cx.spawn(async (cx) => {
      try {
        const dir = await this.homeFor(machine);
        if (dir) await exec(...tasksCmd(dir, ["gc"], machine), { on: machine, timeout: 30000 });
      } catch {
        gcDone.delete(key); // binary may not be installed yet; retry later
      }
    });
  }

  /** Terminals the chosen agent started (its Herdr sub-agents). */
  subTerminals(s) {
    return s.chosen ? terminals().filter((k) => k.parent === s.chosen.address) : [];
  }

  /**
   * A sub-agent's status for display: Herdr's own when it has one, else the
   * activity its adapter recorded in the store (headless agents such as
   * `opencode run` report no Herdr status), mapped with effectiveStatus()'s
   * staleness rule; null when nothing is known.
   */
  subAgentStatus(k) {
    const st = herdrSubStatus(k);
    if (st) return st;
    const activity = this.subTasks.get(k.address)?.parsed?.store?.session?.activity;
    return activityStatus(activity, Date.now());
  }

  /**
   * Reads each Herdr sub-agent's store file the same way as the main one,
   * at most every 3 s per address with a trailing-edge read so the last
   * change in a burst is not dropped; feeds its Tasks card and the totals.
   */
  async loadSubTasks(s, cx) {
    const subs = this.subTerminals(s);
    const live = new Set(subs.map((k) => k.address));
    for (const addr of this.subTasks.keys()) if (!live.has(addr)) this.subTasks.delete(addr);
    const homeDir = await this.homeFor(s.machine);
    const now = Date.now();
    for (const k of subs) {
      const entry = this.subTasks.get(k.address) ?? { parsed: null, read: false, at: 0, busy: false, due: false };
      this.subTasks.set(k.address, entry);
      if (entry.busy || now - entry.at < 3000) {
        // Trailing edge: schedule one more read after the throttle window.
        if (!entry.due) {
          entry.due = true;
          cx.timer.after(3000 - (now - entry.at) + 50, (cx) => {
            const e = this.subTasks.get(k.address);
            if (e) e.due = false;
            this.loadSubTasks(this.session(), cx);
          });
        }
        continue;
      }
      entry.busy = true;
      entry.due = false;
      entry.at = now;
      cx.spawn(async (cx) => {
        const { parsed } = await this.readStoreText(s.machine, homeDir, k.address);
        const e = this.subTasks.get(k.address);
        if (e) {
          e.parsed = parsed;
          e.read = true;
          e.busy = false;
          e.at = Date.now();
        }
        this.publishTaskCount(s);
        cx.notify();
      });
    }
  }

  /** The main agent's and each sub-agent's task list (only visible stores). */
  taskLists(s) {
    const lists = [];
    if (this.tasksReady(s) && this.tasks.parsed?.ok && listVisible(this.tasks.parsed, this.liveFor(s.chosen, s.machine))) {
      lists.push(this.tasks.parsed.store.tasks);
    }
    for (const k of this.subTerminals(s)) {
      const entry = this.subTasks.get(k.address);
      if (entry?.parsed?.ok && listVisible(entry.parsed, this.liveFor(k, s.machine))) {
        lists.push(entry.parsed.store.tasks);
      }
    }
    return lists;
  }

  /** Cancelled tasks are struck through, not counted in "x of y" (F7). */
  liveTasks(tasks) {
    return tasks.filter((t) => t.status !== "cancelled");
  }

  /** Publishes the focused tab's unfinished-task count for the sidebar badge. */
  publishTaskCount(s) {
    if (!s?.tab) return;
    const count = this.taskLists(s).reduce((n, tasks) => n + unfinishedCount(tasks), 0);
    const map = shared("ranch.taskCount") ?? {};
    if (map[s.tab.id] === count) return;
    setShared("ranch.taskCount", { ...map, [s.tab.id]: count });
  }

  /**
   * Installed adapters on the session's machine, from `ranch-tasks status --json`,
   * checked at most once a minute per machine. undefined while unknown; an
   * unreachable or missing binary counts as nothing installed ({}).
   */
  adapterState(s) {
    return this.adapterStatus?.get(s.machine ?? "")?.agents;
  }

  /** Called from pump(): refreshes adapterState for the session's machine. */
  maybeCheckAdapters(machine, cx) {
    if (!this.adapterStatus) this.adapterStatus = new Map();
    const key = machine ?? "";
    const prev = this.adapterStatus.get(key);
    if (prev && (prev.busy || Date.now() - prev.at < 60000)) return;
    this.adapterStatus.set(key, { agents: prev?.agents, at: Date.now(), busy: true });
    cx.spawn(async (cx) => {
      let agents = {};
      try {
        const dir = await this.homeFor(machine);
        const r = dir ? await exec(...tasksCmd(dir, ["status", "--json"], machine), { on: machine, timeout: 10000 }) : null;
        if (r && r.code === 0) agents = JSON.parse(r.stdout).agents ?? {};
      } catch {}
      this.adapterStatus.set(key, { agents, at: Date.now(), busy: false });
      cx.notify();
    });
  }

  /** The Set up button: runs ranch-tasks install on the session's machine. */
  async setUpTasks(cx) {
    if (this.settingUp) return;
    this.settingUp = true;
    this.setupResult = null;
    cx.notify();
    const s = this.session();
    const homeDir = await this.homeFor(s.machine);
    let result = "missing";
    if (homeDir) {
      try {
        const r = await exec(...tasksCmd(homeDir, ["install", "--yes"], s.machine), { on: s.machine });
        if (r.code === 127) result = "missing";
        else {
          const out = `${r.stdout.trim()}\n${r.stderr.trim()}`.trim();
          result = out || (r.code === 0 ? "Done." : "Failed.");
        }
      } catch {}
    }
    this.settingUp = false;
    this.setupResult = result;
    cx.notify();
    if (result !== "missing") this.loadTasks(cx);
  }

  // ---- git --------------------------------------------------------------

  async refreshGit(cx) {
    const op = this.ctx.beginGit();
    if (!op) return;
    const git = (args) => exec("git", args, { cwd: op.cwd, on: op.machine, timeout: 10000 });
    let result;
    try {
      result = await repoSnapshot(git, {
        commits: 5,
        meta: this.gitMeta,
        metaKey: op.machine ?? "",
        now: Date.now(),
      });
    } catch {
      result = { status: "failed", summary: null, details: null };
    }
    // Filed under the context that started the read, even if the user moved on.
    if (this.ctx.finishGit(op, result, Date.now())) this.syncGitWatch();
    cx.notify();
  }

  /** Keeps exactly the current local repo's top watched. */
  syncGitWatch() {
    const e = this.ctx.gitEntry();
    this.gitWatch.setWanted(this.ctx.current.machine == null && e?.top ? [e.top] : []);
  }

  async refreshPr(cx) {
    const op = this.ctx.beginPr();
    if (!op) return;
    // First stderr line, for the quiet error note (I6).
    const stderrLine = (r) => (r.stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? null;
    const gh = (cmd, args) => exec(cmd, args, { cwd: op.cwd, on: op.machine, timeout: 15000 });
    let res;
    try {
      const r = await ghLimit.run(() => runGh(gh, ["pr", "view", op.branch, "--json", PR_JSON_FIELDS]), { front: true });
      if (r.missing) {
        // gh's finishPr coerces failed to Boolean, so the missing note rides
        // on `error` instead of a "missing" failed value.
        res = { parsed: null, failed: true, error: "GitHub CLI not found" };
      } else if (r.code === 0) {
        try {
          res = { parsed: parsePr(JSON.parse(r.stdout)), failed: false, error: null };
        } catch {
          res = { parsed: null, failed: true, error: stderrLine(r) ?? "gh pr view failed" };
        }
      } else if (/no pull request/i.test(r.stderr ?? "")) {
        res = { parsed: null, failed: false, error: null }; // no PR for this branch
      } else {
        res = { parsed: null, failed: true, error: stderrLine(r) ?? "gh pr view failed" };
      }
    } catch {
      res = { parsed: null, failed: true, error: null };
    }
    if (this.ctx.finishPr(op, res, Date.now())) cx.notify();
  }

  /** The 1 s heartbeat: session changes, task re-reads and refresh cadence. */
  pump(cx) {
    const now = Date.now();
    const set = resolveSettings(shared(SETTINGS_KEY));
    const s = this.session();
    const key = `${s.machine ?? ""}|${s.cwd ?? ""}`;
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.filesOpen = false;
      this.ciOpen = null;
      this.copyAt = 0;
      const tkey = s.chosen ? `${s.chosen.address}@${s.machine ?? ""}` : null;
      if (tkey !== this.tasks.key) this.loadTasks(cx);
      else this.loadSubTasks(s, cx);
    }
    // The focused agent can change without the folder changing (I2): reload
    // its store and drop everything bound to the previous agent.
    const akey = s.chosen ? `${s.chosen.address}@${s.machine ?? ""}` : null;
    if (akey !== this.agentKey) {
      this.agentKey = akey;
      this.subTasks.clear();
      this.filesOpen = false;
      this.ciOpen = null;
      if (!this.ctx.push.busy) this.ctx.push = { ...this.ctx.push, err: null, at: 0 };
      this.copyAt = 0;
    }
    // loadTasks guards itself (and takes over from a stalled read).
    if (akey !== this.tasks.key) this.loadTasks(cx);
    // The action bar's Editor button needs one detection per machine.
    this.maybeDetectEditor(s.machine, cx);
    // Only needed while the store is missing (to offer Set up), once a minute.
    if (s.chosen && this.tasks.parsed && !this.tasks.parsed.ok && this.tasks.parsed.reason === "missing") {
      this.maybeCheckAdapters(s.machine, cx);
    }
    // Keep the terminal's identity info (fixes F4) fresh, and gc remote
    // machines' stale store files once per app start (fixes F5).
    if (s.chosen) {
      this.terminalInfo(`${s.chosen.address}@${s.machine ?? ""}`, s.chosen.address, s.machine, cx);
      if (s.machine) this.gcTasks(s.machine, cx);
    }
    // The tasks folder is only watched locally; poll a remote machine's store.
    if (s.machine != null && s.chosen && now - (this.tasksReadAt ?? 0) >= 5000) {
      this.tasksReadAt = now;
      this.loadTasks(cx);
    }
    // The context may have changed since the last pump (render can switch it
    // earlier): make the schedule below act on the session being drawn.
    if (this.ctx.select(s.machine, s.cwd)) this.syncGitWatch();
    // Git: immediately on change, then 30 s locally (watchFolder covers the
    // gaps) and refresh.remoteGitSec on another machine.
    if (this.ctx.shouldRefreshGit(now, this.gitEveryMs(s, set))) this.refreshGit(cx);
    // PR: every refresh.prSec, 20 s while CI checks are pending (I5). The
    // read always queries the current context's branch, so a branch change
    // re-reads it (I7).
    if (this.ctx.shouldRefreshPr(now, this.prEveryMs(set))) this.refreshPr(cx);
    // Recorded PRs ("Opened by this agent"): fetch each URL's real state and
    // title at the branch PR's cadence, one lookup per URL at a time.
    const recordedTtl = Math.max(5, set.refresh.prSec) * 1000; // not the 20 s CI-pending cadence
    if (recordedTtl !== this.recordedPrTtl) {
      this.recordedPrTtl = recordedTtl;
      this.recordedPrCache = createTtlCache(recordedTtl, { max: 100 });
    }
    this.recordedPrCache.prune(now);
    if (s.cwd) {
      for (const p of this.recordedPrs(s, this.ctx.prEntry()?.parsed ?? null)) {
        if (!this.recordedPrBusy.has(p.url) && this.recordedPrCache.get(p.url, now) === undefined) {
          this.lookupRecordedPr(cx, s, p.url);
        }
      }
    }
    // The shared PR registry (~/.herdr/ranch/prs.json): what any terminal's
    // agent opened on this repo + branch. One small file read, at most every
    // few seconds (the tasks watcher also flags it) — recordedPrs() merges it.
    const regKey = `${s.machine ?? ""}`;
    if (this.prRegistry.key !== regKey || this.prRegistry.dirty || now - this.prRegistry.at >= 3000) {
      this.loadPrRegistry(cx);
    }
  }

  /** Git re-read cadence: 30 s locally (watchFolder covers the gaps), refresh.remoteGitSec elsewhere. */
  gitEveryMs(s, set) {
    return s.machine != null ? Math.max(1, set.refresh.remoteGitSec) * 1000 : 30000;
  }

  /** PR re-read cadence: 20 s while CI checks are pending (I5), else refresh.prSec. */
  prEveryMs(set) {
    const pending = (this.ctx.prEntry()?.parsed?.checks?.pending ?? 0) > 0;
    return pending ? 20000 : Math.max(5, set.refresh.prSec) * 1000;
  }

  /** One registry read (chosen machine's home), gated by loadPrRegistry. */
  async loadPrRegistry(cx) {
    if (this.prRegistry.busy) {
      this.prRegistry.dirty = true;
      return;
    }
    const s = this.session();
    const key = `${s.machine ?? ""}`;
    this.prRegistry.busy = true;
    try {
      const homeDir = await this.homeFor(s.machine);
      let parsed = null;
      if (homeDir) {
        try {
          const text = await readTextFile(`${homeDir}/${PRS_FILE}`, { on: s.machine });
          parsed = parsePrRegistry(text);
        } catch {}
      }
      if (key !== `${this.session().machine ?? ""}`) return; // stale read
      this.prRegistry = { key, parsed, at: Date.now(), busy: false, dirty: false };
      cx.notify();
    } finally {
      if (this.prRegistry.busy) this.prRegistry.busy = false;
    }
  }

  /** One recorded PR's state/title, parsed like the branch PR's. */
  async lookupRecordedPr(cx, s, url) {
    this.recordedPrBusy.add(url);
    try {
      const gh = (cmd, args) => exec(cmd, args, { cwd: s.cwd, on: s.machine, timeout: 15000 });
      // Normal priority: the branch PR's lookup queues ahead of this (front).
      const r = await ghLimit.run(() => runGh(gh, ["pr", "view", url, "--json", PR_JSON_FIELDS]));
      let parsed = null;
      if (r.code === 0) {
        try {
          parsed = parsePr(JSON.parse(r.stdout));
        } catch {
          parsed = null;
        }
      }
      this.recordedPrCache.set(url, parsed, Date.now());
    } catch {
      this.recordedPrCache.set(url, null, Date.now()); // retried after the TTL
    }
    this.recordedPrBusy.delete(url);
    cx.notify();
  }

  // ---- ui ---------------------------------------------------------------

  render(cx) {
    const t = theme();
    const set = resolveSettings(shared(SETTINGS_KEY));
    const s = this.session();
    // render can run right after a tab switch, before the 1 s pump: make sure
    // everything below reads the context being drawn.
    this.ctx.select(s.machine, s.cwd);
    const root = v_flex()
      .id("ranch-session-root")
      .size_full()
      .bg(t.surface)
      .text_size(12.5)
      .text_color(t.foreground)
      .overflow_y_scrollbar()
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      });
    root.child(this.header(t, s));
    if (!s.tab) {
      root.child(div().text_size(12.5).text_color(t.dim).px(12).py(10).child("No tab focused"));
      return root;
    }
    if (s.inTab.length > 1) root.child(this.picker(t, s));
    root.child(this.actionBar(t, s));
    if (!s.chosen) {
      // No agent: no tasks or sub-agents, but the tab's git state still applies.
      root.child(div().text_size(12).text_color(t.dim).px(12).py(10).child("No agent in this tab"));
      if (set.session.git) {
        root.child(this.gitCard(t, s, set));
        for (const node of this.prExtras(t, s, set)) root.child(node);
      }
      return root;
    }
    // Tasks first (R-SD-1): the main agent's card, then each sub-agent's.
    if (set.session.tasks) {
      root.child(this.tasksCard(t, s, null));
      for (const card of this.subTaskCards(t, s)) root.child(card);
    }
    if (set.session.subagents) {
      const subs = this.subsCard(t, s);
      if (subs) root.child(subs);
    }
    if (set.session.git) {
      root.child(this.gitCard(t, s, set));
      for (const node of this.prExtras(t, s, set)) root.child(node);
    }
    return root;
  }

  /** The PR card plus the quiet failure notes under it (I3, I6). */
  prExtras(t, s, set) {
    const nodes = [];
    const pr = this.prCard(t, s, set);
    if (pr) nodes.push(pr);
    const pe = this.ctx.prReady() ? this.ctx.prEntry() : null;
    if (pe?.failed) {
      // Only the first stderr line; the full output stays out of the panel.
      nodes.push(div().text_size(12).text_color(t.dim).px(12).py(10).child(pe.error ?? "gh pr view failed"));
    }
    return nodes;
  }

  /** "Session Details" + task subtitle + the panel's close button. */
  header(t, s) {
    // Flat sections: a full-width header row, then sections split by grey lines.
    const row = h_flex().h(40).flex_none().px(12).gap(6).items_center().min_w(0).border_b(1).border_color(t.border);
    row.child(
      div()
        .text_size(13)
        .font_semibold()
        .truncate()
        .tooltip(this.tabTitle(s))
        .child("Session Details")
    );
    const sub = subtitle(this.totals(s)); // null when nothing is tracked
    row.child(
      div()
        .flex_1()
        .min_w(0)
        .text_size(11.5)
        .text_color(t.dim)
        .truncate()
        .when(sub, (el) => el.child(sub))
    );
    row.child(
      div()
        .id("session-close")
        .size(20)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(t.dim)
        .hover((h) => h.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("layout.hide", { id: "panel" }))
        .child(svg("mods/ranch-session/x.svg").size(12))
    );
    return row;
  }

  /** Completed/total across the chosen agent's tasks and its sub-agents'. */
  totals(s) {
    return totalsOf(this.taskLists(s).map((tasks) => this.liveTasks(tasks)));
  }

  /** Same rule as the top bar: an unnamed tab shows its agent's program name. */
  tabTitle(s) {
    if (!s.tab) return "No tab focused";
    const unnamed = /^tb\d+$/.test(s.tab.name) || (!s.tab.named && /^\d+$/.test(s.tab.name));
    if (!unnamed) return s.tab.name;
    const pane = panes().find((p) => p.tab === s.tab.id && p.program?.agent) ?? panes().find((p) => p.tab === s.tab.id);
    return pane?.program?.name ?? "Terminal";
  }

  picker(t, s) {
    return h_flex().gap(6).flex_wrap().children(
      s.inTab.map((a) => {
        const on = a.address === s.chosen.address;
        const pic = this.programIcon(a.program, 13, t.foreground);
        return h_flex()
          .id(`pick-${a.address}`)
          .h(22)
          .px(8)
          .rounded(8)
          .gap(6)
          .items_center()
          .bg(on ? t.selected : t.raised)
          .cursor_pointer()
          .hover((h) => h.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.choose(a, cx))
          .when(pic, (el) => el.child(pic))
          .child(
            div()
              .text_size(10.5)
              .font_semibold()
              .text_color(t[a.status] ?? t.foreground)
              .child(STATUS_LABEL[a.status] ?? a.program?.name ?? "agent")
          );
      })
    );
  }

  // ---- action bar --------------------------------------------------------

  /**
   * One row of common next steps under the header (R-SD-2): shell, editor,
   * copy branch, push and PR. Only known/possible actions show.
   */
  actionBar(t, s) {
    const sum = this.ctx.gitReady() ? this.ctx.gitEntry().summary : null;
    const top = sum?.top ?? s.cwd;
    const branch = sum?.branch ?? null;
    const lk = sum?.host ? links(sum.host) : null;
    const dbl = defaultBranchLine(sum);
    const compare =
      branch && lk && dbl?.kind === "diverged" && (dbl.ahead || dbl.behind)
        ? lk.compare(dbl.default, branch)
        : null;
    const bar = h_flex().px(12).py(8).gap(6).flex_wrap().border_b(1).border_color(t.border);

    bar.child(
      this.actionBtn(t, "action-shell", "mods/ranch-session/terminal.svg", "Shell", "Open a shell below, in this repo", () =>
        run("terminal.open", { folder: top, place: "down" })
      )
    );

    const editor = this.editors.get(s.machine ?? "");
    if (editor?.path) {
      bar.child(
        this.actionBtn(
          t,
          "action-editor",
          "mods/ranch-session/code.svg",
          "Editor",
          `Open in ${editorName(editor.path)}`,
          () => {
            // .cmd launchers (code.cmd, cursor.cmd) need cmd.exe on Windows (F10).
            const [cmd, args] = editorLaunch(editor.path, top);
            exec(cmd, args, { on: s.machine }).catch(() => {});
          }
        )
      );
    }

    if (branch) {
      const copied = Date.now() - this.copyAt < 1500;
      bar.child(
        this.actionBtn(
          t,
          "action-copy",
          "mods/ranch-session/copy.svg",
          copied ? "Copied" : "Copy branch",
          "Copy the branch name",
          (_e, cx) => {
            cx.write_to_clipboard(branch);
            this.copyAt = Date.now();
            cx.notify();
            cx.timer.after(1500, (cx) => cx.notify());
          }
        )
      );
    }

    if (branch && sum.host && branch !== sum.default) {
      const pv = this.ctx.pushView();
      const pushed = pv.at && Date.now() - pv.at < 1500;
      bar.child(
        this.actionBtn(
          t,
          "action-push",
          "mods/ranch-session/upload.svg",
          pv.busy ? "Pushing\u2026" : pushed ? "Pushed" : "Push",
          "Push this branch to origin",
          (_e, cx) => this.pushBranch(cx),
          pv.busy || pv.blocked
        )
      );
    }

    const pr = this.ctx.prReady() ? this.ctx.prEntry().parsed : null;
    if (pr?.url && pr.number != null) {
      bar.child(
        this.actionBtn(
          t,
          "action-pr",
          "mods/ranch-session/git-pull-request.svg",
          `PR #${pr.number}`,
          "Open the pull request",
          () => this.openUrl(pr.url)
        )
      );
    } else if (compare) {
      bar.child(
        this.actionBtn(
          t,
          "action-pr",
          "mods/ranch-session/git-pull-request.svg",
          "Create PR",
          "Open the pull-request page",
          () => this.openUrl(compare)
        )
      );
    }

    const wrap = v_flex().flex_none();
    wrap.child(bar);
    const pv = this.ctx.pushView();
    if (pv.err) {
      wrap.child(div().text_size(11).text_color(t.blocked).truncate().child(pv.err));
    }
    return wrap;
  }

  /** A compact button in the action bar: icon + label, hover lights it up. */
  actionBtn(t, id, icon, label, tip, act, inert) {
    return h_flex()
      .id(id)
      .h(26)
      .px(8)
      .gap(5)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.raised)
      .items_center()
      .cursor_pointer()
      .text_size(11.5)
      .text_color(t.muted)
      .tooltip(tip)
      .hover((h) => h.bg(t.hover).text_color(t.foreground))
      .when(!inert, (el) => el.on_click(act))
      .child(svg(icon).size(12).flex_none())
      .child(label);
  }

  /** Detects the machine's editor CLI once (cursor/code/zed/subl); pump calls it. */
  maybeDetectEditor(machine, cx) {
    const key = machine ?? "";
    if (this.editors.has(key)) return;
    this.editors.set(key, { path: null, busy: true });
    cx.spawn(async (cx) => {
      let path = null;
      try {
        // Windows (F10): Git sh answers with an MSYS path exec can't start, so
        // ask where.exe; it exits 1 when some names are missing — don't check.
        // Decide by the target machine's home: a remote may differ from here.
        const target = machine ? await this.homeFor(machine) : home();
        if (isWinHome(target)) {
          const r = await exec("where.exe", ["cursor.cmd", "code.cmd", "zed.exe", "subl.exe"], { on: machine });
          path = whereFirstPath(r.stdout);
        } else {
          const r = await exec(
            "sh",
            ["-c", "command -v cursor || command -v code || command -v zed || command -v subl"],
            { on: machine }
          );
          path = r.code === 0 ? r.stdout.trim().split("\n")[0] || null : null;
        }
      } catch {}
      this.editors.set(key, { path, busy: false });
      cx.notify();
    });
  }

  /** The Push action: push the branch the button showed, then refresh git+PR. */
  async pushBranch(cx) {
    const s = this.session();
    this.ctx.select(s.machine, s.cwd);
    const op = this.ctx.beginPush(); // captures machine, top and branch once
    if (!op) return;
    cx.notify();
    let res;
    try {
      const r = await exec("git", ["push", "-u", "origin", op.branch], { cwd: op.top, on: op.machine, timeout: 60000 });
      res = r.code === 0 ? { ok: true } : { ok: false, err: (r.stderr ?? "").split("\n").find((l) => l.trim()) ?? "Push failed" };
    } catch {
      res = { ok: false, err: "Push failed" };
    }
    if (this.ctx.finishPush(op, res, Date.now()) && res.ok) cx.timer.after(1500, (cx) => cx.notify());
    cx.notify();
  }

  // ---- card building blocks ---------------------------------------------

  /** A panel card: thin border, rounded, slightly darker than the panel. */
  cardShell(t) {
    return v_flex().flex_none().border_b(1).border_color(t.border).px(12).py(10).gap(5);
  }

  cardTitle(t, text) {
    return div().text_size(11.5).font_medium().text_color(t.muted).min_w(0).truncate().child(text);
  }

  /** A small tinted pill: "Open", "Approved", an agent's status word, … */
  pill(t, text, token) {
    const el = div()
      .flex_none()
      .h(16)
      .px(5)
      .rounded(4)
      .text_size(10.5)
      .font_medium()
      .flex()
      .items_center()
      .child(text);
    // Draft (token "dim") gets the quiet raised look; the rest a ~18% tint.
    if (token === "dim") return el.bg(t.raised).text_color(t.dim);
    return el.bg(`${t[token]}2e`).text_color(t[token]);
  }

  /** The status dot + lowercase word a sub-agent row shows at its right. */
  subStatus(t, st) {
    const word = st ? stateWord(st) : "·";
    const color = st ? t[st] : t.dim;
    return [
      div().flex_none().size(6).rounded(3).bg(color),
      div().flex_none().text_size(10.5).text_color(color).child(word),
    ];
  }

  /** Tiny dim action label (Peek, Keep as tab) at a row's right. */
  smallDim(t, id, label, act) {
    return div()
      .id(id)
      .h(18)
      .px(5)
      .flex_none()
      .rounded(4)
      .text_size(10)
      .text_color(t.dim)
      .flex()
      .items_center()
      .cursor_pointer()
      .hover((h) => h.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => act(cx))
      .child(label);
  }

  /** Text that opens a URL: underline on hover and a pointer cursor. */
  linkEl(t, id, text, url, color) {
    return div()
      .id(id)
      .min_w(0)
      .truncate()
      .text_size(12)
      .text_color(color ?? t.foreground)
      // Dashed bottom border on hover (gpui has no dotted underline); kept in the
      // surface colour otherwise so hovering never shifts the layout.
      .when(Boolean(url), (el) => el.cursor_pointer().border_b(1).border_dashed().border_color(t.surface)
        .hover((h) => h.border_color(t.dim)).on_click(() => this.openUrl(url)))
      .child(text);
  }

  openUrl(url) {
    const platform = appWindow()?.platform;
    if (platform === "windows") exec("cmd", ["/c", "start", "", url]).catch(() => {});
    else if (platform === "linux") exec("xdg-open", [url]).catch(() => {});
    else exec("open", [url]).catch(() => {});
  }

  programIcon(program, size, color) {
    if (!program?.icon) return null;
    return program.tint
      ? svg(program.icon).size(size).flex_none().text_color(color)
      : image(program.icon).w(size).h(size).flex_none();
  }

  // ---- git card ----------------------------------------------------------

  /**
   * True once git has been read for this tab's folder. The per-context cache
   * (gitctx) answers for the context the tab is showing: a tab change keeps
   * the previous folder's cached data on screen ("Updating…"), an unseen one
   * shows "Refreshing…" instead of another repo's branch.
   */
  gitReady(s) {
    this.ctx.select(s.machine, s.cwd);
    return this.ctx.gitReady();
  }

  /** True once the PR lookup has finished for this tab's folder+branch. */
  prReady(s) {
    this.ctx.select(s.machine, s.cwd);
    return this.ctx.prReady();
  }

  /** True once the chosen agent's own store has been read (not the previous tab's). */
  tasksReady(s) {
    const key = s.chosen ? `${s.chosen.address}@${s.machine ?? ""}` : null;
    return this.tasks.read && this.tasks.key === key;
  }

  /** The "Refreshing…" badge a card header shows while its data loads. */
  refreshing(t) {
    return h_flex().gap(5).items_center().flex_none().text_size(11).text_color(t.dim)
      .child(svg("mods/ranch-session/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
      .child("Refreshing\u2026");
  }

  /** The quieter badge for cached data that is being refreshed in place. */
  updating(t) {
    return h_flex().gap(5).items_center().flex_none().text_size(11).text_color(t.dim)
      .child(svg("mods/ranch-session/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
      .child("Updating\u2026");
  }

  /** Dim "as of 12s" badge: the data on screen is that old. */
  asOf(t, label) {
    return div().flex_none().text_size(11).text_color(t.dim).child(label);
  }

  gitCard(t, s, set) {
    const card = this.cardShell(t);
    const ready = this.gitReady(s);
    // Header badge: "Refreshing…" with nothing cached, "Updating…" over data
    // being refreshed in place, "as of …" once it is older than the cadence.
    const age = this.ctx.gitAge(Date.now());
    const badge = !s.cwd
      ? null
      : !ready
        ? this.refreshing(t)
        : this.ctx.gitUpdating()
          ? this.updating(t)
          : age != null && age > this.gitEveryMs(s, set)
            ? this.asOf(t, ageLabel(age))
            : null;
    card.child(
      h_flex().gap(6).items_center().min_w(0)
        .child(this.cardTitle(t, "Git"))
        .child(div().flex_1().min_w(0))
        .when(Boolean(badge), (el) => el.child(badge))
    );
    if (!s.cwd) {
      card.child(div().text_size(12).text_color(t.dim).child("—"));
      return card;
    }
    // Another folder's data would mislead: wait for this tab's read.
    if (!ready) return card;
    const e = this.ctx.gitEntry();
    const sum = e?.summary ?? null;
    if (!sum) {
      card.child(div().text_size(12).text_color(t.dim).child(e?.failed ? "Git unavailable" : "No git repo"));
      return card;
    }
    const lk = sum.host ? links(sum.host) : null;

    // Branch (R-SD-5) and the ref it compares against.
    const ref = sum.vsDefault?.ref ?? sum.default ?? null;
    const branchRow = h_flex().gap(5).items_center().min_w(0);
    branchRow.child(svg("mods/ranch-session/git-branch.svg").size(12).flex_none().text_color(t.muted));
    if (sum.detached) {
      branchRow.child(div().min_w(0).truncate().text_size(12).child(`detached @${sum.head ?? "?"}`));
    } else {
      branchRow.child(
        this.linkEl(t, "branch-link", sum.branch ?? "—", sum.branch && lk ? lk.branch(sum.branch) : null)
      );
    }
    if (ref) {
      branchRow.child(
        div().flex_none().max_w(140).truncate().text_size(11.5).text_color(t.dim).child(`→ ${ref}`)
      );
    }
    card.child(branchRow);

    // Ahead/behind against the branch's own upstream (R-SD-5).
    const remote = remoteText(sum.ahead, sum.behind);
    if (remote) {
      card.child(div().text_size(11.5).text_color(t.dim).child(`${remote} vs remote`));
    }

    // Commits vs the default branch (R-SD-5a); nothing to show at 0/0.
    const dbl = defaultBranchLine(sum);
    if (dbl && dbl.kind === "on-default") {
      card.child(div().text_size(12).text_color(t.muted).child(`On ${dbl.default}`));
    } else if (dbl && dbl.kind === "diverged" && (dbl.ahead || dbl.behind)) {
      const row = h_flex().gap(6).items_center().min_w(0);
      row.child(
        this.linkEl(
          t,
          "compare-link",
          `${dbl.ahead} ahead`,
          lk && dbl.default && sum.branch ? lk.compare(dbl.default, sum.branch) : null
        )
      );
      row.child(div().flex_none().text_size(12).text_color(t.dim).child("·"));
      row.child(
        div()
          .flex_none()
          .text_size(12)
          .text_color(dbl.behind > 0 ? t.blocked : t.muted)
          .when(dbl.behind > 0, (el) =>
            el.tooltip(`${dbl.default} has ${dbl.behind} commits this branch doesn't`)
          )
          .child(`${dbl.behind} behind`)
      );
      row.child(div().flex_none().text_size(12).text_color(t.dim).child(dbl.default));
      card.child(row);
    }

    // Changes vs the default branch (R-SD-6); the count toggles the file list.
    const stat = sum.stat;
    const hasStat = stat && (stat.files || stat.add || stat.del);
    const changes = h_flex().gap(6).items_center().min_w(0);
    if (hasStat) {
      changes.child(
        div()
          .id("files-toggle")
          .text_size(12)
          .cursor_pointer()
          .hover((h) => h.underline())
          .on_click((_e, cx) => {
            this.filesOpen = !this.filesOpen;
            cx.notify();
          })
          .child(`${stat.files} ${stat.files === 1 ? "file" : "files"}`)
      );
      changes.child(div().flex_none().text_size(12).text_color(t.done).child(`+${stat.add}`));
      changes.child(div().flex_none().text_size(12).text_color(t.blocked).child(`\u2212${stat.del}`));
    } else {
      changes.child(div().text_size(12).text_color(t.dim).child("No changes vs last commit"));
    }
    if (ref) changes.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`vs ${ref}`));
    card.child(changes);

    if (this.filesOpen) {
      const files = e.details?.files ?? [];
      const shown = files.slice(0, MAX_FILES);
      for (const [i, f] of shown.entries()) {
        const fr = fileRow(f);
        card.child(
          h_flex()
            .id(`file-${i}`)
            .pl(12)
            .h(22)
            .rounded(6)
            .gap(8)
            .items_center()
            .min_w(0)
            .cursor_pointer()
            .hover((h) => h.bg(t.hover))
            .on_click(() => run("layout.select", { stack: "panel-body", child: "changes" }))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(11.5)
                .text_color(t.muted)
                .child(truncateMiddle(fr.path, 44))
            )
            .child(div().flex_none().text_size(11).text_color(t.done).child(fr.add))
            .when(fr.del, (el) =>
              el.child(div().flex_none().text_size(11).text_color(t.blocked).child(fr.del))
            )
        );
      }
      if (files.length > shown.length) {
        card.child(
          div()
            .pl(12)
            .text_size(11)
            .text_color(t.dim)
            .child(`${files.length - shown.length} more files`)
        );
      }
    }

    // Recent commits (R-SD-8), collapsed by default.
    if (set.session.commits) {
      const commits = e.details?.commits ?? [];
      card.child(
        h_flex()
          .id("commits-toggle")
          .gap(4)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => this.toggleCommits(cx))
          .child(
            svg(this.commitsOpen ? "mods/ranch-session/chevron-down.svg" : "mods/ranch-session/chevron-right.svg")
              .size(11)
              .flex_none()
              .text_color(t.dim)
          )
          .child(div().text_size(11.5).text_color(t.dim).child(`Recent commits ${commits.length}`))
      );
      if (this.commitsOpen) {
        const now = Date.now();
        for (const [i, c] of commits.entries()) {
          card.child(
            h_flex()
              .id(`commit-${i}`)
              .gap(6)
              .items_center()
              .min_w(0)
              .child(this.linkEl(t, `commit-sha-${i}`, c.short, lk ? lk.commit(c.sha) : null))
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(c.subject))
              .child(
                div()
                  .flex_none()
                  .text_size(10.5)
                  .text_color(t.dim)
                  .truncate()
                  .child(relativeTime(now - c.time))
              )
          );
        }
      }
    }
    return card;
  }

  toggleCommits(cx) {
    this.commitsOpen = !this.commitsOpen;
    localStorage.setItem("commitsOpen", this.commitsOpen ? "1" : "0");
    cx.notify();
  }

  // ---- pull request card -------------------------------------------------

  prCard(t, s, set) {
    const ready = this.prReady(s);
    if (s.cwd && !ready) {
      return this.cardShell(t).child(
        h_flex().gap(6).items_center().min_w(0)
          .child(this.cardTitle(t, "Pull request"))
          .child(div().flex_1().min_w(0))
          .child(this.refreshing(t))
      );
    }
    const pe = ready ? this.ctx.prEntry() : null;
    const pr = pe?.parsed ?? null;
    const extra = this.recordedPrs(s, pr);
    if (!pr && !extra.length) return null;
    const sum = this.ctx.gitEntry()?.summary ?? null;
    const lk = sum?.host ? links(sum.host) : null;
    const url = pr ? (pr.url || (lk && pr.number ? lk.pr(pr.number) : null)) : null;
    const card = this.cardShell(t);

    const head = h_flex().gap(6).items_center().min_w(0);
    head.child(this.cardTitle(t, "Pull request"));
    head.child(div().flex_1().min_w(0));
    // Same badge rule as the git card, on the PR's own cadence.
    const now = Date.now();
    const badge = ready && this.ctx.prUpdating()
      ? this.updating(t)
      : pe && this.ctx.prs.has(this.ctx.prKey()) && now - pe.at > this.prEveryMs(set) // a real lookup, not the no-PR placeholder
        ? this.asOf(t, ageLabel(now - pe.at))
        : null;
    if (badge) head.child(badge);
    if (pr) {
      // The PR's own state as the label (the token is only its colour), in
      // GitHub's colours: open green, draft grey, merged purple, closed red.
      const stateToken = { open: "ansi2", draft: "dim", merged: "ansi5", closed: "blocked" }[pr.state];
      const stateLabel = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }[pr.state];
      if (stateToken) {
        head.child(this.pill(t, stateLabel, stateToken));
      }
      card.child(head);

      // "#1285 <title>", wrapping, opens the PR.
      const title = h_flex().id("pr-title").gap(6).items_start().min_w(0);
      title
        .when(Boolean(url), (el) => el.cursor_pointer().on_click(() => this.openUrl(url)))
        // Icon centred in a box one text line tall (12px type ≈ 18px line), so
        // it sits on the title's first line however the title wraps. Coloured
        // by the PR's state, like the pill.
        .child(
          h_flex().h(18).flex_none().items_center().child(
            svg("mods/ranch-session/git-pull-request.svg").size(13).text_color(stateToken ? t[stateToken] : t.dim)
          )
        )
        .child(
          div().flex_1().min_w(0).text_size(12).line_height(1.5).text_color(t.foreground).child(`#${pr.number} ${pr.title ?? ""}`)
        );
      card.child(title);

      const byline = [];
      if (pr.author) byline.push(`by ${pr.author}`);
      if (pr.base) byline.push(`into ${pr.base}`);
      if (pr.updatedAt) byline.push(`updated ${relativeTime(now - pr.updatedAt)}`);
      if (byline.length) {
        // Wraps like the title rather than cutting "updated 14m ago" off.
        card.child(div().text_size(11).text_color(t.dim).child(byline.join(" · ")));
      }

      const pills = [];
      const review = reviewPill(pr.review);
      if (review) pills.push(this.pill(t, review.text, review.token));
      if (pr.behind) pills.push(this.pill(t, "Behind base", "blocked"));
      if (pills.length) card.child(h_flex().gap(4).flex_wrap().children(pills));

      if (pr.approvedBy?.length) {
        card.child(div().text_size(11).text_color(t.done).child(`Approved by ${pr.approvedBy.join(", ")}`));
      }
      if (pr.reviewers?.length) {
        card.child(div().text_size(11).text_color(t.dim).child(`Waiting on ${pr.reviewers.join(", ")}`));
      }

      // CI checks, expanded by default while something failed.
      const summary = checksSummary(pr.checks);
      if (summary) {
        const open = this.ciOpen ?? pr.checks.fail > 0;
        card.child(
          h_flex()
            .id("ci-toggle")
            .gap(6)
            .items_center()
            .cursor_pointer()
            .on_click((_e, cx) => {
              this.ciOpen = !open;
              cx.notify();
            })
            .child(this.ciGlyph(t, checksGlyph(pr.checks)))
            .child(div().text_size(11.5).text_color(t.muted).child(`CI checks ${summary}`))
        );
        if (open) {
          for (const [i, c] of pr.checkList.entries()) {
            card.child(
              h_flex()
                .id(`ci-${i}`)
                .gap(6)
                .items_center()
                .min_w(0)
                .when(Boolean(c.url), (el) =>
                  el.cursor_pointer().hover((h) => h.bg(t.hover)).on_click(() => this.openUrl(c.url))
                )
                .child(this.ciGlyph(t, c.state))
                .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().child(c.name))
                .when(Boolean(c.workflow), (el) =>
                  el.child(
                    div()
                      .flex_none()
                      .max_w(Math.round((this.size?.width ?? 300) * 0.45))
                      .truncate()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(c.workflow)
                  )
                )
            );
          }
        }
      }
    }

    // PRs the agent created (`gh pr create`, recorded by the adapters, I4),
    // shown in addition to the branch PR. State/title come from the recorded
    // PR lookups (pump); until they arrive, show `#n owner/repo`.
    if (extra.length) {
      card.child(div().text_size(11).text_color(t.dim).child("Opened by agents on this branch:"));
      const now = Date.now();
      for (const p of extra) {
        const parsed = this.recordedPrCache.get(p.url, now) ?? null;
        const token = parsed ? prStateToken(parsed.state) : null;
        const label = parsed ? prStateLabel(parsed.state) : null;
        const repo = prRepoText(p.url) ?? p.url;
        card.child(
          h_flex()
            .id(`agent-pr-${p.number}`)
            .gap(6)
            .items_center()
            .min_w(0)
            .cursor_pointer()
            .hover((h) => h.bg(t.hover))
            .tooltip(p.url)
            .on_click(() => this.openUrl(p.url))
            .child(h_flex().h(18).flex_none().items_center().child(
              svg("mods/ranch-session/git-pull-request.svg").size(12).text_color(token ? t[token] : t.dim)
            ))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(t.foreground)
                .child(parsed?.title ? `#${p.number} ${parsed.title}` : `#${p.number} ${repo}`)
            )
            .when(Boolean(label), (el) => el.child(this.pill(t, label, token)))
        );
      }
    }
    return card;
  }

  /**
   * PR URLs the adapters recorded in the store (`gh pr create`, I4), from the
   * main agent's and each sub-agent's store, deduped against the branch PR.
   */
  recordedPrs(s, pr) {
    const branchUrl = this.branchPrUrl(pr);
    const seenUrls = new Set(branchUrl ? [branchUrl] : []);
    const out = [];
    const stores = [];
    if (this.tasksReady(s) && this.tasks.parsed?.ok) stores.push(this.tasks.parsed.store);
    for (const k of this.subTerminals(s)) {
      const entry = this.subTasks.get(k.address);
      if (entry?.parsed?.ok) stores.push(entry.parsed.store);
    }
    for (const store of stores) {
      for (const p of store.prs ?? []) {
        if (!p?.url || seenUrls.has(p.url)) continue;
        seenUrls.add(p.url);
        out.push(p);
      }
    }
    // The shared registry (…): PRs any terminal's agent opened on this repo
    // top + branch (the per-context git entry caches the top), merged with
    // the store records above, deduped, branch PR excluded.
    const e = this.ctx.gitReady() ? this.ctx.gitEntry() : null;
    const top = e?.top ?? e?.summary?.top ?? null;
    const branch = e?.summary?.branch ?? null;
    for (const p of top && branch ? prsFor(this.prRegistry.parsed, top, branch) : []) {
      if (!p?.url || seenUrls.has(p.url)) continue;
      seenUrls.add(p.url);
      out.push(p);
    }
    return out;
  }

  /** The branch PR's URL (gh's, else built from the host and number). */
  branchPrUrl(pr) {
    const host = this.ctx.gitEntry()?.summary?.host;
    return pr?.url || (host && pr?.number ? links(host).pr(pr.number) : null);
  }

  /** The CI glyph: ✕ failed, ○ ring running, ✓ passed, – skipped. */
  ciGlyph(t, kind) {
    if (kind === "fail") {
      return div().flex_none().text_size(10.5).text_color(t.blocked).child("\u2715");
    }
    if (kind === "pending") {
      return div().flex_none().size(9).rounded(5).border(1.5).border_color(t.working);
    }
    if (kind === "skipped") {
      return div().flex_none().text_size(10.5).text_color(t.dim).child("\u2013");
    }
    return svg("mods/ranch-session/check.svg").size(11).flex_none().text_color(t.done);
  }

  // ---- sub-agents card ---------------------------------------------------

  subsCard(t, s) {
    const herdrSubs = terminals().filter((k) => k.parent === s.chosen.address && k.state === "live");
    // Nesting (fixes 3.6): a store sub-agent that belongs to one of the
    // Herdr sub terminals shows in that terminal's card, not twice here.
    const nested = new Set(herdrSubs.map((k) => k.address));
    const tasksReady = this.tasksReady(s);
    const storeSubs = (tasksReady && this.tasks.parsed?.ok ? this.tasks.parsed.store.subagents : [])
      .filter((sub) => !sub.parent_terminal || !nested.has(sub.parent_terminal));
    if (!herdrSubs.length && !storeSubs.length) return null;
    const card = this.cardShell(t);
    // Header counts from the display status (subStatus), not the raw word.
    let running = 0;
    let done = 0;
    for (const k of herdrSubs) {
      const st = this.subAgentStatus(k);
      if (st === "working") running++;
      else if (st === "done") done++;
    }
    for (const sub of storeSubs) {
      if (sub.status === "running") running++;
      else done++;
    }
    card.child(
      this.cardTitle(
        t,
        running || done
          ? `Sub-agents \u00b7 ${running} running${done ? ` \u00b7 ${done} done` : ""}`
          : `Sub-agents \u00b7 ${herdrSubs.length + storeSubs.length}`
      )
    );
    for (const k of herdrSubs) {
      const st = this.subAgentStatus(k);
      const pic = this.programIcon(k.program, 14, t.foreground);
      const row = h_flex()
        .id(`sub-${k.address}`)
        .gap(6)
        .items_center()
        .min_w(0)
        .when(pic, (el) => el.child(pic))
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(11.5)
            .font_medium()
            .child(k.name || k.template || k.program?.name || k.address)
        );
      for (const el of this.subStatus(t, st)) row.child(el);
      row.child(
        this.smallDim(t, `peek-${k.address}`, "Peek", () => run("terminal.peek", { terminal: k.address }))
      );
      row.child(
        this.smallDim(t, `keep-${k.address}`, "Keep as tab", () => run("terminal.keep", { terminal: k.address }))
      );
      card.child(row);
    }
    for (const sub of storeSubs) {
      const tok = sub.status === "running" ? "working" : sub.status === "failed" ? "blocked" : "done";
      const word = sub.status === "running" ? "working" : sub.status === "failed" ? "failed" : "done";
      const color = t[tok];
      card.child(
        h_flex()
          .id(`store-sub-${sub.id}`)
          .gap(6)
          .items_center()
          .min_w(0)
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().child(sub.name))
          .child(div().flex_none().size(6).rounded(3).bg(color))
          .child(div().flex_none().text_size(10.5).text_color(color).child(word))
      );
    }
    return card;
  }

  // ---- tasks cards -------------------------------------------------------

  /**
   * One Tasks card: the main agent (always, empty states included) or a Herdr
   * sub-agent that has tasks.
   */
  tasksCard(t, s, sub) {
    const isMain = !sub;
    const addr = isMain ? s.chosen.address : sub.address;
    const entry = isMain ? this.tasks : this.subTasks.get(addr) ?? null;
    const parsed = entry?.parsed ?? null;
    const read = isMain ? this.tasksReady(s) : Boolean(entry?.read);
    const card = this.cardShell(t);
    const open = this.tasksOpen.get(addr) ?? true;

    const head = h_flex().gap(6).items_center().min_w(0);
    const status = isMain ? s.chosen.status : this.subAgentStatus(sub);
    // A stale done list is hidden ("No recent activity"), so no count either.
    const stale = parsed?.ok && listLifecycle(parsed.store, status, Date.now()).hide;
    const prog = read && parsed?.ok && !stale ? progress(this.liveTasks(parsed.store.tasks)) : { done: 0, total: 0 };
    const label = isMain
      ? "Tasks"
      : `Tasks \u00b7 ${sub.name || sub.template || sub.program?.name || sub.address}`;
    head.child(
      div()
        .text_size(11.5)
        .font_medium()
        .text_color(t.muted)
        .min_w(0)
        .truncate()
        .child(prog.total ? `${label} ${prog.done}/${prog.total}` : label)
    );
    head.child(div().flex_1().min_w(0));
    if (!read) head.child(this.refreshing(t));
    if (status) head.child(this.pill(t, stateWord(status), status));
    // "no task updates" badge (fixes F13): the agent kept working but the
    // list stopped changing.
    if (read && parsed?.ok && parsed.store.missed_turns > 0) {
      head.child(this.pill(t, "no task updates", "blocked"));
    }
    head.child(
      h_flex()
        .id(`tasks-fold-${addr}`)
        .p(2)
        .cursor_pointer()
        .on_click((_e, cx) => {
          this.tasksOpen.set(addr, !open);
          cx.notify();
        })
        .child(
          svg(open ? "mods/ranch-session/chevron-down.svg" : "mods/ranch-session/chevron-right.svg")
            .size(11)
            .flex_none()
            .text_color(t.dim)
        )
    );
    card.child(head);
    if (!open) return card;

    if (!read) return card; // the header shows "Refreshing…"

    // Identity check (fixes F4): show the list only when the terminal is
    // still live and its start time matches the store's.
    if (parsed?.ok && !listVisible(parsed, this.liveFor(isMain ? s.chosen : sub, s.machine))) {
      if (isMain) card.child(div().text_size(12).text_color(t.muted).child("No tasks for this terminal."));
      return isMain ? card : null;
    }

    if (isMain) {
      // Empty and setup states live in the main agent's card.
      const adapters = this.adapterState(s);
      const empty = taskEmptyState(parsed, s.chosen?.app, adapters?.[adapterKey(s.chosen?.app)] ?? (adapters ? "missing" : undefined));
      if (empty) {
        card.child(div().text_size(12).text_color(t.muted).child(empty.text));
        if (empty.setup) card.child(this.setUpRow(t));
        if (this.setupResult) card.child(this.setupResultRow(t));
        return card;
      }
    } else if (!parsed?.ok) {
      return null; // no parsed store yet: no card
    } else if (!parsed.store.tasks.length) {
      // A sub-agent with a parsed store but no plan still gets its card.
      card.child(div().text_size(12).text_color(t.muted).child("No plan yet."));
      return card;
    }

    // Lifecycle (fixes 3.5): fade out stale done lists, flag idle-with-work.
    const lc = listLifecycle(parsed.store, status, Date.now());
    if (lc.hide) {
      if (!isMain) return null;
      card.child(div().text_size(12).text_color(t.muted).child("No recent activity."));
      return card;
    }

    // Progress bar: working-coloured while something runs, done when not.
    const tasks = parsed.store.tasks;
    const width = Math.max(0, (this.size?.width ?? 0) - 40);
    const fill = tasks.some((x) => x.status === "in_progress") ? t.working : t.done;
    card.child(
      div()
        .w_full()
        .h(3)
        .flex_none()
        .rounded(2)
        .bg(t.border)
        .when(prog.done > 0, (el) =>
          el.child(
            div().h(3).rounded(2).bg(fill).w(Math.max(2, Math.round((width * prog.done) / prog.total)))
          )
        )
    );
    // Freshness (fixes 3.6): "updated N ago", greyed out when stale.
    const age = Date.now() - Date.parse(parsed.store.updated_at);
    if (Number.isFinite(age) && age >= 0) {
      card.child(
        div()
          .text_size(10.5)
          .text_color(lc.fresh ? t.muted : t.dim)
          .child(`Updated ${relativeTime(age)}`)
      );
    }
    if (lc.flag) {
      card.child(div().text_size(10.5).text_color(t.muted).child("Agent stopped while working on this"));
    }
    // Cancelled tasks render struck through, after the live ones.
    const cancelled = tasks.filter((x) => x.status === "cancelled");
    for (const task of [...orderTasks(this.liveTasks(tasks)), ...cancelled]) card.child(this.taskRow(t, task, addr));
    return card;
  }

  taskRow(t, task, addr) {
    const row = h_flex().id(`task-${addr}-${task.id}`).h(20).px(4).gap(8).items_center().min_w(0);
    if (task.status === "in_progress") {
      return row
        .child(svg("mods/ranch-session/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
        .child(
          div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground)
            .child(task.active_form || task.title)
        );
    }
    if (task.status === "pending") {
      return row
        .child(div().size(9).flex_none().rounded(5).border(1.5).border_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(task.title));
    }
    if (task.status === "cancelled") {
      return row
        .child(div().flex_none().text_size(11).text_color(t.dim).child("\u2013"))
        .child(
          div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).line_through()
            .child(task.title)
        );
    }
    return row
      .child(svg("mods/ranch-session/check.svg").size(11).flex_none().text_color(t.done))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(task.title));
  }

  /**
   * Tasks cards for the Herdr sub-agents that have a parsed store; a store
   * with no tasks shows its "No plan yet." empty state.
   */
  subTaskCards(t, s) {
    const cards = [];
    for (const k of this.subTerminals(s)) {
      const entry = this.subTasks.get(k.address);
      if (!entry?.parsed?.ok) continue;
      const card = this.tasksCard(t, s, k);
      if (card) cards.push(card);
    }
    return cards;
  }

  setUpRow(t) {
    return div()
      .id("tasks-setup")
      .h(24)
      .px(10)
      .rounded(7)
      .bg(t.solid)
      .text_color(t.solid_foreground)
      .text_size(11.5)
      .font_semibold()
      .flex()
      .items_center()
      .cursor_pointer()
      .hover((h) => h.opacity(0.88))
      .on_click((_e, cx) => this.setUpTasks(cx))
      .child(this.settingUp ? "Setting up\u2026" : "Set up");
  }

  setupResultRow(t) {
    return div()
      .text_size(11.5)
      .text_color(t.dim)
      .child(
        this.setupResult === "missing"
          ? "Install Ranch's task reporting: see Ranch settings."
          : this.setupResult
      );
  }
}
