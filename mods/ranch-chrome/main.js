import { View, div, image, svg } from "gpui-kit";
import { Popover, h_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout, agents, spaces, panes, machines, checking, exec, terminals } from "herdr";
import { FILTER_KEY, SETTINGS_KEY, resolveSettings } from "./lib/settings.js";
import { effectiveStatus } from "./lib/format.js";
import {
  parsePs,
  sessionPids,
  sumUsage,
  parseLsofListen,
  sessionPorts,
  parseHcGet,
  attributeTerminals,
  pushHistory,
  sweepHistory,
  herdrUsage,
  ownerSplit,
  isOrphan,
  buildResourceTree,
  historySamples,
  WINDOWS_PS_SCRIPT,
  parseWinProcs,
  applyWinCpu,
  parseNetstatListen,
} from "./lib/sysstats.js";
import { renderResourcePopover } from "./resources.js";

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

export default class RanchChrome extends View {
  init(_props, cx) {
    // Herdr hands init() no props here; the block's props come from props().
    if (!props()?.status) return;
    // Status bar only: the processes inside Herdr sessions and what they use.
    // Render can't spawn, so a 1 s tick polls every 5 s (or 2 s while open).
    this.stats = null;
    this.statsBusy = false;
    this.pidCache = new Map();
    this.refreshDetails = false;
    this.history = new Map();
    this.resOpen = false;
    this.resTab = "resources";
    this.resSort = "memory";
    this.collapsed = new Set();
    this.selected = new Set();
    this.expanded = new Set();
    this.confirmKill = null;
    this.hoveredRow = null;
    this.lastPollAt = 0;
    this.winCpu = new Map();
    if (!checking()) {
      this.pollStats(cx);
      cx.timer.every(1000, (cx) => {
        const interval = this.resOpen ? 2000 : 5000;
        if (Date.now() - this.lastPollAt >= interval - 50) this.pollStats(cx);
      });
    }
  }

