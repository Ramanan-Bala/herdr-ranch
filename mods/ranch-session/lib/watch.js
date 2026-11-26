/**
 * Shared folder-watch loop management for Herdr mods.
 * Keeps AT MOST ONE watch loop per root, no matter how often callers
 * re-request it: re-adding a removed root while its wait is pending
 * reuses that pending loop. Pure ES module, no imports.
 */

/**
 * How often to re-read a folder whose watch is healthy: changes arrive through
 * the watch, so the periodic re-read is only a safety net (30 s without one).
 */
export const WATCHED_REREAD_MS = 120_000;

/**
 * @param {{ watch: (root: string) => Promise<any>,
 *           onChange: (root: string, paths: any) => (void|Promise<void>),
 *           sleep: (ms: number) => Promise<void>,
 *           errorDelayMs?: number }} opts
 *   `watch(root)` resolves with changed paths on the next change;
 *   `onChange(root, paths)` runs after each wake; `sleep(ms)` backs off
 *   after a failed watch; `errorDelayMs` is that backoff (default 5000).
 */
export function createWatchLoops({ watch, onChange, sleep, errorDelayMs = 5000 }) {
  const wanted = new Set();
  const live = new Set();
  const failing = new Set(); // roots whose last watch() threw (backing off)

  /** Plain async loop for one root; never rejects. */
  async function loop(root) {
    live.add(root);
    try {
      for (;;) {
        let paths;
        try {
          paths = await watch(root);
          failing.delete(root);
        } catch {
          failing.add(root);
          await sleep(errorDelayMs);
          if (!wanted.has(root)) break;
          continue;
        }
        if (!wanted.has(root)) break;
        try {
          await onChange(root, paths);
        } catch {}
        if (!wanted.has(root)) break;
      }
    } finally {
      live.delete(root);
      failing.delete(root);
    }
  }

  /** Start a loop for root unless one is already live. */
  function startIfIdle(root) {
    if (!root || live.has(root)) return;
    loop(root);
  }

  return {
    /**
     * Mark root wanted; start a loop if none is live.
     * @param {string} root
     */
    add(root) {
      if (!root) return;
      wanted.add(root);
      startIfIdle(root);
    },

    /**
     * Mark root unwanted; its loop exits on its next wake.
     * @param {string} root
     */
    remove(root) {
      if (!root) return;
      wanted.delete(root);
    },

    /**
     * Make wanted exactly the given roots, starting missing loops.
     * @param {Iterable<string>} roots
     */
    setWanted(roots) {
      wanted.clear();
      for (const root of roots ?? []) {
        if (root) wanted.add(root);
      }
      for (const root of wanted) startIfIdle(root);
    },

    /**
     * Copy of the wanted roots.
     * @returns {Set<string>}
     */
    wanted() {
      return new Set(wanted);
    },

    /**
     * True when root has a running loop whose watch is not failing: changes
     * there are seen as they happen, so periodic re-reads can be rare.
     * @param {string} root
     */
    healthy(root) {
      return live.has(root) && !failing.has(root);
    },

    /**
     * Copy of the roots with a running loop.
     * @returns {Set<string>}
     */
    live() {
      return new Set(live);
    },
  };
}
