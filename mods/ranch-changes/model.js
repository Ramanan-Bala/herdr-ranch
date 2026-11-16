// Pure helpers for the Ranch Git changes pane (audit fix: a context switch
// while a git read is in flight must never show the old workspace's data).
// Imports only ./lib/* so Node tests can run it without Herdr.

import { folderLabel } from "./lib/format.js";

/**
 * Serialises the pane's git reads and decides which one may talk to the pane.
 * Each read gets a monotonically increasing token; only the latest token's
 * completion applies results, and when an older read settles while a newer
 * context is queued, the queued read starts immediately (no 10s timer wait).
 *
 * The caller supplies the focused context on every call; the gate only sees
 * strings, so it stays pure.
 * @returns {{
 *   plan(context: string, busy?: boolean): {action: "start"|"queue"|"wait", token: number|null, context: string},
 *   settle(token: number, contextNow: string): {apply: boolean, restart: boolean},
 * }}
 */
export function requestGate() {
  let seq = 0;
  let flight = null; // { token, context } — the read that may still apply
  let pending = null; // { context } — a newer context waiting for the flight
  return {
    // What refresh() should do for this context right now. "start" returns a
    // fresh token; "queue"/"wait" return the in-flight token so the caller can
    // keep its loading state pointing at the read that will apply.
    plan(context, busy = false) {
      if (busy) {
        // A commit owns the pane; the read waits for its completion.
        if (pending?.context === context) return { action: "wait", token: null, context };
        pending = { context };
        return { action: "queue", token: null, context };
      }
      if (flight) {
        if (flight.context === context) {
          pending = null; // back to the in-flight context: drop the queue
          return { action: "wait", token: flight.token, context };
        }
        if (pending?.context !== context) pending = { context };
        return { action: "queue", token: flight.token, context };
      }
      pending = null;
      const token = ++seq;
      flight = { token, context };
      return { action: "start", token, context };
    },
    // A read returned. apply says whether its results belong to the currently
    // focused context; restart says a queued newer context should start now.
    settle(token, contextNow) {
      if (flight?.token !== token) return { apply: false, restart: false };
      const apply = flight.context === contextNow;
      flight = null;
      // Restart for a queued context, and also when focus moved without a
      // render queuing it: otherwise the pane would show loading until the
      // 10 s timer.
      const restart = pending !== null || !apply;
      pending = null;
      return { apply, restart };
    },
  };
}

/**
 * "repo" or "repo · machine" for the header pill; the machine name only shows
 * when the read runs on a remote machine. Null when nothing is displayed.
 * @param {string|null} root git toplevel the pane is displaying
 * @param {string|null} machine exec target ("on" from the pane's location)
 * @param {string|null} home local home directory (folderLabel's "~" case)
 * @returns {string|null}
 */
export function headerLabel(root, machine, home) {
  const folder = folderLabel(root, home);
  if (!folder) return null;
  return machine ? `${folder} · ${machine}` : folder;
}

/** `git status` arguments for parseStatusV2(). */
export const STATUS_ARGS = ["status", "--porcelain=v2", "-z", "--branch", "--no-renames", "--untracked-files=all"];

/** `git stash list` format for parseStashList(). */
export const STASH_FORMAT = "%gd%x00%gs%x00%ct";

/** status letter from a porcelain XY field. */
function statusLetter(letter) {
  if (letter === "A") return "A";
  if (letter === "D") return "D";
  return "M";
}

/** Text after `count` space-separated fields of a status record. */
function afterFields(record, count) {
  let index = 0;
  for (let i = 0; i < count; i += 1) {
    const space = record.indexOf(" ", index);
    if (space === -1) return null;
    index = space + 1;
  }
  return record.slice(index);
}

/** Sort by path and cap the list; returns the capped list and whether it was. */
function capList(list) {
  list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (list.length <= 1000) return { list, capped: false };
  return { list: list.slice(0, 1000), capped: true };
}

/**
 * Parse `git status --porcelain=v2 -z --branch` output (STATUS_ARGS).
 * Entries: `{ path, status: "A"|"M"|"D"|"U", fresh? }`; a partially staged
 * file appears in both staged and unstaged. Each list is sorted by path and
 * capped at 1000 entries (`limited` is true when a list was capped).
 * @param {string} text
 * @returns {{branch: {head: string|null, detached: boolean, upstream: string|null,
 *            ahead: number, behind: number},
 *            staged: Array<object>, unstaged: Array<object>, conflicts: Array<object>,
 *            limited: boolean}}
 */
export function parseStatusV2(text) {
  const branch = { head: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const conflicts = [];
  for (const record of String(text ?? "").split("\0")) {
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length);
      if (name === "(detached)") {
        branch.head = null;
        branch.detached = true;
      } else {
        branch.head = name || null;
      }
    } else if (record.startsWith("# branch.upstream ")) {
      branch.upstream = record.slice("# branch.upstream ".length) || null;
    } else if (record.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(record.slice("# branch.ab ".length));
      if (m) {
        branch.ahead = Number(m[1]);
        branch.behind = Number(m[2]);
      }
    } else if (record.startsWith("1 ")) {
      const xy = record.slice(2, 4);
      const path = afterFields(record, 8);
      if (!path) continue;
      if (xy[0] !== ".") staged.push({ path, status: statusLetter(xy[0]) });
      if (xy[1] !== ".") unstaged.push({ path, status: statusLetter(xy[1]) });
    } else if (record.startsWith("u ")) {
      const path = afterFields(record, 10);
      if (path) conflicts.push({ path, status: "U" });
    } else if (record.startsWith("? ")) {
      unstaged.push({ path: record.slice(2), status: "A", fresh: true });
    }
  }
  const stagedCap = capList(staged);
  const unstagedCap = capList(unstaged);
  const conflictsCap = capList(conflicts);
  return {
    branch,
    staged: stagedCap.list,
    unstaged: unstagedCap.list,
    conflicts: conflictsCap.list,
    limited: stagedCap.capped || unstagedCap.capped || conflictsCap.capped,
  };
}

