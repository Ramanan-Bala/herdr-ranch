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
  repoSummary,
  repoDetails,
  links,
  parsePr,
  runGh,
  PR_JSON_FIELDS,
} from "./lib/git.js";
import { TASKS_DIR, SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { parseStore, orderTasks, progress, storeFileName } from "./lib/tasks.js";
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
} from "./model.js";

const MAX_FILES = 20;

export default class RanchSession extends View {
  init(_props, cx) {
    this.remembered = new Map(); // tabId -> chosen agent address
    this.homes = new Map(); // machine (null excepted) -> its home dir
    this.tasks = { key: null, parsed: null, read: false };
    this.tasksBusy = false;
    this.tasksPending = false;
    this.tasksWatchGen = 0;
    this.subTasks = new Map(); // sub address -> { parsed, read, at, busy }
    this.git = { key: null, summary: null, details: null, top: null, busy: false, dirty: true, at: 0 };
    this.gitWatchGen = 0;
    this.pr = { key: null, parsed: null, busy: false, dirty: true, at: 0, failed: false };
    this.sessionKey = null;
    this.commitsOpen = localStorage.getItem("commitsOpen") === "1";
    this.filesOpen = false;
    this.ciOpen = null; // null: follow the default (open when checks failed)
    this.tasksOpen = new Map(); // agent address -> collapsed?
    this.settingUp = false;
    this.setupResult = null; // string output, "missing", or null
    this.size = null;
    cx.timer.every(1000, (cx) => this.pump(cx));
    this.watchTasks(cx);
    this.pump(cx);
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
      machineLabel: space?.machine ?? "This Mac",
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
    return null;
  }

