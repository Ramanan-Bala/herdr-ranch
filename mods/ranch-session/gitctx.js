// Pure per-context Git/PR cache for the Ranch session panel.
// No imports at all: every asynchronous result is filed under the exact
// context (machine|cwd|branch) that started it, and every view is derived
// only from the CURRENT context, so data for another machine/folder/branch
// can never be shown. `now` is always passed in; Date.now() is never read.

/** Contexts kept per cache (LRU bound). */
export const CACHE_MAX = 20;

/** Git reads running at once across contexts. */
export const GIT_INFLIGHT_MAX = 3;

/**
 * Stable key for a machine + folder pair (machine null = this computer).
 * @param {string|null} machine
 * @param {string|null} cwd
 * @returns {string}
 */
export function ctxKey(machine, cwd) {
  return `${machine ?? ""}|${cwd ?? ""}`;
}

/**
 * Set-with-recency: move key to newest, evict the oldest beyond max.
 * @template V
 * @param {Map<string, V>} map
 * @param {string} key
 * @param {V} value
 * @param {number} [max] bound (default CACHE_MAX)
 */
export function remember(map, key, value, max = CACHE_MAX) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

/**
 * A PR read is worth doing only for a feature branch on a known host
 * (the default branch has no PR, and no host means nothing to ask).
 * @param {{branch?: string|null, host?: object|null, default?: string}|null} summary git summary
 * @returns {boolean}
 */
export function prNeeded(summary) {
  return Boolean(summary?.branch && summary.host && summary.branch !== summary.default);
}

/**
 * Per-folder Git/PR state, one cache entry per machine|cwd context. All
 * methods are synchronous; async callers use begin/finish pairs whose ops
 * carry the context they belong to, so a late result never lands elsewhere.
 */
export class GitContexts {
  /**
   * @param {{max?: number, inflightMax?: number}} [opts]
   */
  constructor({ max = CACHE_MAX, inflightMax = GIT_INFLIGHT_MAX } = {}) {
    this.max = max;
    this.inflightMax = inflightMax;
    /** ctxKey -> { summary, details, top, at, checkedAt, failed } */
    this.git = new Map();
    /** prKey -> { parsed, failed, error, at } */
    this.prs = new Map();
    /** the selected context; gen bumps on every actual switch */
    this.current = { key: null, machine: null, cwd: null, gen: 0 };
    /** ctxKeys with a git read in flight / prKeys with a PR read in flight */
    this.gitBusy = new Set();
    this.prBusy = new Set();
    /** dirty flags for the CURRENT context (true = refresh it soon) */
    this.gitDirty = false;
    this.prDirty = false;
    /** the single push slot, bound to the context that started it */
    this.push = { id: 0, key: null, busy: false, err: null, at: 0 };
  }

  /**
   * Select a context; a switch always schedules a background refresh, even
   * on a cache hit.
   * @param {string|null} machine
   * @param {string|null} cwd
   * @returns {boolean} true when the context actually changed
   */
  select(machine, cwd) {
    const k = ctxKey(machine, cwd);
    if (k === this.current.key) return false;
    this.current = { key: k, machine: machine ?? null, cwd: cwd || null, gen: this.current.gen + 1 };
    this.gitDirty = true;
    this.prDirty = true;
    return true;
  }

  /** The current context's git entry, or null (never another context's). */
  gitEntry() {
    return this.current.cwd ? this.git.get(this.current.key) ?? null : null;
  }

  /** A summary is known for the current folder. */
  gitReady() {
    return Boolean(this.current.cwd) && this.git.has(this.current.key);
  }

  /** Ready but about to change (a read is running or a refresh is due). */
  gitUpdating() {
    return this.gitReady() && (this.gitBusy.has(this.current.key) || this.gitDirty);
  }

  /** Age of the current entry in ms, or null with no entry. */
  gitAge(now) {
    const e = this.gitEntry();
    return e ? now - e.at : null;
  }

  /**
   * Whether a background git read for the current context should start now.
   * @param {number} now
   * @param {number} everyMs re-read every this many ms
   */
  shouldRefreshGit(now, everyMs) {
    if (!this.current.cwd || this.gitBusy.has(this.current.key)) return false;
    if (this.gitBusy.size >= this.inflightMax) return false;
    if (this.gitDirty) return true;
    const e = this.git.get(this.current.key);
    return !e || now - Math.max(e.at, e.checkedAt ?? 0) >= everyMs;
  }

  /** Start a git read for the current context; the op is frozen and bound. */
  beginGit() {
    if (!this.current.cwd || this.gitBusy.has(this.current.key) || this.gitBusy.size >= this.inflightMax) return null;
    this.gitBusy.add(this.current.key);
    this.gitDirty = false;
    return Object.freeze({
      key: this.current.key,
      machine: this.current.machine,
      cwd: this.current.cwd,
      gen: this.current.gen,
    });
  }

