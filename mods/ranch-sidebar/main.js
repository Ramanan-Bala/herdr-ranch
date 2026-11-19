// Ranch sidebar: the machine → space → session tree. Model (pure) in model.js;
// this view adds git summaries, PR state, folding, keyboard navigation and the
// compact rail for narrow sidebars.

import { View, div, svg, image } from "gpui-kit";
import { HoverCard, v_flex, h_flex } from "gpui-base";
import {
  spaces, machines, agents, panes, setAgentOrder, exec, watchFolder, run,
  openOverlay, theme, shared, setShared, nextCommand, window, home, readTextFile,
} from "herdr";
import {
  buildTree, nestWorktrees, BADGE_COLORS, badgeColorIndex, initials,
  normalizeCollapsed, topOfFresh, cardRows, moveIndex, worktreeName, branchLine,
} from "./model.js";
import { isViewerTab } from "./lib/file-viewer.js";
import { STATUS_LABEL, formatDuration, truncateMiddle, effectiveStatus, mostUrgent, closeNeedsConfirm, closeConfirmProps } from "./lib/format.js";
import {
  repoSummary, parsePr, createTtlCache, createLimiter, runGh, PR_JSON_FIELDS,
} from "./lib/git.js";
import { createWatchLoops } from "./lib/watch.js";
import { EdgeGrip } from "./lib/edge-grip.js";
import { homeCache } from "./lib/home.js";
import { SETTINGS_KEY, FILTER_KEY, resolveSettings } from "./lib/settings.js";
import { PRS_FILE, parsePrRegistry, prsFor, registryPrBelongs, repoOfWebBase, samePr } from "./lib/prs.js";
import { progress } from "./lib/tasks.js";
import { TabNamer, ACTIVITY_KEY } from "./namer.js";

const ICON = (name) => `mods/ranch-sidebar/${name}.svg`;
const COLLAPSE_KEY = "collapsed";
// The sidebar's share of the 4-gh budget (requirements §Performance: sidebar 3
// + session 1); module-level so every copy of this view in the mod shares one
// limit.
const ghLimit = createLimiter(3);
const GIT_META_TTL_MS = 600000;

// The New-space dialog (mods/ranch-newspace), prefilled from the active space:
// machine, folder, worktree and branch in one place. The three New space
// buttons below all open it.
function openNewSpace() {
  const active = spaces().find((s) => s.active);
  openOverlay({
    mod: "ranch-newspace",
    kind: "dialog",
    width: 560,
    props: { machine: active?.machine ?? null, folder: active?.folder ?? null },
  });
}

