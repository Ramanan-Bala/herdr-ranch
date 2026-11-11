// Ranch sidebar: the machine → space → session tree. Model (pure) in model.js;
// this view adds git summaries, PR state, folding, keyboard navigation and the
// compact rail for narrow sidebars.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces, machines, agents, panes, setAgentOrder, exec, watchFolder, run,
  openOverlay, theme, shared, setShared, nextCommand, window, home,
} from "herdr";
import { buildTree, nestWorktrees, BADGE_COLORS, badgeColorIndex, initials, diffSquares } from "./model.js";
import { STATUS_LABEL, formatDuration, truncateMiddle, effectiveStatus, mostUrgent } from "./lib/format.js";
import { repoSummary, parsePr, createTtlCache, runGh, PR_JSON_FIELDS } from "./lib/git.js";
import { SETTINGS_KEY, FILTER_KEY, resolveSettings } from "./lib/settings.js";
import { progress } from "./lib/tasks.js";
import { TabNamer, ACTIVITY_KEY } from "./namer.js";

const ICON = (name) => `mods/ranch-sidebar/${name}.svg`;
const COLLAPSE_KEY = "collapsed";

export default class RanchSidebar extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.size = null; // root size, null until first layout
    this.highlight = null; // keyboard-highlighted tab id
    this.hovered = null; // pointer-hovered tab id (drives the card action strip)
    this.hoveredSpace = null; // pointer-hovered space id (drives plus/sparkle)
    this.order = []; // visible card tab ids, display order
    this.cardById = new Map();
    this.settings = resolveSettings(shared(SETTINGS_KEY));

    // Folding: { m: {machineKey: bool}, s: {spaceId: bool}, w: {worktreeSpaceId: bool}, settled: {spaceId: bool} }
    this.collapsed = this.loadCollapsed();

    // Git: repos `${machine}|${top}` -> {summary, at}; topOf `${machine}|${cwd}`
    // -> top|null (null = known not a repo).
    this.repos = new Map();
    this.topOf = new Map();
    this.pendingRepos = new Map(); // key -> {machine, cwd}, drained off-render
    this.busy = new Set();
    this.watching = new Set();
    this.wanted = new Set(); // repo keys the current render still needs

    // PRs: TTL cache keyed `${machine}|${top}|${branch}`; render rebuilds the
    // queue, drain() pumps it four at a time.
    this.prCache = createTtlCache(120_000);
    this.prSec = null;
    this.prQueue = [];
    this.prPumping = false;
    this.prBusy = new Set();
    this.healthAt = 0;

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
      return { m: {}, s: {}, w: {}, settled: {}, ...JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "{}") };
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
      const summary = await repoSummary(this.gitCmd(machine, cwd));
      if (summary) {
        this.repos.set(`${machine ?? ""}|${summary.top}`, { summary, at: Date.now() });
        this.topOf.set(`${machine ?? ""}|${cwd}`, summary.top);
        if (!machine) this.watchRepo(summary.top, cx);
      } else {
        this.topOf.set(`${machine ?? ""}|${cwd}`, null);
      }
    } finally {
      this.busy.delete(busyKey);
    }
    cx.notify();
  }

  watchRepo(top, cx) {
    if (this.watching.has(top)) return;
    this.watching.add(top);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(top);
          if (!this.watching.has(top)) break;
          // Debounce: agents write many files in a burst; refresh once it settles.
          await new Promise((resolve) => cx.timer.after(1000, () => resolve()));
          await this.refreshRepo(null, top, cx);
        }
      } catch {
        this.watching.delete(top);
      }
    });
  }

  sweep(cx) {
    const now = Date.now();
    const s = resolveSettings(shared(SETTINGS_KEY));
    const remoteMs = Math.max(5_000, s.refresh.remoteGitSec * 1000);
    for (const [key, entry] of [...this.repos]) {
      if (!this.wanted.has(key)) {
        this.repos.delete(key);
        continue;
      }
      if (!entry?.summary) continue;
      const i = key.indexOf("|");
      const machine = key.slice(0, i) || null;
      const due = now - entry.at > (machine ? remoteMs : 30_000);
      if (due) this.refreshRepo(machine, key.slice(i + 1), cx);
    }
    for (const top of [...this.watching]) {
      if (!this.wanted.has(`|${top}`)) this.watching.delete(top);
    }
  }

  // ---- pull requests ----

  async fetchPr(job, cx) {
    if (this.prBusy.has(job.key)) return;
    this.prBusy.add(job.key);
    try {
      const r = await runGh(
        (bin, args) => exec(bin, args, { cwd: job.cwd, on: job.machine, timeout: 15_000 }),
        ["pr", "view", job.branch, "--json", PR_JSON_FIELDS],
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

  // Pump pending repos and PRs. Runs on a timer: render() only enqueues.
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
    if (this.prQueue.length && !this.prPumping) {
      this.prPumping = true;
      cx.spawn(async (cx) => {
        try {
          while (this.prQueue.length) {
            const batch = this.prQueue.splice(0, 4);
            await Promise.all(batch.map((job) => this.fetchPr(job, cx)));
          }
        } finally {
          this.prPumping = false;
        }
      });
    }
  }

  // ---- keyboard ----

  onKey(e, cx) {
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

  statusChip(c, settled) {
    const t = theme();
    if (!c.status) return null;
    const time = this.settings.card.time && c.since !== null && c.since !== undefined
      ? ` · ${formatDuration(c.since)}`
      : "";
    const word = STATUS_LABEL[c.status] ?? c.status;
    return h_flex().id(`chip-${c.tabId}`).flex_none().items_center().gap(5).tooltip(word)
      .child(this.ring(c.status, 10))
      .when(Boolean(time), (e) => e.child(div().flex_none().text_size(10.5).text_color(settled ? t.dim : t.muted)
        .child(time.replace(" · ", ""))));
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
    // Machine icon in the space-badge column; chevron in the space-row chevron
    // column so every fold control lines up.
    return h_flex().id(`machine-${key || "local"}`).h(30).flex_none().pl(10).pr(8).gap(8).items_center()
      .when(first, (e) => e.mt(4))
      .when(!first, (e) => e.mt(10).border_t(1).border_color(t.border).pt(1))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.toggleFold("m", key, cx))
      .child(div().flex_none().size(17).flex().items_center().justify_center()
        .child(svg(ICON(g.machine ? "server" : "laptop")).size(13).flex_none().text_color(t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.muted).child(g.label))
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
      .when(!open, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(String(g.spaces.length))))
      .child(div().flex_none().size(16).flex().items_center().justify_center()
        .child(svg(ICON(open ? "chevron-down" : "chevron-right")).size(10).flex_none().text_color(t.dim)));
  }

  /** The "+" button that opens the new-tab menu, shared by space and worktree rows. */
  plusBtn(space) {
    const t = theme();
    return div().id(`plus-${space}`).flex_none().size(16).flex().items_center().justify_center()
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
  sparkBtn(space) {
    const t = theme();
    return div().id(`spark-${space}`).flex_none().size(16).flex().items_center().justify_center()
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

  spaceRow(sp) {
    const t = theme();
    const folded = !!this.collapsed.s[sp.space];
    const fold = div().id(`fold-${sp.space}`).flex_none().size(16).flex().items_center().justify_center()
      .rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(folded ? "Expand" : "Collapse")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold("s", sp.space, cx);
      })
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11));
    // A space colour may be saved as hex ("#9333ea") or as a theme name
    // ("ansi6"): resolve names through the theme. Only a plain #rrggbb can
    // take the "38" alpha suffix for the badge's tint.
    const custom = shared("space.colors")?.[sp.space];
    const resolved = typeof custom === "string" ? (custom.startsWith("#") ? custom : t[custom]) : null;
    const tint = resolved ?? t[BADGE_COLORS[badgeColorIndex(sp.space)]] ?? t.muted;
    const tintBg = /^#[0-9a-f]{6}$/i.test(tint) ? `${tint}38` : t.hover;
    const badge = div().flex_none().size(17).rounded(4).flex().items_center().justify_center()
      .bg(tintBg).text_size(8.5).font_bold().text_color(tint)
      .child(initials(sp.name) || "·");
    // Checkout facts moved up from the cards: branch (+" · primary" when
    // worktrees hang off this space), diff stats and PR badge.
    const co = sp.checkout ?? null;
    const coBranch = co ? (co.detached ? `detached @${co.head ?? ""}` : co.branch ?? null) : null;
    return h_flex().id(`space-${sp.space}`).h(28).mt(10).flex_none().pl(10).pr(8).gap(8).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((isIn, cx) => {
        const next = isIn ? sp.space : null;
        if (this.hoveredSpace !== next) {
          this.hoveredSpace = next;
          cx.notify();
        }
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("space.select", { id: sp.space }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: sp.space } } });
      })
      .child(badge)
      // The name keeps its width; the dim branch label shrinks first.
      .child(div().when(Boolean(coBranch), (e) => e.flex_none().max_w(130)).when(!coBranch, (e) => e.flex_1().min_w(0))
        .truncate().text_size(12).font_semibold()
        .text_color(sp.active ? t.foreground : t.muted).child(sp.name))
      .when(Boolean(coBranch), (e) => e.child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
        .child(coBranch + (sp.worktrees?.length > 0 ? " · primary" : ""))))
      .when(Boolean(co) && this.settings.card.line3 && co.stat?.files > 0, (e) => e
        .child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${co.stat.add}`))
        .when(co.stat.del > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`\u2212${co.stat.del}`))))
      .when(Boolean(this.settings.card.pr && sp.pr), (e) => e.child(this.prBadge(`pr-sp-${sp.space}`, sp.pr)))
      // Plus/sparkle appear only on hover, left of the ring, so the ring,
      // count and chevron keep their place.
      .when(this.hoveredSpace === sp.space, (e) => e.child(this.plusBtn(sp.space)).child(this.sparkBtn(sp.space)))
      .when(Boolean(sp.status), (e) => e.child(this.ring(sp.status, 9)))
      .when(folded, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(String(sp.cards.length + sp.settled.length))))
      .child(fold);
  }

  /** The compact 24px row drawn under a main space for each of its worktrees. */
  worktreeRow(wt) {
    const t = theme();
    const folded = !!this.collapsed.w[wt.space];
    const fold = div().id(`fold-${wt.space}`).flex_none().size(16).flex().items_center().justify_center()
      .rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(folded ? "Expand" : "Collapse")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold("w", wt.space, cx);
      })
      .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(11));
    const label = wt.checkout
      ? (wt.checkout.detached ? `detached @${wt.checkout.head ?? ""}` : wt.checkout.branch ?? wt.name)
      : wt.name;
    const stat = wt.checkout?.stat ?? null;
    return h_flex().id(`worktree-${wt.space}`).h(24).mt(2).flex_none().pl(10).pr(8).gap(8).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((isIn, cx) => {
        const next = isIn ? wt.space : null;
        if (this.hoveredSpace !== next) {
          this.hoveredSpace = next;
          cx.notify();
        }
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("space.select", { id: wt.space }))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: wt.space } } });
      })
      .tooltip([wt.name, wt.checkout?.top ?? null].filter(Boolean).join("\n"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(wt.tree))
      .child(svg(ICON("git-branch")).size(10).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold()
        .text_color(wt.active ? t.foreground : t.muted).child(truncateMiddle(label, 28)))
      .when(this.settings.card.line3 && stat?.files > 0, (e) => e
        .child(div().flex_none().text_size(10).text_color(t.ansi2).child(`+${stat.add}`))
        .when(stat.del > 0, (el) => el.child(div().flex_none().text_size(10).text_color(t.ansi1).child(`\u2212${stat.del}`))))
      .when(Boolean(this.settings.card.pr && wt.pr), (e) => e.child(this.prBadge(`pr-wt-${wt.space}`, wt.pr)))
      .when(this.hoveredSpace === wt.space, (e) => e.child(this.plusBtn(wt.space)).child(this.sparkBtn(wt.space)))
      .when(folded && Boolean(wt.status), (e) => e.child(this.ring(wt.status, 9)))
      .when(folded && wt.blocked > 0, (e) => e.child(div().flex_none().text_size(10).text_color(t.blocked).child("Needs you")))
      .when(folded && !(wt.blocked > 0), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim)
        .child(String(wt.cards.length + wt.settled.length))))
      .child(fold);
  }

  /** Tab name; an unnamed tab shows its agent's program name (like the top bar). */
  cardTitle(c) {
    const unnamed = /^tb\d+$/.test(c.label) || /^\d+$/.test(c.label ?? "");
    return unnamed ? (c.agentIcon?.name ?? c.repo ?? c.label) : c.label;
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
        .on_click(() => run("space.new", {}))
        .child(svg(ICON("folder-plus")).size(13)));
  }

  settledRow(sp) {
    const t = theme();
    const folded = !!this.collapsed.settled[sp.space];
    // Aligned with the cards: mx(6) + pl(10) puts the icon on the cards' text
    // column, and mx(6) + pr(2) puts the chevron in the space/machine chevron
    // column at the right.
    return h_flex().id(`settled-${sp.space}`).h(26).my(3).mx(6).flex_none().pl(10).pr(2).gap(6).items_center()
      .rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleFold("settled", sp.space, cx);
      })
      .child(svg(ICON("archive")).size(11).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child("Settled"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(String(sp.settled.length)))
      .child(div().flex_none().size(16).flex().items_center().justify_center()
        .child(svg(ICON(folded ? "chevron-right" : "chevron-down")).size(10).flex_none().text_color(t.dim)));
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

  card(c, { settled = false, grouped = false } = {}) {
    const t = theme();
    const active = c.active && !settled;
    const hovered = this.hovered === c.tabId;
    // Hover actions sit on line 1 (after the status chip); line 3 never swaps.
    const acts = hovered ? this.cardActions(c) : [];
    const line1 = h_flex().flex_none().items_center().justify_between().gap(6)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold()
        .text_color(settled ? t.dim : active ? t.foreground : t.muted)
        .child(this.cardTitle(c)))
      .when(c.status, (e) => e.child(this.statusChip(c, settled)))
      .when(acts.length, (e) => e.child(
        h_flex().flex_none().items_center().gap(2)
          .children(acts.map((a) => this.actionBtn(c, a)))));

    const branch = this.branchOf(c);
    // Grouped under a checkout whose facts moved to the row above: line 2
    // keeps the branch/folder segment only when it differs from the
    // checkout's branch, and line 3 (diff stats + PR) is not drawn.
    const co = this.checkoutBySpace.get(c.spaceId) ?? null;
    const coBranch = co ? (co.detached ? `detached @${co.head ?? ""}` : co.branch ?? null) : null;
    const showLoc = !grouped || branch !== coBranch;
    // Task progress from the primary agent's store (the namer's tick keeps it
    // fresh): "done/total" on line 2, and the active task in the tooltip.
    const tasks = c.primaryAgent ? (this.namer.cachedStore(c.primaryAgent)?.tasks ?? []) : [];
    const prog = tasks.length ? progress(tasks) : null;
    const activeTask = tasks.find((task) => task.status === "in_progress") ?? null;
    const parts2 = [];
    if (showLoc) {
      if (branch) {
        parts2.push(h_flex().flex_1().min_w(0).items_center().gap(4)
          .child(svg(ICON("git-branch")).size(10).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate()
            .text_color(settled ? t.dim : t.muted)
            .child(truncateMiddle(branch, 28))));
      } else if (c.cwd) {
        parts2.push(h_flex().flex_1().min_w(0).items_center().gap(4)
          .child(svg(ICON("folder")).size(10).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(c.repo ?? c.cwd)));
      }
    }
    const icon = c.agentIcon?.icon;
    if (prog) {
      // Task progress "done/total" sits just before the agent icon on line 2.
      parts2.push(div().flex_none().text_size(10).text_color(t.dim)
        .child(`${prog.done}/${prog.total}`));
    }
    if (icon) {
      parts2.push(c.agentIcon.tint
        ? svg(icon).size(14).flex_none().text_color(t.muted)
        : image(icon).size(14).flex_none());
    } else if (c.agentIcon?.agent) {
      // Agents without an icon: two-letter badge, colour stable per agent id.
      const color = t[BADGE_COLORS[badgeColorIndex(c.primaryAgent ?? c.agentIcon.name)]] ?? t.muted;
      parts2.push(div().flex_none().size(14).rounded(7).flex().items_center().justify_center()
        .bg(color).text_size(7).font_semibold().text_color(t.background)
        .child(initials(c.agentIcon.name ?? c.primaryAgent) || "?"));
    }
    const line2 = parts2.length
      ? h_flex().flex_none().items_center().justify_between().gap(6).children(parts2)
      : null;

    const parts3 = [];
    if (this.settings.card.line3 && !settled && !grouped) {
      const stat = c.summary?.stat ?? null;
      if (stat && stat.files > 0) {
        parts3.push(div().flex_none().text_size(10.5).text_color(t.muted)
          .child(`${stat.files} ${stat.files === 1 ? "file" : "files"}`));
        parts3.push(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${stat.add}`));
        if (stat.del) parts3.push(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`\u2212${stat.del}`));
        parts3.push(h_flex().flex_none().gap(2).children(
          diffSquares(stat.add, stat.del).map((kind) =>
            div().flex_none().size(6).rounded(2)
              .bg(kind === "add" ? t.ansi2 : kind === "del" ? t.ansi1 : t.border))
        ));
      }
      if (this.settings.card.pr && c.pr) {
        parts3.push(this.prBadge(`pr-${c.tabId}`, c.pr));
      }
    }
    // Line 3 renders only when there is something to show (diff stats, PR);
    // the card's height follows, so there is no empty slot any more. Line 2
    // likewise: a grouped card with nothing left on line 2 is 30px tall.
    const line3 = parts3.length
      ? h_flex().flex_none().h(16).items_center().gap(5).children([...parts3.slice(0, -1), div().flex_1(), parts3.at(-1)])
      : null;

    const tip = [
      activeTask ? `Now: ${activeTask.active_form ?? activeTask.title}` : null,
      c.summary ? c.repo : c.cwd,
      branch,
      c.label,
    ].filter(Boolean).join("\n");

    // Left bar = status: idle grey, working yellow, needs you red, done blue.
    // An agent pane whose status report was cleared still counts as idle.
    const agentKeys = (shared("ranch.knownAgents") ?? []).map((k) => k.key);
    const isAgent = c.agentIcon?.agent || agentKeys.includes(c.agentIcon?.key);
    const barStatus = c.status ?? (isAgent ? "idle" : null);
    const bar = { idle: t.muted, working: t.ansi3, blocked: t.ansi1, done: t.ansi4 }[barStatus] ?? null;
    // my(3): a 6px gap between cards so each session reads as its own block.
    return v_flex().id(`card-${c.tabId}`).relative().mx(6).my(3).h(parts3.length ? 58 : parts2.length ? 44 : 30).rounded(6).pl(10).pr(8).py(6).gap(3).justify_center().text_size(11)
      .when(active, (e) => e.bg(t.selected))
      .when(Boolean(bar), (e) => e.child(
        div().absolute().left(0).top(8).bottom(8).w(2).rounded(1).bg(bar)))
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
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.selectCard(c))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.tabId, space: c.spaceId } } });
      })
      .children([line1, line2, line3].filter(Boolean));
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
    const busy = agents().some((a) => a.tab === c.tabId && (a.status === "working" || a.status === "blocked"));
    if (!busy) { run("tab.close", { id: c.tabId }); return; }
    const sp = spaces().find((s) => s.id === c.spaceId);
    openOverlay({
      mod: "confirm", kind: "dialog", width: 400, height: 170,
      props: {
        title: "Close this tab?",
        detail: sp?.tabs.length === 1
          ? "An agent here is still working, and this is the space's last tab: the space closes with it."
          : "An agent here is still working. Its terminal closes with the tab.",
        command: { name: "tab.close", args: { id: c.tabId, confirmed: true } },
      },
    });
  }

  rail(tree) {
    const t = theme();
    const cells = [];
    for (const g of tree.groups) {
      for (const sp of g.spaces) {
        const working = sp.cards.filter((c) => c.status === "working").length;
        const cell = div().id(`rail-${sp.space}`).relative().size(28).flex_none().rounded(7)
          .flex().items_center().justify_center()
          .bg(sp.active ? t.selected : t.surface).hover((s) => s.bg(t.hover))
          .cursor_pointer()
          .tooltip(`${sp.name} — ${working} working, ${sp.blocked} needs you`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => run("space.select", { id: sp.space }))
          .child(div().text_size(12).font_semibold()
            .text_color(sp.active ? t.foreground : t.muted)
            .child(sp.name[0]?.toUpperCase() ?? "·"));
        if (sp.status) {
          cell.child(div().absolute().bottom(2).right(2).size(5).rounded(3)
            .when(sp.status === "blocked", (e) => e.bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 1200 }))
            .when(sp.status !== "blocked", (e) => e.bg(t[sp.status])));
        }
        if (sp.blocked > 0) {
          cell.child(div().absolute().top(0).right(0).min_w(12).px(3).rounded(6)
            .bg(t.chrome).text_color(t.blocked).text_size(9).child(String(sp.blocked)));
        }
        cells.push(cell);
      }
    }
    // The rail always offers a way back out (on macOS the header has no toggle).
    const expand = div().id("rail-expand").size(28).flex_none().rounded(7).flex().items_center().justify_center()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
      .tooltip("Expand sidebar")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        setShared("sidebar.collapsed", false);
        run("layout.resize", { id: "sidebar", px: shared("sidebar.width") ?? 268 });
      })
      .child(svg(ICON("chevron-right")).size(12));
    return h_flex().id("rail").flex_wrap().gap(4).p(6).children([expand, ...cells]);
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
        .on_click(() => run("space.new", {}))
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
          c.top = this.topOf.get(ck);
          if (c.top) {
            const tk = `${m}|${c.top}`;
            this.wanted.add(tk);
            c.summary = this.repos.get(tk)?.summary ?? null;
            // Line 1 shows the repo (its top-level folder), not the pane's subfolder.
            c.repo = c.top.split(/[\\/]/).filter(Boolean).pop() ?? c.repo;
          }
        }
        if (!settled && s.card.line3 && s.card.pr && c.top && c.summary && !c.summary.detached) {
          const branch = c.branch ?? c.summary.branch;
          if (branch && branch !== c.summary.default) {
            const pk = `${c.machine ?? ""}|${c.top}|${branch}`;
            const cached = this.prCache.get(pk, now);
            c.pr = cached ?? null;
            if (cached === undefined && !this.prBusy.has(pk) && !jobKeys.has(pk)) {
              jobKeys.add(pk);
              jobs.push({ key: pk, machine: c.machine, top: c.top, branch, cwd: c.cwd, active: c.spaceActive });
            }
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
        this.checkoutBySpace.set(sp.space, sp.checkout);
      }
      g.blocked = g.spaces.reduce((n, sp) => n + sp.blocked, 0);
    }
    jobs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    return jobs;
  }

  allCards(tree) {
    // Same walk as render: main cards, then each worktree's, in display order.
    const out = [];
    for (const g of tree.groups) {
      for (const e of nestWorktrees(g.spaces, (sp) => sp.checkout)) {
        out.push(...e.cards, ...e.settled);
        for (const wt of e.worktrees) out.push(...wt.cards, ...wt.settled);
      }
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
      this.prCache = createTtlCache(s.refresh.prSec * 1000);
    }
    const filter = shared(FILTER_KEY) ?? null;
    const tree = buildTree({
      home: home(),
      machines: machines(), spaces: spaces(), agents: agents(), panes: panes(),
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
        for (const e of nestWorktrees(g.spaces, (sp) => sp.checkout)) {
          rows.push(this.spaceRow(e));
          if (this.collapsed.s[e.space]) continue; // folded: hides its worktrees too
          const grouped = (c) => Boolean(e.checkout) && c.top === e.checkout.top;
          for (const c of e.cards) {
            rows.push(this.card(c, { grouped: grouped(c) }));
            this.order.push(c.tabId);
          }
          if (e.settled.length) {
            rows.push(this.settledRow(e));
            if (!this.collapsed.settled[e.space]) {
              for (const c of e.settled) {
                rows.push(this.card(c, { settled: true, grouped: grouped(c) }));
                this.order.push(c.tabId);
              }
            }
          }
          for (const wt of e.worktrees) {
            rows.push(this.worktreeRow(wt));
            if (this.collapsed.w[wt.space]) continue;
            const wtGrouped = (c) => Boolean(wt.checkout) && c.top === wt.checkout.top;
            const body = [];
            for (const c of wt.cards) {
              body.push(this.card(c, { grouped: wtGrouped(c) }));
              this.order.push(c.tabId);
            }
            if (wt.settled.length) {
              body.push(this.settledRow(wt));
              if (!this.collapsed.settled[wt.space]) {
                for (const c of wt.settled) {
                  body.push(this.card(c, { settled: true, grouped: wtGrouped(c) }));
                  this.order.push(c.tabId);
                }
              }
            }
            // Cards indented under the tree glyph, with a 1px guide line.
            if (body.length) {
              rows.push(v_flex().id(`worktree-body-${wt.space}`).flex_none().ml(13)
                .border_l(1).border_color(t.border).children(body));
            }
          }
        }
      }
    }

    return v_flex().id("root").size_full().min_h(0).bg(t.chrome)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => {
        if (this.size === null || size.width !== this.size.width) {
          this.size = size;
          cx.notify();
        }
      })
      .when(!narrow, (e) => e.child(this.projectsHeader()))
      .child(v_flex().id("tree-scroll").flex_1().min_h(0).overflow_y_scrollbar().pb(6).children(rows));
  }
}
