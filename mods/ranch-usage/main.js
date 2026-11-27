// Usage limits: every Claude Code / Codex / Copilot limit window in the status
// bar, and one panel on hover: the details, and behind ⚙ the checkboxes to
// choose what shows.
//
// Data comes from small helpers that run the CLIs themselves (helpers/*.sh);
// this mod never reads a token. Everything below main.js is pure and tested.
//
// Adapted from Orca's usage-limits mod (https://github.com/VladTemp27/herdr-orca,
// Apache-2.0); see THIRD_PARTY.md at the repo root for the licence and changes.
import { View, div, image, svg } from "gpui-kit";
import { HoverCard, h_flex, v_flex } from "gpui-base";
import { exec, focused, spaces, theme, props, shared, setShared, appHome, window, run } from "herdr";
import { PROVIDERS } from "./providers/index.js";
import { barModel, cardModel, chooseDensity, panelOnEnter } from "./usage/view.js";
import { effectivePrefs, isOnBar, isShown, toggleOnBar, toggleProvider, toggleShowBars, toggleShowRemaining, toggleShowResetTime, toggleWindow } from "./usage/prefs.js";
import { parseSession, sessionOnBar, sessionView } from "./usage/session.js";
import { sessionUsageSupport } from "./usage/session-support.js";
import { nextState } from "./usage/state.js";
import { UNREPORTED } from "./usage/unreported.js";
import { SETTINGS_KEY, resolveSettings } from "./lib/settings.js";

const MOD = "ranch-usage";
const KEY_STATE = "ranch-usage.state";
const KEY_PREFS = "ranch-usage.prefs";
const KEY_REFRESH = "ranch-usage.refresh";
const FETCH_EVERY = 5 * 60;       // s, installed providers
const MISSING_EVERY = 60 * 60;    // s, not-installed providers
const REFRESH_COOLDOWN = 30;      // s
const SESSION_EVERY = 10 * 1000;   // ms, at most this often on hover
const AGENTS = { "claude-code": "claude", codex: "codex", antigravity: "antigravity" }; // Herdr's app name → session helper
const BAR_W = 30;
const PANEL_W = 360;
const PANEL_BAR_W = 96;
// The percent column fits "100%", or "100% left" when showing what remains.
const PCT_W = { used: 40, remaining: 66 };
const SESSION_BAR_W = 60;
const LEFT_W = 48;                   // the time-left column in the panel
const PANEL_OPEN_DELAY = 350;       // ms, so passing over the bar doesn't flash it
const PANEL_CLOSE_DELAY = 300;      // ms, lets the pointer cross from the bar to the card

const now = () => Math.floor(Date.now() / 1000);
const states = () => shared(KEY_STATE) ?? {};

function levelColor(level, t) {
  if (level === "hot") return t.ansi1 ?? t.blocked;
  if (level === "warn") return t.ansi3 ?? t.done;
  return t.foreground;
}

const textColor = (level, text, t) => (level === "ok" ? (text === "—" ? t.dim : t.foreground) : levelColor(level, t));

// The bar's limit numbers always wear their level, green included; the panel's only when amber or red.
const limitColor = (level, text, t) => (text === "—" ? t.dim : levelColor(level, t));

// One-colour glyphs (tint) take the text colour; full-colour logos draw as images.
const INNER_W = PANEL_W - 28; // the panel's content width (p(14) each side)
const clip = (id, text, _px, _size = 12) => div().id(id).min_w(0).truncate().child(text);

const providerIcon = (p, size, t) => (p.tint ? svg(p.icon).size(size).flex_none().text_color(t.foreground) : image(p.icon).size(size).flex_none());

function usageBar(width, fill, tick, color, t) {
  return div().relative().w(width).h(6).rounded(3).bg(t.raised).flex_none()
    .child(div().absolute().left(0).top(0).h(6).rounded(3).w(Math.round(width * fill)).bg(color))
    .when(tick != null, (b) => b.child(div().absolute().top(-1).left(Math.round(width * tick)).w(1).h(8).bg(t.foreground).opacity(0.75)));
}

