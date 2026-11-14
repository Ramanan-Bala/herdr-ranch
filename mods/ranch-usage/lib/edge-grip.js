// A drag-to-resize strip on one edge of a layout block, with a hover cue.
// Herdr's own divider has no hover style, so a mod draws this along the edge
// that touches the divider and resizes its layout node itself.
// No imports: the gpui-kit/herdr functions are passed in, so this file can be
// copied into every mod (scripts/sync-lib.sh) and its math tested in Node.

/** While dragging, the node is grown this far past the pointer so the pointer
 * stays over the (widened) grip: GPUI only reports moves over the element. */
export const GRIP_SLACK = 24;

/** The node width a drag asks for: pointer travel from the press, clamped.
 * side "right": the grip is on the node's right edge (dragging right grows it);
 * side "left": on its left edge (dragging left grows it). */
export function dragWidth({ side, startW, startX, x, min, max }) {
  const delta = side === "left" ? startX - x : x - startX;
  return Math.min(max, Math.max(min, Math.round(startW + delta)));
}

export class EdgeGrip {
  /**
   * @param {object} o
   * @param {string} o.id        layout node id to resize ("sidebar", "panel")
   * @param {"left"|"right"} o.side
   * @param {number} o.min
   * @param {number} o.max
   * @param {Function} o.div     gpui-kit div
   * @param {Function} o.theme   herdr theme
   * @param {Function} o.run     herdr run
   * @param {() => number} o.width  the node's current width in px
   * @param {(px: number) => void} [o.onEnd]  called with the final width
   */
  constructor(o) {
    Object.assign(this, o);
    this.drag = null; // { startX, startW, lastPx }
    this.hover = false;
  }

  get active() {
    return this.drag !== null;
  }

  /** Press on the grip. `width` is the node's current width in px. */
  start(e, width) {
    this.drag = { startX: e.position.x, startW: width, lastPx: null };
  }

  /** Mouse-move on the mod's root (and the grip): resize once per new width. */
  move(e, cx) {
    const d = this.drag;
    if (!d) return;
    // A move with the left button up means the release happened off the mod.
    if ("pressed_button" in e && String(e.pressed_button).toLowerCase() !== "left") {
      this.end(cx);
      return;
    }
    const px = dragWidth({ side: this.side, startW: d.startW, startX: d.startX, x: e.position.x, min: this.min, max: this.max });
    if (px === d.lastPx) return;
    d.lastPx = px;
    this.run("layout.resize", { id: this.id, px: Math.min(this.max, px + GRIP_SLACK) });
    cx?.notify();
  }

  /** Release (grip or root, whichever comes first), or the pointer left the mod. */
  end(cx) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    const px = d.lastPx ?? d.startW;
    if (d.lastPx !== null) this.run("layout.resize", { id: this.id, px });
    this.onEnd?.(px);
    cx?.notify();
  }

  /** The strip itself. `bg` is the block's background, so the idle line is invisible. */
  element(bg) {
    const t = this.theme();
    const lit = this.hover || this.active;
    const left = this.side === "left";
    const grip = this.div().id(`edge-grip-${this.id}`).absolute().top(0).bottom(0)
      .w(this.active ? GRIP_SLACK + 8 : 6)
      .cursor_col_resize()
      // The cue: a 2px line on the outer edge. Style-level hover is what
      // GPUI paints from the hit test itself; the flag covers the drag.
      .when(left, (e) => e.left(0).border_l(2))
      .when(!left, (e) => e.right(0).border_r(2))
      .border_color(lit ? t.accent : bg)
      .hover((s) => s.border_color(t.accent))
      .on_hover((isIn, cx) => {
        if (this.hover !== isIn) {
          this.hover = isIn;
          cx.notify();
        }
      })
      .on_mouse_move((e, cx) => {
        if (!this.hover && !this.drag) {
          this.hover = true;
          cx.notify();
        }
        this.move(e, cx);
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.start(e, this.width());
      })
      .on_mouse_up("left", (_e, cx) => this.end(cx));
    return grip;
  }

  /** Wraps a mod's whole body: the drag is followed on this frame (moves are
   * only reported over the mod), its width is measured, and the grip sits on top. */
  wrap(body, bg) {
    return this.div().id(`edge-wrap-${this.id}`).relative().size_full().min_h(0)
      .on_size_change((size) => { this.measured = size.width; })
      .on_mouse_move((e, cx) => this.move(e, cx))
      .on_mouse_up("left", (_e, cx) => this.end(cx))
      .on_hover((isIn, cx) => { if (!isIn) this.end(cx); })
      .child(body)
      .child(this.element(bg));
  }
}
