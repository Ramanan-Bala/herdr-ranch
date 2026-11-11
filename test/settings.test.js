import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, resolveSettings, withSetting } from "../lib/settings.js";

test("resolveSettings fills defaults and ignores junk", () => {
  assert.deepEqual(resolveSettings(null), DEFAULTS);
  const s = resolveSettings({ naming: { exitMode: "revert", maxLen: "x", bogus: 1 }, agents: ["claude", 3], nope: true });
  assert.equal(s.naming.exitMode, "revert");
  assert.equal(s.naming.maxLen, 32);
  assert.equal(s.naming.bogus, undefined);
  assert.deepEqual(s.agents, ["claude"]);
  assert.equal(s.nope, undefined);
  assert.equal(s.refresh.prSec, 120);
});

test("withSetting sets nested paths without mutating", () => {
  const a = { naming: { enabled: true } };
  const b = withSetting(a, "naming.exitMode", "check");
  assert.deepEqual(a, { naming: { enabled: true } });
  assert.deepEqual(b, { naming: { enabled: true, exitMode: "check" } });
  assert.deepEqual(withSetting(undefined, "card.pr", false), { card: { pr: false } });
});
