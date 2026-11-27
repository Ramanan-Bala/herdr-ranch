// Hover marquee for names that don't fit: while the pointer is over a row, its
// truncated name scrolls left to show the rest, pauses, and starts over. Off
// hover it is the plain ellipsis again.
// No imports: gpui-kit's div is passed in, so this file can be copied into
// every mod (scripts/sync-lib.sh) and its timing tested in Node.

/** Timing: redraw tick, scroll speed (px/s) and the pauses at each end (ms). */
export const MARQUEE = { tickMs: 40, speed: 45, startPause: 700, endPause: 1100 };

/**
 * How far (px, 0..overflow) the text is scrolled `elapsed` ms into a hover:
 * hold at the start, scroll at `speed`, hold at the end, repeat.
 * @param {number} elapsed
 * @param {number} overflow text width minus box width
 * @param {typeof MARQUEE} [o]
 * @returns {number}
 */
export function marqueeOffset(elapsed, overflow, o = MARQUEE) {
  if (!(overflow > 0) || !(elapsed > 0)) return 0;
  const run = (overflow / o.speed) * 1000;
  const t = elapsed % (o.startPause + run + o.endPause);
  if (t < o.startPause) return 0;
  if (t < o.startPause + run) return ((t - o.startPause) / 1000) * o.speed;
  return overflow;
}

export class Marquee {
  /**
   * @param {object} o
   * @param {Function} o.div   gpui-kit div
   * @param {() => number} [o.now]
   */
  constructor({ div, now = () => Date.now() }) {
    this.div = div;
    this.now = now;
    this.key = null; // the hovered name's key
    this.since = 0;
    // key -> {box, text} widths in px, measured by on_size_change. Kept across
    // hovers: GPUI only reports a size when it changes.
    this.sizes = new Map();
  }

  /**
   * Row hover in/out. Returns true when the view should redraw. Pass the
   * handler's `cx` to start the redraw loop (animate) on hover-in.
   */
  hover(key, isIn, cx) {
    if (isIn) {
      if (this.key === key) return false;
      this.key = key;
      this.since = this.now();
      this.animate(cx);
      return true;
    }
    if (this.key !== key) return false;
    this.key = null;
    return true;
  }

  /** Pixels the hovered name overflows its box (0 when it fits or is unknown). */
  overflow(key = this.key) {
    const s = key == null ? null : this.sizes.get(key);
    if (!s || !(s.box > 0) || !(s.text > 0)) return 0;
    const over = s.text - s.box;
    return over > 1 ? over : 0;
  }

  /**
   * Redraws every `tickMs` while a name is hovered, then stops: an idle view
   * (nothing hovered) never wakes. At most one loop runs per Marquee.
   * @param {any} cx  a gpui-kit context with spawn(); the loop's own cx sleeps
   */
  animate(cx) {
    if (this.running || this.key === null || typeof cx?.spawn !== "function") return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.key !== null) {
          await cx.sleep(MARQUEE.tickMs);
          if (this.tick()) cx.notify();
        }
      } finally {
        this.running = false;
      }
    });
  }

  /** True while a hovered name is scrolling (redraw needed). */
  tick() {
    return this.key !== null && this.overflow() > 0;
  }

  offset(key) {
    if (key !== this.key) return 0;
    return Math.round(marqueeOffset(this.now() - this.since, this.overflow(key)));
  }

  measure(key, field, width, cx) {
    if (!Number.isFinite(width)) return;
    const s = this.sizes.get(key) ?? { box: 0, text: 0 };
    if (s[field] === width) return;
    if (!this.sizes.has(key) && this.sizes.size > 300) this.sizes.clear();
    this.sizes.set(key, { ...s, [field]: width });
    if (key === this.key) cx?.notify();
  }

  /**
   * The name element. `box(el)` sizes the visible box (e.g. flex_1().min_w(0)
   * or max_w(320)); `style(el)` sets colour/weight on the text. Not hovered:
   * a truncated (ellipsis) div. Hovered: a clipping box around the unwrapped
   * text, shifted left by the current offset.
   * @param {string} key  unique per row
   * @param {string} text
   * @param {(el: any) => any} box
   * @param {(el: any) => any} [style]
   */
  render(key, text, box, style = (el) => el) {
    const div = this.div;
    const label = String(text ?? "");
    if (this.key !== key) return style(box(div().truncate())).child(label);
    const inner = style(div().id(`mq-text-${key}`).flex_none().whitespace_nowrap())
      .ml(-this.offset(key))
      .on_size_change((size, cx) => this.measure(key, "text", size.width, cx))
      .child(label);
    return box(div().id(`mq-box-${key}`).flex().overflow_hidden())
      .on_size_change((size, cx) => this.measure(key, "box", size.width, cx))
      .child(inner);
  }
}
