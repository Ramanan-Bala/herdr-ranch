// Pure helpers for the Ranch session panel (requirements.md §6).
// Imports only ./lib/* so Node tests can run it without Herdr.

import { statusRank, STATUS_LABEL, effectiveStatus } from "./lib/format.js";

/** Agent apps whose task store Ranch reads (requirements.md §7.4). */
export const TASK_AGENTS = new Set(["claude-code", "claude", "codex", "opencode"]);

/** Agent app name (OSC 7501 `app`) -> ranch-tasks adapter key. */
export function adapterKey(app) {
  if (app === "claude-code" || app === "claude") return "claude";
  if (app === "codex" || app === "opencode") return app;
  return null;
}

/**
 * Which agent the panel shows: the remembered pick, else the most urgent
 * (statusRank: blocked > done > working > idle; ties keep list order).
 * @param {Array<{address: string, status: string}>|null} agentsInTab
 * @param {string|null} rememberedAddress
 * @returns {object|null}
 */
export function pickAgent(agentsInTab, rememberedAddress) {
  if (!agentsInTab?.length) return null;
  const remembered = agentsInTab.find((a) => a.address === rememberedAddress);
  if (remembered) return remembered;
  return [...agentsInTab].sort((a, b) => statusRank(a.status) - statusRank(b.status))[0];
}

/**
 * A Herdr sub-agent terminal's raw status word as a Herdr Status for display
 * (error counts as blocked; a finished sub-agent reports to its parent, so
 * "done" shows as idle), or null when nothing should show.
 * @param {{status?: string}} t a terminals() row
 * @returns {string|null}
 */
export function herdrSubStatus(t) {
  const s = String(t?.status ?? "").toLowerCase();
  if (s === "error") return "blocked";
  // "done" is an agent's own report (hc ls / terminals() use the same words as
  // Herdr's status order), so it stays "done", not idle.
  if (s === "running") return "working";
  return STATUS_LABEL[s] ? s : null;
}

/** { done, total } summed over task lists (arrays of store tasks). */
export function totalsOf(lists) {
  let done = 0;
  let total = 0;
  for (const tasks of lists ?? []) {
    if (!Array.isArray(tasks)) continue;
    total += tasks.length;
    done += tasks.filter((t) => t.status === "completed").length;
  }
  return { done, total };
}

/** Tasks not finished yet: pending + in_progress. */
export function unfinishedCount(tasks) {
  return (tasks ?? []).filter((t) => t.status === "pending" || t.status === "in_progress").length;
}

/** The panel title subtitle: "2 of 6 done", or null with no tasks (quieter header). */
export function subtitle(totals) {
  if (!totals || !totals.total) return null;
  return `${totals.done} of ${totals.total} done`;
}

/**
 * A sub-agent's status from the activity its adapter recorded in the store
 * (store.session.activity = { state, at }), same rule as effectiveStatus():
 * a "working" older than ACTIVITY_STALE_MS reads as idle (a missed Stop event).
 * @param {{state?: string, at?: number}|null|undefined} activity
 * @param {number} now ms since the epoch
 * @returns {string|null} null when nothing is recorded.
 */
export function activityStatus(activity, now) {
  if (!activity?.state) return null;
  return effectiveStatus(null, activity, now).status;
}

/**
 * A status as a lowercase display word ("needs you" for blocked).
 * @param {string|null} status
 * @returns {string|null}
 */
export function stateWord(status) {
  if (!status) return null;
  if (status === "blocked") return "needs you";
  return STATUS_LABEL[status] ? STATUS_LABEL[status].toLowerCase() : String(status).toLowerCase();
}

/**
 * CI summary "3 failed · 2 running · 12 passed" (pending = running), zero
 * parts skipped.
 * @param {{pass?: number, fail?: number, pending?: number}|null} checks
 * @returns {string|null} null when nothing to show.
 */
