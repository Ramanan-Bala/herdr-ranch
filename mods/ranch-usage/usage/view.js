// What the bar and its hover card show, as plain data. Pure: no Herdr imports.
import { timeLeft, level, pace, ago } from "./format.js";
import { isShown } from "./prefs.js";
import { PROVIDERS } from "../providers/index.js";

const STALE_AFTER = 15 * 60; // s

// text is the full reading; brief is what's left when the bar runs out of room:
// an amber or red window keeps its time, a calm one gives it up.
export function segmentView(w, now, showResetTime = false, remaining = false) {
  if (w.resetsAt != null && w.resetsAt <= now) {
    return { id: w.id, short: w.short, text: "—", brief: "—", compact: "—", level: "ok", fill: 0, tick: null, expired: true };
  }
  const lv = level(w.percent);
  const left = w.resetsAt != null ? ` · ${timeLeft(w.resetsAt - now)}` : "";
  const shown = remaining ? 100 - w.percent : w.percent;
  const elapsed = pace(w, now)?.elapsed ?? null;
  const brief = `${shown}%${lv !== "ok" ? left : ""}`;
  return {
    id: w.id,
    short: w.short,
    text: showResetTime ? `${shown}%${left}` : brief,
    brief,
    compact: ["5h", "wk"].includes(w.short)
      ? `${shown}%${w.resetsAt != null ? ` ${timeLeft(w.resetsAt - now)}` : ""}`
      : `${shown}% ${w.short}`,
    level: lv,
    fill: Math.min(1, Math.max(0, shown / 100)),
    tick: elapsed == null ? null : remaining ? 1 - elapsed : elapsed,
    expired: false,
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const VERDICT = { "on pace": "you're on pace", ahead: "you're using it up too fast", under: "you have room to spare" };

// What the tick means, in this limit's own numbers. No tick, nothing to explain.
function tickHint(percent, p, remaining) {
  if (!p) return null;
  if (remaining) return `Tick: ${Math.round((1 - p.elapsed) * 100)}% of the time is left.\nYou have ${100 - percent}% left, so ${VERDICT[p.verdict]}.`;
  return `Tick: ${Math.round(p.elapsed * 100)}% of the time has passed.\nYou've used ${percent}%, so ${VERDICT[p.verdict]}.`;
}

function cardRow(w, now, remaining = false) {
  if (w.resetsAt != null && w.resetsAt <= now) {
    return { id: w.id, long: w.long, percent: "—", level: "ok", fill: 0, tick: null, hint: null, left: "", detail: "reset, waiting for a new reading" };
  }
  const p = pace(w, now);
  const shown = remaining ? 100 - w.percent : w.percent;
  return {
    id: w.id,
    long: w.long,
    percent: remaining ? `${shown}% left` : `${shown}%`,
    level: level(w.percent),
    fill: Math.min(1, Math.max(0, shown / 100)),
    tick: p == null ? null : remaining ? 1 - p.elapsed : p.elapsed,
    hint: tickHint(w.percent, p, remaining),
    left: w.resetsAt != null ? timeLeft(w.resetsAt - now) : "",
    detail: "",
  };
}

// The hover panel: everything known. What's hidden is hidden from the bar only.
export function cardModel(states, now, providers = PROVIDERS, remaining = false) {
  const groups = [];
  for (const p of providers) {
    const { report = null, lastGood = null, installed = null } = states[p.id] ?? {};
    if (installed === false) continue;
    const g = { providerId: p.id, name: p.name, icon: p.icon, plan: null, status: "loading…", failed: false, dim: false, age: null, rows: [] };
    if (report?.status === "ok") {
      g.plan = report.plan ? cap(report.plan) : null;
      g.status = `updated ${ago(report.observedAt, now)}`;
      g.dim = now - report.observedAt > STALE_AFTER;
      g.rows = report.windows.map((w) => cardRow(w, now, remaining));
    } else if (report) {
      g.status = report.message ?? report.status;
      g.failed = true;
      g.dim = true;
      g.age = lastGood ? `Last reading ${ago(lastGood.observedAt, now)}` : null;
      g.rows = (lastGood?.windows ?? []).map((w) => cardRow(w, now, remaining));
    }
    groups.push(g);
  }
  return { groups, empty: groups.length === 0 };
}

// The panel opens on limits: settings last only until it closes. It closes closeDelay
// after the pointer leaves, and nothing reports that, so it's worked out on the way back.
export function panelOnEnter(panel, leftAt, nowMs, closeDelay) {
  return leftAt != null && nowMs - leftAt > closeDelay ? "limits" : panel;
}

// ProviderState: { report: Report|null, lastGood: Report|null, installed: true|false|null }
export function barModel(states, prefs, now, providers = PROVIDERS) {
  const groups = [];
  for (const p of providers) {
    if (!isShown(prefs, p.id)) continue;
    const st = states[p.id] ?? { report: null, lastGood: null, installed: null };
    if (st.installed === false) continue;
    let mark = null;
    let source = st.report;
    if (!st.report) {
      mark = "…";
      source = null;
    } else if (st.report.status !== "ok") {
      mark = "!";
      source = st.lastGood;
    }
    const segments = (source?.windows ?? [])
      .filter((w) => isShown(prefs, p.id, w.id))
      .map((w) => segmentView(w, now, prefs.showResetTime, prefs.showRemaining));
    const dim = mark === "!" || (source != null && now - source.observedAt > STALE_AFTER);
    groups.push({ providerId: p.id, name: p.name, icon: p.icon, mark, dim, segments });
  }
  return { groups, empty: groups.length === 0 };
}

// Rough text widths at 11.8px (labels 10.5px): enough to pick a density, not to lay out.
const GROUP = 20; // icon + gaps
function segmentWidth(s, density) {
  const text = 7 * (density === 3 ? s.brief : s.text).length + 12;
  if (density >= 2) return text;
  const label = 8 + 6.5 * s.short.length;
  return density === 1 ? label + text : label + 30 + text;
}

// 0 = label + bar + percent, 1 = no bars, 2 = no labels, 3 = no time on calm windows.
export function chooseDensity(model, widthPx, showBars = true) {
  for (const d of showBars ? [0, 1, 2, 3] : [1, 2, 3]) {
    const need = model.groups.reduce((sum, g) => sum + GROUP + g.segments.reduce((a, s) => a + segmentWidth(s, d), 0), 0);
    if (need <= widthPx) return d;
  }
  return 3;
}
