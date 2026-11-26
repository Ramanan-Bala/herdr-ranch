// Git summaries and PR lookups shared between mods (shared state), so the
// sidebar and the Session panel don't run the same git and gh calls for the
// same repo and branch. Whichever mod reads first publishes; the other uses
// that result when it is new enough for its own cadence, and reads itself
// otherwise. `at` is when the read STARTED: a result counts as newer than a
// change only if its read began after that change.
// Pure module (no herdr/gpui imports) so it can be copied into every mod
// (scripts/sync-lib.mjs) and tested in Node.

export const GIT_SHARE_KEY = "ranch.share.git";
export const PR_SHARE_KEY = "ranch.share.pr";

/** Entries older than this are dropped on the next write. */
export const SHARE_MAX_AGE_MS = 10 * 60_000;
/** At most this many entries per map (oldest dropped first). */
export const SHARE_MAX_ENTRIES = 200;

const k = (machine, path) => `${machine ?? ""}|${path ?? ""}`;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A copy of `map` without entries older than SHARE_MAX_AGE_MS, capped to SHARE_MAX_ENTRIES (newest kept). */
function pruned(map, now) {
  const rows = Object.entries(isObj(map) ? map : {}).filter(
    ([, e]) => isObj(e) && Number.isFinite(e.at) && now - e.at <= SHARE_MAX_AGE_MS,
  );
  rows.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(rows.slice(0, SHARE_MAX_ENTRIES));
}

/**
 * The share value with one repo summary added (read started at `at`).
 * Records `machine|cwd -> top` too, so a caller that only knows a folder
 * inside the repo can find it.
 * @param {any} value current shared(GIT_SHARE_KEY)
 * @param {string|null} machine
 * @param {string} cwd the folder the read ran in
 * @param {{top: string}} summary a repoSnapshot/repoSummary summary
 * @param {number} at
 * @param {number} [now]
 */
export function withGitSummary(value, machine, cwd, summary, at, now = at) {
  const cur = isObj(value) ? value : {};
  if (!summary?.top || !Number.isFinite(at)) return cur;
  const repos = pruned(cur.repos, now);
  const cwds = pruned(cur.cwds, now);
  const prev = repos[k(machine, summary.top)];
  if (!prev || prev.at <= at) repos[k(machine, summary.top)] = { summary, at };
  if (cwd) cwds[k(machine, cwd)] = { top: summary.top, at };
  return { repos: pruned(repos, now), cwds: pruned(cwds, now) };
}

/**
 * A shared summary for `cwd` (a repo top, or a folder some read mapped to
 * one) whose read started after `newerThan`, else null.
 * @returns {{summary: object, at: number}|null}
 */
export function sharedGitSummary(value, machine, cwd, newerThan) {
  if (!isObj(value) || !cwd) return null;
  const repos = isObj(value.repos) ? value.repos : {};
  const cwds = isObj(value.cwds) ? value.cwds : {};
  const top = repos[k(machine, cwd)] ? cwd : cwds[k(machine, cwd)]?.top;
  const entry = top ? repos[k(machine, top)] : null;
  if (!isObj(entry) || !isObj(entry.summary) || !Number.isFinite(entry.at)) return null;
  return entry.at > newerThan ? entry : null;
}

/** PR share key for a branch's own PR. */
export function prBranchKey(machine, top, branch) {
  return `${machine ?? ""}|${top ?? ""}|${branch ?? ""}`;
}

/** PR share key for a PR looked up by URL (recorded PRs). */
export function prUrlKey(url) {
  return `url:${url}`;
}

/**
 * The share value with one PR lookup added. `parsed` is parsePr()'s result,
 * or null for a definite "no pull request". Only successful lookups belong
 * here: a failure must not read as "no PR" in another mod.
 */
export function withPr(value, key, parsed, at, now = at) {
  const cur = pruned(value, now);
  if (!key || !Number.isFinite(at)) return cur;
  const prev = cur[key];
  if (!prev || prev.at <= at) cur[key] = { parsed: parsed ?? null, at };
  return pruned(cur, now);
}

/** A shared PR lookup started after `newerThan`, else undefined. */
export function sharedPr(value, key, newerThan) {
  const e = isObj(value) ? value[key] : undefined;
  if (!isObj(e) || !Number.isFinite(e.at) || !(e.at > newerThan)) return undefined;
  return { parsed: e.parsed ?? null, at: e.at };
}