export default class RanchSidebar extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.size = null; // root size, null until first layout
    this.highlight = null; // keyboard-highlighted tab id
    this.hovered = null; // pointer-hovered tab id (drives the card action strip)
    this.hoveredSpace = null; // pointer-hovered space id (drives plus/sparkle)
    this.order = []; // visible card tab ids, display order
    this.cardById = new Map();
    // Drag to reorder: { kind: "space"|"card", id, machine|spaceId, startY,
    // active, over, place } — active after the pointer moved >4px, over/place
    // name the hovered target row and which side of it. Order itself lives
    // in Herdr (space.move / tab.move); nothing is saved locally.
    this.drag = null;
    this.dragJustEnded = 0; // swallow the click GPUI fires on drag mouse-up
    // Right-edge drag strip with a hover cue (lib/edge-grip.js).
    this.grip = new EdgeGrip({
      id: "sidebar", side: "right", min: 44, max: 480, div, theme, run,
      width: () => this.size?.width ?? 268,
      onEnd: (px) => this.onResized(px),
    });
    this.settings = resolveSettings(shared(SETTINGS_KEY));

    // Folding: { m: {machineKey: bool}, s: {spaceId: bool}, w: {worktreeSpaceId: bool},
    // settled: {"m:<machineKey>": bool} } — old per-space settled keys may linger in storage; ignored.
    this.collapsed = this.loadCollapsed();

    // Git: repos `${machine}|${top}` -> {summary, at}; topOf `${machine}|${cwd}`
    // -> { top: string|null, at } (top null = no repository found at `at`).
    this.repos = new Map();
    this.topOf = new Map();
    this.pendingRepos = new Map(); // key -> {machine, cwd}, drained off-render
    this.busy = new Set();
    // One watch loop per repo root, however often it is dropped and re-added
    // (a pending watchFolder cannot be cancelled).
    this.repoWatch = createWatchLoops({
      watch: (top) => watchFolder(top),
      onChange: async (top) => {
        // Debounce: agents write many files in a burst; refresh once it settles.
        await cx.sleep(1000);
        await this.refreshRepo(null, top, cx);
      },
      sleep: (ms) => cx.sleep(ms),
    });
    this.wanted = new Set(); // repo keys the current render still needs

    // PRs: TTL cache keyed `${machine}|${top}|${branch}`; render rebuilds the
    // queue, drain() pumps it through the shared gh limiter.
    this.prCache = createTtlCache(120_000, { max: 500 });
    this.prSec = null;
    this.prQueue = [];
    this.prBusy = new Set();
    this.healthAt = 0;
    // Default branch + remote URL per repo, refreshed every 10 min.
    this.gitMeta = createTtlCache(GIT_META_TTL_MS, { max: 100 });
    // Recorded PRs (shared registry, …): `~/.herdr/ranch/prs.json` read per
    // machine (cached, refreshed on the sweep tick); remote home dirs come
    // from lib/home.js (sh, then cmd.exe; failed lookups back off).
    this.homeFor = homeCache(exec, home);
    this.prRegistries = new Map(); // machineKey -> { parsed, at }
    this.prRegistryBusy = new Set();
    this.pendingRegistries = new Map(); // machineKey -> machine, drained off-render

    // Smart tab names (requirements §8): agent session -> tab name, one way.
    this.namer = new TabNamer();
    this.namer.start(cx);

    cx.timer.every(500, (cx) => this.drain(cx));
    cx.timer.every(5_000, (cx) => this.sweep(cx));
    cx.timer.every(60_000, (cx) => cx.notify()); // keep "time in status" fresh
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        cx.notify();
      }
    });
  }

  // ---- folding ----

  loadCollapsed() {
    try {
      return normalizeCollapsed(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}"));
    } catch {
      return { m: {}, s: {}, w: {}, settled: {} };
    }
  }

  toggleFold(map, key, cx) {
    this.collapsed = { ...this.collapsed, [map]: { ...this.collapsed[map], [key]: !this.collapsed[map][key] } };
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(this.collapsed));
    // Redraw now: without it the fold only showed on the next unrelated
    // render (a timer tick or a hover), which felt slow.
    cx?.notify();
  }

  // ---- git ----

  gitCmd(machine, cwd) {
    return (args) => exec("git", args, { cwd, on: machine, timeout: 10_000 });
  }

  // Render-time: enqueue repo summaries we are missing. Actual work happens in
  // drain(), because render's context cannot spawn tasks.
  scheduleGit(cards) {
    for (const c of cards) {
      if (!c.cwd) continue;
      const m = c.machine ?? "";
      if (c.top) {
        const tk = `${m}|${c.top}`;
        if (!this.repos.has(tk) && !this.pendingRepos.has(tk)) {
          this.pendingRepos.set(tk, { machine: c.machine, cwd: c.top });
        }
      } else if (c.top === undefined) {
        const ck = `${m}|${c.cwd}`;
        if (!this.pendingRepos.has(ck)) this.pendingRepos.set(ck, { machine: c.machine, cwd: c.cwd });
      }
    }
  }

  async refreshRepo(machine, cwd, cx) {
    const busyKey = `${machine ?? ""}|${cwd}`;
    if (this.busy.has(busyKey)) return;
    this.busy.add(busyKey);
    try {
      const summary = await repoSummary(this.gitCmd(machine, cwd), {
        meta: this.gitMeta, metaKey: machine ?? "", now: Date.now(),
      });
      // One entry shape for both outcomes: null top = no repository found
      // (timeout, unreachable machine or plain not-a-repo); trusted only
      // inside the TOP_OF_RETRY_MS window (model.js topOfFresh).
      this.topOf.set(`${machine ?? ""}|${cwd}`, { top: summary?.top ?? null, at: Date.now() });
      if (summary) {
        this.repos.set(`${machine ?? ""}|${summary.top}`, { summary, at: Date.now() });
        if (!machine) this.repoWatch.add(summary.top);
      }
    } finally {
      this.busy.delete(busyKey);
    }
    cx.notify();
  }

  sweep(cx) {
    const now = Date.now();
    const s = resolveSettings(shared(SETTINGS_KEY));
    const remoteMs = Math.max(5_000, s.refresh.remoteGitSec * 1000);
    for (const [key, entry] of [...this.repos]) {
      if (!this.wanted.has(key)) {
        this.repos.delete(key);
        // Drop positive topOf mappings for this top on the same machine (the
        // null "known not a repo" values stay).
        const i = key.indexOf("|");
        const prefix = key.slice(0, i + 1);
        const top = key.slice(i + 1);
        for (const [tk, t] of [...this.topOf]) {
          if (tk.startsWith(prefix) && t?.top === top) this.topOf.delete(tk);
        }
        continue;
      }
      if (!entry?.summary) continue;
      const i = key.indexOf("|");
      const machine = key.slice(0, i) || null;
      const due = now - entry.at > (machine ? remoteMs : 30_000);
      if (due) this.refreshRepo(machine, key.slice(i + 1), cx);
    }
    for (const top of this.repoWatch.wanted()) {
      if (!this.wanted.has(`|${top}`)) this.repoWatch.remove(top);
    }
    this.prCache.prune(now);
  }

  // ---- pull requests ----

  async fetchPr(job, cx) {
    try {
      const r = await runGh(
        (bin, args) => exec(bin, args, { cwd: job.cwd, on: job.machine, timeout: 15_000 }),
        ["pr", "view", job.ref ?? job.branch, "--json", PR_JSON_FIELDS],
      ).catch(() => ({ code: 127, stderr: "", missing: true }));
      let pr = null;
      let health = null;
      if (r.missing) health = "missing";
      else if (/auth|login/i.test(r.stderr ?? "")) health = "signed-out";
      else if (r.code === 0) {
        health = "ok";
        try { pr = parsePr(JSON.parse(r.stdout ?? "")); } catch { pr = null; }
      }
      if (health) this.reportHealth(health);
      this.prCache.set(job.key, pr, Date.now());
    } finally {
      this.prBusy.delete(job.key);
    }
    cx.notify();
  }

  reportHealth(state) {
    const now = Date.now();
    if (now - this.healthAt < 60_000) return;
    this.healthAt = now;
    setShared("ranch.health.gh", state);
  }

  // ---- recorded PRs (shared registry) ----

  /** One registry read per machine (cached in prRegistries, best effort). */
  async refreshRegistry(machine, cx) {
    const mk = machine ?? "";
    if (this.prRegistryBusy.has(mk)) return;
    this.prRegistryBusy.add(mk);
    try {
      const homeDir = await this.homeFor(machine);
      let parsed = null;
      if (homeDir) {
        try {
          const text = await readTextFile(`${homeDir}/${PRS_FILE}`, { on: machine });
          parsed = parsePrRegistry(text);
        } catch {}
      }
      this.prRegistries.set(mk, { parsed, at: Date.now() });
    } finally {
      this.prRegistryBusy.delete(mk);
    }
    cx.notify();
  }

  /**
   * The checkout's recorded PRs (registry records + cached gh state),
   * filtered like the branch badge shows them: open/draft always, merged or
   * closed only when updated in the last 24 h. Missing lookups are enqueued
   * (prCache keyed by url); the branch PR itself never duplicates a badge.
   * Registry records for another repository (checkoutRepo, the "owner/repo"
   * of the checkout's web host) are skipped.
   */
  recordedResolved(registry, machine, top, branch, cwd, active, now, jobs, jobKeys, branchPr, checkoutRepo) {
    if (!top || !branch) return [];
    const out = [];
    for (const r of prsFor(registry, top, branch)) {
      if (!r?.url || !registryPrBelongs(r.url, checkoutRepo)) continue;
      if (branchPr && samePr(branchPr, r)) continue;
      let parsed = this.prCache.get(r.url, now);
      if (parsed === undefined && !this.prBusy.has(r.url) && !jobKeys.has(r.url)) {
        jobKeys.add(r.url);
        jobs.push({ key: r.url, ref: r.url, machine, cwd, top, branch, active });
        parsed = null;
      }
      if (!parsed) continue;
      if (parsed.state === "open" || parsed.state === "draft") {
        out.push(parsed);
      } else if ((parsed.state === "merged" || parsed.state === "closed")
        && parsed.updatedAt && now - parsed.updatedAt <= 24 * 60 * 60 * 1000) {
        out.push(parsed);
      }
    }
    return out;
  }

  // Pump pending repos, registries and PRs. Runs on a timer: render() only
  // enqueues.
  drain(cx) {
    const pending = this.pendingRepos;
    if (pending.size) {
      this.pendingRepos = new Map();
      for (const job of pending.values()) {
        cx.spawn(async (cx) => {
          await this.refreshRepo(job.machine, job.cwd, cx);
        });
      }
    }
    if (this.pendingRegistries.size) {
      const regs = this.pendingRegistries;
      this.pendingRegistries = new Map();
      for (const [mk, machine] of regs) {
        cx.spawn(async (cx) => {
          await this.refreshRegistry(machine, cx);
        });
      }
    }
    if (this.prQueue.length) {
      const jobs = this.prQueue;
      this.prQueue = [];
      for (const job of jobs) {
        if (this.prBusy.has(job.key)) continue;
        // Claim the key before queueing so render does not queue it again.
        this.prBusy.add(job.key);
        ghLimit.run(() => this.fetchPr(job, cx)).catch(() => {});
      }
    }
  }

  // ---- keyboard ----

  onKey(e, cx) {
    if (e.key === "escape" && this.drag) {
      this.drag = null; // cancel without moving anything
      cx.notify();
      return;
    }
    if (e.key === "down" || e.key === "up" || e.key === "j" || e.key === "k") {
      if (!this.order.length) return;
      const down = e.key === "down" || e.key === "j";
      const i = this.order.indexOf(this.highlight);
      const next = i === -1
        ? (down ? 0 : this.order.length - 1)
        : down
          ? Math.min(this.order.length - 1, i + 1)
          : Math.max(0, i - 1);
      this.highlight = this.order[next];
      cx.stop_propagation();
      cx.notify();
    } else if (e.key === "enter") {
      const c = this.cardById.get(this.highlight);
      if (!c) return;
      this.selectCard(c);
      cx.stop_propagation();
    } else if (e.key === "right") {
      run("pane.go", { direction: "right" });
      cx.stop_propagation();
    } else if (e.key === "x" || e.key === "p" || e.key === "c") {
      const c = this.cardById.get(this.highlight);
      if (!c) return;
      if (e.key === "x") {
        run(c.settled ? "tab.unsettle" : "tab.settle", { id: c.tabId });
      } else if (e.key === "p") {
        if (!c.primaryAgent) return;
        run("terminal.peek", { terminal: c.primaryAgent });
      } else {
        const branch = this.branchOf(c);
        if (!branch) return;
        cx.write_to_clipboard(branch);
      }
      cx.stop_propagation();
    }
  }

  // ---- resize grip ----

  /** End of a grip drag: remember the width, and below 160px treat the
   * sidebar as collapsed (mods/ranch-chrome reads both). */
  onResized(px) {
    if (px >= 160) {
      setShared("sidebar.width", px);
      setShared("sidebar.collapsed", false);
    } else {
      // The rail is a fixed width: snap to it (on macOS wide enough for the
      // traffic lights), and it has no grip, so only its button expands it.
      setShared("sidebar.collapsed", true);
      run("layout.resize", { id: "sidebar", px: window().platform === "macos" ? 76 : 44 });
    }
  }

  /** The branch a card shows on line 2 (git summary wins over the pane's). */
  branchOf(c) {
    return c.summary
      ? (c.summary.detached ? `detached @${c.summary.head ?? ""}` : c.summary.branch ?? c.branch)
      : null;
  }

  selectCard(c) {
    if (!c.spaceActive) run("space.select", { id: c.spaceId });
    run("tab.select", { id: c.tabId });
  }

  openPr(url) {
    const platform = window().platform;
    if (platform === "macos") exec("open", [url]);
    else if (platform === "windows") exec("cmd", ["/c", "start", "", url]);
    else exec("xdg-open", [url]);
  }

  // ---- drag to reorder ----

  /** True within 300ms of an active drag ending: swallow the click GPUI
   * fires on mouse-up, so a drop does not also select or fold the row. */
  clickSuppressed() {
    return Date.now() - this.dragJustEnded < 300;
  }

  // Mouse-down on a draggable row (top-level space row, non-settled card):
  // remember the press. A press that never moves more than 4px is still the
  // plain click it always was (the row's on_click runs as before).
  dragStart(kind, id, e, extra) {
    this.drag = { kind, id, startY: e.position.y, active: false, over: null, place: "before", ...extra };
  }

  // Mouse-move on a draggable row: the pointer hovers it. Becomes a drag
  // past the threshold; only valid targets count (a space stays inside its
  // machine's block, a card inside its space's non-settled cards). The
  // dragged row itself never becomes its own target.
  dragMove(kind, rowId, isValid, e, cx) {
    const d = this.drag;
    if (!d || d.kind !== kind) return;
    if (!d.active) {
      if (Math.abs(e.position.y - d.startY) <= 4) return;
      d.active = true; // past the click threshold: this is a drag now
      cx.notify();
    }
    if (rowId === d.id || !isValid) return;
    const bounds = e.bounds;
    const localY = e.local_position?.y ?? (bounds ? e.position.y - bounds.y : 0);
    const place = localY < (bounds?.height ?? 0) / 2 ? "before" : "after";
    if (d.over !== rowId || d.place !== place) {
      d.over = rowId;
      d.place = place;
      cx.notify();
    }
  }

  // Mouse-up on a draggable row: end the drag. When it was active and landed
  // on a different row, ask Herdr to move it (positions are 1-based over the
  // full Herdr list; errors are ignored, Herdr owns the order).
  dragEnd(cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (!d.active) return;
    this.dragJustEnded = Date.now();
    if (d.over != null && d.over !== d.id) {
      let ids = [];
      if (d.kind === "space") {
        ids = spaces().filter((s) => s.machine === d.machine).map((s) => s.id);
      } else {
        const sp = spaces().find((s) => s.id === d.spaceId);
        ids = sp?.tabs.map((tb) => tb.id) ?? [];
      }
      const index = moveIndex(ids, d.id, d.over, d.place);
      if (index != null) {
        try {
          run(d.kind === "space" ? "space.move" : "tab.move", { id: d.id, index });
        } catch {}
      }
    }
    cx.notify();
  }

  /** The 2px accent drop line at the top (before) or bottom (after) of the
   * hovered target row, or null when that row is not the hovered target. */
  dropLine(id) {
    const d = this.drag;
    if (!d?.active || d.over !== id) return null;
    const t = theme();
    return div().absolute().left(0).right(0).h(2).rounded(1).bg(t.accent)
      .when(d.place === "before", (e) => e.top(0))
      .when(d.place === "after", (e) => e.bottom(0));
  }

  // ---- render helpers ----

  ring(status, size) {
    const t = theme();
    const inner = size - 3;
    if (status === "working") {
      // A spinning loader (native animation, no timers).
      return svg(ICON("spinner")).size(size + 1).flex_none().text_color(t.ansi3).spin(900);
    }
    if (status === "blocked") {
      return div().flex_none().size(inner).rounded(inner / 2).bg(t.blocked)
        .loop("opacity", { from: 0.35, to: 1, period: 1200 });
    }
    if (status === "done") return svg(ICON("check")).size(size).flex_none().text_color(t.done);
    if (status === "idle") return div().flex_none().size(inner).rounded(inner / 2).border(1).border_color(t.dim);
    // Unknown status words still render (never hand child() a null).
    return div().flex_none().size(inner).rounded(inner / 2).bg(t.dim);
  }

  badge(count) {
    const t = theme();
    return h_flex().flex_none().items_center().gap(3)
      .child(div().size(6).rounded(3).bg(t.blocked))
      .child(div().text_size(10).text_color(t.blocked).child(String(count)));
  }

  machineHeader(g, first) {
    const t = theme();
    const key = g.machine ?? "";
    const open = !this.collapsed.m[key];
    const sessions = g.spaces.reduce((n, sp) => n + sp.cards.length + sp.settled.length, 0);
    // Machine icon in the space-badge column; chevron in the space-row chevron
    // column so every fold control lines up.
    return h_flex().id(`machine-${key || "local"}`).h(30).mx(8).flex_none().pl(10).pr(8).gap(8).items_center()
      .rounded(7).border(1).border_color(t.border)
      .when(first, (e) => e.mt(6))
      .when(!first, (e) => e.mt(14))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.toggleFold("m", key, cx))
      .child(div().flex_none().size(17).flex().items_center().justify_center()
        .child(svg(ICON(g.machine ? "server" : "laptop")).size(13).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground)
        .child(g.label))
      .when(sessions > 0, (e) => e.child(div().flex_none().h(16).px(6).rounded_full()
        .border(1).border_color(t.border).flex().items_center().justify_center()
        .text_size(10).text_color(t.dim).child(String(sessions))))
      .when(g.state !== "ready", (e) => e.child(
        div().flex_none().text_size(10.5).text_color(t.dim)
          .child(g.state === "loading" ? "connecting…" : "offline")))
      .when(g.blocked > 0, (e) => e.child(this.badge(g.blocked)))
      .when(g.state === "unavailable" && g.machine, (e) => e.child(
        div().id(`copy-machine-${key || "local"}`).flex_none().px(6).py(2).rounded(5).text_size(10)
          .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.write_to_clipboard(`hc machine login ${g.machine}`);
          })
          .child("Copy")))
      .child(div().flex_none().size(16).flex().items_center().justify_center()
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none().text_color(t.dim)));
  }

  /** The "+" button that opens the new-tab menu, shared by space and worktree rows. */
  plusBtn(space, id = space) {
    const t = theme();
    return div().id(`plus-${id}`).flex_none().size(16).flex().items_center().justify_center()
      .rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("space.select", { id: space });
        openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
      })
      .child(svg(ICON("plus")).size(11));
  }

  /** The sparkle button that opens the start-agent dialog, same rows. */
  sparkBtn(space, id = space) {
    const t = theme();
    return div().id(`spark-${id}`).flex_none().size(16).flex().items_center().justify_center()
      .rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Start agent with a task")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("space.select", { id: space });
        openOverlay({ mod: "ranch-launch", kind: "dialog", width: 520, height: 256, props: { space } });
      })
      .child(svg(ICON("sparkle")).size(11));
  }

  spaceRow(sp, first = false) {
    const t = theme();
    const folded = !!this.collapsed.s[sp.space];
    const hovered = this.hoveredSpace === sp.space;
    // Clicking the row folds it (like the machine header); the chevron is an
    // indicator only, aligned with the machine chevrons at the far right.
    const fold = div().flex_none().size(16).flex().items_center().justify_center()
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11));
    const sessions = sp.cards.length;
    const tooltip = [
      sp.name,
      `${sessions} session${sessions === 1 ? "" : "s"}${sp.blocked > 0 ? ` · ${sp.blocked} needs you` : ""}`,
    ].join("\n");
    // The machine the space belongs to: a drag stays inside it.
    const machine = spaces().find((s) => s.id === sp.space)?.machine ?? null;
    const line = this.dropLine(sp.space);
    // When linked worktrees hang off this space, its folded ring and count
    // cover the whole repo: the main checkout plus its worktrees.
    const withWts = sp.worktrees?.length ? [sp, ...sp.worktrees] : null;
    const status = withWts ? mostUrgent(withWts.map((x) => x.status)) : sp.status;
    const count = withWts
      ? withWts.reduce((n, x) => n + x.cards.length + x.settled.length, 0)
      : sp.cards.length + sp.settled.length;
    return h_flex().id(`space-${sp.space}`).relative().h(28).flex_none().pl(12).pr(8).gap(8).items_center()
      .when(first, (e) => e.mt(6))
      .when(!first, (e) => e.mt(12))
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tooltip)
      .when(this.drag?.active && this.drag.id === sp.space, (e) => e.opacity(0.5))
      .when(Boolean(line), (e) => e.child(line))
      .on_hover((isIn, cx) => {
        const next = isIn ? sp.space : null;
        if (this.hoveredSpace !== next) {
          this.hoveredSpace = next;
          cx.notify();
        }
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation(); // as before the drag support: the press stays on this row
        this.dragStart("space", sp.space, e, { machine });
      })
      .on_mouse_move((e, cx) => this.dragMove("space", sp.space, machine === this.drag?.machine, e, cx))
      .on_mouse_up("left", (_e, cx) => this.dragEnd(cx))
      .on_click((_e, cx) => {
        if (this.clickSuppressed()) return;
        this.toggleFold("s", sp.space, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: sp.space } } });
      })
      .child(svg(ICON("folder")).size(14).flex_none().text_color(this.spaceTint(sp).tint))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold()
        .text_color(t.foreground).child(sp.name))
      // The checkout facts (branch, diff, PR) live on the worktree blocks.
      .when(hovered, (e) => e.child(this.plusBtn(sp.space)).child(this.sparkBtn(sp.space)))
      .when(Boolean(status), (e) => e.child(this.ring(status, 9)))
      .when(folded, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(String(count))))
      .when(hovered || folded, (e) => e.child(fold))
      .when(!hovered && !folded, (e) => e.child(div().flex_none().size(16)));
  }

  /**
   * One checkout block: a compact header (status ring · name · "primary" pill
   * and a branch line with diff stats + PR badges) followed by its session
   * rows. The main checkout's space entry is drawn through this too: pass
   * `primary: true` and a `foldKey` distinct from any space id (ids and hover
   * keys are keyed by foldKey).
   */
  worktreeBlock(entry, { primary = false, foldKey = entry.space } = {}) {
    const t = theme();
    const folded = !!this.collapsed.w[foldKey];
    const hovered = this.hoveredSpace === foldKey;
    const name = worktreeName(entry, primary);
    const fold = div().id(`fold-${foldKey}`).flex_none().size(16).flex().items_center().justify_center()
      .rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(folded ? "Expand" : "Collapse")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold("w", foldKey, cx);
      })
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11));
    const co = entry.checkout ?? null;
    const branch = branchLine(name, co);
    const stat = co?.stat ?? null;
    // Stats follow card.line3, PR badges card.pr alone (finding 19).
    const rows = cardRows({
      line3: this.settings.card.line3,
      pr: this.settings.card.pr,
      hasDiff: (stat?.files ?? 0) > 0,
      hasPr: Boolean(entry.pr || entry.recorded?.length),
    });
    const right = [];
    if (rows.stats) {
      right.push(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${stat.add}`));
      if (stat.del > 0) right.push(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`\u2212${stat.del}`));
    }
    if (rows.pr && entry.pr) right.push(this.prBadge(`pr-wt-${foldKey}`, entry.pr));
    if (rows.pr && entry.recorded?.length) right.push(
      h_flex().flex_none().gap(3).children(this.recordedBadges(`rec-wt-${foldKey}`, entry.recorded)));
    const head = h_flex().id(`worktree-head-${foldKey}`).flex_none().h(22).pl(10).pr(8).gap(8).items_center()
      .cursor_pointer()
      .on_hover((isIn, cx) => {
        const next = isIn ? foldKey : null;
        if (this.hoveredSpace !== next) {
          this.hoveredSpace = next;
          cx.notify();
        }
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("space.select", { id: entry.space }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: entry.space } } });
      })
      .tooltip([name, entry.checkout?.top ?? null].filter(Boolean).join("\n"))
      .child(div().flex_none().w(14).flex().items_center().justify_center()
        .when(Boolean(entry.status), (e) => e.child(this.ring(entry.status, 10))))
      .child(div().min_w(0).truncate().text_size(12.5).font_medium()
        .text_color(entry.active ? t.foreground : t.muted).child(truncateMiddle(name, 30)))
      .when(primary, (e) => e.child(div().flex_none().h(16).px(5).rounded(4).flex().items_center()
        .bg(t.selected).text_size(10).text_color(t.muted).child("primary")))
      .child(div().flex_1())
      // No branch line to carry them: diff stats and PR badges sit on line 1.
      .when(!branch && right.length > 0, (e) => e.children(right))
      .when(hovered, (e) => e.child(this.plusBtn(entry.space, foldKey)).child(this.sparkBtn(entry.space, foldKey)))
      .when(folded && entry.blocked > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.blocked).child("Needs you")))
      .when(folded && !(entry.blocked > 0), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(String(entry.cards.length + entry.settled.length))))
      .when(hovered || folded, (e) => e.child(fold))
      .when(!hovered && !folded, (e) => e.child(div().flex_none().size(16)));

    const sub = branch
      ? h_flex().flex_none().h(18).pl(32).pr(8).gap(6).items_center()
        .when(Boolean(branch), (e) => e
          .child(svg(ICON("git-branch")).size(10).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().text_size(11).text_color(t.dim)
            .child(truncateMiddle(branch, 30))))
        .child(div().flex_1())
        .children(right)
      : null;

    const body = [head, sub].filter(Boolean);
    if (!folded) {
      const grouped = (c) => Boolean(co) && c.top === co.top;
      for (const c of entry.cards) {
        body.push(this.sessionRow(c, { grouped: grouped(c) }));
        this.order.push(c.tabId);
      }
    }
    return v_flex().id(`worktree-${foldKey}`).flex_none().mx(6).mt(4).py(4).rounded(8).border(1)
      .when(entry.active, (e) => e.bg(t.hover).border_color(t.border))
      .when(!entry.active, (e) => e.border_color(t.chrome))
      .children(body);
  }

  /** Tab name; an unnamed tab shows its agent's program name (like the top bar). */
  cardTitle(c) {
    const unnamed = /^tb\d+$/.test(c.label) || /^\d+$/.test(c.label ?? "");
    if (unnamed) return c.agentIcon?.name ?? c.repo ?? c.label;
    // Herdr names a space's first tab after the space: under that space's own
    // row the repeat says nothing, so a plain shell reads as "Terminal".
    if (!c.primaryAgent && c.spaceName && c.label === c.spaceName) return "Terminal";
    return c.label;
  }

  projectsHeader() {
    const t = theme();
    return h_flex().id("projects-header").h(34).flex_none().pl(12).pr(8).gap(7).items_center()
      .border_b(1).border_color(t.border)
      .child(svg(ICON("layers")).size(13).flex_none().text_color(t.foreground))
      .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child("Projects"))
      .child(div().id("new-space").flex_none().size(22).rounded(5).flex().items_center().justify_center()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("New space")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => openNewSpace())
        .child(svg(ICON("folder-plus")).size(13)));
  }

  /** The machine's Settled section header: `(id, count, folded, onToggle)`. */
  settledRow(id, count, folded, onToggle) {
    const t = theme();
    // Aligned with the cards: mx(6) + pl(10) puts the icon on the cards' text
    // column, and mx(6) + pr(2) puts the chevron in the space/machine chevron
    // column at the right. The inset top border reads as the machine footer.
    return h_flex().id(`settled-${id}`).h(26).mt(8).mx(6).flex_none().pl(10).pr(2).gap(6).items_center()
      .border_t(1).border_color(t.border).pt(1)
      .rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        onToggle(cx);
      })
      .child(svg(ICON("archive")).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Settled"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(count)))
      .child(div().flex_none().size(16).flex().items_center().justify_center()
        .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(10).flex_none().text_color(t.dim)));
  }

  /** Recorded-PR badges (drawn after the branch PR badge): at most 2, then a
   * dim "+N". */
  recordedBadges(prefix, recs) {
    const els = recs.slice(0, 2).map((pr, i) => this.prBadge(`${prefix}-${i}`, pr));
    if (recs.length > 2) {
      els.push(div().flex_none().text_size(10).text_color(theme().dim).child(`+${recs.length - 2}`));
    }
    return els;
  }

  /** The PR link badge (git-compare icon + "#N"), coloured by PR state. */
  prBadge(id, pr) {
    const t = theme();
    // Same colours as the Session panel's PR pill (GitHub's).
    const color = pr.state === "open" ? t.ansi2
      : pr.state === "draft" ? t.dim
      : pr.state === "merged" ? t.ansi5
      : t.blocked;
    const stateWord = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }[pr.state] ?? "";
    return div().id(id).flex_none().text_size(10).font_medium().text_color(color)
      .cursor_pointer().tooltip([stateWord, pr.title ?? `Pull request #${pr.number}`].filter(Boolean).join(" · "))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (pr.url) this.openPr(pr.url);
      })
      .child(h_flex().items_center().gap(3)
        .child(svg(ICON("git-compare")).size(10).flex_none())
        .child(`#${pr.number}`));
  }

  /**
   * One 24px session row: status ring · agent logo · name · task progress and
   * age (hover actions instead). Diff stats live on the worktree header now.
   */
  sessionRow(c, { settled = false, grouped = false, context = false } = {}) {
    const t = theme();
    const active = c.active && !settled;
    const hovered = this.hovered === c.tabId;
    const plain = !c.primaryAgent && !c.agentIcon?.agent;
    // Task progress from the primary agent's store (the namer's tick keeps it
    // fresh); the active task goes in the tooltip.
    const tasks = c.primaryAgent ? (this.namer.cachedStore(c.primaryAgent)?.tasks ?? []) : [];
    const prog = tasks.length ? progress(tasks) : null;
    const activeTask = tasks.find((task) => task.status === "in_progress") ?? null;
    const branch = this.branchOf(c);
    // Grouped under a checkout whose facts moved to the header above: the
    // branch icon shows only when the session's branch differs from it.
    const co = this.checkoutBySpace.get(c.spaceId) ?? null;
    const coBranch = co ? (co.detached ? `detached @${co.head ?? ""}` : co.branch ?? null) : null;
    const showLoc = Boolean(branch) && branch !== coBranch;
    const tip = [
      activeTask ? `Now: ${activeTask.active_form ?? activeTask.title}` : null,
      c.summary ? c.repo : c.cwd,
      branch,
      c.label,
    ].filter(Boolean).join("\n");
    const line = this.dropLine(c.tabId);
    // Left slot = status: an agent whose status report was cleared reads idle.
    const agentKeys = (shared("ranch.knownAgents") ?? []).map((k) => k.key);
    const isAgent = c.agentIcon?.agent || agentKeys.includes(c.agentIcon?.key);
    const ring = c.status ? this.ring(c.status, 9) : isAgent ? this.ring("idle", 9) : null;
    const icon = c.agentIcon?.icon;
    const logo = plain
      ? svg(ICON("terminal")).size(12).flex_none().text_color(t.dim)
      : icon
        ? c.agentIcon.tint
          ? svg(icon).size(14).flex_none().text_color(t.muted)
          : image(icon).size(14).flex_none()
        : c.agentIcon?.agent
          // Agents without an icon: two-letter badge, colour stable per agent id.
          ? div().flex_none().size(14).rounded(7).flex().items_center().justify_center()
            .bg(t[BADGE_COLORS[badgeColorIndex(c.primaryAgent ?? c.agentIcon.name)]] ?? t.muted)
            .text_size(7).font_semibold().text_color(t.background)
            .child(initials(c.agentIcon.name ?? c.primaryAgent) || "?")
          : null;
    const age = this.settings.card.time && c.since !== null && c.since !== undefined
      ? formatDuration(c.since)
      : "";
    const acts = hovered ? this.cardActions(c) : [];
    return h_flex().id(`card-${c.tabId}`).relative().h(24).mx(4).flex_none().pl(16).pr(8).gap(7).items_center()
      .rounded(5).text_size(12)
      .when(active, (e) => e.bg(t.selected))
      .when(!active, (e) => e.hover((s) => s.bg(t.hover)))
      .when(this.highlight === c.tabId, (e) => e.border(1).border_color(t.accent))
      .cursor_pointer().tooltip(tip)
      .on_hover((isIn, cx) => {
        const next = isIn ? c.tabId : null;
        if (this.hovered !== next) {
          this.hovered = next;
          cx.notify();
        }
      })
      // Only non-settled rows are drag sources/targets; settled rows keep their
      // plain press behaviour.
      .when(!settled && Boolean(line), (e) => e.child(line))
      .when(!settled && this.drag?.active && this.drag.id === c.tabId, (e) => e.opacity(0.5))
      .when(!settled, (e) => e
        .on_mouse_down("left", (ev, ecx) => {
          ecx.stop_propagation(); // as before the drag support: the press stays on this row
          this.dragStart("card", c.tabId, ev, { spaceId: c.spaceId });
        })
        .on_mouse_move((ev, ecx) => this.dragMove("card", c.tabId, c.spaceId === this.drag?.spaceId, ev, ecx))
        .on_mouse_up("left", (_ev, ecx) => this.dragEnd(ecx)))
      .when(settled, (e) => e.on_mouse_down("left", (_ev, ecx) => ecx.stop_propagation()))
      .on_click(() => {
        if (this.clickSuppressed()) return;
        this.selectCard(c);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.tabId, space: c.spaceId } } });
      })
      .child(div().flex_none().w(12).flex().items_center().justify_center()
        .when(Boolean(ring), (e) => e.child(ring)))
      .when(Boolean(logo), (e) => e.child(logo))
      .when(context && c.spaceName, (e) => e.child(div().flex_none().text_color(t.dim)
        .child(`${truncateMiddle(c.spaceName, 14)} · `)))
      .child(div().flex_1().min_w(0).truncate()
        .text_color(settled ? t.dim : active ? t.foreground : t.muted)
        .child(this.cardTitle(c)))
      .when(showLoc && Boolean(branch), (e) => e.child(svg(ICON("git-branch")).size(10).flex_none().text_color(t.dim)))
      .when(!hovered && Boolean(prog), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim)
        .child(`${prog.done}/${prog.total}`)))
      .when(!hovered && Boolean(age), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(age)))
      .when(hovered, (e) => e.child(h_flex().flex_none().items_center().gap(2)
        .children(acts.map((a) => this.actionBtn(c, a)))));
  }

  /** One 18x18 icon button in a card's line-1 hover group. */
  actionBtn(c, a) {
    const t = theme();
    return div().id(`act-${a.id}-${c.tabId}`).flex_none().size(18).rounded(4).flex()
      .items_center().justify_center()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(a.label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        a.go(cx);
      })
      .child(svg(ICON(a.icon)).size(11));
  }

  /** Hover actions for a card's line 1 (PR stays reachable via line 3's link). */
  cardActions(c) {
    const acts = [];
    if (c.primaryAgent && !c.active) {
      acts.push({ id: "peek", icon: "eye", label: "Peek agent", go: () => run("terminal.peek", { terminal: c.primaryAgent }) });
    }
    if (this.branchOf(c)) {
      acts.push({ id: "copy", icon: "copy", label: "Copy branch name", go: (cx) => cx.write_to_clipboard(this.branchOf(c)) });
    }
    acts.push(c.settled
      ? { id: "unsettle", icon: "archive-restore", label: "Unsettle", go: () => run("tab.unsettle", { id: c.tabId }) }
      : { id: "settle", icon: "archive", label: "Settle", go: () => run("tab.settle", { id: c.tabId }) });
    acts.push({ id: "close", icon: "x", label: "Close", go: () => this.closeTab(c) });
    return acts;
  }

  /** Same close rule as the top bar: confirm before killing a busy agent. */
  closeTab(c) {
    const sp = spaces().find((s) => s.id === c.spaceId);
    const tab = sp?.tabs.find((tb) => tb.id === c.tabId);
    const busy = closeNeedsConfirm({ tabId: c.tabId, tab, agents: agents(), panes: panes(), activity: (shared(ACTIVITY_KEY) ?? {})[c.tabId], now: Date.now() });
    if (!busy) { run("tab.close", { id: c.tabId }); return; }
    openOverlay({
      mod: "confirm", kind: "dialog", width: 400, height: 170,
      props: closeConfirmProps(c.tabId, sp?.tabs.length === 1),
    });
  }

  /** HoverCard body for one space cell in the rail: who it is, where its
   * checkout stands, and its sessions as clickable rows. */
  spacePopover(sp, machineLabel) {
    const t = theme();
    const id = (k) => `rail-pop-${sp.space}-${k}`;
    const { tint, fill } = this.spaceTint(sp);
    const n = sp.cards.length;
    const meta = [machineLabel, `${n} session${n === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    const body = v_flex().id(`rail-pop-${sp.space}`).w(288).rounded(10).overflow_hidden()
      .border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground);

    // Header: the space's tile, name and where it lives.
    const head = h_flex().id(id("head")).gap(10).items_center().px(12).pt(12).pb(10)
      .child(div().flex_none().size(28).rounded(8).flex().items_center().justify_center()
        .bg(fill).text_size(11).font_bold().text_color(tint).child(initials(sp.name) || "·"))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(sp.name))
        .child(div().truncate().text_size(11).text_color(t.dim).child(meta)));
    if (sp.blocked > 0) {
      head.child(div().flex_none().px(6).py(1).rounded(5).bg(t.blocked).text_size(10).font_bold()
        .text_color(t.chrome).child(`${sp.blocked} needs you`));
    }
    body.child(head);

    const co = sp.checkout;
    if (co) {
      const branch = co.detached ? `detached @${co.head ?? ""}` : co.branch ?? "";
      const stat = co.stat ?? null;
      body.child(h_flex().id(id("git")).mx(12).mb(10).h(24).px(8).gap(6).items_center().rounded(6)
        .bg(t.surface).border(1).border_color(t.border).text_color(t.muted)
        .child(svg(ICON("git-branch")).size(11).flex_none())
        .child(div().flex_1().min_w(0).truncate().text_size(11).child(truncateMiddle(branch, 34)))
        .when(Boolean(stat && stat.files > 0), (e) => e
          .child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${stat.add}`))
          .when(stat.del > 0, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`\u2212${stat.del}`)))));
    }

    const list = v_flex().id(id("list")).p(4).gap(1).border_t(1).border_color(t.border);
    if (!n) {
      list.child(div().id(id("empty")).px(8).py(8).text_size(11.5).text_color(t.dim).child("No open sessions"));
    }
    for (const c of sp.cards) {
      const tasks = c.primaryAgent ? (this.namer.cachedStore(c.primaryAgent)?.tasks ?? []) : [];
      const prog = tasks.length ? progress(tasks) : null;
      const dur = this.settings.card.time && c.since !== null && c.since !== undefined ? formatDuration(c.since) : "";
      const sub = [c.status ? STATUS_LABEL[c.status] ?? c.status : null, dur].filter(Boolean).join(" · ");
      list.child(h_flex().id(id(c.tabId)).relative().min_h(36).flex_none().rounded(6).pl(10).pr(8).py(4).gap(8).items_center()
        .cursor_pointer().when(c.active, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
        .on_click(() => this.selectCard(c))
        .when(c.active, (e) => e.child(div().absolute().left(0).top(10).bottom(10).w(2).rounded(1).bg(t.accent)))
        .child(div().flex_none().w(12).flex().items_center().justify_center()
          .child(c.status ? this.ring(c.status, 10) : div().size(6).rounded(3).bg(t.border)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12).font_medium()
            .text_color(c.active ? t.foreground : t.muted).child(this.cardTitle(c)))
          .when(Boolean(sub), (e) => e.child(div().truncate().text_size(10.5).text_color(t.dim).child(sub))))
        .when(Boolean(prog), (e) => e.child(v_flex().flex_none().w(36).gap(3).items_end()
          .child(div().text_size(10).text_color(t.dim).child(`${prog.done}/${prog.total}`))
          .child(div().w_full().h(3).rounded(2).bg(t.border)
            .child(div().h_full().rounded(2).bg(prog.done === prog.total ? t.done : t.accent)
              .w(Math.round(36 * (prog.total ? prog.done / prog.total : 0))))))));
    }
    body.child(list);
    return body;
  }

  /** The tint a space's badge and rail tile share: a custom colour (hex or a
   * theme name) or its stable palette slot, plus a translucent fill of it. */
  spaceTint(sp) {
    const t = theme();
    const custom = shared("space.colors")?.[sp.space];
    const resolved = typeof custom === "string" ? (custom.startsWith("#") ? custom : t[custom]) : null;
    const tint = resolved ?? t[BADGE_COLORS[badgeColorIndex(sp.space)]] ?? t.muted;
    const hex = /^#[0-9a-f]{6}$/i.test(tint);
    return { tint, fill: hex ? `${tint}2e` : t.hover, fillStrong: hex ? `${tint}55` : t.selected };
  }

  /** A square icon button for the rail's top/bottom controls. */
  railButton(id, icon, tip, onClick) {
    const t = theme();
    return div().id(id).size(32).flex_none().rounded(8).flex().items_center().justify_center()
      .text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(onClick)
      .child(svg(ICON(icon)).size(15));
  }

  /** One space in the rail: a full-width row holding a tinted initials tile,
   * an accent pill at the left edge when active, status dot and blocked count. */
  railCell(sp, machineLabel) {
    const t = theme();
    const { tint, fill, fillStrong } = this.spaceTint(sp);
    const tile = div().id(`rail-tile-${sp.space}`).relative().size(34).flex_none().rounded(9)
      .flex().items_center().justify_center()
      .bg(sp.active ? fillStrong : fill)
      .when(sp.active, (e) => e.border(1).border_color(tint))
      .hover((s) => s.bg(fillStrong))
      .text_size(12).font_bold().text_color(sp.active ? t.foreground : tint)
      .child(initials(sp.name) || "·");
    if (sp.status) {
      // Ringed in the rail colour so it reads against any tile tint.
      tile.child(div().absolute().bottom(-3).right(-3).size(11).rounded(6)
        .border(2).border_color(t.chrome)
        .when(sp.status === "blocked", (e) => e.bg(t.blocked).loop("opacity", { from: 0.4, to: 1, period: 1200 }))
        .when(sp.status === "working", (e) => e.bg(t.ansi3).loop("opacity", { from: 0.55, to: 1, period: 900 }))
        .when(sp.status !== "blocked" && sp.status !== "working", (e) => e.bg(t[sp.status] ?? t.dim)));
    }
    if (sp.blocked > 0) {
      tile.child(div().absolute().top(-5).right(-6).h(15).min_w(15).px(4).rounded(8)
        .flex().items_center().justify_center()
        .border(2).border_color(t.chrome).bg(t.blocked)
        .text_color(t.chrome).text_size(9).font_bold().child(String(sp.blocked)));
    }
    const row = h_flex().id(`rail-${sp.space}`).relative().w_full().h(44).flex_none()
      .items_center().justify_center().cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("space.select", { id: sp.space }))
      .child(div().absolute().left(0).top(13).w(3).h(18).rounded_r(2)
        .when(sp.active, (e) => e.bg(t.accent)))
      .child(tile);
    return HoverCard.new(`rail-card-${sp.space}`).anchor("top_left")
      .open_delay(250).close_delay(150)
      .trigger(row)
      .content(this.spacePopover(sp, machineLabel));
  }

  rail(tree) {
    const t = theme();
    const items = [];
    for (const [gi, g] of tree.groups.entries()) {
      // Machines split by a short rule; the popover names the machine.
      if (gi > 0) items.push(div().id(`rail-sep-${gi}`).flex_none().w(20).h(1).my(6).bg(t.border));
      for (const sp of g.spaces) items.push(this.railCell(sp, g.machine ? g.label : null));
    }
    const top = v_flex().id("rail-top").flex_none().items_center().gap(2).pt(8).pb(6)
      .child(this.railButton("rail-expand", "panel", "Expand sidebar", () => {
        setShared("sidebar.collapsed", false);
        run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 });
      }))
      .child(this.railButton("rail-search", "search", "Search", () => run("mod.open", { name: "picker" })));
    const add = div().id("rail-new-space").size(34).flex_none().mt(4).rounded(9)
      .flex().items_center().justify_center().cursor_pointer().tooltip("New space")
      .border(1).border_dashed().border_color(t.border).text_color(t.dim)
      .hover((s) => s.border_color(t.muted).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openNewSpace())
      .child(svg(ICON("plus")).size(14));
    return v_flex().id("rail").w_full().items_center()
      .child(top)
      .child(div().id("rail-top-sep").flex_none().w(20).h(1).mb(4).bg(t.border))
      .children(items)
      .child(add);
  }

  filterRow(filter) {
    const t = theme();
    return h_flex().id("filter-row").h(24).flex_none().pl(14).pr(6).gap(4).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`Showing: ${filter}`))
      .child(div().id("clear-filter").flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => setShared(FILTER_KEY, null))
        .child("Clear"));
  }

  emptyState() {
    const t = theme();
    return v_flex().id("empty").flex_none().items_center().gap(8).p(12)
      .child(div().text_size(12).text_color(t.dim).child("No spaces yet"))
      .child(div().id("new-space-empty").px(10).py(4).rounded(7).text_size(12).font_medium()
        .bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
        .on_click(() => openNewSpace())
        .child("New space"));
  }

  // Attach git/PR state to every card, record what the sweep should keep, and
  // collect PR jobs (deduped, active space first).
  decorate(tree, s, now) {
    this.wanted = new Set();
    this.cardById = new Map();
    this.checkoutBySpace = new Map();
    const jobs = [];
    const jobKeys = new Set();
    // Herdr's status first; else what Ranch's own hooks recorded for the tab.
    const activity = shared(ACTIVITY_KEY) ?? {};
    const tabs = new Map(spaces().flatMap((sp) => sp.tabs.map((tb) => [tb.id, tb])));
    // The shared registry is read per machine, cached, refreshed on this tick
    // (sweep cadence); drain() does the actual reads.
    const wantRegistry = (machine) => {
      const mk = machine ?? "";
      const hit = this.prRegistries.get(mk);
      if (!hit || now - hit.at >= 5000) this.pendingRegistries.set(mk, machine);
      return hit?.parsed ?? null;
    };
    const walk = (cards, settled) => {
      for (const c of cards) {
        const eff = effectiveStatus(tabs.get(c.tabId), activity[c.tabId], now);
        c.status = eff.status;
        c.since = eff.since;
        c.settled = settled;
        this.cardById.set(c.tabId, c);
        if (c.cwd) {
          const m = c.machine ?? "";
          const ck = `${m}|${c.cwd}`;
          this.wanted.add(ck);
          const topEntry = this.topOf.get(ck);
          c.top = topOfFresh(topEntry, now) ? (topEntry.top ?? null) : undefined;
          if (c.top) {
            const tk = `${m}|${c.top}`;
            this.wanted.add(tk);
            c.summary = this.repos.get(tk)?.summary ?? null;
            // Line 1 shows the repo (its top-level folder), not the pane's subfolder.
            c.repo = c.top.split(/[\\/]/).filter(Boolean).pop() ?? c.repo;
          }
        }
        // Settled tabs too: the PR badge now lives on the space/worktree row.
        if (s.card.pr && c.top && c.summary && !c.summary.detached) {
          const branch = c.branch ?? c.summary.branch;
          // The branch's own PR: never looked up on the default branch.
          if (branch && branch !== c.summary.default) {
            const pk = `${c.machine ?? ""}|${c.top}|${branch}`;
            const cached = this.prCache.get(pk, now);
            c.pr = cached ?? null;
            if (cached === undefined && !this.prBusy.has(pk) && !jobKeys.has(pk)) {
              jobKeys.add(pk);
              jobs.push({ key: pk, machine: c.machine, top: c.top, branch, cwd: c.cwd, active: c.spaceActive });
            }
          }
          // PRs an agent opened from this repo top + branch (shared registry),
          // on any branch including the default one: resolved by url through
          // prCache, drawn after the branch badge, never duplicating it.
          if (branch) {
            c.recorded = this.recordedResolved(wantRegistry(c.machine), c.machine,
              c.top, branch, c.cwd, c.spaceActive, now, jobs, jobKeys, c.pr ?? null, repoOfWebBase(c.summary?.host?.base));
          }
        }
      }
    };
    for (const g of tree.groups) {
      for (const sp of g.spaces) {
        walk(sp.cards, false);
        walk(sp.settled, true);
        const all = [...sp.cards, ...sp.settled];
        sp.status = mostUrgent(all.map((c) => c.status));
        sp.blocked = all.filter((c) => c.status === "blocked").length;
        // Facts that belong to the checkout move to the space/worktree row:
        // the first card's git summary and the first matching PR.
        sp.checkout = all.find((c) => c.summary)?.summary ?? null;
        sp.pr = all.find((c) => c.pr && c.top === sp.checkout?.top)?.pr ?? null;
        // The checkout block (worktreeBlock) shows its recorded PRs too (…).
        if (s.card.pr && sp.checkout?.top && sp.checkout.branch && !sp.checkout.detached) {
          const pk = `${g.machine ?? ""}|${sp.checkout.top}|${sp.checkout.branch}`;
          const branchPr = sp.pr ?? this.prCache.get(pk, now) ?? null;
          sp.recorded = this.recordedResolved(wantRegistry(g.machine), g.machine,
            sp.checkout.top, sp.checkout.branch, sp.cards[0]?.cwd ?? null, sp.active, now, jobs, jobKeys, branchPr, repoOfWebBase(sp.checkout?.host?.base));
        }
        this.checkoutBySpace.set(sp.space, sp.checkout);
      }
      g.blocked = g.spaces.reduce((n, sp) => n + sp.blocked, 0);
    }
    jobs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    return jobs;
  }

  allCards(tree) {
    // Same walk as render: each machine's active cards in tree order, then
    // that machine's settled cards (they draw in one group after the spaces).
    const out = [];
    for (const g of tree.groups) {
      const settled = [];
      for (const e of nestWorktrees(g.spaces, (sp) => sp.checkout)) {
        out.push(...e.cards);
        settled.push(...e.settled);
        for (const wt of e.worktrees) {
          out.push(...wt.cards);
          settled.push(...wt.settled);
        }
      }
      out.push(...settled);
    }
    return out;
  }

  // ---- root ----

  render(cx) {
    const t = theme();
    const s = resolveSettings(shared(SETTINGS_KEY));
    this.settings = s;
    if (this.prSec !== s.refresh.prSec) {
      this.prSec = s.refresh.prSec;
      this.prCache = createTtlCache(s.refresh.prSec * 1000, { max: 500 });
    }
    const filter = shared(FILTER_KEY) ?? null;
    // The file viewer tab lives only in the top bar (lib/file-viewer.js), not in this tree.
    const paneList = panes();
    const listed = spaces().map((sp) => ({ ...sp, tabs: (sp.tabs ?? []).filter((tb) => !isViewerTab(tb, paneList)) }));
    const tree = buildTree({
      home: home(),
      machines: machines(), spaces: listed, agents: agents(), panes: paneList,
      filter, now: Date.now(),
    });

    const jobs = this.decorate(tree, s, Date.now());
    this.scheduleGit(this.allCards(tree));
    this.prQueue = jobs;

    if (setAgentOrder) {
      const primary = [];
      for (const c of this.allCards(tree)) {
        if (c.primaryAgent && !primary.includes(c.primaryAgent)) primary.push(c.primaryAgent);
      }
      setAgentOrder([...primary, ...agents().map((a) => a.address).filter((a) => !primary.includes(a))]);
    }

    const narrow = this.size !== null && this.size.width < 160;
    this.order = [];
    const rows = [];
    if (filter) rows.push(this.filterRow(filter));
    if (spaces().length === 0 && !filter) {
      rows.push(this.emptyState());
    } else if (!tree.groups.length) {
      rows.push(div().id("no-match").flex_none().pl(14).pt(8).text_size(11).text_color(t.dim)
        .child("Nothing matches this filter"));
    } else if (narrow) {
      rows.push(this.rail(tree));
    } else {
      for (const [i, g] of tree.groups.entries()) {
        const key = g.machine ?? "";
        if (tree.showMachines) {
          rows.push(this.machineHeader(g, i === 0));
          if (this.collapsed.m[key]) continue;
        }
        // Settled tabs of the whole machine gather in one group after the last
        // space, in display order (this space, its worktrees, next space…).
        const settledAll = [];
        for (const [si, e] of nestWorktrees(g.spaces, (sp) => sp.checkout).entries()) {
          rows.push(this.spaceRow(e, si === 0));
          // Collected before any fold check: the Settled group lists them all,
          // even from folded spaces and worktrees.
          settledAll.push(...e.settled);
          for (const wt of e.worktrees) settledAll.push(...wt.settled);
          if (this.collapsed.s[e.space]) continue; // folded: hides its worktrees too
          if (!e.checkout) {
            // Non-git space: its sessions sit directly under the space row.
            for (const c of e.cards) {
              rows.push(this.sessionRow(c));
              this.order.push(c.tabId);
            }
            continue;
          }
          // Git space: the main checkout's block first (tagged "primary"), then
          // its linked worktrees, each with its own session rows.
          rows.push(this.worktreeBlock(e, { primary: true, foldKey: `main:${e.space}` }));
          for (const wt of e.worktrees) {
            rows.push(this.worktreeBlock(wt, { primary: false, foldKey: wt.space }));
          }
        }
        if (settledAll.length) {
          const folded = !!this.collapsed.settled[`m:${key}`];
          rows.push(this.settledRow(`m-${g.machine ?? "local"}`, settledAll.length, folded,
            (cx) => this.toggleFold("settled", `m:${key}`, cx)));
          if (!folded) {
            for (const c of settledAll) {
              rows.push(this.sessionRow(c, { settled: true, context: true }));
              this.order.push(c.tabId);
            }
          }
        }
      }
    }

    return v_flex().id("root").relative().size_full().min_h(0).bg(t.chrome)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_hover((isIn, cx) => {
        if (!isIn) this.grip.end(cx);
      })
      .on_mouse_down("left", (_e, cx) => {
        this.grip.end(cx);
      })
      // Live resize drag: the grip only records the press; the move happens here.
      .on_mouse_move((e, cx) => this.grip.move(e, cx))
      // Fallback end of a drag: released off any draggable row cancels it
      // (mouse-up bubbles here after the rows; a row already nulled this.drag).
      .on_mouse_up("left", (_e, cx) => {
        this.grip.end(cx);
        if (!this.drag) return;
        this.drag = null;
        cx.notify();
      })
      .on_size_change((size, cx) => {
        if (this.size === null || size.width !== this.size.width) {
          this.size = size;
          cx.notify();
        }
      })
      .when(!narrow, (e) => e.child(this.projectsHeader()))
      .child(v_flex().id("tree-scroll").flex_1().min_h(0).overflow_y_scrollbar().pb(6).children(rows))
      .when(!narrow || this.grip.active, (e) => e.child(this.grip.element(t.chrome)));
  }
}
