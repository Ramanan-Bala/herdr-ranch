// Unit tests for Ranch sidebar mergeFolderOrder helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { mergeFolderOrder } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

test("mergeFolderOrder with empty prev appends live keys then kept keys", () => {
  assert.deepEqual(mergeFolderOrder([], ["a", "b"], ["c", "d"]), ["a", "b", "c", "d"]);
  assert.deepEqual(mergeFolderOrder([], ["a", "b"], []), ["a", "b"]);
  assert.deepEqual(mergeFolderOrder([], [], ["c", "d"]), ["c", "d"]);
  assert.deepEqual(mergeFolderOrder([], [], []), []);
});

test("mergeFolderOrder keeps a live key in its slot when it becomes kept", () => {
  assert.deepEqual(mergeFolderOrder(["a", "b", "c"], ["a", "c"], ["b"]), ["a", "b", "c"]);
  assert.deepEqual(mergeFolderOrder(["a", "b", "c"], ["b", "c"], ["a"]), ["a", "b", "c"]);
  assert.deepEqual(mergeFolderOrder(["a", "b", "c"], ["a", "b"], ["c"]), ["a", "b", "c"]);
});

test("mergeFolderOrder preserves live reorder around a kept key in the middle", () => {
  assert.deepEqual(mergeFolderOrder(["a", "b", "c"], ["c", "a"], ["b"]), ["c", "b", "a"]);
  assert.deepEqual(
    mergeFolderOrder(["a", "b", "c", "d", "e"], ["e", "c", "a"], ["b", "d"]),
    ["e", "b", "c", "d", "a"],
  );
});

test("mergeFolderOrder appends new live keys after remembered slots", () => {
  assert.deepEqual(mergeFolderOrder(["a", "b"], ["a", "c"], ["b"]), ["a", "b", "c"]);
  assert.deepEqual(mergeFolderOrder(["a", "b"], ["c", "a"], ["b"]), ["c", "b", "a"]);
});

test("mergeFolderOrder appends new kept keys last in keptKeys order", () => {
  assert.deepEqual(mergeFolderOrder(["a", "b"], ["a"], ["b", "c", "d"]), ["a", "b", "c", "d"]);
  assert.deepEqual(mergeFolderOrder(["a", "b"], ["a", "e"], ["b", "c"]), ["a", "b", "e", "c"]);
});

test("mergeFolderOrder drops unknown keys and lists each current key once", () => {
  assert.deepEqual(mergeFolderOrder(["x", "a", "y", "b", "z"], ["a"], ["b"]), ["a", "b"]);
  assert.deepEqual(mergeFolderOrder(["x", "b"], ["a"], ["b"]), ["b", "a"]);
  assert.deepEqual(mergeFolderOrder(["a", "a", "b", "b"], ["a", "a"], ["b", "b", "a"]), ["a", "b"]);
});

test("mergeFolderOrder does not mutate input arrays", () => {
  const prev = Object.freeze(["a", "b", "c"]);
  const live = Object.freeze(["c", "a", "d"]);
  const kept = Object.freeze(["b", "e"]);
  const result = mergeFolderOrder(prev, live, kept);
  assert.deepEqual(result, ["c", "b", "a", "d", "e"]);
  assert.notEqual(result, prev);
  assert.notEqual(result, live);
  assert.notEqual(result, kept);
});

test("mergeFolderOrder treats null and undefined arguments as empty", () => {
  assert.deepEqual(mergeFolderOrder(null, null, null), []);
  assert.deepEqual(mergeFolderOrder(undefined, undefined, undefined), []);
  assert.deepEqual(mergeFolderOrder(null, ["a", "b"], null), ["a", "b"]);
  assert.deepEqual(mergeFolderOrder(null, null, ["c", "d"]), ["c", "d"]);
  assert.deepEqual(mergeFolderOrder(["a", "b"], null, ["b"]), ["b"]);
  assert.deepEqual(mergeFolderOrder(["a", "b"], ["b"], undefined), ["b"]);
});
