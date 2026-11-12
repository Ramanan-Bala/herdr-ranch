import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, shared, setShared, run, exec, home, knownAgents, nextCommand, readTextFile, window as appWindow } from "herdr";
import { runGh } from "./lib/git.js";
import { relativeTime } from "./lib/format.js";
import { SETTINGS_KEY, resolveSettings, withSetting } from "./lib/settings.js";
import { tasksCommand } from "./lib/tasks-command.js";

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
    // Task-reporting health (the report file) refreshes every 30 s; the version
    // checks spawn processes, so those wait for refreshHealth's 5-min gate.
    cx.timer.every(30_000, (cx) => this.refreshHealth(cx));
    if (shared("ranch.health.gh") !== "ok") this.checkGh(cx);
    cx.spawn(async (cx) => {
      for (;;) if ((await nextCommand()) === "focus") {
        this.handle.focus();
        this.refreshHealth(cx); // shown again: catch up on the report file
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

  header(label) {
    const t = theme();
    return div().text_size(11).font_semibold().text_color(t.dim).child(label.toUpperCase());
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
      .on_click(() => toggle())
      .child(div().size(12).rounded(9).bg(on ? t.accent_foreground : t.muted));
  }

  switchRow(id, label, value, path) {
    const t = theme();
    return h_flex().flex_none().items_center().justify_between().gap(8)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(this.pill(id, value, () => this.set(path, !value)));
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
    return v_flex().gap(8).children([
      this.header("Top bar agents"),
      ...s.agents.map((key, i) => row(key, i)),
      ...(choices.length
        ? [h_flex().flex_wrap().items_center().gap(6).children([
            div().text_size(11).text_color(t.dim).child("Add:"),
            ...choices.map((c) => h_flex().id(`agent-add-${c.key}`).flex_none().items_center().gap(4).px(8).py(3).rounded(6)
              .bg(t.input).border_1().border_color(t.border).cursor_pointer().hover((st) => st.bg(t.hover))
              .on_click(() => this.set("agents", [...s.agents, c.key]))
              .child(div().text_size(11).child(c.name))
              .child(svg("mods/ranch-settings/plus.svg").size(10).text_color(t.muted))),
          ])]
        : []),
    ]);
  }

  sectionCards(t, s) {
    return v_flex().gap(8).children([
      this.header("Sidebar cards"),
      this.switchRow("card-time", "Time in status", s.card.time, "card.time"),
      this.switchRow("card-line3", "Diff stats line", s.card.line3, "card.line3"),
      this.switchRow("card-pr", "Pull request link", s.card.pr, "card.pr"),
    ]);
  }

  sectionSession(t, s) {
    return v_flex().gap(8).children([
      this.header("Session details"),
      this.switchRow("session-tasks", "Agent tasks", s.session.tasks, "session.tasks"),
      this.switchRow("session-git", "Git status", s.session.git, "session.git"),
      this.switchRow("session-commits", "Recent commits", s.session.commits, "session.commits"),
      this.switchRow("session-subagents", "Subagents", s.session.subagents, "session.subagents"),
    ]);
  }

  sectionRefresh(t, s) {
    return v_flex().gap(8).children([
      this.header("Refresh"),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Remote git"))
        .child(this.stepper("refresh-git", s.refresh.remoteGitSec, "s", 5, 300, 5, "refresh.remoteGitSec")),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("Pull request"))
        .child(this.stepper("refresh-pr", s.refresh.prSec, "s", 30, 900, 30, "refresh.prSec")),
    ]);
  }

  sectionNaming(t, s) {
    return v_flex().gap(8).children([
      this.header("Smart tab names"),
      this.switchRow("naming-enabled", "Enabled", s.naming.enabled, "naming.enabled"),
      h_flex().flex_none().items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).truncate().child("On exit"))
        .child(this.seg("naming-exit", s.naming.exitMode, [["keep", "Keep name"], ["revert", "Revert"], ["check", "Add ✓"]], "naming.exitMode")),
      this.switchRow("naming-follow", "Follow agent renames", s.naming.followAgent, "naming.followAgent"),
      v_flex().gap(2).children([
        this.switchRow("naming-model", "Summarise with a model", s.naming.model, "naming.model"),
        div().text_size(11).text_color(t.dim).child("Sends the first prompt of each session to the model provider (via the claude CLI)."),
      ]),
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
        rows.push(h_flex().flex_none().items_center().justify_between().gap(8)
          .child(div().flex_1().min_w(0).truncate().child(key))
          .child(div().text_color(color).child(status)));
        // "last report N min ago" (fixes 3.8): when the agent last evented.
        const at = this.report?.[key] ? Date.parse(this.report[key]) : null;
        if (Number.isFinite(at)) {
          const ago = Date.now() - at;
          if (ago >= 0) {
            rows.push(div().text_size(11).text_color(t.dim).child(`last report ${relativeTime(ago)}`));
          }
        }
      }
      const repair = TASK_KEYS.some((key) => this.tasks.agents[key] === "broken");
      // Codex hooks waiting for trust: only Codex's own /hooks can approve them.
      if (this.tasks.agents.codex === "needs approval") {
        rows.push(div().text_size(11).text_color(t.dim).child("Codex: approve the Ranch hooks once with /hooks in Codex."));
      }
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
    return v_flex().gap(8).children([this.header("Task reporting"), ...rows]);
  }

  sectionHealth(t) {
    const gh = shared("ranch.health.gh");
    const word = (w) => (w === "ok" ? ["ok", t.done]
      : w === "missing" ? ["missing", t.blocked]
      : w === "signed-out" ? ["signed out", t.blocked]
      : w === "old" ? ["too old", t.working]
      : ["checking…", t.dim]);
    return v_flex().gap(8).children([
      this.header("Health"),
      ...[["git", this.health.git, "health-git"], ["gh (GitHub CLI)", gh, "health-gh"], ["Herdr app", this.health.herdr, "health-herdr"]].map(([label, w, id]) => {
        const [word_, color] = word(w);
        return h_flex().flex_none().items_center().justify_between().gap(8)
          .child(div().flex_1().min_w(0).truncate().child(label))
          .child(div().text_color(color).child(word_));
      }),
    ]);
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
    const t = theme(), s = this.s();
    return v_flex().id("ranch-settings").size_full().min_h(0).overflow_y_scrollbar().bg(t.surface)
      .text_color(t.foreground).text_size(13).p(12).gap(20).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") run("pane.go", { direction: "left" });
      })
      .children([
        this.sectionAgents(t, s),
        this.sectionCards(t, s),
        this.sectionSession(t, s),
        this.sectionRefresh(t, s),
        this.sectionNaming(t, s),
        this.sectionTasks(t),
        this.sectionHealth(t),
        this.sectionFooter(t),
      ]);
  }
}
