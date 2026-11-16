import { View, div, image, svg } from "gpui-kit";
import { Popover, v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, run, exec, home, knownAgents, nextCommand, readTextFile, window as appWindow } from "herdr";
import { runGh } from "./lib/git.js";
import { relativeTime } from "./lib/format.js";
import { SETTINGS_KEY, MAX_AGENTS, resolveSettings, withSetting } from "./lib/settings.js";
import { tasksCommand } from "./lib/tasks-command.js";
import { EdgeGrip } from "./lib/edge-grip.js";

// Windows can't exec the POSIX sh launcher; it calls node on the .js entry.
const isWin = () => appWindow()?.platform === "windows";
const tasksCmd = (args) => tasksCommand(home(), args, isWin());
const TASK_KEYS = ["claude", "codex", "opencode"];
const HERDR_MIN = [0, 1, 15];

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
    this.tasks = null; // null = checking; {agents: {claude, codex, opencode}} | {error: true}
    this.setup = null; // output of the last "Set up" run
    this.health = { git: "checking", herdr: "checking" };
    this.report = null; // agent -> last_event_at, from ~/.herdr/ranch/health.json
    this.healthBusy = false; // a health load in flight: skip ticks until done
    this.versionsAt = 0;     // ms, when git/herdr versions were last checked
    this.upd = { state: "checking", installed: null, latest: null, message: "" };
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
    this.loadHealth(cx);
    this.checkUpdate(cx, false);
    // Task-reporting health (the report file) refreshes every 30 s; the version
    // checks spawn processes, so those wait for refreshHealth's 5-min gate.
    cx.timer.every(30_000, (cx) => this.refreshHealth(cx));
    if (shared("ranch.health.gh") !== "ok") this.checkGh(cx);
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "focus") {
        this.handle.focus();
        this.refreshHealth(cx); // shown again: catch up on the report file
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

  loadTasks(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec(...tasksCmd(["status", "--json"]));
        let data = null;
        try { data = JSON.parse(r.stdout || ""); } catch {}
        if (data?.agents) {
          const agents = {};
          for (const key of TASK_KEYS) {
            const v = data.agents[key];
            agents[key] = ["installed", "outdated", "broken", "needs approval"].includes(v) ? v : "missing";
          }
          this.tasks = { agents };
        } else {
          this.tasks = { error: true };
        }
      } catch {
        this.tasks = { error: true };
      }
      cx.notify();
    });
  }

  runSetup(cx) {
    this.setup = "Setting up…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(...tasksCmd(["install", "--yes"]));
        const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
        this.setup = out || (r.code === 0 ? "Done." : `Exit code ${r.code}.`);
        if (r.code === 0) this.loadTasks(cx);
      } catch {
        this.setup = "Could not run ranch-tasks.";
      }
      cx.notify();
    });
  }

  checkUpdate(cx, force) {
    const checkedAt = shared("ranch.update.checkedAt");
    if (!force && Number.isFinite(checkedAt) && Date.now() - checkedAt < 30 * 60_000) {
      const last = shared("ranch.update.last");
      if (last) this.upd = last;
      return;
    }
    this.upd = { ...this.upd, state: "checking", message: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(...tasksCmd(["update", "check", "--json"]), { timeout: 20000 });
        let data = null;
        try { data = JSON.parse(r.stdout || ""); } catch {}
        if (!data || typeof data !== "object") {
          this.upd = { ...this.upd, state: "unsupported", message: "" };
        } else {
          const state = data.dev ? "dev" : data.error ? "error" : data.available ? "available" : "current";
          this.upd = {
            state,
            installed: data.installed ?? null,
            latest: data.latest ?? null,
            message: data.error || "",
          };
        }
      } catch {
        this.upd = { ...this.upd, state: "unsupported", message: "" };
      }
      setShared("ranch.update.last", this.upd);
      setShared("ranch.update.checkedAt", Date.now());
      cx.notify();
    });
  }

  runUpdate(cx) {
    this.upd = { ...this.upd, state: "updating", message: "" };
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec(...tasksCmd(["update", "--yes", "--json"]), { timeout: 300000 });
        let data = null;
        try { data = JSON.parse(r.stdout || ""); } catch {}
        if (data?.ok) {
          let message = `Updated to ${String(data.to ?? "").slice(0, 7)}`;
          if (data.backedUp?.length) message += `, backed up ${data.backedUp.length} edited file(s) to ${data.backupDir}`;
          if (data.tasks === "failed") message += " Task reporting reinstall failed.";
          this.upd = { state: "updated", installed: data.to ?? null, latest: data.to ?? null, message };
          setShared("ranch.update.last", { ...this.upd, state: "current" });
          setShared("ranch.update.checkedAt", Date.now());
          cx.notify();
          run("layout.switch", { name: "main" });
          run("layout.switch", { name: "ranch" });
        } else if (data) {
          this.upd = { ...this.upd, state: data.dev ? "dev" : "error", message: data.error || "Update failed." };
        } else {
          this.upd = { ...this.upd, state: "unsupported", message: "" };
        }
      } catch {
        this.upd = { ...this.upd, state: "error", message: "Could not run ranch-tasks." };
      }
      cx.notify();
    });
  }

  // One read of the per-agent report file: cheap, no processes spawned.
  async loadReport() {
    try {
      const raw = await readTextFile(`${home()}/.herdr/ranch/health.json`);
      const agents = JSON.parse(raw || "{}")?.agents ?? {};
      this.report = Object.fromEntries(
        Object.entries(agents)
          .filter(([, v]) => v && typeof v.last_event_at === "string")
          .map(([k, v]) => [k, v.last_event_at])
      );
    } catch {
      this.report = null;
    }
  }

  loadHealth(cx) {
    if (this.healthBusy) return; // never overlapping loads
    this.healthBusy = true;
    this.versionsAt = Date.now();
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
        // Per-agent last event time (fixes 3.8), written by the adapters.
        await this.loadReport();
      } finally {
        this.healthBusy = false;
      }
      cx.notify();
    });
  }

  // The health tick: the report file every time; version checks only every
  // 5 min, so a 30 s tick stays a single cheap file read.
  refreshHealth(cx) {
    if (this.healthBusy) return;
    if (Date.now() - this.versionsAt < 5 * 60_000) {
      this.healthBusy = true;
      cx.spawn(async (cx) => {
        try { await this.loadReport(); } finally { this.healthBusy = false; }
        cx.notify();
      });
    } else this.loadHealth(cx);
  }

  checkGh(cx) {
    cx.spawn(async (cx) => {
      const r = await runGh((cmd, args) => exec(cmd, args, { timeout: 15000 }), ["auth", "status"]);
      const gh = r.missing ? "missing" : r.code === 0 ? "ok" : "signed-out";
      setShared("ranch.health.gh", gh);
    });
  }

  // ---- render helpers ----

  card(title, description, rows) {
    const t = theme();
    return v_flex().flex_none().rounded(8).border_1().border_color(t.border).bg(t.background).p(12).gap(10)
      .child(v_flex().gap(2)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
        .when(!!description, (e) => e.child(div().text_size(11).text_color(t.dim).child(description))))
      .children(rows.flatMap((row, i) => (i === 0 ? [row] : [div().h(1).flex_none().bg(t.border), row])));
  }

  iconBtn(id, icon, action) {
    const t = theme();
    return div().id(id).flex_none().size(22).rounded(6).flex().items_center().justify_center()
      .text_color(action ? t.muted : t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(action, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action))
      .child(svg(`mods/ranch-settings/${icon}.svg`).size(13));
  }

  pill(id, on, toggle) {
    const t = theme();
    return div().id(id).flex_none().w(32).h(18).rounded(9).p(2).flex().items_center().border_1().border_color(t.border)
      .bg(on ? t.accent : t.input).cursor_pointer()
      .when(on, (e) => e.justify_end())
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        toggle();
      })
      .child(div().size(12).rounded(9).bg(on ? t.accent_foreground : t.muted));
  }

  switchRow(id, label, value, path, hint = null, onChange = null) {
    const t = theme();
    const toggle = () => {
      const next = !value;
      this.set(path, next);
      if (onChange) onChange(next);
    };
    return h_flex().id(id).flex_none().items_center().justify_between().gap(8).cursor_pointer()
      .rounded(6).px(6).py(4).hover((s) => s.bg(t.hover))
      .on_click(toggle)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().child(label))
        .when(!!hint, (e) => e.child(div().text_size(11).text_color(t.dim).child(hint))))
      .child(this.pill(`${id}-pill`, value, toggle));
  }

  stepper(id, value, unit, min, max, step, path) {
    const t = theme();
    const clamp = (v) => Math.min(max, Math.max(min, v));
    const btn = (bid, icon, delta) => div().id(`${id}-${bid}`).flex_none().size(20).rounded(6).flex().items_center().justify_center()
      .text_color(t.muted).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(() => this.set(path, clamp(value + delta)))
      .child(svg(`mods/ranch-settings/${icon}.svg`).size(11));
    return h_flex().flex_none().items_center().gap(6)
      .child(div().min_w(34).text_right().text_color(t.muted).child(`${value}${unit}`))
      .child(btn("dec", "minus", -step))
      .child(btn("inc", "plus", step));
  }

  seg(id, value, options, path) {
    const t = theme();
    return h_flex().flex_none().gap(2).p(2).rounded(8).bg(t.input).border_1().border_color(t.border)
      .children(options.map(([key, label]) => div().id(`${id}-${key}`).flex_none().px(8).py(3).rounded(6).text_size(11).cursor_pointer()
        .when(key === value, (e) => e.bg(t.selected).text_color(t.foreground).font_semibold())
        .when(key !== value, (e) => e.text_color(t.muted).hover((s) => s.bg(t.hover)))
        .on_click(() => this.set(path, key))
        .child(label)));
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
    const row = (key, i) => {
      const k = known.find((a) => a.key === key);
      const checking = key !== "terminal" && this.known === null;
      const missing = key !== "terminal" && !checking && (!k || k.installed === false);
      const move = (to) => {
        const agents = [...s.agents];
        agents.splice(i, 1);
        agents.splice(to, 0, key);
        this.set("agents", agents);
      };
      return h_flex().flex_none().items_center().gap(8)
        .child(this.agentIcon(key, k))
        .child(div().flex_1().min_w(0).truncate().child(displayName(key, known)))
        .when(missing, (e) => e.child(div().flex_none().px(6).py(1).rounded(4).bg(t.input).text_size(10).text_color(t.dim).child("not installed")))
        .when(checking, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("checking…")))
        .child(this.iconBtn(`agent-up-${key}`, "chevron-up", i > 0 ? () => move(i - 1) : null))
        .child(this.iconBtn(`agent-down-${key}`, "chevron-down", i < s.agents.length - 1 ? () => move(i + 1) : null))
        .child(this.iconBtn(`agent-remove-${key}`, "x", s.agents.length > 1 ? () => this.set("agents", s.agents.filter((a) => a !== key)) : null));
    };
    const choices = [
      ...known.filter((a) => a.run && !s.agents.includes(a.key)).map((a) => ({ key: a.key, name: a.name })),
      ...(s.agents.includes("terminal") ? [] : [{ key: "terminal", name: "Terminal" }]),
    ];
    const full = s.agents.length >= MAX_AGENTS;
    return this.card("Agents", `Launch buttons in the top bar (up to ${MAX_AGENTS})`, [
      ...s.agents.map((key, i) => row(key, i)),
      this.addAgentSelect(t, s, choices, full),
    ]);
  }

  /** "Add agent" as one dropdown: a select-style trigger and a list popover. */
  addAgentSelect(t, s, choices, full) {
    const disabled = full || !choices.length;
    const label = full ? `Limit reached (${MAX_AGENTS} of ${MAX_AGENTS})` : choices.length ? "Add an agent…" : "All agents added";
    const trigger = h_flex().id("agent-add").flex_none().h(28).px(10).gap(8).items_center().rounded(6)
      .bg(t.input).border_1().border_color(this.addOpen ? t.accent : t.border)
      .when(!disabled, (e) => e.cursor_pointer().hover((st) => st.border_color(t.muted)))
      .child(svg("mods/ranch-settings/plus.svg").size(11).text_color(disabled ? t.border : t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(disabled ? t.dim : t.muted).child(label))
      .when(!disabled, (e) => e.child(svg("mods/ranch-settings/chevron-down.svg").size(11).text_color(t.muted)));
    if (disabled) return trigger;
    const known = this.known ?? [];
    const list = v_flex().id("agent-add-list").w(240).p(4).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.popover).shadow_lg()
      .children(choices.map((c) => h_flex().id(`agent-add-${c.key}`).h(28).px(8).gap(8).items_center().rounded(5)
        .cursor_pointer().hover((st) => st.bg(t.hover))
        .on_click((_e, cx) => {
          this.addOpen = false;
          this.set("agents", [...s.agents, c.key]);
          cx.notify();
        })
        .child(this.agentIcon(c.key, known.find((a) => a.key === c.key)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(c.name))));
    return Popover.new("agent-add-popover").anchor("top_left")
      .open(!!this.addOpen)
      .on_open_change((open, cx) => {
        this.addOpen = open;
        cx.notify();
      })
      .trigger(trigger)
      .content(list);
  }

  sectionCards(t, s) {
    return this.card("Sidebar cards", "What each session card shows", [
      this.switchRow("card-time", "Time in status", s.card.time, "card.time"),
      this.switchRow("card-line3", "Diff stats line", s.card.line3, "card.line3"),
      this.switchRow("card-pr", "Pull request link", s.card.pr, "card.pr"),
    ]);
  }

  sectionSession(t, s) {
    return this.card("Session details", "Sections of the session panel", [
      this.switchRow("session-tasks", "Agent tasks", s.session.tasks, "session.tasks"),
      this.switchRow("session-git", "Git status", s.session.git, "session.git"),
      this.switchRow("session-commits", "Recent commits", s.session.commits, "session.commits"),
      this.switchRow("session-subagents", "Subagents", s.session.subagents, "session.subagents"),
    ]);
  }

  sectionStatus(t, s) {
    return this.card("Status bar", "Bottom bar contents", [
      this.switchRow("usage-show", "Show agent usage", s.usage.show, "usage.show",
        "Plan limits and session usage at the bottom right",
        (next) => run(next ? "layout.show" : "layout.hide", { id: "usage" })),
    ]);
  }

  sectionRefresh(t, s) {
    return this.card("Refresh", "How often git and PRs refresh", [
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Remote git"))
        .child(this.stepper("refresh-git", s.refresh.remoteGitSec, "s", 5, 300, 5, "refresh.remoteGitSec")),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Pull request"))
        .child(this.stepper("refresh-pr", s.refresh.prSec, "s", 30, 900, 30, "refresh.prSec")),
    ]);
  }

  sectionNaming(t, s) {
    return this.card("Naming", "Automatic tab names", [
      this.switchRow("naming-enabled", "Enabled", s.naming.enabled, "naming.enabled"),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("On exit"))
        .child(this.seg("naming-exit", s.naming.exitMode, [["keep", "Keep name"], ["revert", "Revert"], ["check", "Add ✓"]], "naming.exitMode")),
      this.switchRow("naming-follow", "Follow agent renames", s.naming.followAgent, "naming.followAgent"),
      this.switchRow("naming-model", "Summarise with a model", s.naming.model, "naming.model",
        "Sends the first prompt of each session to the model provider (via the claude CLI)."),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Max length"))
        .child(this.stepper("naming-maxlen", s.naming.maxLen, "", 16, 60, 4, "naming.maxLen")),
      div().text_size(11).text_color(t.dim).child("Renaming a tab in Herdr never changes the agent's session."),
    ]);
  }

  sectionTasks(t) {
    const rows = [];
    if (!this.tasks) {
      rows.push(div().text_color(t.dim).child("Checking task reporting…"));
    } else if (this.tasks.error) {
      rows.push(div().text_color(t.dim).child("Task reporting isn't installed. Run `node bin/ranch-tasks install` from the Ranch repo."));
    } else {
      for (const key of TASK_KEYS) {
        const status = this.tasks.agents[key];
        const color = status === "installed" ? t.done : status === "outdated" || status === "needs approval" ? t.working : t.blocked;
        const group = [h_flex().flex_none().items_center().justify_between().gap(8)
          .child(div().flex_1().min_w(0).truncate().child(key))
          .child(div().text_color(color).child(status))];
        // "last report N min ago" (fixes 3.8): when the agent last evented.
        const at = this.report?.[key] ? Date.parse(this.report[key]) : null;
        if (Number.isFinite(at)) {
          const ago = Date.now() - at;
          if (ago >= 0) {
            group.push(div().text_size(11).text_color(t.dim).child(`last report ${relativeTime(ago)}`));
          }
        }
        // Codex hooks waiting for trust: only Codex's own /hooks can approve them.
        if (key === "codex" && status === "needs approval") {
          group.push(div().text_size(11).text_color(t.dim).child("Codex: approve the Ranch hooks once with /hooks in Codex."));
        }
        rows.push(v_flex().gap(2).children(group));
      }
      const repair = TASK_KEYS.some((key) => this.tasks.agents[key] === "broken");
      if (TASK_KEYS.some((key) => !["installed", "needs approval"].includes(this.tasks.agents[key]))) {
        rows.push(h_flex().flex_none().justify_end()
          .child(div().id("tasks-setup").flex_none().px(10).py(4).rounded(7).bg(t.accent).text_color(t.accent_foreground).font_semibold().cursor_pointer()
            .on_click((_e, cx) => this.runSetup(cx))
            .child(repair ? "Repair" : "Set up")));
      }
    }
    if (this.setup) {
      rows.push(div().text_size(11).text_color(t.dim).child(this.setup.split("\n").slice(0, 6).join("\n")));
    }
    rows.push(div().text_size(11).text_color(t.dim).child("Codex asks you to trust new hooks once (/hooks in Codex)."));
    return this.card("Task reporting", "Which agents report their tasks", rows);
  }

  sectionHealth(t) {
    const gh = shared("ranch.health.gh");
    const word = (w) => (w === "ok" ? ["ok", t.done]
      : w === "missing" ? ["missing", t.blocked]
      : w === "signed-out" ? ["signed out", t.blocked]
      : w === "old" ? ["too old", t.working]
      : ["checking…", t.dim]);
    return this.card("Health", "git, GitHub CLI and Herdr versions", [
      ...[["git", this.health.git, "health-git"], ["gh (GitHub CLI)", gh, "health-gh"], ["Herdr app", this.health.herdr, "health-herdr"]].map(([label, w, id]) => {
        const [word_, color] = word(w);
        return h_flex().flex_none().items_center().justify_between().gap(8)
          .child(div().flex_1().min_w(0).truncate().child(label))
          .child(div().text_color(color).child(word_));
      }),
    ]);
  }

  sectionUpdates(t) {
    const u = this.upd;
    const short = (sha) => (sha ? String(sha).slice(0, 7) : null);
    const [word, color] = {
      current: ["up to date", t.done],
      updated: ["up to date", t.done],
      available: ["update available", t.working],
      checking: ["checking…", t.dim],
      updating: ["updating…", t.dim],
      error: ["error", t.blocked],
      dev: ["dev install", t.working],
      unsupported: ["not available", t.blocked],
    }[u.state] ?? ["checking…", t.dim];
    const busy = u.state === "checking" || u.state === "updating";
    const message = u.message
      || (u.state === "dev" ? "Symlinked dev install — run git pull in the repo."
        : u.state === "unsupported" ? "This Ranch install predates updates. Ask your agent to reinstall Ranch once to enable them."
          : "");
    // Same chain as the "Set up" button in sectionTasks.
    const button = (id, label, action, disabled) =>
      div().id(id).flex_none().px(10).py(4).rounded(7).bg(t.accent).text_color(t.accent_foreground).font_semibold()
        .when(!disabled, (e) => e.cursor_pointer().on_click(action))
        .when(disabled, (e) => e.opacity(0.6))
        .child(label);
    const rows = [
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Installed"))
        .child(div().text_color(t.muted).child(short(u.installed) ?? "unknown")),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Latest"))
        .child(div().text_color(t.muted).child(short(u.latest) ?? "—")),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Status"))
        .child(div().text_color(color).child(word)),
    ];
    if (message) rows.push(div().text_size(11).text_color(t.dim).child(message));
    const showUpdate = u.state === "available" || u.state === "updating";
    rows.push(h_flex().flex_none().justify_end().gap(8)
      .child(button("updates-check", "Check now", (_e, cx) => this.checkUpdate(cx, true), busy))
      .when(showUpdate, (e) => e.child(button("updates-update", "Update", (_e, cx) => this.runUpdate(cx), u.state === "updating"))));
    return this.card("Updates", "Ranch layout and mods from GitHub main", rows);
  }

  sectionFooter(t) {
    return h_flex().flex_none().justify_end()
      .child(div().id("open-herdr-settings").flex_none().px(10).py(4).rounded(7).border_1().border_color(t.border).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("app.settings"))
        .child("Herdr settings"));
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
      .text_color(t.foreground).text_size(13).p(14).gap(14).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") run("pane.go", { direction: "left" });
      })
      .children([
        v_flex().flex_none().gap(2)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).child("Ranch settings"))
          .child(div().text_size(11).text_color(t.dim).child("Sidebar, session panel and agent options")),
        this.sectionAgents(t, s),
        this.sectionCards(t, s),
        this.sectionSession(t, s),
        this.sectionStatus(t, s),
        this.sectionRefresh(t, s),
        this.sectionNaming(t, s),
        this.sectionTasks(t),
        this.sectionHealth(t),
        this.sectionUpdates(t),
        this.sectionFooter(t),
      ]);
  }
}