export default class UsageLimits extends View {
  init(_props, cx) {
    this.width = 0;
    this.panel = "limits"; // or "settings"
    this.leftAt = null;    // ms, when the pointer left the bar and the panel
    this.terminal = null;  // the focused terminal the session below belongs to
    this.machine = null;   // that terminal's machine, null on this computer
    this.session = null;   // { data: Session, title } | { unsupported, title } | null
    this.sessionAt = 0;    // ms, last session read
    this.sessionBusy = false;
    this.lastFetch = {};   // providerId → epoch s of last attempt
    this.busy = {};        // providerId → fetch in flight
    this.unreported = [];  // UNREPORTED entries whose bin is on PATH
    this.unreportedAt = 0; // ms, when the PATH was last checked (once an hour)
    this.seenRefresh = shared(KEY_REFRESH) ?? 0;
    // The block stays hidden across restarts: render() alone cannot shrink it.
    if (!resolveSettings(shared(SETTINGS_KEY)).usage.show) run("layout.hide", { id: "usage" });
    this.tick(cx, true);
    cx.timer.every(60 * 1000, (cx) => this.tick(cx, false));
  }

  // Fetch whatever is due, then redraw (countdowns and pace move every minute).
  tick(cx, force) {
    // Usage bar turned off in Ranch settings: nothing shows these numbers, so
    // no CLI runs; the next tick after it is turned back on fetches what's due.
    if (!resolveSettings(shared(SETTINGS_KEY)).usage.show) return;
    const st = states();
    for (const p of PROVIDERS) {
      const every = st[p.id]?.installed === false ? MISSING_EVERY : FETCH_EVERY;
      if (force || now() - (this.lastFetch[p.id] ?? 0) >= every) this.fetch(p, cx);
    }
    // The focused session's numbers (hc get + a helper): kept fresh every
    // minute only when the bar shows some of them. The hover panel re-reads
    // on open (SESSION_EVERY), and a focus change reads at once (render).
    if (this.prefs().sessionOnBar.length) this.readSession(cx);
    this.checkUnreported(cx);
    cx.notify();
  }

  fetch(p, cx) {
    if (this.busy[p.id]) return;
    this.busy[p.id] = true;
    this.lastFetch[p.id] = now();
    cx.spawn(async (cx) => {
      let next;
      const prev = states()[p.id] ?? { report: null, lastGood: null, installed: null };
      try {
        // Node port of helpers/*.sh (fixes doc F11); falls back to the sh
        // original when node is not on PATH (Unix installs without node).
        // node may be missing from Herdr's PATH (nvm/volta): exec then throws
        // or exits 127, so fall back in both cases.
        let r = null;
        try { r = await exec("node", [`${appHome()}/mods/${MOD}/${p.helper}`]); } catch {}
        if (!r || r.code === 127) r = await exec("sh", [`${appHome()}/mods/${MOD}/${p.helper.replace(/\.mjs$/, ".sh")}`]);
        next = r.code === 127 ? nextState(prev, null, false) : nextState(prev, p.parse(r.stdout, now()), true);
      } catch (e) {
        next = { ...prev, report: { status: "error", message: String(e?.message ?? e), plan: null, observedAt: now(), source: p.helper, windows: [] } };
      }
      this.busy[p.id] = false;
      setShared(KEY_STATE, { ...states(), [p.id]: next });
      cx.notify();
    });
  }

  // Which "Not reported by its CLI" agents are installed: checked at most once
  // an hour. The bin names are constants in usage/unreported.js, never input.
  checkUnreported(cx) {
    if (Date.now() - this.unreportedAt < 60 * 60 * 1000) return;
    this.unreportedAt = Date.now();
    cx.spawn(async (cx) => {
      const found = await Promise.all(UNREPORTED.map(async (u) => {
        try {
          const r = await exec("sh", ["-c", `command -v ${u.bin}`]);
          return r.code === 0 ? u : null;
        } catch {
          return null;
        }
      }));
      this.unreported = found.filter(Boolean);
      cx.notify();
    });
  }

