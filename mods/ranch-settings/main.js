import { View, div, image, svg } from "gpui-kit";
import { Popover, v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, run, exec, home, knownAgents, nextCommand, spaces, readTextFile, window as appWindow } from "herdr";
import { runGh } from "./lib/git.js";
import { SETTINGS_KEY, MAX_AGENTS, resolveSettings, withSetting } from "./lib/settings.js";
import { tasksCommand, looksWindows } from "./lib/tasks-command.js";
import { homeCache } from "./lib/home.js";
import { pushBridge, bridgeMissing } from "./lib/remote-bridge.js";
import { EdgeGrip } from "./lib/edge-grip.js";

// Ranch settings panel: one flat list. Every row sits on the same grid
// (label left, control right, 28px tall); sections are split by a hairline,
// never boxed. System status stays quiet unless something needs the person.

// Windows can't exec the POSIX sh launcher; it calls node on the .js entry.
// Locally that is the app's platform; on a remote machine its home path says.
const isWin = () => appWindow()?.platform === "windows";
const tasksCmd = (dir, args, machine) => tasksCommand(dir, args, machine ? looksWindows(dir) : isWin());
const UPDATE_KEY = "ranch.update.byMachine"; // { [machine or ""]: { upd, checkedAt } }
const UPDATE_EVERY = 30 * 60_000;
const IDLE_UPD = { state: "checking", installed: null, latest: null, message: "", bridgeOnly: false };
const TASK_KEYS = ["claude", "codex", "opencode", "pi"];
const HERDR_MIN = [0, 1, 15];
const ROW_H = 28;

const displayName = (key, known) => (key === "terminal" ? "Terminal" : known.find((k) => k.key === key)?.name || key);

const semver = (out) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out || "");
  return m ? [+m[1], +m[2], +m[3]] : null;
};

const cmp = (a, b) => {
  for (let i = 0; i < b.length; i++) if ((a?.[i] ?? 0) !== b[i]) return (a?.[i] ?? 0) - b[i];
  return 0;
};

