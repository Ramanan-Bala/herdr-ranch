import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, MAX_AGENTS, resolveSettings, withSetting } from "../lib/settings.js";

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

test("usage.show defaults to true and only takes booleans", () => {
  assert.equal(resolveSettings(undefined).usage.show, true);
  assert.equal(resolveSettings({ usage: { show: false } }).usage.show, false);
  assert.equal(resolveSettings({ usage: { show: "no" } }).usage.show, true);
});

test("withSetting sets nested paths without mutating", () => {
  const a = { naming: { enabled: true } };
  const b = withSetting(a, "naming.exitMode", "check");
  assert.deepEqual(a, { naming: { enabled: true } });
  assert.deepEqual(b, { naming: { enabled: true, exitMode: "check" } });
  assert.deepEqual(withSetting(undefined, "card.pr", false), { card: { pr: false } });
});

test("agents: duplicates dropped and capped at MAX_AGENTS", () => {
  const s = resolveSettings({ agents: ["claude", "codex", "claude", "opencode", "terminal", "gemini", "amp"] });
  assert.deepEqual(s.agents, ["claude", "codex", "opencode", "terminal"]);
  assert.equal(MAX_AGENTS, 4);
});