export function checksSummary(checks) {
  if (!checks) return null;
  const parts = [];
  if (checks.fail) parts.push(`${checks.fail} failed`);
  if (checks.pending) parts.push(`${checks.pending} running`);
  if (checks.pass) parts.push(`${checks.pass} passed`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * The CI row's leading glyph kind: fail wins, then pending, then pass.
 * @param {{pass?: number, fail?: number, pending?: number}|null} checks
 * @returns {"fail"|"pending"|"pass"}
 */
export function checksGlyph(checks) {
  if (!checks) return "pass";
  if (checks.fail) return "fail";
  if (checks.pending) return "pending";
  return "pass";
}

const REVIEW_PILL = {
  approved: { text: "Approved", token: "done" },
  changes_requested: { text: "Changes requested", token: "blocked" },
  review_required: { text: "Review required", token: "blocked" },
};

/**
 * The review-decision pill for gh's reviewDecision.
 * @param {string|null} review
 * @returns {{text: string, token: string}|null} token: a theme colour name.
 */
export function reviewPill(review) {
  return REVIEW_PILL[review] ?? null;
}

/**
 * The default-branch line (R-SD-5a).
 * @param {object|null} summary repoSummary() output (vsDefault may be missing)
 * @returns {{kind: "on-default"|"diverged"|"none", ahead: number, behind: number, default: string|null}|null}
 *   null when there is no summary at all; kind "none" hides the row.
 */
export function defaultBranchLine(summary) {
  if (!summary) return null;
  const def = summary.default ?? null;
  const vs = summary.vsDefault;
  if (!vs) return { kind: "none", ahead: 0, behind: 0, default: def };
  const ahead = vs.ahead ?? 0;
  const behind = vs.behind ?? 0;
  if (summary.branch && summary.branch === def) {
    return { kind: "on-default", ahead: 0, behind: 0, default: def };
  }
  return { kind: "diverged", ahead, behind, default: def };
}

/**
 * Empty-state text for the Tasks section (R-SD-3).
 * @param {{ok: boolean, reason?: string, store?: object}|null} parsed parseStore() output
 * @param {string|null} app the agent's reported app (OSC 7501)
 * @returns {{text: string, setup?: boolean}|null} null: show the tasks.
 */
export function taskEmptyState(parsed, app, adapterState) {
  if (parsed?.ok && parsed.store.tasks.length) return null;
  if (parsed && !parsed.ok) {
    if (parsed.reason === "newer") return { text: "Update Ranch to see tasks." };
    if (parsed.reason === "invalid") return { text: "Task reporting isn't set up", setup: true };
    // No store yet: only offer setup once `ranch-tasks status` says the adapter
    // isn't installed (undefined = still checking -> "No plan yet.").
    // Codex hooks waiting for trust: Set up can't fix that, /hooks in Codex can.
    if (parsed.reason === "missing" && adapterState === "needs approval") {
      return { text: "Approve the Ranch hooks with /hooks in Codex." };
    }
    if (parsed.reason === "missing" && TASK_AGENTS.has(app ?? "") && adapterState && adapterState !== "installed") {
      return { text: "Task reporting isn't set up", setup: true };
    }
  }
  return TASK_AGENTS.has(app ?? "")
    ? { text: "No plan yet." }
    : { text: "This agent doesn't report tasks." };
}

/**
 * "↑2 ↓5" against the remote, zero parts skipped; null when nothing to show
 * (no upstream, or in sync).
 * @param {number|null} ahead
 * @param {number|null} behind
 * @returns {string|null}
 */
export function remoteText(ahead, behind) {
  if (ahead == null && behind == null) return null;
  const parts = [];
  if (ahead) parts.push(`↑${ahead}`);
  if (behind) parts.push(`↓${behind}`);
  return parts.length ? parts.join(" ") : null;
}

/**
 * One changed-file row: +adds / −dels, "bin" for binary (numstat "-").
 * @param {{path: string, add: number|null, del: number|null}} f
 * @returns {{path: string, add: string, del: string|null}}
 */
export function fileRow(f) {
  const bin = !f || f.add == null || f.del == null;
  return {
    path: f?.path ?? "",
    add: bin ? "bin" : `+${f.add}`,
    del: bin ? null : `−${f.del}`,
  };
}

/**
 * A store sub-agent's duration in ms, from its ISO timestamps.
 * @param {string|null} started_at
 * @param {string|null} ended_at
 * @param {number} now ms since the epoch (used while it still runs)
 * @returns {number|null}
 */
export function subDuration(started_at, ended_at, now) {
  const start = Date.parse(started_at ?? "");
  if (Number.isNaN(start)) return null;
  const end = ended_at ? Date.parse(ended_at) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/** PR state -> colour token (t.<token>) for the icon and pill, or null. */
export function prStateToken(state) {
  return { open: "ansi2", draft: "dim", merged: "ansi5", closed: "blocked" }[state] ?? null;
}

/** PR state -> pill label ("Open", "Draft", …), or null. */
export function prStateLabel(state) {
  return { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }[state] ?? null;
}

/**
 * A PR URL -> "owner/repo" (the path's first two segments), for the fallback
 * row text while the title is unknown, or null when it can't be parsed.
 * @param {string} url
 * @returns {string|null}
 */
export function prRepoText(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}
