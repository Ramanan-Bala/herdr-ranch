import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeGrip, dragWidth, GRIP_SLACK } from "../lib/edge-grip.js";

test("dragWidth: right edge grows rightward, left edge grows leftward, clamped", () => {
  assert.equal(dragWidth({ side: "right", startW: 268, startX: 268, x: 300, min: 44, max: 480 }), 300);
  assert.equal(dragWidth({ side: "left", startW: 360, startX: 900, x: 850, min: 280, max: 640 }), 410);
  assert.equal(dragWidth({ side: "left", startW: 360, startX: 900, x: 1200, min: 280, max: 640 }), 280);
  assert.equal(dragWidth({ side: "right", startW: 268, startX: 0, x: 999, min: 44, max: 480 }), 480);
});

test("EdgeGrip: drag resizes with slack, release sends exact width and onEnd", () => {
  const calls = [];
  let ended = null;
  const g = new EdgeGrip({ id: "panel", side: "left", min: 280, max: 640, run: (c, a) => calls.push([c, a]), width: () => 360, onEnd: (px) => { ended = px; } });
  g.start({ position: { x: 900 } }, 360);
  assert.equal(g.active, true);
  g.move({ position: { x: 880 }, pressed_button: "left" });
  assert.deepEqual(calls.at(-1), ["layout.resize", { id: "panel", px: 380 + GRIP_SLACK }]);
  g.move({ position: { x: 880 }, pressed_button: "left" }); // same width: no extra resize
  assert.equal(calls.length, 1);
  g.end();
  assert.deepEqual(calls.at(-1), ["layout.resize", { id: "panel", px: 380 }]);
  assert.equal(ended, 380);
  assert.equal(g.active, false);
});

test("EdgeGrip: a move with the button up ends the drag (release off the mod)", () => {
  const calls = [];
  const g = new EdgeGrip({ id: "sidebar", side: "right", min: 44, max: 480, run: (c, a) => calls.push([c, a]), width: () => 268 });
  g.start({ position: { x: 268 } }, 268);
  g.move({ position: { x: 300 }, pressed_button: null });
  assert.equal(g.active, false);
  assert.equal(calls.length, 0); // never moved: nothing to send
});