  // Terminal → its agent's process → that process's session. Any step failing means
  // no block at all: another session's numbers would be worse than none.
  readSession(cx) {
    if (this.sessionBusy) return; // a hung hc mustn't pile up; it re-reads below if focus moved
    const terminal = this.terminal;
    const remote = this.machine != null;
    const platform = window()?.platform;
    this.sessionAt = Date.now();
    if (!terminal) {
      this.session = null;
      return;
    }
    this.sessionBusy = true;
    cx.spawn(async (cx) => {
      let next = null;
      try {
        const info = JSON.parse((await exec("hc", ["get", terminal])).stdout);
        const app = AGENTS[info.status?.app];
        const pid = info.foreground?.pid;
        const target = app === "antigravity" ? terminal : pid != null ? String(pid) : null;
        // Decided before any helper runs (finding 17): the helpers match the
        // PID/terminal against this machine's session files, which lies for a
        // remote terminal and can't work for Codex on Windows (pgrep/lsof).
        const support = sessionUsageSupport({ remote, agent: app, platform });
        const title = (info.cwd ?? "").split("/").pop();
        if (app && target && support.ok) {
          // Node helper (fixes doc F11); sh fallback when node is not on PATH.
          let r = null;
          try { r = await exec("node", [`${appHome()}/mods/${MOD}/helpers/session.mjs`, app, target]); } catch {}
          if (!r || r.code === 127) r = await exec("sh", [`${appHome()}/mods/${MOD}/helpers/session.sh`, app, target]);
          const data = r.code === 0 ? parseSession(r.stdout, app) : null;
          if (data) next = { data, title };
        } else if (app && target && !support.ok) {
          next = { unsupported: support.reason, title };
        }
      } catch {
        next = null;
      } finally {
        this.sessionBusy = false;
      }
      if (terminal !== this.terminal) {
        this.readSession(cx); // focus moved on while this was reading
        return;
      }
      this.session = next;
      cx.notify();
    });
  }

  cooling() {
    return now() - Math.floor((shared(KEY_REFRESH) ?? 0) / 1000) < REFRESH_COOLDOWN;
  }

  refresh(cx) {
    if (!this.cooling()) setShared(KEY_REFRESH, Date.now());
    cx.notify();
  }

  // Herdr's props come from props(), not init's first argument (shipped mods ignore it too).
  prefs() {
    return effectivePrefs(shared(KEY_PREFS), props());
  }

  hover(on, cx) {
    if (!on) {
      this.leftAt = Date.now();
      return;
    }
    this.panel = panelOnEnter(this.panel, this.leftAt, Date.now(), PANEL_CLOSE_DELAY);
    this.leftAt = null;
    if (Date.now() - this.sessionAt >= SESSION_EVERY) this.readSession(cx);
    cx.notify();
  }

  show(panel, cx) {
    this.panel = panel;
    cx.notify();
  }

  // ---------- status bar ----------

