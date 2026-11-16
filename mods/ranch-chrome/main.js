import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, agents, spaces, panes, exec } from "herdr";
import { FILTER_KEY, SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { repoLabels } from "./lib/git.js";
import { effectiveStatus } from "./lib/format.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Agent counts the footer shows, in chip order. Idle is a tooltip-only total.
// Per tab: Herdr's status, else the activity Ranch's hooks recorded (so a
// Claude whose status Herdr lost still counts as working).
function statusCounts() {
  const counts = { blocked: 0, working: 0, done: 0, idle: 0 };
  const activity = shared("ranch.activity") ?? {};
  const now = Date.now();
  for (const sp of spaces()) {
    for (const tb of sp.tabs) {
      const { status } = effectiveStatus(tb, activity[tb.id], now);
      if (status in counts) counts[status]++;
    }
  }
  return counts;
}

// The tab to focus for "needs you": a blocked agent, else a tab whose hooks say blocked.
function blockedTarget() {
  const a = agents().find((x) => x.status === "blocked");
  if (a) return { terminal: a.address };
  const activity = shared("ranch.activity") ?? {};
  for (const sp of spaces()) for (const tb of sp.tabs) {
    if (!tb.status && activity[tb.id]?.state === "blocked") return { tab: tb.id };
  }
  return null;
}

// The pane the active tab shows: its agent's pane, else the focused/first pane.
function activePane() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((c) => c.active);
  const tabPanes = tab ? panes().filter((p) => p.tab === tab.id) : [];
  const pane = tabPanes.find((p) => p.program?.agent) ?? tabPanes.find((p) => p.focused) ?? tabPanes[0];
  return { space, pane };
}

// How long a repo/worktree/branch lookup for one folder stays fresh.
const REPO_TTL_MS = 15_000;

export default class RanchChrome extends View {
  init(p, cx) {
    if (!p?.status) return;
    // Status bar only: repo, worktree and branch of the active pane's folder,
    // keyed by "machine|cwd". Render can't spawn, so a 1 s tick does the lookups.
    this.repoInfo = new Map();
    this.repoBusy = false;
    cx.timer.every(1000, (cx) => this.pollRepo(cx));
  }

