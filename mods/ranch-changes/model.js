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
