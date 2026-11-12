// Start-agent dialog: type a task, pick an agent, Enter. Starts the agent in a
// new tab (or, when "New worktree" is on and the space is in a git repo, a fresh
// worktree as a new space). Opened by ranch-topbar with
// openOverlay({ mod: "ranch-launch", kind: "dialog", width: 520, height: 300,
//   props: { space: "<space id>" } }); props().space missing: the active space.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  run,
  props,
  closeOverlay,
  theme,
  spaces,
  panes,
  exec,
  home,
  shared,
  setShared,
  knownAgents,
} from "herdr";
import { SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { branchFromPrompt, worktreePath, launchOrder, launchDecision } from "./lib/launch.js";
import { homeCache } from "./lib/home.js";

// Where a space is now: its first terminal's live folder, else where it was
// made — the worktree mod's place().
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

export default class RanchLaunch extends View {
  init(_props, cx) {
    const space = this.space();
    this.spaceId = props()?.space ?? space?.id ?? null;
    this.machine = space?.machine ?? null;

    this.text = "";
    this.input = InputState.new({ value: "", placeholder: "What should it do? (optional)" });
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value();
      // The branch name follows the prompt until the person edits it.
      if (!this.branchEdited) {
        // set_value fires the branch input's own "change": don't count it as an edit.
        this.syncingBranch = true;
        this.branch.set_value(branchFromPrompt(this.text, Date.now()));
        this.syncingBranch = false;
      }
      this.error = "";
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();

    // Agents to offer. The top bar caches its knownAgents() answer under
    // "ranch.knownAgents"; empty here means ask once ourselves.
    this.known = shared("ranch.knownAgents") ?? null;
    if (!this.known?.length) {
      cx.spawn(async (cx) => {
        try {
          this.known = await knownAgents();
          setShared("ranch.knownAgents", this.known);
        } catch {
          // A failed check isn't cached; the dialog still works without chips.
        }
        cx.notify();
      });
    }
    // Default selection: the agent used last time, if it is still offered.
    this.picked = localStorage.getItem("lastAgent");

    // Worktree state: is the space's folder in a git repo, and is that on?
    // probe: pending (looking) | repo | none | error, decided by launchDecision.
    this.probe = "pending";
    this.probeGen = 0;
    this.homeOk = undefined; // false once the remote home lookup failed
    this.worktree = localStorage.getItem("worktree") === "1";
    this.branchEdited = false;
    this.branch = InputState.new({ value: branchFromPrompt("", Date.now()) });
    this.branch.on("change", (_e, cx) => {
      if (this.syncingBranch) return;
      this.branchEdited = true;
      this.error = "";
      cx.notify();
    });
    this.busy = false;
    this.error = "";

    // The home lookup for the target machine, cached per view (lib/home.js):
    // sh first, cmd.exe on a Windows remote, failures remembered for a while.
    this.homeFor = homeCache(exec, () => home());
    this.probeRepo(cx, space);
  }

  /**
   * Finds the target folder's git toplevel. The generation token ignores a
   * completion from an older run; calling this again (target moved) bumps it
   * and resets the state, so a stale probe can't decide a new launch.
   */
  probeRepo(cx, space) {
    const gen = ++this.probeGen;
    this.probe = "pending";
    this.homeOk = undefined;
    cx.notify();
    cx.spawn(async (cx) => {
      const folder = place(space);
      if (!folder) { this.probe = "none"; cx.notify(); return; }
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on: this.machine });
        if (gen !== this.probeGen) return; // stale probe
        this.repoTop = r.code === 0 ? r.stdout.trim() : null;
        this.probe = this.repoTop ? "repo" : "none";
        if (this.probe === "repo") {
          try { this.homeOk = (await this.homeFor(this.machine)) != null; }
          catch { this.homeOk = false; }
        }
      } catch {
        this.repoTop = null;
        this.probe = "error";
      }
      cx.notify();
    });
  }

  /** The space this dialog targets: props().space, else the active one. */
  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? spaces().find((s) => s.active);
  }

  /** The agents to offer as chips, in Ranch settings order (lib/launch.js). */
  offered() {
    const known = shared("ranch.knownAgents") ?? this.known ?? [];
    const byKey = new Map(known.map((a) => [a.key, a]));
    const keys = launchOrder(resolveSettings(shared(SETTINGS_KEY)).agents, known);
    return keys.map((k) => byKey.get(k)).filter(Boolean);
  }

  chosen(offered) {
    const list = offered ?? this.offered();
    return list.find((a) => a.key === this.picked) ?? list[0] ?? null;
  }

  toggleWorktree(cx) {
    this.worktree = !this.worktree;
    localStorage.setItem("worktree", this.worktree ? "1" : "0");
    cx.notify();
  }

  cycle(cx, dir) {
    const list = this.offered();
    if (list.length < 2) return;
    const i = Math.max(0, list.findIndex((a) => a.key === this.picked));
    this.picked = list[(i + dir + list.length) % list.length].key;
    cx.notify();
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
    else if (e.key === "down") { this.cycle(cx, 1); cx.stop_propagation(); }
    else if (e.key === "up") { this.cycle(cx, -1); cx.stop_propagation(); }
  }

  start(cx) {
    if (this.busy) return;
    const agent = this.chosen();
    if (!agent) { this.error = "No agent to start."; cx.notify(); return; }
    const text = this.text.trim();
    localStorage.setItem("lastAgent", agent.key);

    const decision = launchDecision({ worktree: this.worktree, probe: this.probe, homeOk: this.homeOk });
    if (decision === "wait") {
      // Worktree mode on but the repo probe hasn't finished: never guess.
      this.error = "Checking repository…";
      cx.notify();
      return;
    }
    if (decision.startsWith("error:")) {
      this.error = {
        "error:no-repo": "This folder isn't in a git repository — turn off New worktree to start here.",
        "error:probe": "Couldn't check for a git repository.",
        "error:home": "Couldn't get the machine's home directory.",
      }[decision] ?? "Cannot start in a worktree.";
      cx.notify();
      return;
    }
    if (decision === "plain") {
      closeOverlay(props().overlay);
      run("tab.new", { space: this.spaceId, argv: agent.run, ...(text ? { task: text } : {}) });
      return;
    }

    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const branch = this.branch.value().trim();
        if (!branch) throw new Error("Name the new branch.");
        const userHome = await this.homeFor(this.machine);
        if (!userHome) throw new Error("Couldn't get the machine's home directory.");
        const path = worktreePath(userHome, this.repoTop, branch);
        const git = (args) =>
          exec("git", args, { cwd: this.repoTop, on: this.machine, timeout: 600000 });
        let r = await git(["worktree", "add", "-b", branch, path]);
        // The branch already exists: check it out into the new worktree instead.
        if (r.code !== 0 && /already exists/.test(r.stderr ?? "")) {
          r = await git(["worktree", "add", path, branch]);
        }
        if (r.code !== 0) {
          this.error = (r.stderr ?? "").trim().split("\n")[0] || "git worktree add failed.";
        } else {
          closeOverlay(props().overlay);
          run("space.new", { folder: path, argv: agent.run, machine: this.machine ?? "", ...(text ? { task: text } : {}) });
        }
      } catch (e) {
        this.error = String(e).replace(/^Error: /, "").split("\n")[0];
      }
      this.busy = false;
      cx.notify();
    });
  }

  chip(t, agent, on) {
    const icon = agent.icon
      ? agent.tint
        ? svg(agent.icon).size(14).flex_none().text_color(t.muted)
        : image(agent.icon).size(14).flex_none()
      : div().text_size(10).flex_none().child(agent.key.slice(0, 2));
    return h_flex()
      .id(`agent-${agent.key}`)
      .h(28)
      .px(10)
      .gap(6)
      .items_center()
      .rounded(7)
      .border_1()
      .when(on, (el) => el.bg(t.selected).border_color(t.border).text_color(t.foreground))
      .when(!on, (el) => el.border_color(t.popover).text_color(t.muted).hover((h) => h.bg(t.hover)))
      .cursor_pointer()
      .on_click((_e, cx) => { this.picked = agent.key; cx.notify(); })
      .child(icon)
      .child(div().text_size(11.5).truncate().child(agent.name));
  }

  render() {
    const t = theme();
    const offered = this.offered();
    const inRepo = this.probe === "repo";
    return v_flex()
      .id("ranch-launch")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().flex_1().min_w(0).text_size(13.5).font_semibold().child("Start an agent"))
          .child(div().flex_none().truncate().text_size(11.5).text_color(t.dim)
            .child(this.space() ? `in ${this.space().name}` : "")),
      )
      .child(
        Input.new(this.input)
          .h(38)
          .px(10)
          .rounded(8)
          .border_1()
          .border_color(this.inputFocused ? t.accent : t.input)
          .bg(t.background)
          .text_size(12.8)
          .text_color(t.foreground),
      )
      .when(offered.length > 0, (el) =>
        el.child(h_flex().gap(6).flex_wrap().children(offered.map((a) => this.chip(t, a, a.key === this.chosen(offered)?.key)))))
      .when(inRepo, (el) =>
        el.child(
          h_flex()
            .items_center()
            .gap(10)
            .child(
              h_flex()
                .id("launch-worktree")
                .gap(8)
                .items_center()
                .cursor_pointer()
                .on_click((_e, cx) => this.toggleWorktree(cx))
                .child(
                  div()
                    .size(16)
                    .flex_none()
                    .rounded(4)
                    .border(1)
                    .border_color(this.worktree ? t.accent : t.border)
                    .when(this.worktree, (el) => el.bg(t.accent).flex().items_center().justify_center()
                      .child(svg("mods/ranch-launch/check.svg").size(11).text_color(t.background))),
                )
                .child(div().flex_none().text_size(12).text_color(this.worktree ? t.foreground : t.muted).child("New worktree")),
            )
            .when(this.worktree, (el) =>
              el.child(
                Input.new(this.branch)
                  .h(30)
                  .px(8)
                  .flex_1()
                  .min_w(0)
                  .rounded(6)
                  .border_1()
                  .border_color(t.input)
                  .bg(t.background)
                  .text_size(11.5)
                  .text_color(t.foreground),
              ),
            ),
        ))
      .when(Boolean(this.error), (el) =>
        el.child(div().truncate().text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(
        h_flex()
          .items_center()
          .gap(10)
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child("↵ start · ↑↓ agent · esc close"))
          .child(
            h_flex()
              .id("launch-start")
              .h(30)
              .px(14)
              .items_center()
              .rounded(8)
              .bg(t.solid)
              .text_color(t.solid_foreground)
              .text_size(12.5)
              .font_medium()
              .when(!this.busy, (el) => el.cursor_pointer().hover((h) => h.opacity(0.88)).on_click((_e, cx) => this.start(cx)))
              .when(this.busy, (el) => el.opacity(0.6))
              .child(this.busy ? "Creating worktree…" : "Start"),
          ),
      );
  }
}