  renderBar(cx) {
    const t = theme();
    const st = states();
    const prefs = this.prefs();
    const model = barModel(st, prefs, now());
    const numbers = sessionOnBar(this.session?.data, prefs);
    const numbersWidth = numbers.reduce((w, n) => w + 7 * n.text.length + 14, numbers.length ? 14 : 0);
    const density = chooseDensity(model, this.width ? this.width - 24 - numbersWidth : Infinity, prefs.showBars);
    const left = props()?.align === "left";
    const root = h_flex().id("root").size_full().px(12).gap(10).items_center().overflow_hidden()
      .when(left, (e) => e.justify_start()).when(!left, (e) => e.justify_end())
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); });
    // Only the limits themselves open the panel, not the empty rest of the block.
    const content = h_flex().id("ul-content").gap(18).items_center().flex_none().on_hover((on, cx) => this.hover(on, cx))
      .child(div().flex_none().text_color(t.dim).child(prefs.showRemaining ? "Remaining" : "Used"));
    const showBars = prefs.showBars && this.compactWidth(model, numbersWidth, true) <= this.width - 70;
    if (numbers.length) {
      content.child(h_flex().gap(10).items_center().flex_none()
        .children(numbers.map((n) => div().whitespace_nowrap().text_color(textColor(n.level, n.text, t)).child(n.text))));
      if (!model.empty) content.child(div().w(1).h(14).bg(t.border).flex_none());
    }
    if (model.empty) content.child(div().id("ul-empty").child(svg(`mods/${MOD}/icons/gauge.svg`).size(14)));
    model.groups.forEach((g) => content.child(this.compactGroup(g, showBars, t)));
    const panel = cardModel(st, now(), undefined, prefs.showRemaining);
    // With no CLI installed there are no limits to show, so settings are all there is.
    const body = this.panel === "settings" || panel.empty ? this.settings(!panel.empty, t) : this.limits(panel, t);
    const cooling = this.cooling();
    return root.child(HoverCard.new("ul-panel").anchor(left ? "bottom_left" : "bottom_right").open_delay(PANEL_OPEN_DELAY).close_delay(PANEL_CLOSE_DELAY)
      .trigger(content)
      .content(body))
      .child(this.iconButton("ul-bar-refresh", "refresh", cooling ? "Refreshing…" : "Refresh now", !cooling, (cx) => this.refresh(cx), t));
  }

  // Rough width of the compact bar, to drop the bars first when it doesn't fit.
  compactWidth(model, extra, bars) {
    return model.groups.reduce((w, g) => w + 37 + (bars ? 50 : 0)
      + g.segments.reduce((a, s) => a + 6.8 * s.compact.length + 18, 0), 80 + extra);
  }

  // Icon, one bar for the first window, then every window as text joined by ·.
  compactGroup(g, showBars, t) {
    const first = g.segments[0];
    const parts = [];
    g.segments.forEach((s, i) => {
      if (i > 0) parts.push(div().text_color(t.dim).child("·"));
      parts.push(div().whitespace_nowrap().text_color(s.level === "ok" ? (s.text === "—" ? t.dim : t.foreground) : levelColor(s.level, t)).child(s.compact));
    });
    return h_flex().id(`ul-${g.providerId}`).gap(8).items_center().flex_none().opacity(g.dim ? 0.55 : 1)
      .child(providerIcon(g, 14, t))
      .when(g.mark != null, (e) => e.child(div().text_color(t.dim).child(g.mark)))
      .when(showBars && first != null, (e) => e.child(usageBar(44, first.fill, null, first.level === "ok" ? t.muted : levelColor(first.level, t), t)))
      .child(h_flex().gap(6).items_center().children(parts));
  }

  openUrl(url) {
    const platform = window().platform;
    if (platform === "macos") exec("open", [url]);
    else if (platform === "windows") exec("cmd", ["/c", "start", "", url]);
    else exec("xdg-open", [url]);
  }

  // ---------- panel: limits ----------

  cardRow(r, providerId, t) {
    const labelW = INNER_W - PANEL_BAR_W - (this.prefs().showRemaining ? PCT_W.remaining : PCT_W.used) - LEFT_W - 24;
    return v_flex().gap(3)
      .child(h_flex().id(`ul-row-${providerId}-${r.id}`).gap(8).items_center()
        .child(clip(`ul-row-${providerId}-${r.id}-label`, r.long, labelW).flex_1().text_color(t.muted))
        .child(usageBar(PANEL_BAR_W, r.fill, r.tick, levelColor(r.level, t), t))
        .child(div().w(this.prefs().showRemaining ? PCT_W.remaining : PCT_W.used).flex_none().flex().justify_end().whitespace_nowrap().text_color(textColor(r.level, r.percent, t)).child(r.percent))
        .child(div().w(LEFT_W).flex_none().flex().justify_end().whitespace_nowrap().text_size(11).text_color(t.dim).child(r.left)))
      .when(r.detail !== "", (e) => e.child(clip(`ul-row-${providerId}-${r.id}-detail`, r.detail, INNER_W, 11).text_size(11).text_color(t.dim)));
  }

  cardGroup(g, t) {
    const statusW = INNER_W - 13 - 24 - String(g.name).length * 7.5 - (g.plan != null ? String(g.plan).length * 6 + 16 : 0);
    return v_flex().gap(8)
      .child(h_flex().gap(6).items_center()
        .child(providerIcon(g, 13, t))
        .child(div().flex_none().font_semibold().child(g.name))
        .when(g.plan != null, (e) => e.child(div().flex_none().px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.accent).child(g.plan)))
        .child(div().flex_1())
        .child(clip(`ul-status-${g.providerId}`, g.status, statusW, 11).text_size(11).text_color(g.failed ? levelColor("hot", t) : t.dim)))
      .when(g.age != null, (e) => e.child(div().text_size(11).text_color(t.dim).child(g.age)))
      .child(v_flex().gap(6).opacity(g.dim ? 0.55 : 1).children(g.rows.map((r) => this.cardRow(r, g.providerId, t))));
  }

  sessionBlock(v, t) {
    const stats = [v.context.detail, v.calls, v.compactions, v.last].filter(Boolean).join(" · ");
    return v_flex().gap(4)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().font_semibold().child("This session"))
        .child(clip("ul-session-title", v.title, INNER_W - 84 - (v.context.fill != null ? SESSION_BAR_W + 6 : 0) - (4 + String(v.context.text).length) * 7 - 12).flex_1().text_color(t.dim))
        .when(v.context.fill != null, (r) => r.child(usageBar(SESSION_BAR_W, v.context.fill, null, levelColor(v.context.level, t), t)))
        .child(div().flex_none().whitespace_nowrap().text_color(textColor(v.context.level, v.context.text, t)).child(`ctx ${v.context.text}`)))
      .child(div().text_size(11).text_color(t.dim).child(stats));
  }

  iconButton(id, icon, label, enabled, onClick, t) {
    return div().id(id).size(24).rounded(5).flex().items_center().justify_center().tooltip(label)
      .when(enabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(svg(`mods/${MOD}/icons/${icon}.svg`).size(14).text_color(enabled ? t.muted : t.dim));
  }

  shell(t) {
    return v_flex().id("ul-panel-body").w(PANEL_W).p(14).gap(14).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(12).text_color(t.foreground)
      .on_hover((on, cx) => this.hover(on, cx));
  }

  limits(model, t) {
    const body = this.shell(t);
    model.groups.forEach((g) => body.child(this.cardGroup(g, t)));
    if (this.unreported.length) {
      body.child(v_flex().gap(4)
        .child(div().text_size(11).font_semibold().child("Not reported by its CLI"))
        .children(this.unreported.map((u) => h_flex().id(`ul-unreported-${u.id}`).gap(6).items_center()
          .child(image(u.icon).size(13))
          .child(clip(`ul-unreported-${u.id}-name`, u.name, INNER_W - 13 - 12 - 76, 11).flex_1().text_size(11).text_color(t.muted))
          .child(div().id(`ul-open-${u.id}`).text_size(11).text_color(t.accent).cursor_pointer()
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.openUrl(u.url); })
            .child("Open usage ↗")))));
    }
    const unsupported = this.session?.unsupported ?? null;
    const session = unsupported ? null : sessionView(this.session?.data, this.session?.title);
    if (unsupported) body.child(v_flex().pt(10).border_t(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).child(`Session usage: ${unsupported}`)));
    if (session) body.child(v_flex().pt(10).border_t(1).border_color(t.border).child(this.sessionBlock(session, t)));
    const cooling = this.cooling();
    return body.child(h_flex().gap(2).items_center()
      .child(clip("ul-data-note", "Data: claude, codex, gh, opencode and agy CLIs, numbers from session logs.", INNER_W - 52, 10.5).flex_1().text_size(10.5).text_color(t.dim))
      .child(this.iconButton("ul-refresh", "refresh", cooling ? "Refreshing…" : "Refresh now", !cooling, (cx) => this.refresh(cx), t))
      .child(this.iconButton("ul-settings", "gear", "Settings", true, (cx) => this.show("settings", cx), t)));
  }

  // ---------- panel: settings ----------
  // Same grammar as the Ranch settings panel: sections split by a hairline, one
  // row shape (label left, switch right). Labels truncate; a provider's problem
  // wraps on a hint line under its name, so nothing can push past the card edge.

  /** Ranch's switch: a 26×14 track with a dot, accent when on. */
  pill(id, on, t) {
    return div().id(`${id}-pill`).flex_none().w(26).h(14).rounded(7).p(2).flex().items_center().border(1).border_color(t.border)
      .bg(on ? t.accent : t.input).when(on, (e) => e.justify_end())
      .child(div().size(8).rounded(4).bg(on ? t.accent_foreground : t.muted));
  }

  /** One settings row. `indent` nests a row under its parent's label; `hint` wraps under the label. */
  toggleRow(id, label, on, onToggle, t, { icon = null, indent = 0, color = null, hint = null, hintColor = null, tooltip = null } = {}) {
    return h_flex().id(id).w_full().min_w(0).min_h(26).pl(6 + indent).pr(6).gap(8).items_center().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .when(tooltip != null, (e) => e.tooltip(tooltip))
      .on_click((_e, cx) => { onToggle(); cx.notify(); })
      .when(icon != null, (e) => e.child(icon))
      .child(v_flex().flex_1().min_w(0).py(hint != null ? 4 : 0).gap(2)
        .child(clip(`${id}-label`, label, INNER_W - 12 - indent - (icon != null ? 22 : 0) - 34).text_color(color ?? t.foreground))
        .when(hint != null, (e) => e.child(div().w_full().min_w(0).text_size(11).text_color(hintColor ?? t.dim).child(hint))))
      .child(this.pill(id, on, t));
  }

  /** A section: heading plus rows; every section after the first starts with a hairline. */
  settingsSection(id, title, rows, t, first = false) {
    return v_flex().id(`ul-sec-${id}`).w_full().min_w(0).flex_none().pt(first ? 0 : 8)
      .when(!first, (e) => e.border_t(1).border_color(t.border))
      .child(div().flex_none().h(24).px(6).flex().items_center().text_size(11.5).font_semibold().text_color(t.muted).child(title))
      .children(rows);
  }

  settings(canGoBack, t) {
    const prefs = this.prefs();
    const st = states();
    const save = (p) => setShared(KEY_PREFS, p);
    const limitRows = [];
    for (const p of PROVIDERS) {
      const s = st[p.id] ?? {};
      const on = isShown(prefs, p.id);
      const missing = s.installed === false;
      const problem = !missing && s.report && s.report.status !== "ok" ? String(s.report.message || "No usage reported") : null;
      // Error text comes straight from CLIs and APIs: keep the hint to two short lines, full text on hover.
      const hint = missing ? "Not installed" : problem && (problem.length > 120 ? `${problem.slice(0, 117).trimEnd()}…` : problem);
      limitRows.push(this.toggleRow(`p-${p.id}`, p.name, on, () => save(toggleProvider(this.prefs(), p.id)), t, {
        icon: providerIcon(p, 14, t),
        color: missing ? t.dim : t.foreground,
        hint,
        hintColor: s.report?.status === "error" ? levelColor("hot", t) : t.dim,
        tooltip: problem && problem !== hint ? problem : null,
      }));
      const windows = (s.report?.status === "ok" ? s.report : s.lastGood)?.windows ?? [];
      for (const w of windows) {
        limitRows.push(this.toggleRow(`w-${p.id}-${w.id}`, w.long, on && isShown(prefs, p.id, w.id),
          () => save(toggleWindow(this.prefs(), p.id, w.id)), t, { indent: 22, color: on ? t.muted : t.dim }));
      }
    }
    const display = [
      ["opt-reset-time", "Always show time to reset", prefs.showResetTime, toggleShowResetTime],
      ["opt-bars", "Show bars", prefs.showBars, toggleShowBars],
      ["opt-remaining", "Show remaining, not used", prefs.showRemaining, toggleShowRemaining],
    ].map(([id, label, on, flip]) => this.toggleRow(id, label, on, () => save(flip(this.prefs())), t));
    const session = ["Context", "Calls", "Compactions"].map((name) => {
      const row = name.toLowerCase();
      return this.toggleRow(`s-${row}`, name, isOnBar(prefs, row), () => save(toggleOnBar(this.prefs(), row)), t);
    });
    return this.shell(t).gap(10)
      .child(v_flex().w_full().min_w(0).gap(2)
        .child(h_flex().gap(4).items_center().h(24)
          .when(canGoBack, (e) => e.child(this.iconButton("ul-back", "back", "Back to limits", true, (cx) => this.show("limits", cx), t)))
          .child(div().pl(canGoBack ? 0 : 6).font_semibold().child("Usage bar")))
        .child(div().w_full().min_w(0).px(6).text_size(11).text_color(t.dim).child("Choose what the status bar shows. This panel always lists everything.")))
      .child(this.settingsSection("limits", "Limits", limitRows, t, true))
      .child(this.settingsSection("display", "Display", display, t))
      .child(this.settingsSection("session", "This session", session, t))
      .child(div().w_full().min_w(0).px(6).text_size(10.5).text_color(t.dim).child("Data: claude, codex, gh, opencode and agy CLIs, numbers from session logs."));
  }

  render(cx) {
    // Nothing in the rest of render must run while hidden: the timers in init
    // keep the data warm, and the terminal/machine diff runs again once shown.
    if (!resolveSettings(shared(SETTINGS_KEY)).usage.show) return div().size_full();
    const focus = focused();
    const terminal = focus?.terminal ?? null;
    // The terminal's machine, like ranch-session: its space's machine field,
    // null on this computer. Same terminal never changes space.
    const machine = spaces().find((sp) => sp.id === focus?.space)?.machine ?? null;
    if (terminal !== this.terminal) {
      this.terminal = terminal;
      this.machine = machine;
      this.session = null;
      this.readSession(cx);
    }
    const asked = shared(KEY_REFRESH) ?? 0;
    if (asked !== this.seenRefresh) {
      this.seenRefresh = asked;
      for (const p of PROVIDERS) this.fetch(p, cx);
    }
    return this.renderBar(cx);
  }
}