  choose(agent, cx) {
    const tabId = focused()?.tab;
    if (!tabId || this.remembered.get(tabId) === agent.address) return;
    this.remembered.set(tabId, agent.address);
    this.filesOpen = false;
    this.loadTasks(cx);
    this.git.dirty = true;
    this.pr.dirty = true;
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
        this.loadTasks(cx);
      }
    });
  }

  /** Reads the chosen agent's store file (one read in flight). */
  async loadTasks(cx) {
    if (this.tasksBusy) {
      this.tasksPending = true;
      return;
    }
    this.tasksBusy = true;
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
      const name = storeFileName(agent.address);
      let parsed = { ok: false, reason: "missing" };
      if (homeDir && name) {
        try {
          const text = await readTextFile(`${homeDir}/${TASKS_DIR}/${name}`, { on: s.machine });
          parsed = parseStore(text);
        } catch {}
      }
      if (this.tasks.key !== key) this.filesOpen = false;
      this.tasks = { key, parsed, read: true };
      cx.notify();
      this.publishTaskCount(s);
      this.loadSubTasks(s, cx);
    } finally {
      this.tasksBusy = false;
      if (this.tasksPending) {
        this.tasksPending = false;
        this.loadTasks(cx);
      }
    }
  }

  /** Terminals the chosen agent started (its Herdr sub-agents). */
  subTerminals(s) {
    return s.chosen ? terminals().filter((k) => k.parent === s.chosen.address) : [];
  }

  /**
   * Reads each Herdr sub-agent's store file the same way as the main one,
   * at most every 3 s per address; feeds its Tasks card and the totals.
   */
  async loadSubTasks(s, cx) {
    const subs = this.subTerminals(s);
    const live = new Set(subs.map((k) => k.address));
    for (const addr of this.subTasks.keys()) if (!live.has(addr)) this.subTasks.delete(addr);
    const homeDir = await this.homeFor(s.machine);
    const now = Date.now();
    for (const k of subs) {
      const entry = this.subTasks.get(k.address) ?? { parsed: null, read: false, at: 0, busy: false };
      this.subTasks.set(k.address, entry);
      if (entry.busy || now - entry.at < 3000) continue;
      entry.busy = true;
      entry.at = now;
      cx.spawn(async (cx) => {
        const name = storeFileName(k.address);
        let parsed = { ok: false, reason: "missing" };
        if (homeDir && name) {
          try {
            const text = await readTextFile(`${homeDir}/${TASKS_DIR}/${name}`, { on: s.machine });
            parsed = parseStore(text);
          } catch {}
        }
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

  /** The main agent's and each sub-agent's task list (only parsed stores). */
  taskLists(s) {
    const lists = [];
    if (this.tasks.parsed?.ok) lists.push(this.tasks.parsed.store.tasks);
    for (const k of this.subTerminals(s)) {
      const entry = this.subTasks.get(k.address);
      if (entry?.parsed?.ok) lists.push(entry.parsed.store.tasks);
    }
    return lists;
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
        const r = dir ? await exec(`${dir}/.herdr/ranch/bin/ranch-tasks`, ["status", "--json"], { on: machine, timeout: 10000 }) : null;
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
        const r = await exec(`${homeDir}/.herdr/ranch/bin/ranch-tasks`, ["install", "--yes"], { on: s.machine });
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
    if (this.git.busy) {
      this.git.dirty = true;
      return;
    }
    const s = this.session();
    if (!s.cwd) {
      this.git = { key: null, summary: null, details: null, top: null, busy: false, dirty: false, at: Date.now() };
      cx.notify();
      return;
    }
    const key = `${s.machine ?? ""}|${s.cwd}`;
    this.git.key = key;
    this.git.busy = true;
    this.git.dirty = false;
    const git = (args) => exec("git", args, { cwd: s.cwd, on: s.machine, timeout: 10000 });
    try {
      const summary = await repoSummary(git);
      const details = summary ? await repoDetails(git, summary.base, { commits: 5 }) : null;
      if (this.git.key !== key) return; // session changed mid-flight; pump redoes it
      this.git.summary = summary;
      this.git.details = details;
      this.git.top = summary?.top ?? null;
    } catch {
      if (this.git.key !== key) return;
      this.git.summary = null;
      this.git.details = null;
      this.git.top = null;
    }
    this.git.busy = false;
    this.git.at = Date.now();
    cx.notify();
    this.watchGit(cx);
  }

  /** Local only: repo changes set a dirty flag the 1 s timer acts on. */
  watchGit(cx) {
    const gen = ++this.gitWatchGen;
    const top = this.git.top;
    if (!top || this.session().machine != null) return;
    cx.spawn(async (cx) => {
      while (this.gitWatchGen === gen) {
        try {
          await watchFolder(top);
        } catch {
          await cx.sleep(5000);
          continue;
        }
        if (this.gitWatchGen !== gen) return;
        this.git.dirty = true;
      }
    });
  }

  async refreshPr(cx) {
    if (this.pr.busy) {
      this.pr.dirty = true;
      return;
    }
    const s = this.session();
    const branch = this.git.summary?.branch ?? null;
    // No PR to look up on the default branch or without a known web host.
    const noPr = branch && (branch === this.git.summary?.default || !this.git.summary?.host);
    if (!s.cwd || !branch || noPr) {
      this.pr = { key: null, parsed: null, busy: false, dirty: false, at: Date.now(), failed: false };
      cx.notify();
      return;
    }
    const key = `${s.machine ?? ""}|${s.cwd}|${branch}`;
    this.pr.key = key;
    this.pr.busy = true;
    this.pr.dirty = false;
    try {
      const gh = (cmd, args) => exec(cmd, args, { cwd: s.cwd, on: s.machine, timeout: 15000 });
      const r = await runGh(gh, ["pr", "view", branch, "--json", PR_JSON_FIELDS]);
      if (this.pr.key !== key) return;
      if (r.missing) {
        this.pr.parsed = null;
        this.pr.failed = "missing";
      } else if (r.code === 0) {
        try {
          this.pr.parsed = parsePr(JSON.parse(r.stdout));
          this.pr.failed = false;
        } catch {
          this.pr.parsed = null;
          this.pr.failed = true;
        }
      } else if (/no pull request/i.test(r.stderr ?? "")) {
        this.pr.parsed = null; // no PR for this branch
        this.pr.failed = false;
      } else {
        this.pr.parsed = null;
        this.pr.failed = true;
      }
    } catch {
      if (this.pr.key !== key) return;
      this.pr.parsed = null;
      this.pr.failed = true;
    }
    this.pr.busy = false;
    this.pr.at = Date.now();
    cx.notify();
  }

  /** The 1 s heartbeat: session changes, task re-reads and refresh cadence. */
  pump(cx) {
    const now = Date.now();
    const set = resolveSettings(shared(SETTINGS_KEY));
    const s = this.session();
    const key = `${s.machine ?? ""}|${s.cwd ?? ""}`;
    if (key !== this.sessionKey) {
      this.sessionKey = key;
      this.git.dirty = true;
      this.pr.dirty = true;
      this.filesOpen = false;
      this.ciOpen = null;
      const tkey = s.chosen ? `${s.chosen.address}@${s.machine ?? ""}` : null;
      if (tkey !== this.tasks.key) this.loadTasks(cx);
      else this.loadSubTasks(s, cx);
    }
    // Only needed while the store is missing (to offer Set up), once a minute.
    if (s.chosen && this.tasks.parsed && !this.tasks.parsed.ok && this.tasks.parsed.reason === "missing") {
      this.maybeCheckAdapters(s.machine, cx);
    }
    // The tasks folder is only watched locally; poll a remote machine's store.
    if (s.machine != null && s.chosen && now - (this.tasksReadAt ?? 0) >= 5000) {
      this.tasksReadAt = now;
      this.loadTasks(cx);
    }
    // Git: immediately on change, then 30 s locally (watchFolder covers the
    // gaps) and refresh.remoteGitSec on another machine.
    const gitEvery = s.machine != null ? Math.max(1, set.refresh.remoteGitSec) * 1000 : 30000;
    if (!this.git.busy && (this.git.dirty || now - this.git.at >= gitEvery)) this.refreshGit(cx);
    // PR: every refresh.prSec, sooner when the branch changed.
    const prKey = `${s.machine ?? ""}|${s.cwd ?? ""}|${this.git.summary?.branch ?? ""}`;
    if (prKey !== this.pr.key) this.pr.dirty = true;
    const prEvery = Math.max(5, set.refresh.prSec) * 1000;
    if (!this.pr.busy && (this.pr.dirty || now - this.pr.at >= prEvery)) this.refreshPr(cx);
  }

  // ---- ui ---------------------------------------------------------------

  render(cx) {
    const t = theme();
    const set = resolveSettings(shared(SETTINGS_KEY));
    const s = this.session();
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
    if (!s.chosen) {
      // No agent: no tasks or sub-agents, but the tab's git state still applies.
      root.child(div().text_size(12).text_color(t.dim).px(12).py(10).child("No agent in this tab"));
      if (set.session.git) root.child(this.gitCard(t, s, set));
      return root;
    }
    if (set.session.git) {
      root.child(this.gitCard(t, s, set));
      // Only gh itself being absent is worth a word; other failures stay quiet.
      if (this.pr.failed === "missing") {
        root.child(div().text_size(12).text_color(t.dim).px(12).py(10).child("GitHub CLI not found"));
      }
      const pr = this.prCard(t);
      if (pr) root.child(pr);
    }
    if (set.session.subagents) {
      const subs = this.subsCard(t, s);
      if (subs) root.child(subs);
    }
    if (set.session.tasks) {
      root.child(this.tasksCard(t, s, null));
      for (const card of this.subTaskCards(t, s)) root.child(card);
    }
    return root;
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
    row.child(
      div()
        .flex_1()
        .min_w(0)
        .text_size(11.5)
        .text_color(t.dim)
        .truncate()
        .child(subtitle(this.totals(s)))
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
    return totalsOf(this.taskLists(s));
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

  gitCard(t, s, set) {
    const card = this.cardShell(t);
    card.child(this.cardTitle(t, "Git"));
    const sum = this.git.summary;
    if (!s.cwd) {
      card.child(div().text_size(12).text_color(t.dim).child("—"));
      return card;
    }
    if (!sum) {
      card.child(div().text_size(12).text_color(t.dim).child("No git repo"));
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
      const files = this.git.details?.files ?? [];
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
      const commits = this.git.details?.commits ?? [];
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

  prCard(t) {
    const pr = this.pr.parsed;
    if (!pr) return null;
    const sum = this.git.summary;
    const lk = sum?.host ? links(sum.host) : null;
    const url = pr.url || (lk && pr.number ? lk.pr(pr.number) : null);
    const card = this.cardShell(t);

    const head = h_flex().gap(6).items_center().min_w(0);
    head.child(this.cardTitle(t, "Pull request"));
    head.child(div().flex_1().min_w(0));
    const stateToken = { open: "working", draft: "dim", merged: "done", closed: "blocked" }[pr.state];
    if (stateToken) {
      head.child(this.pill(t, stateToken[0].toUpperCase() + stateToken.slice(1), stateToken));
    }
    card.child(head);

    // "#1285 <title>", wrapping, opens the PR.
    const title = h_flex().id("pr-title").gap(6).items_start().min_w(0);
    title
      .when(Boolean(url), (el) => el.cursor_pointer().on_click(() => this.openUrl(url)))
      .child(svg("mods/ranch-session/git-pull-request.svg").size(13).flex_none().text_color(t.working))
      .child(
        div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(`#${pr.number} ${pr.title ?? ""}`)
      );
    card.child(title);

    const now = Date.now();
    const byline = [];
    if (pr.author) byline.push(`by ${pr.author}`);
    if (pr.base) byline.push(`into ${pr.base}`);
    if (pr.updatedAt) byline.push(`updated ${relativeTime(now - pr.updatedAt)}`);
    if (byline.length) {
      card.child(div().text_size(11).text_color(t.dim).truncate().child(byline.join(" · ")));
    }

    const pills = [];
    const review = reviewPill(pr.review);
    if (review) pills.push(this.pill(t, review.text, review.token));
    if (pr.behind) pills.push(this.pill(t, "Behind base", "blocked"));
    if (pills.length) card.child(h_flex().gap(4).flex_wrap().children(pills));

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
    return card;
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
    const storeSubs = this.tasks.parsed?.ok ? this.tasks.parsed.store.subagents : [];
    if (!herdrSubs.length && !storeSubs.length) return null;
    const card = this.cardShell(t);
    card.child(this.cardTitle(t, `Sub-agents \u00b7 ${herdrSubs.length + storeSubs.length}`));
    for (const k of herdrSubs) {
      const st = herdrSubStatus(k);
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
    const read = isMain ? this.tasks.read : Boolean(entry?.read);
    const card = this.cardShell(t);
    const open = this.tasksOpen.get(addr) ?? true;

    const head = h_flex().gap(6).items_center().min_w(0);
    const prog = parsed?.ok ? progress(parsed.store.tasks) : { done: 0, total: 0 };
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
    const status = isMain ? s.chosen.status : herdrSubStatus(sub);
    if (status) head.child(this.pill(t, stateWord(status), status));
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

    if (!read) {
      card.child(div().text_size(11.5).text_color(t.dim).child("Loading\u2026"));
      return card;
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
    } else if (!parsed?.ok || !parsed.store.tasks.length) {
      return null; // only called for sub-agents with tasks
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
    for (const task of orderTasks(tasks)) card.child(this.taskRow(t, task, addr));
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
    return row
      .child(svg("mods/ranch-session/check.svg").size(11).flex_none().text_color(t.done))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(task.title));
  }

  /** Tasks cards for the Herdr sub-agents that have tasks. */
  subTaskCards(t, s) {
    const cards = [];
    for (const k of this.subTerminals(s)) {
      const entry = this.subTasks.get(k.address);
      if (!entry?.parsed?.ok || !entry.parsed.store.tasks.length) continue;
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
