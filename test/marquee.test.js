import { test } from "node:test";
import assert from "node:assert/strict";
import { Marquee, marqueeOffset, MARQUEE } from "../lib/marquee.js";

const o = { tickMs: 40, speed: 50, startPause: 500, endPause: 1000 };

test("marqueeOffset holds, scrolls, holds, repeats", () => {
  assert.equal(marqueeOffset(0, 100, o), 0);
  assert.equal(marqueeOffset(400, 100, o), 0);
  assert.equal(marqueeOffset(1500, 100, o), 50); // 1 s into the scroll
  assert.equal(marqueeOffset(2600, 100, o), 100); // end pause
  assert.equal(marqueeOffset(3500 + 200, 100, o), 0); // next cycle's start pause
});

test("marqueeOffset is 0 when the text fits", () => {
  assert.equal(marqueeOffset(5000, 0, o), 0);
  assert.equal(marqueeOffset(5000, -20, o), 0);
});

// A chainable stand-in for gpui-kit's div that records calls.
function fakeDiv() {
  const el = { calls: [] };
  return new Proxy(el, {
    get(target, p) {
      if (p === "calls") return target.calls;
      return (...args) => {
        target.calls.push([p, ...args]);
        return new Proxy(target, this);
      };
    },
  });
}

test("Marquee scrolls only a hovered name that overflows", () => {
  let now = 0;
  const m = new Marquee({ div: fakeDiv, now: () => now });
  assert.equal(m.tick(), false);
  assert.equal(m.hover("a", true), true);
  assert.equal(m.hover("a", true), false);
  assert.equal(m.tick(), false); // not measured yet
  m.measure("a", "box", 100);
  m.measure("a", "text", 180);
  assert.equal(m.overflow(), 80);
  assert.equal(m.tick(), true);
  now = MARQUEE.startPause + 1000;
  assert.equal(m.offset("a"), MARQUEE.speed);
  assert.equal(m.offset("b"), 0);
  assert.equal(m.hover("b", false), false);
  assert.equal(m.hover("a", false), true);
  assert.equal(m.tick(), false);
});

test("Marquee keeps sizes across hovers and ignores a name that fits", () => {
  const m = new Marquee({ div: fakeDiv, now: () => 0 });
  m.measure("a", "box", 100);
  m.measure("a", "text", 90);
  m.hover("a", true);
  assert.equal(m.tick(), false);
  m.hover("a", false);
  m.measure("a", "text", 140);
  m.hover("a", true);
  assert.equal(m.overflow(), 40);
});

test("Marquee.render: truncated off hover, clipped and shifted on hover", () => {
  const m = new Marquee({ div: fakeDiv, now: () => 0 });
  const idle = m.render("a", "long name", (el) => el.flex_1());
  assert.ok(idle.calls.some(([p]) => p === "truncate"));
  m.hover("a", true);
  const live = m.render("a", "long name", (el) => el.flex_1());
  assert.ok(live.calls.some(([p]) => p === "overflow_hidden"));
  assert.ok(live.calls.some(([p]) => p === "on_size_change"));
  const inner = live.calls.find(([p]) => p === "child")[1];
  assert.ok(inner.calls.some(([p]) => p === "whitespace_nowrap"));
  assert.ok(inner.calls.some(([p]) => p === "ml"));
});
