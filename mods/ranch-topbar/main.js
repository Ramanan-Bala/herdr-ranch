// Ranch top bar: the current tab on the left, agent launchers and right-panel
// toggles on the right. Lives in the layout's "tabs" block, a window_drag area:
// every control stops mouse-down propagation. Starts from Herdr's tabs mod.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  spaces, panes, agents, run, openOverlay, theme, window, shared, layout,
  settings, knownAgents, nextCommand, setShared, home,
} from "herdr";
import { AUTONAMES_KEY, SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { effectiveStatus, attentionQueue } from "./lib/format.js";
import { readPanels } from "./state.js";

// The right-panel stack ids this bar can toggle, in layout "panel-body".
const PANELS = ["session", "files", "changes", "settings"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function cap(key) {
  return key ? key[0].toUpperCase() + key.slice(1) : key;
}

export default class RanchTopbar extends View {
  init(_props, cx) {
    // localStorage access itself can throw (privacy mode, corrupted store).
    let storedPanels = null;
    try { storedPanels = localStorage.getItem("panels"); } catch {}
    this.panels = readPanels(storedPanels, PANELS);
    // knownAgents(), null until the first check lands; the cached answer shows at once.
    this.agents = shared("ranch.knownAgents") ?? null;
    const loadAgents = async (cx) => {
      try {
        this.agents = await knownAgents();
        setShared("ranch.knownAgents", this.agents);
      } catch {
        // A failed check isn't cached; keep what we have and retry on the timer.
      }
      cx.notify();
    };
    cx.spawn(loadAgents);
    cx.timer.every(60000, (cx) => cx.spawn(loadAgents));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "attention:next") this.attentionNext();
        else if (c === "launch") this.launch();
        else {
          const m = /^panel:(session|files|changes|settings)$/.exec(c);
          if (m) this.togglePanel(m[1]);
        }
        cx.notify();
      }
    });
  }

  // Jump to the next tab that needs the person: the entry after the active one
  // in the queue (wrapping), or the queue's first entry. Never a no-op when
  // there's a queue: the active tab may be settling, so falling back to q[0].
  attentionTarget(q, spaceList) {
    if (!q.length) return null;
    const activeTab = spaceList.find(p => p.active)?.tabs.find(c => c.active);
    const i = q.findIndex(e => e.tabId === activeTab?.id);
    return i === -1 ? q[0] : q[(i + 1) % q.length];
  }

  attentionNext() {
    const spaceList = spaces();
    const next = this.attentionTarget(attentionQueue(spaceList, shared("ranch.activity") ?? {}, Date.now()), spaceList);
    if (!next) return;
    if (next.spaceId !== spaceList.find(p => p.active)?.id) run("space.select", { id: next.spaceId });
    run("tab.select", { id: next.tabId });
  }

  // The Start agent dialog (ranch-launch), scoped to the active space.
  launch() {
    const activeSpace = spaces().find(p => p.active);
    openOverlay({
      mod: "ranch-launch", kind: "dialog", width: 520, height: 256,
      props: { space: activeSpace?.id },
    });
  }

  // Shared by the toggle buttons and the panel:* key commands.
  togglePanel(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (panel && !panel.hidden && body?.active === id) run("layout.hide", { id: "panel" });
    else {
      run("layout.select", { stack: "panel-body", child: id });
      run("layout.show", { id: "panel" });
    }
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, child, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(child);
    const space = spaces().find(p => p.active);
    const tab = space?.tabs.find(c => c.active);
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    this.syncPanel(space, panel, body, PANELS);

    // Group 1: agent launchers from Ranch settings, in order. "terminal" is a plain shell.
    const launch = (id, icon, tooltip, action) => {
      let el = div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).child(icon);
      if (tooltip) el = el.tooltip(tooltip);
      return action ? el.on_click(action) : el.opacity(0.4);
    };
    const launchers = (resolveSettings(shared(SETTINGS_KEY)).agents ?? []).map(key => {
      if (key === "terminal") {
        return launch("launch-terminal", svg("mods/ranch-topbar/terminal.svg").size(14), "New terminal tab",
          () => run("tab.new", space ? { space: space.id } : {}));
      }
      const agent = this.agents?.find(a => a.key === key);
      const name = agent?.name ?? cap(key);
      // Until knownAgents() answers, Herdr's shipped icon for the key stands in.
      const fallback = ["claude", "codex", "opencode"].includes(key) ? `icons/${key}.svg` : null;
      const icon = agent?.icon
        ? (agent.tint ? svg(agent.icon).size(14).text_color(t.muted) : image(agent.icon).size(14))
        : fallback ? image(fallback).size(14) : div().text_size(10).child(cap(key).slice(0, 2));
      if (!agent) {
        // Still checking, or a settings key no agent answers to: shown but inert.
        return launch(`launch-${key}`, icon, this.agents === null ? null : `${name} isn't installed`, null);
      }
      if (agent.installed === false) {
        return launch(`launch-${key}`, icon, `${name} isn't installed`, null);
      }
      return launch(`launch-${key}`, icon, `New ${name} tab`, () => run("tab.new", space ? { space: space.id, argv: agent.run } : { argv: agent.run }));
    });

    // Attention pill: tabs that need the person right now (see attentionNext).
    // "⌘⌥J"-style suffix for tooltips, per platform.
    const keySuffix = (letter) => w?.platform === "macos" ? `(⌘⌥${letter})` : `(Ctrl+Alt+${letter})`;
    const queue = attentionQueue(spaces(), shared("ranch.activity") ?? {}, Date.now());
    const blockedCount = queue.filter(e => e.status === "blocked").length;
    const doneCount = queue.length - blockedCount;
    const attentionPill = queue.length ? (() => {
      // The tooltip names the tab a click would actually go to.
      const entry = this.attentionTarget(queue, spaces());
      const entrySpace = spaces().find(p => p.id === entry.spaceId);
      const entryTab = entrySpace?.tabs.find(c => c.id === entry.tabId);
      const entryPanes = panes().filter(p => p.tab === entry.tabId);
      const entryProgram = (entryPanes.find(p => p.program?.agent) ?? entryPanes.find(p => p.focused) ?? entryPanes[0])?.program;
      const unnamed = entryTab && (/^tb\d+$/.test(entryTab.name) || (!entryTab.named && /^\d+$/.test(entryTab.name)));
      const name = unnamed ? entryProgram?.name ?? "Terminal" : entryTab?.name ?? "?";
      return div().id("attention-pill").h(24).px(8).gap(6).flex_none().flex().items_center().rounded(6)
        .bg(t.raised).border(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => this.attentionNext())
        .tooltip(`Next: ${entrySpace?.name ?? "?"} / ${name} ${keySuffix("J")}`)
        .child(blockedCount
          ? div().id("attention-dot").size(6).rounded_full().bg(t.blocked).flex_none().loop("opacity", { from: 0.35, to: 1, period: 1200 })
          : div().id("attention-dot").size(6).rounded_full().bg(t.done).flex_none())
        .child(div().max_w(180).truncate().child(blockedCount
          ? doneCount ? `${blockedCount} needs you · ${doneCount} done` : `${blockedCount} needs you`
          : `${doneCount} done`));
    })() : null;

    // Group 2: right-panel toggles, icon only, one panel at a time; the open one hides it.
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      const el = div().id(`panel-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(on ? t.foreground : t.dim)
        .when(on, el => el.bg(t.raised).border(1).border_color(t.border))
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => this.togglePanel(id)).tooltip(label)
        .child(svg(icon).size(14));
      // The session panel publishes its unfinished task count per tab.
      if (id === "session" && tab) {
        const count = shared("ranch.taskCount")?.[tab.id];
        if (typeof count === "number" && count > 0) {
          return div().id(`panel-session-wrap`).relative().flex_none()
            .child(el)
            .child(div().id(`panel-session-badge`).absolute().top(0).right(0).size(12).rounded_full().flex()
              .items_center().justify_center().bg(t.working).text_size(9)
              .child(String(Math.min(count, 99))));
        }
      }
      return el;
    };

    // The current tab, inline on the bar (no pill): status ring, space / name,
    // branch pill, auto/lock marker, close.
    const left = tab && (() => {
      // Branch from the pane this tab shows: the agent's pane, else the focused/first pane.
      const tabPanes = panes().filter(p => p.tab === tab.id);
      const pane = tabPanes.find(p => p.program?.agent) ?? tabPanes.find(p => p.focused) ?? tabPanes[0];
      const program = pane?.program;
      const unnamed = /^tb\d+$/.test(tab.name) || (!tab.named && /^\d+$/.test(tab.name));
      const name = unnamed ? program?.name ?? "Terminal" : tab.name;
      const auto = shared(AUTONAMES_KEY)?.[tab.id];
      const close = (_e, cx) => {
        cx.stop_propagation();
        const busy = agents().some(a => a.tab === tab.id && (a.status === "working" || a.status === "blocked"));
        if (!busy) { run("tab.close", { id: tab.id }); return; }
        openOverlay({
          mod: "confirm", kind: "dialog", width: 400, height: 170,
          props: {
            title: "Close this tab?",
            detail: space?.tabs.length === 1
              ? "An agent here is still working, and this is the space's last tab: the space closes with it."
              : "An agent here is still working. Its terminal closes with the tab.",
            command: { name: "tab.close", args: { id: tab.id, confirmed: true } },
          },
        });
      };
      // Status glyph: spinner while working, filled dot when blocked, check when done,
      // otherwise a dim ring.
      // Herdr's status, else the activity Ranch's hooks recorded for this tab.
      const status = effectiveStatus(tab, shared("ranch.activity")?.[tab.id], Date.now()).status;
      const statusGlyph = status === "working" ? svg("mods/ranch-topbar/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)
        : status === "blocked" ? div().size(7).rounded_full().bg(t.blocked).flex_none()
        : status === "done" ? svg("mods/ranch-topbar/check.svg").size(12).flex_none().text_color(t.done)
        : div().size(9).rounded_full().border(1).border_color(t.dim).flex_none();
      return h_flex().id(`tab-${tab.id}`).gap(6).px(2).min_w(0).max_w(760).items_center().flex_none().text_size(12.5)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } });
        })
        // Agent logo first (the pane header is gone; its details live here now).
        .when(Boolean(program?.icon), el => el.child(program.tint
          ? svg(program.icon).size(15).flex_none().text_color(t.muted)
          : image(program.icon).size(15).flex_none()))
        .child(statusGlyph)
        .child(div().max_w(160).truncate().text_color(t.muted).child(space.name))
        .child(div().text_color(t.dim).flex_none().child("/"))
        .child(div().max_w(260).truncate().font_semibold().text_color(t.foreground).child(name))
        .when(Boolean(pane?.branch), el => el.child(
          // The focused pane's branch, as a pill.
          h_flex().id(`branch-${tab.id}`).h(18).px(6).gap(4).flex_none().items_center().rounded(4).bg(t.raised)
            .text_size(11).text_color(t.muted)
            .child(svg("mods/ranch-topbar/git-branch.svg").size(11).flex_none().text_color(t.muted))
            .child(div().max_w(220).truncate().child(pane.branch))))
        .when(Boolean(pane?.cwd), el => el.child(div().id(`cwd-${tab.id}`).max_w(240).truncate().text_size(11).text_color(t.dim)
          .tooltip(pane.cwd).child(pane.cwd.replace(home(), "~"))))
        .when(tab.named && auto?.name === tab.name, el => el.child(div().id(`auto-${tab.id}`).text_size(10).text_color(t.dim).flex_none()
          .tooltip(`Named by the agent's session (source: ${auto.source ?? "agent"})`).child("auto")))
        .when(tab.named && auto?.name !== tab.name, el => el.child(div().id(`lock-${tab.id}`).text_size(10).text_color(t.dim).flex_none()
          .tooltip("You named this tab. Reset name in the tab menu to let the agent name it.").child("✎")))
        .child(div().id(`close-${tab.id}`).flex_none().text_color(t.dim).hover(s => s.text_color(t.foreground))
          .on_mouse_down("left", stop).on_click(close).child(svg("mods/ranch-topbar/close.svg").size(12)));
    })();

    return h_flex().id("root").size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .children([
        ...(left ? [left] : []),
        button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })),
        h_flex().id("spacer").flex_1().min_w(0),
        ...(attentionPill ? [attentionPill] : []),
        launch("launch-sparkle", svg("mods/ranch-topbar/sparkle.svg").size(14),
          `Start agent with a task ${keySuffix("N")}`, () => this.launch()),
        ...launchers,
        div().id("panel-divider").w(1).h(18).flex_none().mx(6).bg(t.border),
        panelButton("session", `Session details ${keySuffix("1")}`, "mods/ranch-topbar/session.svg"),
        panelButton("files", `Files ${keySuffix("2")}`, "mods/ranch-files/file.svg"),
        panelButton("changes", `Changes ${keySuffix("3")}`, "mods/ranch-changes/changes.svg"),
        panelButton("settings", `Ranch settings ${keySuffix("4")}`, "mods/ranch-topbar/settings.svg"),
        ...w?.buttons ? [
          button("minimize", w.platform === "windows" ? svg("mods/ranch-topbar/win-min.svg").size(16) : "−", () => run("window.minimize")),
          button("maximize", w.platform === "windows" ? svg(`mods/ranch-topbar/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")),
          button("close-window", w.platform === "windows" ? svg("mods/ranch-topbar/win-close.svg").size(16) : svg("mods/ranch-topbar/close.svg").size(13), () => run("window.close")),
        ] : [],
      ]);
  }
}