export default class RanchSettings extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    // knownAgents() result: [{key, name, icon, tint, run, installed}]. It can take
    // ~30 s (it asks the login shell), so start from the last cached answer.
    this.known = shared("ranch.knownAgents") ?? null;
    // Task reporting and updates follow the machine of the shown space: its
    // agents run there, so that is where the bridge must be installed.
    this.homeFor = homeCache(exec, home);
    this.tasksBy = new Map(); // machine key -> null (checking) | {agents} | {error} | {missing}
    this.setupBy = new Map(); // machine key -> output of the last "Set up" run
    this.updBy = new Map(); // machine key -> update state
    this.machineKey = this.machineNow() ?? "";
    this.health = { git: "checking", herdr: "checking" };
    this.healthBusy = false;
    cx.spawn(async (cx) => {
      try {
        this.known = await knownAgents();
        setShared("ranch.knownAgents", this.known);
      } catch {
        this.known = this.known ?? [];
      }
      cx.notify();
    });
    this.loadTasks(cx);
    cx.timer.every(60_000, (cx) => this.loadTasks(cx));
    // Follow the shown space's machine: check it as soon as it changes.
    cx.timer.every(1000, (cx) => {
      const key = this.machineNow() ?? "";
      if (key === this.machineKey) return;
      this.machineKey = key;
      if (!this.tasksBy.has(key)) this.loadTasks(cx);
      this.checkUpdate(cx, false);
      cx.notify();
    });
    this.loadHealth(cx);
    // Version checks spawn processes: every 5 min is plenty.
    cx.timer.every(5 * 60_000, (cx) => this.loadHealth(cx));
    this.checkUpdate(cx, false);
    if (shared("ranch.health.gh") !== "ok") this.checkGh(cx);
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "focus") {
        this.handle.focus();
        this.checkUpdate(cx, false);
      }
    });
  }

  // ---- data ----

  s() {
    return resolveSettings(shared(SETTINGS_KEY));
  }

  set(path, value) {
    setShared(SETTINGS_KEY, withSetting(shared(SETTINGS_KEY), path, value));
  }

  /** The shown space's machine (null: this computer). */
  machineNow() {
    return spaces().find((sp) => sp.active)?.machine ?? null;
  }

  /** The machine the System rows describe, as remembered by the 1 s follower. */
  machine() {
    return this.machineKey || null;
  }

  get tasks() {
    return this.tasksBy.get(this.machineKey) ?? null;
  }

  get setup() {
    return this.setupBy.get(this.machineKey) ?? null;
  }

  get upd() {
    return this.updBy.get(this.machineKey) ?? shared(UPDATE_KEY)?.[this.machineKey]?.upd ?? IDLE_UPD;
  }

  /** Runs ranch-tasks on `machine`; null when its home can't be found. */
  async tasksExec(machine, args, opts = {}) {
    const dir = await this.homeFor(machine);
    if (!dir) return null;
    return exec(...tasksCmd(dir, args, machine), { ...opts, on: machine });
  }

  loadTasks(cx, machine = this.machine()) {
    const key = machine ?? "";
    cx.spawn(async (cx) => {
      let tasks;
      let r = null;
      try {
        r = await this.tasksExec(machine, ["status", "--json"]);
      } catch {}
      let data = null;
      try { data = JSON.parse(r?.stdout || ""); } catch {}
      if (data?.agents) {
        const agents = {};
        for (const k of TASK_KEYS) {
          const v = data.agents[k];
          agents[k] = ["installed", "outdated", "broken", "needs approval"].includes(v) ? v : "missing";
        }
        tasks = { agents };
      } else if (machine && (await this.homeFor(machine)) && bridgeMissing(r)) {
        tasks = { missing: true }; // reachable, never set up: Set up copies the bridge
      } else {
        tasks = { error: true, unreachable: !!machine && !(await this.homeFor(machine)) };
      }
      this.tasksBy.set(key, tasks);
      cx.notify();
    });
  }

  runSetup(cx) {
    const machine = this.machine();
    const key = machine ?? "";
    this.setupBy.set(key, "Setting up…");
    cx.notify();
    cx.spawn(async (cx) => {
      let text;
      let ok = false;
      if (machine && this.tasksBy.get(key)?.missing) {
        const pushed = await pushBridge({
          exec, machine, localHome: home(), readLocal: (p) => readTextFile(p),
          localWindows: isWin(), remoteHome: await this.homeFor(machine),
        });
        ({ text, ok } = pushed);
      } else {
        try {
          const r = await this.tasksExec(machine, ["install", "--yes"]);
          const out = `${r?.stdout || ""}${r?.stderr || ""}`.trim();
          ok = r?.code === 0;
          text = !r ? `Can't reach ${machine}.` : out || (ok ? "Done." : `Exit code ${r.code}.`);
        } catch {
          text = "Could not run ranch-tasks.";
        }
      }
      this.setupBy.set(key, text);
      if (ok) {
        this.loadTasks(cx, machine);
        this.checkUpdate(cx, true, machine);
      }
      cx.notify();
    });
  }

  /** Remembers one machine's update state, in memory and across panel copies. */
  saveUpd(key, upd, checked = true) {
    this.updBy.set(key, upd);
    const all = shared(UPDATE_KEY) ?? {};
    const prev = all[key];
    setShared(UPDATE_KEY, { ...all, [key]: { upd, checkedAt: checked ? Date.now() : prev?.checkedAt ?? 0 } });
  }

  checkUpdate(cx, force, machine = this.machine()) {
    const key = machine ?? "";
    const last = shared(UPDATE_KEY)?.[key];
    if (!force && last && Number.isFinite(last.checkedAt) && Date.now() - last.checkedAt < UPDATE_EVERY) {
      if (last.upd) this.updBy.set(key, last.upd);
      return;
    }
    const prev = this.updBy.get(key) ?? last?.upd ?? IDLE_UPD;
    this.updBy.set(key, { ...prev, state: "checking", message: "" });
    cx.notify();
    cx.spawn(async (cx) => {
      let upd;
      try {
        const r = await this.tasksExec(machine, ["update", "check", "--json"], { timeout: 20000 });
        let data = null;
        try { data = JSON.parse(r?.stdout || ""); } catch {}
        if (!r) {
          upd = { ...prev, state: "error", message: `Can't reach ${machine}.` };
        } else if (!data || typeof data !== "object") {
          upd = { ...prev, state: bridgeMissing(r) ? "missing" : "unsupported", message: "" };
        } else {
          const state = data.dev ? "dev" : data.error ? "error" : data.available ? "available" : "current";
          upd = {
            state,
            installed: data.installed ?? null,
            latest: data.latest ?? null,
            message: data.error || "",
            bridgeOnly: !!data.bridgeOnly,
          };
        }
      } catch {
        upd = { ...prev, state: machine ? "missing" : "unsupported", message: "" };
      }
      this.saveUpd(key, upd);
      cx.notify();
    });
  }

  runUpdate(cx) {
    const machine = this.machine();
    const key = machine ?? "";
    const prev = this.upd;
    this.updBy.set(key, { ...prev, state: "updating", message: "" });
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await this.tasksExec(machine, ["update", "--yes", "--json"], { timeout: 300000 });
        let data = null;
        try { data = JSON.parse(r?.stdout || ""); } catch {}
        if (data?.ok) {
          let message = `Updated to ${String(data.to ?? "").slice(0, 7)}`;
          if (data.bridgeOnly) message += machine ? ` on ${machine} (task reporting)` : " (task reporting)";
          if (data.backedUp?.length) message += `, backed up ${data.backedUp.length} edited file(s) to ${data.backupDir}`;
          if (data.tasks === "failed") message += " Task reporting reinstall failed.";
          const upd = { state: "updated", installed: data.to ?? null, latest: data.to ?? null, message, bridgeOnly: !!data.bridgeOnly };
          this.saveUpd(key, { ...upd, state: "current", message: "" });
          this.updBy.set(key, upd);
          cx.notify();
          // Mods and the layout changed only when this computer updated them.
          if (!machine && !data.bridgeOnly) {
            run("layout.switch", { name: "main" });
            run("layout.switch", { name: "ranch" });
          }
          if (data.bridgeOnly) this.loadTasks(cx, machine);
        } else if (data) {
          this.updBy.set(key, { ...prev, state: data.dev ? "dev" : "error", message: data.error || "Update failed." });
        } else {
          this.updBy.set(key, { ...prev, state: r ? "unsupported" : "error", message: r ? "" : `Can't reach ${machine}.` });
        }
      } catch {
        this.updBy.set(key, { ...prev, state: "error", message: "Could not run ranch-tasks." });
      }
      cx.notify();
    });
  }

  loadHealth(cx) {
    if (this.healthBusy) return; // never overlapping loads
    this.healthBusy = true;
    cx.spawn(async (cx) => {
      try {
        const git = await exec("git", ["--version"]).then((r) => (r.code === 0 ? "ok" : "missing")).catch(() => "missing");
        const herdr = await exec("herdr-app", ["--version"])
          .then((r) => {
            const v = semver(r.stdout);
            return r.code === 0 && v && cmp(v, HERDR_MIN) < 0 ? "old" : "ok";
          })
          .catch(() => "missing");
        this.health = { git, herdr };
      } finally {
        this.healthBusy = false;
      }
      cx.notify();
    });
  }

  checkGh(cx) {
    cx.spawn(async (cx) => {
      const r = await runGh((cmd, args) => exec(cmd, args, { timeout: 15000 }), ["auth", "status"]);
      const gh = r.missing ? "missing" : r.code === 0 ? "ok" : "signed-out";
      setShared("ranch.health.gh", gh);
    });
  }

  // ---- building blocks ----

  /** A section: a heading and its rows; every section after the first starts with a hairline. */
  section(id, title, rows, first = false) {
    const t = theme();
    return v_flex().id(`section-${id}`).flex_none().gap(0).pt(first ? 4 : 10).pb(10)
      .when(!first, (e) => e.border_t(1).border_color(t.border))
      .child(div().flex_none().h(24).px(6).flex().items_center().text_size(11.5).font_semibold().text_color(t.muted).child(title))
      .children(rows);
  }

  /** The one row shape: label (and optional hint under it) left, control right. */
  row(id, label, control, { onClick = null, hint = null, icon = null } = {}) {
    const t = theme();
    return h_flex().id(id).flex_none().min_h(ROW_H).px(6).gap(8).items_center().rounded(5)
      .when(!!onClick, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .when(!!icon, (e) => e.child(icon))
      .child(v_flex().flex_1().min_w(0).py(hint ? 4 : 0)
        .child(div().truncate().child(label))
        .when(!!hint, (e) => e.child(div().text_size(11).text_color(t.dim).child(hint))))
      .when(!!control, (e) => e.child(control));
  }

  /** A hint line aligned with row labels. */
  note(text, color = null) {
    const t = theme();
    return div().flex_none().px(6).pb(4).text_size(11).text_color(color ?? t.dim).child(text);
  }

  pill(id, on, toggle) {
    const t = theme();
    return div().id(id).flex_none().w(26).h(14).rounded(7).p(2).flex().items_center().border_1().border_color(t.border)
      .bg(on ? t.accent : t.input).cursor_pointer()
      .when(on, (e) => e.justify_end())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        toggle();
      })
      .child(div().size(8).rounded(4).bg(on ? t.accent_foreground : t.muted));
  }

  toggle(id, label, value, path, onChange = null) {
    const flip = () => {
      this.set(path, !value);
      if (onChange) onChange(!value);
    };
    return this.row(id, label, this.pill(`${id}-pill`, value, flip), { onClick: flip });
  }

  /** Small text button; `primary` fills it with the accent. */
  button(id, label, action, { primary = false, disabled = false } = {}) {
    const t = theme();
    return div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(5).text_size(11.5)
      .when(primary, (e) => e.bg(t.accent).text_color(t.accent_foreground).font_semibold())
      .when(!primary, (e) => e.border_1().border_color(t.border).text_color(t.muted))
      .when(disabled, (e) => e.opacity(0.5))
      .when(!disabled, (e) => e.cursor_pointer()
        .when(!primary, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(action))
      .child(label);
  }

  iconBtn(id, icon, action) {
    const t = theme();
    return div().id(id).flex_none().size(20).rounded(5).flex().items_center().justify_center()
      .text_color(action ? t.dim : t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(action, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(svg(`mods/ranch-settings/${icon}.svg`).size(12));
  }

  seg(id, value, options, path) {
    const t = theme();
    return h_flex().flex_none().gap(1).p(1).rounded(6).bg(t.input).border_1().border_color(t.border)
      .children(options.map(([key, label]) => div().id(`${id}-${key}`).flex_none().px(7).h(20).flex().items_center().rounded(5).text_size(11).cursor_pointer()
        .when(key === value, (e) => e.bg(t.selected).text_color(t.foreground))
        .when(key !== value, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click(() => this.set(path, key))
        .child(label)));
  }

  status(text, color) {
    return div().flex_none().text_size(11.5).text_color(color).child(text);
  }

  agentIcon(key, k) {
    const t = theme();
    if (key !== "terminal" && k?.icon) {
      return div().flex_none().w(16).flex().items_center().justify_center()
        .child(k.tint ? svg(k.icon).size(14) : image(k.icon).size(14));
    }
    return div().flex_none().w(16).flex().items_center().justify_center().text_color(t.muted)
      .child(svg("mods/ranch-settings/terminal.svg").size(14));
  }

  // ---- sections ----

  sectionAgents(t, s) {
    const known = this.known ?? [];
    const rows = s.agents.map((key, i) => {
      const k = known.find((a) => a.key === key);
      const checking = key !== "terminal" && this.known === null;
      const missing = key !== "terminal" && !checking && (!k || k.installed === false);
      const move = (to) => {
        const agents = [...s.agents];
        agents.splice(i, 1);
        agents.splice(to, 0, key);
        this.set("agents", agents);
      };
      const controls = h_flex().flex_none().items_center().gap(2)
        .when(missing, (e) => e.child(this.status("not installed", t.dim).mr(4)))
        .when(checking, (e) => e.child(this.status("checking…", t.dim).mr(4)))
        .child(this.iconBtn(`agent-up-${key}`, "chevron-up", i > 0 ? () => move(i - 1) : null))
        .child(this.iconBtn(`agent-down-${key}`, "chevron-down", i < s.agents.length - 1 ? () => move(i + 1) : null))
        .child(this.iconBtn(`agent-remove-${key}`, "x", s.agents.length > 1 ? () => this.set("agents", s.agents.filter((a) => a !== key)) : null));
      return this.row(`agent-${key}`, displayName(key, known), controls, { icon: this.agentIcon(key, k) });
    });
    const choices = [
      ...known.filter((a) => a.run && !s.agents.includes(a.key)).map((a) => ({ key: a.key, name: a.name })),
      ...(s.agents.includes("terminal") ? [] : [{ key: "terminal", name: "Terminal" }]),
    ];
    if (s.agents.length < MAX_AGENTS && choices.length) rows.push(this.addAgent(t, s, choices));
    return this.section("agents", `Launch buttons · ${s.agents.length} of ${MAX_AGENTS}`, rows, true);
  }

  /** "Add agent": a quiet row that opens a list of the agents not yet added. */
  addAgent(t, s, choices) {
    const known = this.known ?? [];
    const trigger = h_flex().id("agent-add").flex_none().h(ROW_H).px(6).gap(8).items_center().rounded(5)
      .cursor_pointer().text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
      .when(!!this.addOpen, (e) => e.bg(t.hover))
      .child(div().flex_none().w(16).flex().items_center().justify_center().child(svg("mods/ranch-settings/plus.svg").size(12)))
      .child(div().flex_1().min_w(0).truncate().child("Add agent"));
    const list = v_flex().id("agent-add-list").w(220).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .children(choices.map((c) => h_flex().id(`agent-add-${c.key}`).h(ROW_H).px(8).gap(8).items_center().rounded(5)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          this.addOpen = false;
          this.set("agents", [...s.agents, c.key]);
          cx.notify();
        })
        .child(this.agentIcon(c.key, known.find((a) => a.key === c.key)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.name))));
    return Popover.new("agent-add-popover").anchor("top_left")
      .open(!!this.addOpen)
      .on_open_change((open, cx) => {
        this.addOpen = open;
        cx.notify();
      })
      .trigger(trigger)
      .content(list);
  }

  sectionTopbar(t, s) {
    return this.section("topbar", "Top bar", [
      this.toggle("topbar-status", "Agent status", s.topbar.status, "topbar.status"),
      this.toggle("topbar-logo", "Agent logo", s.topbar.logo, "topbar.logo"),
      this.toggle("topbar-space", "Space name before title", s.topbar.space, "topbar.space"),
      this.toggle("topbar-marker", "Naming marker", s.topbar.marker, "topbar.marker"),
      this.toggle("topbar-attention", "Needs-you pill", s.topbar.attention, "topbar.attention"),
      this.toggle("topbar-launch", "Start agent button", s.topbar.launch, "topbar.launch"),
    ]);
  }

  sectionStatus(t, s) {
    return this.section("statusbar", "Status bar", [
      this.toggle("statusbar-memory", "Memory", s.statusbar.memory, "statusbar.memory"),
      this.toggle("statusbar-cpu", "CPU", s.statusbar.cpu, "statusbar.cpu"),
      this.toggle("statusbar-terminals", "Terminals", s.statusbar.terminals, "statusbar.terminals"),
      this.toggle("statusbar-ports", "Listening ports", s.statusbar.ports, "statusbar.ports"),
      this.toggle("statusbar-hosts", "Hosts", s.statusbar.hosts, "statusbar.hosts"),
      this.toggle("usage-show", "Agent usage", s.usage.show, "usage.show",
        (next) => run(next ? "layout.show" : "layout.hide", { id: "usage" })),
    ]);
  }

  sectionCards(t, s) {
    return this.section("cards", "Sidebar cards", [
      this.toggle("card-time", "Time in status", s.card.time, "card.time"),
      this.toggle("card-line3", "Diff stats", s.card.line3, "card.line3"),
      this.toggle("card-pr", "Pull request link", s.card.pr, "card.pr"),
    ]);
  }

  sectionSession(t, s) {
    return this.section("session", "Session panel", [
      this.toggle("session-tasks", "Agent tasks", s.session.tasks, "session.tasks"),
      this.toggle("session-git", "Git status", s.session.git, "session.git"),
      this.toggle("session-commits", "Recent commits", s.session.commits, "session.commits"),
      this.toggle("session-subagents", "Subagents", s.session.subagents, "session.subagents"),
    ]);
  }

  sectionNaming(t, s) {
    return this.section("naming", "Tab names", [
      this.toggle("naming-enabled", "Name tabs automatically", s.naming.enabled, "naming.enabled"),
      this.row("naming-exit", "When the agent exits",
        this.seg("naming-exit", s.naming.exitMode, [["keep", "Keep"], ["revert", "Revert"], ["check", "Add ✓"]], "naming.exitMode")),
    ]);
  }

  // Task reporting, Ranch updates and tool health, each one line; details only
  // when something needs the person.
  sectionSystem(t) {
    const rows = [];
    const machine = this.machine();
    const on = machine ? ` · ${machine}` : "";

    // Task reporting (on the shown space's machine)
    const tasks = this.tasks;
    const pending = tasks?.agents ? TASK_KEYS.filter((k) => !["installed", "needs approval"].includes(tasks.agents[k])) : [];
    const broken = pending.some((k) => tasks.agents[k] === "broken");
    const setUp = (label) => this.button("tasks-setup", label, (_e, cx) => this.runSetup(cx),
      { primary: true, disabled: this.setup === "Setting up…" });
    const taskStatus = !tasks ? this.status("checking…", t.dim)
      : tasks.missing ? h_flex().flex_none().items_center().gap(8)
          .child(this.status("not installed", t.blocked))
          .child(setUp("Set up"))
      : tasks.error ? this.status(tasks.unreachable ? "unreachable" : "not installed", t.blocked)
      : pending.length ? h_flex().flex_none().items_center().gap(8)
          .child(this.status(`${pending.length} to set up`, t.working))
          .child(setUp(broken ? "Repair" : "Set up"))
      : this.status("on", t.done);
    rows.push(this.row("sys-tasks", `Task reporting${on}`, taskStatus));
    if (tasks?.missing) rows.push(this.note(`Agents on ${machine} report nothing yet. Set up copies this computer's task reporting there and installs it.`));
    else if (tasks?.error && tasks.unreachable) rows.push(this.note(`Can't reach ${machine}.`));
    else if (tasks?.error) rows.push(this.note(machine
      ? `Run \`node bin/ranch-tasks install\` from the Ranch repo on ${machine}.`
      : "Run `node bin/ranch-tasks install` from the Ranch repo."));
    if (pending.length) rows.push(this.note(pending.map((k) => `${displayName(k, this.known ?? [])} ${tasks.agents[k]}`).join(" · ")));
    if (tasks?.agents?.codex === "needs approval") rows.push(this.note("Codex: approve the Ranch hooks once with /hooks.", t.working));
    if (this.setup) rows.push(this.note(this.setup.split("\n").slice(0, 3).join("\n")));

    // Ranch updates
    const u = this.upd;
    const [word, color] = {
      current: ["up to date", t.done],
      updated: ["up to date", t.done],
      available: ["update ready", t.working],
      checking: ["checking…", t.dim],
      updating: ["updating…", t.dim],
      error: ["check failed", t.blocked],
      dev: ["dev install", t.dim],
      unsupported: ["unavailable", t.dim],
      missing: ["not installed", t.dim],
    }[u.state] ?? ["checking…", t.dim];
    const busy = u.state === "checking" || u.state === "updating";
    const updControl = h_flex().flex_none().items_center().gap(8)
      .child(this.status(word, color))
      .when(u.state !== "missing", (e) => e.child(u.state === "available" || u.state === "updating"
        ? this.button("updates-update", "Update", (_e, cx) => this.runUpdate(cx), { primary: true, disabled: u.state === "updating" })
        : this.button("updates-check", "Check", (_e, cx) => this.checkUpdate(cx, true), { disabled: busy })));
    rows.push(this.row("sys-ranch", `Ranch${on}`, updControl));
    const updNote = u.message
      || (u.state === "dev" ? "Symlinked dev install: git pull in the repo."
        : u.state === "unsupported" ? "This install predates updates. Reinstall Ranch once to enable them."
        : u.state === "missing" ? `Set up task reporting on ${machine} first.`
        : u.bridgeOnly && u.state === "available" ? `Updates task reporting on ${machine ?? "this computer"}; the layout updates from the computer running the app.`
        : "");
    if (updNote) rows.push(this.note(updNote, u.state === "error" ? t.blocked : null));

    // Tool health: a row only for what's wrong.
    const gh = shared("ranch.health.gh");
    const problems = [
      this.health.git === "missing" && ["git", "missing"],
      gh === "missing" && ["GitHub CLI", "missing"],
      gh === "signed-out" && ["GitHub CLI", "signed out"],
      this.health.herdr === "missing" && ["Herdr app", "missing"],
      this.health.herdr === "old" && ["Herdr app", "too old"],
    ].filter(Boolean);
    for (const [label, what] of problems) rows.push(this.row(`sys-${label}`, label, this.status(what, t.blocked)));

    rows.push(this.row("open-herdr-settings", "Herdr settings", this.status("Open", t.dim), { onClick: () => run("app.settings") }));
    return this.section("system", "System", rows);
  }

  // ---- root ----

  render(cx) {
    // Left-edge drag strip on the panel column with a hover cue (lib/edge-grip.js).
    this.grip ??= new EdgeGrip({
      id: "panel", side: "left", min: 280, max: 640, div, theme, run,
      width: () => this.grip.measured ?? 360,
    });
    return this.grip.wrap(this.renderBody(cx), theme().surface);
  }

  renderBody(cx) {
    const t = theme(), s = this.s();
    return v_flex().id("ranch-settings").size_full().min_h(0).overflow_y_scrollbar().bg(t.surface)
      .text_color(t.foreground).text_size(12.5).px(8).pt(12).pb(16).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") run("pane.go", { direction: "left" });
      })
      .children([
        div().flex_none().px(6).pb(6).text_size(13).font_semibold().text_color(t.foreground).child("Ranch settings"),
        this.sectionAgents(t, s),
        this.sectionTopbar(t, s),
        this.sectionStatus(t, s),
        this.sectionCards(t, s),
        this.sectionSession(t, s),
        this.sectionNaming(t, s),
        this.sectionSystem(t),
      ]);
  }
}