  pollRepo(cx) {
    if (this.repoBusy) return;
    const { space, pane } = activePane();
    if (!pane?.cwd) return;
    const machine = space?.machine ?? null;
    const key = `${machine ?? ""}|${pane.cwd}`;
    const hit = this.repoInfo.get(key);
    if (hit && Date.now() - hit.at < REPO_TTL_MS) return;
    this.repoBusy = true;
    cx.spawn(async (cx) => {
      let info = { repo: null, worktree: null, branch: null };
      try {
        const r = await exec("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"],
          { cwd: pane.cwd, on: machine, timeout: 10_000 });
        if (r.code === 0) {
          const [top, common, head] = (r.stdout || "").split("\n").map((l) => l.trim());
          if (top) info = { ...repoLabels(top, common || null), branch: head && head !== "HEAD" ? head : null };
        }
      } catch {
        // Unreachable machine or no git: show nothing for this folder until the TTL passes.
      } finally {
        this.repoBusy = false;
      }
      if (this.repoInfo.size > 64) this.repoInfo.clear();
      this.repoInfo.set(key, { ...info, at: Date.now() });
      cx.notify();
    });
  }

  button(id, label, action, size = 26) {
    const t = theme();
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }
  render() {
    const t = theme();
    const collapsed = narrow();
    // Bottom status bar, left end: repo, worktree, branch, machine of the active
    // tab (each one optional in Ranch settings, statusbar.*).
    if (props()?.status) {
      const show = resolveSettings(shared(SETTINGS_KEY)).statusbar;
      const { space, pane } = activePane();
      const info = pane?.cwd ? this.repoInfo?.get(`${space?.machine ?? ""}|${pane.cwd}`) : null;
      const branch = pane?.branch || info?.branch;
      const item = (id, icon, text, tip) => h_flex().id(id).gap(5).items_center().min_w(0).flex_shrink(1)
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .child(svg(`mods/ranch-chrome/${icon}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().truncate().child(text));
      const items = [
        show.repo && info?.repo ? item("sb-repo", "folder", info.repo, "Repository") : null,
        show.worktree && info?.worktree ? item("sb-worktree", "layers", info.worktree, "Worktree") : null,
        show.branch && branch ? item("sb-branch", "git-branch", branch, "Branch") : null,
        show.machine ? item("sb-machine", space?.machine ? "server" : "laptop", space?.machine ?? "This computer", "Machine") : null,
      ].filter(Boolean);
      return h_flex().size_full().min_w(0).px(12).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
        .children(items);
    }
    if (props()?.footer) {
      const counts = statusCounts();
      const filter = shared(FILTER_KEY);
      const toggle = (status) => {
        if (status === "blocked") {
          const target = blockedTarget();
          if (target?.terminal) run("agent.focus", { terminal: target.terminal });
          else if (target?.tab) run("tab.select", { id: target.tab });
        } else {
          setShared(FILTER_KEY, filter === status ? null : status);
        }
      };
      const dot = (color, pulse) => div().size(6).flex_none().rounded_full().bg(color)
        .when(pulse, el => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
      // One status chip; hidden when its count is 0. Blocked focuses the agent, the rest filter the tree.
      const chip = (status, color, pulse) => {
        const selected = status !== "blocked" && filter === status;
        return h_flex().id(`status-${status}`).h(18).px(5).gap(5).items_center().rounded(6).flex_none()
          .when(selected, el => el.bg(t.selected))
          .text_color(selected ? t.foreground : t.muted).hover(s => s.bg(t.hover)).cursor_pointer()
          .on_click(() => toggle(status))
          .child(dot(color, pulse))
          .child(`${counts[status]} ${status === "blocked" ? "needs you" : status}`);
      // (chips are compact: the footer is a single 28px row)
      };
      // Wide footer: chips for whatever is busy (done included), else a quiet line.
      const busy = counts.blocked + counts.working > 0;
      const chips = [
        counts.blocked ? chip("blocked", t.blocked, true) : null,
        counts.working ? chip("working", t.working, false) : null,
        counts.done ? chip("done", t.done, false) : null,
      ].filter(Boolean);
      const idleTip = counts.idle ? `${counts.idle} idle` : null;
      // The rail keeps only the non-zero counts as small badges, blocked first.
      const badge = (status, color) => h_flex().id(`rail-${status}`).size(18).items_center().justify_center().rounded_full().bg(t.hover).flex_none()
        .text_size(10).text_color(color).cursor_pointer().tooltip(`${counts[status]} ${status === "blocked" ? "needs you" : status}`)
        .on_click(() => toggle(status)).child(String(counts[status]));
      const badges = [
        counts.blocked ? badge("blocked", t.blocked) : null,
        counts.working ? badge("working", t.working) : null,
        counts.done ? badge("done", t.done) : null,
      ].filter(Boolean);
      const quiet = h_flex().id("status-summary").h(22).px(8).gap(8).items_center()
        .when(idleTip, el => el.tooltip(idleTip))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child("Nothing needs you"))
        .when(counts.done > 0, el => el.child(chip("done", t.done, false)));
      const summary = collapsed
        ? h_flex().id("status-summary").h(22).gap(6).items_center().justify_center()
            .when(idleTip && !badges.length, el => el.tooltip(idleTip)).children(badges)
        : busy
          ? h_flex().id("status-summary").h(22).px(8).gap(6).items_center()
              .when(idleTip, el => el.tooltip(idleTip)).children(chips)
          : quiet;
      // Tools: two icon buttons; the update-ready dot sits on the settings slot.
      const tool = (id, icon, label, action) => this.button(id, svg(`mods/ranch-chrome/${icon}.svg`).size(14), action, 22)
        .tooltip(label);
      const tools = h_flex().id("tools").h_full().flex_none().gap(6).items_center()
        .when(collapsed, el => el.flex_1().justify_center())
        .child(tool("settings", "settings", "Settings", () => run("app.settings")).relative()
          .when(Boolean(updates().app.ready), el => el.child(
            div().absolute().top(4).right(4).size(6).rounded_full().bg(t.accent))))
        .child(tool("machine", "plus", "Add machine", () => run("mod.open", { name: "machine-add" })));
      // One row like the reference: status text at left, two tool buttons at right.
      if (collapsed) {
        // The rail shows per-space badges already; keep the 28px footer to the tools.
        return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).items_center().justify_center().text_size(11)
          .child(tools);
      }
      return h_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).pl(6).pr(8).gap(4).items_center().text_size(11.5)
        .child(summary.flex_1().min_w(0))
        .child(tools);
    }
    const macos = window()?.platform === "macos";
    return h_flex().size_full().bg(t.chrome).pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(13.5)
      .border_b(1).border_color(t.border)
      .when(macos && !window()?.fullscreen && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(8).items_center()
        .child(image("mods/ranch-chrome/logo.svg").size(20))
        .child(div().font_semibold().text_color(t.foreground).child("Ranch"))))
      .when(!collapsed, el => el.child(this.button("search", svg("mods/ranch-chrome/search.svg").size(15), () => run("mod.open", { name: "picker" }))))
      // On the rail (non-macOS) the logo is all the brand there is; on macOS the traffic lights fill the row.
      .when(collapsed && !macos, el => el.child(h_flex().flex_1().justify_center().child(image("mods/ranch-chrome/logo.svg").size(22))))
      .when(!(collapsed && macos), el => el.child(this.button("sidebar-toggle", svg("mods/ranch-chrome/sidebar.svg").size(15), toggleSidebar)));
  }
}
