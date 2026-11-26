// Unit tests for Ranch sidebar reopenIndex helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { reopenIndex } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

test("reopenIndex returns 1 when the reopened key is at the front of order", () => {
  assert.equal(reopenIndex(["a", "b", "c"], "a", ["b", "c"]), 1);
  assert.equal(reopenIndex(["a", "b"], "a", ["b"]), 1);
});

test("reopenIndex in the middle counts only live keys that appear before key in order", () => {
  assert.equal(reopenIndex(["a", "b", "c", "d"], "c", ["a", "d"]), 2);
  assert.equal(reopenIndex(["a", "b", "c", "d", "e"], "d", ["a", "c", "e"]), 3);
  assert.equal(reopenIndex(["a", "b", "c", "d"], "c", ["d"]), 1);
});

test("reopenIndex returns null when key is not in order", () => {
  assert.equal(reopenIndex(["a", "b"], "c", ["a", "b"]), null);
  assert.equal(reopenIndex([], "a", ["b"]), null);
  assert.equal(reopenIndex(null, "a", ["b"]), null);
});

test("reopenIndex returns 1 when liveKeys is empty", () => {
  assert.equal(reopenIndex(["a", "b", "c"], "b", []), 1);
  assert.equal(reopenIndex(["a", "b", "c"], "c", []), 1);
  assert.equal(reopenIndex(["a", "b", "c"], "b", null), 1);
});

test("reopenIndex does not mutate input arrays", () => {
  const order = Object.freeze(["a", "b", "c", "d"]);
  const live = Object.freeze(["a", "d"]);
  assert.equal(reopenIndex(order, "c", live), 2);
});
