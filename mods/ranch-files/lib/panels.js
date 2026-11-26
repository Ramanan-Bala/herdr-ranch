// Is a mod's layout block on screen? Herdr keeps every block's view alive, and
// a hidden copy keeps its timers (requirements.md "Performance"), so the
// right-hand panels use this to skip git/gh/process work nobody can see and
// catch up the moment they are shown again.
// Pure module (no herdr/gpui imports) so it can be copied into every mod
// (scripts/sync-lib.mjs) and tested in Node.

/**
 * True when a block showing `mod` (or, for layout nodes without a `content`
 * field, the block with id `id`) is visible: no ancestor is `hidden`, and
 * every stack on the way shows that branch (`active`, else its first child).
 * Several matching blocks: true if any is visible. No layout, or no matching
 * block (a layout Ranch doesn't know): true, so work is never skipped by
 * mistake.
 * @param {any} root  herdr layout() tree
 * @param {{id?: string, mod?: string}} which
 * @returns {boolean}
 */
export function blockShown(root, { id, mod } = {}) {
  if (!root || typeof root !== "object") return true;
  let found = false;
  let shown = false;
  const matches = (node) => {
    if (node?.type !== "block") return false;
    const m = node.content?.mod;
    if (typeof m === "string" && mod) return m === mod;
    return id != null && node.id === id;
  };
  const walk = (node, visible) => {
    if (!node || typeof node !== "object" || shown) return;
    const here = visible && node.hidden !== true;
    if (matches(node)) {
      found = true;
      if (here) shown = true;
      return;
    }
    const kids = Array.isArray(node.children) ? node.children : [];
    const active = node.type === "stack" ? node.active ?? kids[0]?.id : undefined;
    for (const child of kids) {
      walk(child, here && (node.type !== "stack" || child?.id === active));
    }
  };
  walk(root, true);
  return found ? shown : true;
}

/**
 * Tracks one panel's visibility across ticks so it can skip work while hidden
 * and catch up once on show.
 *   const vis = new PanelVisibility(() => blockShown(layout(), {...}));
 *   if (!vis.check()) return;     // hidden: skip
 *   if (vis.justShown) refresh(); // first tick after it was hidden
 */
export class PanelVisibility {
  /** @param {() => boolean} probe */
  constructor(probe) {
    this.probe = probe;
    this.shown = true; // unknown at start: act as before until the first check
    this.justShown = false;
    this.missed = false; // work was skipped while hidden
  }

  /** Re-reads visibility. Returns whether the panel is shown now. */
  check() {
    let now = true;
    try {
      now = this.probe() !== false;
    } catch {
      now = true;
    }
    this.justShown = now && !this.shown;
    this.shown = now;
    return now;
  }

  /** Records that hidden-time work was skipped; takeMissed() hands it back once. */
  skip() {
    this.missed = true;
  }

  /** True once after skip(): the caller should catch up now. */
  takeMissed() {
    const m = this.missed;
    this.missed = false;
    return m;
  }
}
