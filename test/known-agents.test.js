import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_KEY, KNOWN_AT_KEY, knownAgentsDue, refreshKnownAgents } from "../lib/known-agents.js";

function store(init = {}) {
  const m = new Map(Object.entries(init));
  return { shared: (k) => m.get(k), setShared: (k, v) => m.set(k, v), m };
}

test("knownAgentsDue: due with no record, not due within maxAge", () => {
  const s = store();
  assert.equal(knownAgentsDue(s.shared, 1000, 60_000), true);
  s.setShared(KNOWN_AT_KEY, 1000);
  assert.equal(knownAgentsDue(s.shared, 30_000, 60_000), false);
  assert.equal(knownAgentsDue(s.shared, 61_001, 60_000), true);
  assert.equal(knownAgentsDue(s.shared, 2000, 0), true);
});

test("refreshKnownAgents asks once, shares the list, and skips while fresh", async () => {
  const s = store();
  let asks = 0;
  const knownAgents = async () => { asks++; return [{ key: "claude" }]; };
  const list = await refreshKnownAgents({ knownAgents, ...s, maxAge: 60_000, now: 1000 });
  assert.deepEqual(list, [{ key: "claude" }]);
  assert.deepEqual(s.m.get(KNOWN_KEY), [{ key: "claude" }]);
  assert.equal(await refreshKnownAgents({ knownAgents, ...s, maxAge: 60_000, now: 5000 }), null);
  assert.equal(asks, 1);
});

test("refreshKnownAgents: a concurrent caller sees the claim and does not ask again", async () => {
  const s = store();
  let asks = 0;
  let release;
  const knownAgents = () => { asks++; return new Promise((r) => { release = r; }); };
  const first = refreshKnownAgents({ knownAgents, ...s, maxAge: 60_000, now: 1000 });
  assert.equal(await refreshKnownAgents({ knownAgents, ...s, maxAge: 60_000, now: 1001 }), null);
  release([]);
  await first;
  assert.equal(asks, 1);
});

test("refreshKnownAgents: a failed ask releases the claim", async () => {
  const s = store();
  await assert.rejects(refreshKnownAgents({ knownAgents: async () => { throw new Error("x"); }, ...s, maxAge: 60_000, now: 1000 }));
  assert.equal(knownAgentsDue(s.shared, 1001, 60_000), true);
});