/**
 * Parse `git for-each-ref --format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(committerdate:unix) refs/heads refs/remotes`
 * output (one ref per line, fields NUL-separated). Remote symbolic heads and
 * remote branches already tracked by a local branch are skipped. Current
 * branch first, then locals by time desc, then remotes by time desc.
 * @param {string} text
 * @returns {Array<{name: string, current: boolean, upstream: string|null,
 *            remote: boolean, time: number}>}
 */
export function parseBranches(text) {
  const locals = [];
  const remotes = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const [refname, head, upstream, date] = line.split("\0");
    if (!refname) continue;
    const remote = refname.startsWith("refs/remotes/");
    if (!remote && !refname.startsWith("refs/heads/")) continue;
    const name = remote
      ? refname.slice("refs/remotes/".length)
      : refname.slice("refs/heads/".length);
    if (remote && name.endsWith("/HEAD")) continue;
    const branch = {
      name,
      current: head === "*",
      upstream: upstream || null,
      remote,
      time: date ? Number(date) * 1000 : 0,
    };
    if (remote) remotes.push(branch);
    else locals.push(branch);
  }
  const tracked = new Set(locals.map((b) => b.upstream).filter(Boolean));
  const visibleRemotes = remotes.filter((b) => !tracked.has(b.name));
  const byTime = (a, b) => b.time - a.time;
  return [
    ...locals.filter((b) => b.current),
    ...locals.filter((b) => !b.current).sort(byTime),
    ...visibleRemotes.sort(byTime),
  ];
}

/**
 * Parse `git stash list --format=STASH_FORMAT` output (one stash per line).
 * A leading "WIP on <branch>: " or "On <branch>: " is stripped from message.
 * @param {string} text
 * @returns {Array<{ref: string, message: string, time: number}>}
 */
export function parseStashList(text) {
  const stashes = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line) continue;
    const [ref, message, date] = line.split("\0");
    if (!ref) continue;
    stashes.push({
      ref,
      message: (message ?? "").replace(/^(?:WIP on|On) .*?: /, ""),
      time: date ? Number(date) * 1000 : 0,
    });
  }
  return stashes;
}

/**
 * The git commands a commit needs, in order, or null when nothing can be
 * committed. Amend with no message uses --no-edit (when only committing the
 * amend itself, or when changes are added first).
 * @param {{message: string, amend: boolean, staged: Array, unstaged: Array}} state
 * @returns {string[][]|null}
 */
export function commitPlan({ message, amend, staged, unstaged }) {
  const msg = (message ?? "").trim();
  const hasStaged = (staged ?? []).length > 0;
  const hasUnstaged = (unstaged ?? []).length > 0;
  if (!msg && !amend) return null;
  const amendFlag = amend ? ["--amend"] : [];
  const messageArgs = msg ? ["-m", msg] : ["--no-edit"];
  if (hasStaged) return [["commit", ...amendFlag, ...messageArgs]];
  if (hasUnstaged) return [["add", "-A"], ["commit", ...amendFlag, ...messageArgs]];
  if (amend) return [["commit", "--amend", ...(msg ? ["-m", msg] : ["--no-edit"])]];
  return null;
}

/**
 * Why a branch name is unacceptable, or null when acceptable. Git has the
 * final word; this only catches the obvious mistakes early.
 * @param {string} name
 * @returns {string|null}
 */
export function branchNameError(name) {
  const value = String(name ?? "");
  if (!value.trim()) return "Enter a branch name";
  if (/\s/.test(value)) return "Branch names cannot contain spaces";
  if (value.startsWith("-")) return "Branch names cannot start with -";
  if (value.startsWith("/")) return "Branch names cannot start with /";
  if (value.endsWith("/")) return "Branch names cannot end with /";
  if (value.endsWith(".lock")) return "Branch names cannot end with .lock";
  if (value.endsWith(".")) return "Branch names cannot end with .";
  if (value.includes("..")) return "Branch names cannot contain ..";
  if (value.includes("@{")) return "Branch names cannot contain @{";
  if (value.includes("//")) return "Branch names cannot contain //";
  if (/[~^:?*[\\]/.test(value)) return "Branch names cannot contain ~ ^ : ? * [ or \\";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "Branch names cannot contain control characters";
  return null;
}

/**
 * Per-file actions the UI offers for a status group.
 * @param {"staged"|"unstaged"|"conflicts"|string} group
 * @returns {string[]}
 */
export function fileActions(group) {
  if (group === "staged") return ["unstage"];
  if (group === "unstaged") return ["stage", "discard"];
  if (group === "conflicts") return ["stage"];
  return [];
}

/**
 * Git arguments for a per-file action from fileActions(). Discarding an
 * untracked (fresh) file uses `clean -f`; anything else restores the worktree.
 * @param {"stage"|"unstage"|"discard"|string} action
 * @param {{path: string, fresh?: boolean}} entry
 * @returns {string[][]}
 */
export function actionArgs(action, entry) {
  const path = entry?.path ?? "";
  if (action === "stage") return [["add", "--", path]];
  if (action === "unstage") return [["restore", "--staged", "--", path]];
  if (action === "discard") {
    return [entry?.fresh ? ["clean", "-f", "--", path] : ["restore", "--worktree", "--", path]];
  }
  return [];
}