  pollStats(cx) {
    if (this.statsBusy || checking()) return;
    this.statsBusy = true;
    this.lastPollAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        // Windows has no ps/lsof: PowerShell's Win32_Process list (CPU from the
        // tick delta between polls) and netstat stand in for them.
        const win = window()?.platform === "windows";
        const tryExec = async (cmd, args, timeout) => {
          try {
            return await exec(cmd, args, { timeout });
          } catch {
            return null;
          }
        };
        let procs;
        let listens = null;
        if (win) {
          const ps = await tryExec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PS_SCRIPT], 15000);
          // Without a process list there is nothing to attribute; keep the last stats (or null).
          if (!ps || ps.code !== 0) return;
          procs = applyWinCpu(parseWinProcs(ps.stdout), this.winCpu, Date.now());
          const ns = await tryExec("netstat", ["-ano"], 5000);
          if (ns && ns.code === 0) listens = parseNetstatListen(ns.stdout, procs);
        } else {
          const ps = await tryExec("ps", ["-axo", "pid=,ppid=,rss=,pcpu=,comm="], 5000);
          if (!ps || ps.code !== 0) return;
          procs = parsePs(ps.stdout);
          const lsof = await tryExec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], 5000);
          if (lsof && lsof.code === 0) listens = parseLsofListen(lsof.stdout);
        }
        const pids = sessionPids(procs);
        const usage = sumUsage(procs, pids);
        const ports = listens ? sessionPorts(listens, pids) : null;

        let rows = this.stats?.rows ?? [];
        let other = this.stats?.other ?? { rssKB: 0, cpu: 0, count: 0 };
        let herdr = this.stats?.herdr ?? herdrUsage(procs);
        let agentAddresses = this.stats?.agentAddresses ?? new Set();
        let orphanAddresses = this.stats?.orphanAddresses ?? new Set();
        let split = this.stats?.split ?? ownerSplit({ herdr, rows, agentAddresses });
        let localTerms = this.stats?.terminals ?? [];
        const observedAt = Date.now();

        try {
          localTerms = (terminals() ?? []).filter((t) =>
            t && typeof t.address === "string" && t.address
            && !t.address.includes(":") && !t.address.includes("/")
            && t.machine == null && t.host == null);
          const listed = new Set(localTerms.map((t) => t.address));
          for (const addr of this.pidCache.keys()) {
            if (!listed.has(addr)) this.pidCache.delete(addr);
          }
          for (const addr of this.selected) {
            if (!listed.has(addr)) this.selected.delete(addr);
          }
          for (const addr of this.expanded) {
            if (!listed.has(addr)) this.expanded.delete(addr);
          }
          if (this.hoveredRow && !listed.has(this.hoveredRow)) this.hoveredRow = null;
          if (typeof this.confirmKill === "string") {
            if (this.confirmKill.startsWith("row:") && !listed.has(this.confirmKill.slice(4))) {
              this.confirmKill = null;
            } else if (this.confirmKill.startsWith("term:") && !listed.has(this.confirmKill.slice(5))) {
              this.confirmKill = null;
            } else if (this.confirmKill === "__selected__" && this.selected.size === 0) {
              this.confirmKill = null;
            }
          }

          const refreshAll = Boolean(this.refreshDetails);
          let fetched = 0;
          for (const term of localTerms) {
            if (!refreshAll) {
              if (this.pidCache.has(term.address)) continue;
              if (fetched >= 6) break;
              fetched++;
            }
            try {
              const r = await exec("hc", ["get", "--json", term.address], { timeout: 5000 });
              if (r && r.code === 0) {
                const parsed = parseHcGet(r.stdout);
                if (parsed) this.pidCache.set(term.address, parsed);
              }
            } catch {}
          }
          if (refreshAll) this.refreshDetails = false;

          const cached = [];
          for (const term of localTerms) {
            const c = this.pidCache.get(term.address);
            if (!c) continue;
            const labels = term.labels && typeof term.labels === "object" ? term.labels : null;
            cached.push({
              ...c,
              tab: (labels && typeof labels["herdr.tab"] === "string" && labels["herdr.tab"]) || c.tab,
              space: (labels && typeof labels["herdr.space"] === "string" && labels["herdr.space"]) || c.space,
              title: typeof term.title === "string" ? term.title : c.title,
            });
          }

          const attr = attributeTerminals(procs, cached);
          rows = attr.terminals;
          other = attr.other;
          herdr = herdrUsage(procs);
          agentAddresses = new Set(localTerms.filter((t) => Boolean(t.agent)).map((t) => t.address));
          const spList = spaces() ?? [];
          const knownTabIds = new Set();
          for (const sp of spList) {
            for (const tb of sp?.tabs ?? []) {
              if (typeof tb?.id === "string" && tb.id) knownTabIds.add(tb.id);
            }
          }
          orphanAddresses = new Set(localTerms.filter((t) => isOrphan(t, listed, knownTabIds)).map((t) => t.address));
          split = ownerSplit({ herdr, rows, agentAddresses });
          const tree = buildResourceTree({
            rows,
            spaces: spList,
            history: this.history,
            sort: this.resSort,
            agentAddresses,
            orphanAddresses,
          });
          for (const [key, bytes] of historySamples(tree)) {
            pushHistory(this.history, key, bytes, observedAt);
          }
          pushHistory(this.history, "herdr", herdr.rssKB * 1024, observedAt);
          sweepHistory(this.history, observedAt);
        } catch {}

        this.stats = {
          rssKB: usage.rssKB,
          cpu: usage.cpu,
          procs: usage.count,
          ports,
          rows,
          other,
          herdr,
          split,
          orphanAddresses,
          agentAddresses,
          terminals: localTerms,
          observedAt,
        };
        cx.notify();
      } finally {
        this.statsBusy = false;
      }
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
    // Bottom status bar, right end: the resource strip for the processes running
    // inside Herdr sessions (each one optional in Ranch settings, statusbar.*).
    if (props()?.status) {
      const show = resolveSettings(shared(SETTINGS_KEY)).statusbar;
      const stats = this.stats;
      const item = (id, icon, text, tip) => h_flex().id(id).gap(5).items_center().min_w(0).flex_shrink(1)
        .when(Boolean(tip), (el) => el.tooltip(tip))
        .child(svg(`mods/ranch-chrome/${icon}.svg`).size(12).flex_none().text_color(t.dim))
        .child(div().truncate().child(text));
      const items = [];
      if (show.memory || show.cpu) {
        try {
          const aliveCount = (stats?.rows ?? []).filter((r) => r.alive).length;
          const orphanCount = stats?.orphanAddresses?.size ?? 0;
          const trigger = h_flex().id("sb-resources").gap(5).items_center().min_w(0).flex_shrink(1)
            .cursor_pointer().hover((s) => s.text_color(t.foreground))
            .child(svg("mods/ranch-chrome/memory-stick.svg").size(12).flex_none().text_color(t.dim))
            .child(svg("mods/ranch-chrome/square-terminal.svg").size(12).flex_none().text_color(t.dim))
            .child(div().truncate().child(String(aliveCount)))
            .when(orphanCount > 0, (el) => el.child(div().text_color(t.blocked).child(`(${orphanCount})`)));
          items.push(Popover.new("sb-resources-popover").anchor("bottom_right")
            .open(!!this.resOpen)
            .on_open_change((open, cx) => {
              this.resOpen = open;
              if (!open) {
                this.confirmKill = null;
                this.hoveredRow = null;
              } else if (!checking()) {
                this.pollStats(cx);
              }
              cx.notify();
            })
            .trigger(trigger)
            .content(renderResourcePopover(this, t, stats)));
        } catch {}
      }
      if (show.terminals) {
        const n = panes().filter((p) => p.terminal).length;
        items.push(item("sb-terminals", "square-terminal", String(n), null));
      }
      if (show.ports && stats?.ports) {
        const ports = stats.ports;
        const tip = ports.length
          ? ports.slice(0, 8).map((p) => `:${p.port}  ${p.command}`).join("\n")
            + (ports.length > 8 ? `\n…and ${ports.length - 8} more` : "")
          : "No listening ports in Herdr sessions";
        items.push(item("sb-ports", "plug", String(ports.length), tip));
      }
      if (show.hosts) {
        const ms = machines();
        const n = Math.max(ms.length, 1);
        const bad = ms.some((m) => m.layout === "unavailable");
        items.push(h_flex().id("sb-hosts").gap(5).items_center().min_w(0).flex_shrink(1)
          .when(bad, (el) => el.child(div().size(5).flex_none().rounded_full().bg(t.dim)))
          .child(svg("mods/ranch-chrome/server.svg").size(12).flex_none().text_color(t.dim))
          .child(div().truncate().child(`${n} host${n === 1 ? "" : "s"}`)));
      }
      return h_flex().size_full().min_w(0).px(12).gap(14).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
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
      // The rail keeps only the non-zero counts as small badges, blocked first.
      // A bare coloured count: the tooltip is its only label (requirements: never colour alone).
      const badge = (status, color) => h_flex().id(`rail-${status}`).size(18).items_center().justify_center().rounded_full().bg(t.hover).flex_none()
        .text_size(10).text_color(color).cursor_pointer().tooltip(`${counts[status]} ${status === "blocked" ? "needs you" : status}`)
        .on_click(() => toggle(status)).child(String(counts[status]));
      const badges = [
        counts.blocked ? badge("blocked", t.blocked) : null,
        counts.working ? badge("working", t.working) : null,
        counts.done ? badge("done", t.done) : null,
      ].filter(Boolean);
      const quiet = h_flex().id("status-summary").h(22).px(8).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child("Nothing needs you"))
        .when(counts.done > 0, el => el.child(chip("done", t.done, false)));
      const summary = collapsed
        ? h_flex().id("status-summary").h(22).gap(6).items_center().justify_center()
            .children(badges)
        : busy
          ? h_flex().id("status-summary").h(22).px(8).gap(6).items_center()
              .children(chips)
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
