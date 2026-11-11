/**
 * Pure formatting helpers shared by Herdr mods.
 * No imports, no globals, no Date.now() — time is always passed in.
 */

/** Status order, most urgent first (same as Herdr's). */
export const STATUS_ORDER = ["blocked", "done", "working", "idle"];

/**
 * Rank of a status in STATUS_ORDER.
 * @param {string|null} status
 * @returns {number} index in STATUS_ORDER, or 4 for null/unknown.
 */
export function statusRank(status) {
  const i = STATUS_ORDER.indexOf(status);
  return i === -1 ? 4 : i;
}

/**
 * The most urgent non-null status from an array, or null if none.
 * @param {Array<string|null|undefined>} statuses
 * @returns {string|null}
 */
export function mostUrgent(statuses) {
  let best = null;
  let bestRank = Infinity;
  for (const status of statuses) {
    if (status === null || status === undefined) continue;
    const rank = statusRank(status);
    if (rank < bestRank) {
      best = status;
      bestRank = rank;
    }
  }
  return best;
}

/** Human labels per status. */
export const STATUS_LABEL = {
  blocked: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

/**
 * Format a duration in milliseconds, coarse to days.
 * @param {number|null} ms
 * @returns {string|null} "<1m", "4m", "1h 12m", "1h", "2d" or null.
 */
export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return null;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (ms < MIN) return "<1m";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const mins = Math.floor((ms % HOUR) / MIN);
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  }
  return `${Math.floor(ms / DAY)}d`;
}

/**
 * How long a tab has been in its current status.
 * @param {{status: string, working_since: number|null, changed_at: number|null}} tab
 * @param {number} now ms epoch
 * @returns {number|null} ms elapsed, or null when no timestamp applies.
 */
export function statusSince(tab, now) {
  const since = tab.status === "working" ? tab.working_since : tab.changed_at;
  if (since === null || since === undefined) return null;
  return now - since;
}

/**
 * Shorten long text by cutting out the middle, keeping head and tail.
 * @param {string} text
 * @param {number} max maximum result length
 * @returns {string}
 */
export function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  if (max < 2) return "…";
  const keep = max - 1;
  const headLen = Math.floor(keep / 2);
  const tailLen = keep - headLen;
  return text.slice(0, headLen) + "…" + text.slice(text.length - tailLen);
}

/**
 * One-line summary of a diff stat.
 * @param {{files: number, add: number, del: number}|null} stat
 * @returns {string|null} e.g. "12 files  +340  −87", or null when empty.
 */
export function diffSummary(stat) {
  if (!stat) return null;
  const files = stat.files ?? 0;
  const add = stat.add ?? 0;
  const del = stat.del ?? 0;
  if (files === 0 && add === 0 && del === 0) return null;
  const noun = files === 1 ? "file" : "files";
  return `${files} ${noun}  +${add}  \u2212${del}`;
}

/**
 * Coarse relative time for an age in milliseconds.
 * @param {number} msAgo
 * @returns {string} "just now", "5m ago", "3h ago", "2d ago", "3w ago",
 *   "4mo ago" or "2y ago".
 */
export function relativeTime(msAgo) {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  if (msAgo < MIN) return "just now";
  if (msAgo < HOUR) return `${Math.floor(msAgo / MIN)}m ago`;
  if (msAgo < DAY) return `${Math.floor(msAgo / HOUR)}h ago`;
  if (msAgo < 7 * DAY) return `${Math.floor(msAgo / DAY)}d ago`;
  if (msAgo < 5 * WEEK) return `${Math.floor(msAgo / WEEK)}w ago`;
  if (msAgo < 12 * MONTH) return `${Math.floor(msAgo / MONTH)}mo ago`;
  return `${Math.floor(msAgo / YEAR)}y ago`;
}

/**
 * Short label for a path: "~" for home, else its last segment.
 * @param {string|null} path
 * @param {string} home
 * @returns {string|null}
 */
export function folderLabel(path, home) {
  if (!path) return null;
  if (path === home) return "~";
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

/** Hook activity older than this is treated as idle (a missed Stop event). */
export const ACTIVITY_STALE_MS = 30 * 60 * 1000;

/**
 * Tabs across all spaces that need the person right now: effectiveStatus is
 * "blocked" or "done", and the tab isn't settled. Entries are
 * { tabId, spaceId, status, since }, blocked before done, then the one
 * waiting longest (largest since) first; unknown since sorts last.
 * @param {Array<{id: string, tabs: Array<object>}>} spaceList spaces() result
 * @param {Record<string, {state: string, at: number}>|null|undefined} activity
 * @param {number} now ms epoch
 * @returns {Array<{tabId: string, spaceId: string, status: string, since: number|null}>}
 */
export function attentionQueue(spaceList, activity, now) {
  const queue = [];
  for (const space of spaceList) {
    for (const tab of space.tabs) {
      if (tab.settled) continue;
      const { status, since } = effectiveStatus(tab, activity?.[tab.id], now);
      if (status !== "blocked" && status !== "done") continue;
      queue.push({ tabId: tab.id, spaceId: space.id, status, since });
    }
  }
  const rank = (status) => (status === "blocked" ? 0 : 1);
  return queue.sort(
    (a, b) => rank(a.status) - rank(b.status) || (b.since ?? -1) - (a.since ?? -1),
  );
}

/**
 * The status to show for a tab: Herdr's own status when it has one, else the
 * activity Ranch's hooks recorded ({ state, at }), else null.
 * Returns { status, since } where since is ms elapsed (or null).
 */
export function effectiveStatus(tab, activity, now) {
  if (tab?.status) return { status: tab.status, since: statusSince(tab, now) };
  if (!activity?.state) return { status: null, since: null };
  const age = typeof activity.at === "number" ? now - activity.at : null;
  if (age !== null && age > ACTIVITY_STALE_MS && activity.state === "working") {
    return { status: "idle", since: age };
  }
  return { status: activity.state, since: age };
}