  /**
   * File a finished git read under op.key (never the current context).
   * @param {{key: string}} op a beginGit() op
   * @param {{status: "ok"|"not-repo"|"failed", summary: object|null, details: *}} result
   * @param {number} now
   * @returns {boolean} true when the result landed in the current context
   */
  finishGit(op, result, now) {
    this.gitBusy.delete(op.key);
    if (result?.status === "failed") {
      const prev = this.git.get(op.key);
      if (prev) remember(this.git, op.key, { ...prev, checkedAt: now }, this.max);
      else remember(this.git, op.key, { summary: null, details: null, top: null, at: now, checkedAt: now, failed: true }, this.max);
    } else {
      const summary = result?.summary ?? null;
      const details = result?.details ?? null;
      remember(this.git, op.key, { summary, details, top: summary?.top ?? null, at: now, checkedAt: now, failed: false }, this.max);
    }
    return op.key === this.current.key;
  }

  /** A repo change can move the branch, so the PR follows. */
  markGitDirty() {
    this.gitDirty = true;
    this.prDirty = true;
  }

  /** The current context's branch, or null with no summary. */
  branch() {
    return this.gitEntry()?.summary?.branch ?? null;
  }

  /** PR cache key: context + branch, so a branch change invalidates it. */
  prKey() {
    return `${this.current.key}|${this.branch() ?? ""}`;
  }

  /**
   * The current context+branch's PR entry: null while unknown, or a
   * synthetic ready entry when no PR applies (default branch / no host).
   */
  prEntry() {
    if (!this.gitReady()) return null;
    const entry = this.git.get(this.current.key);
    if (!prNeeded(entry.summary)) return { parsed: null, failed: false, error: null, at: entry.at };
    return this.prs.get(this.prKey()) ?? null;
  }

  /** A PR row can be drawn for the current context+branch. */
  prReady() {
    return this.prEntry() !== null;
  }

  /** Ready but about to change (a PR read is running or a refresh is due). */
  prUpdating() {
    return this.prReady() && prNeeded(this.gitEntry().summary) && (this.prBusy.has(this.prKey()) || this.prDirty);
  }

  /**
   * Whether a PR read for the current context+branch should start now.
   * @param {number} now
   * @param {number} everyMs re-read every this many ms
   */
  shouldRefreshPr(now, everyMs) {
    if (!this.gitReady() || !prNeeded(this.gitEntry().summary)) return false;
    if (this.prBusy.has(this.prKey())) return false;
    if (this.prDirty) return true;
    const e = this.prs.get(this.prKey());
    return !e || now - e.at >= everyMs;
  }

  /** Start a PR read for the current context+branch; the op is frozen. */
  beginPr() {
    if (!this.gitReady() || !prNeeded(this.gitEntry().summary) || this.prBusy.has(this.prKey())) return null;
    this.prBusy.add(this.prKey());
    this.prDirty = false;
    return Object.freeze({
      key: this.current.key,
      prKey: this.prKey(),
      machine: this.current.machine,
      cwd: this.current.cwd,
      branch: this.branch(),
      gen: this.current.gen,
    });
  }

  /**
   * File a finished PR read under op.prKey (never the current branch).
   * @param {{prKey: string}} op a beginPr() op
   * @param {{parsed: object|null, failed: boolean, error: string|null}} result
   * @param {number} now
   * @returns {boolean} true when the result landed in the current branch
   */
  finishPr(op, result, now) {
    this.prBusy.delete(op.prKey);
    remember(this.prs, op.prKey, { parsed: result?.parsed ?? null, failed: Boolean(result?.failed), error: result?.error ?? null, at: now }, this.max);
    return op.prKey === this.prKey();
  }

  /** Start the single push, bound to the current context. */
  beginPush() {
    if (this.push.busy || !this.gitReady()) return null;
    const summary = this.gitEntry().summary;
    if (!summary?.top || !summary.branch) return null;
    const id = this.push.id + 1;
    this.push = { id, key: this.current.key, busy: true, err: null, at: 0 };
    return Object.freeze({
      id,
      key: this.current.key,
      machine: this.current.machine,
      cwd: this.current.cwd,
      top: summary.top,
      branch: summary.branch,
      gen: this.current.gen,
    });
  }

  /**
   * File a finished push; an old completion never changes a newer push.
   * @param {{id: number, key: string}} op a beginPush() op
   * @param {{ok: boolean, err?: string|null}} result
   * @param {number} now
   * @returns {boolean} false when the op is stale
   */
  finishPush(op, result, now) {
    if (this.push.id !== op.id) return false;
    const good = Boolean(result?.ok);
    this.push = { id: op.id, key: op.key, busy: false, err: good ? null : result?.err || "Push failed", at: good ? now : 0 };
    if (op.key === this.current.key) this.markGitDirty();
    return true;
  }

  /**
   * Push state to show for the CURRENT context: another context's push
   * leaves this one inert (blocked) without showing the other's state.
   */
  pushView() {
    if (this.push.key === this.current.key) return { busy: this.push.busy, err: this.push.err, at: this.push.at, blocked: false };
    return { busy: false, err: null, at: 0, blocked: this.push.busy };
  }
}

/**
 * "as of 12s" freshness label for a card's header: under a minute in seconds,
 * under an hour in minutes, else in hours. Null when there is no age.
 * @param {number|null|undefined} ms
 * @returns {string|null}
 */
export function ageLabel(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60000) return `as of ${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `as of ${Math.floor(ms / 60000)}m`;
  return `as of ${Math.floor(ms / 3600000)}h`;
}
