// Unit tests for the sidebar's own folder order (stableFolderOrder, moveKey,
// normalizeFolderNames).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { stableFolderOrder, moveKey, normalizeFolderNames } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

test("stableFolderOrder ignores Herdr reordering live spaces", () => {
  assert.deepEqual(stableFolderOrder(["a", "b", "c"], ["c", "a", "b"], []), ["a", "b", "c"]);
  assert.deepEqual(stableFolderOrder(["a", "k", "b"], ["b", "a"], ["k"]), ["a", "k", "b"]);
});

test("stableFolderOrder appends new live keys, then new kept keys", () => {
  assert.deepEqual(stableFolderOrder(["a"], ["x", "a", "y"], ["k"]), ["a", "x", "y", "k"]);
  assert.deepEqual(stableFolderOrder(null, ["a"], ["k"]), ["a", "k"]);
});

test("stableFolderOrder drops gone keys unless retained", () => {
  assert.deepEqual(stableFolderOrder(["a", "b", "c"], ["a"], ["c"]), ["a", "c"]);
  assert.deepEqual(stableFolderOrder(["a", "b", "c"], ["a"], ["c"], { retain: ["b"] }), ["a", "b", "c"]);
});

test("stableFolderOrder carries a renamed live key into its old slot", () => {
  const renames = new Map([["space:1", "|/r"]]);
  assert.deepEqual(stableFolderOrder(["a", "space:1", "b"], ["a", "|/r", "b"], [], { renames }), ["a", "|/r", "b"]);
});

test("stableFolderOrder keeps the existing slot when the renamed key already has one", () => {
  // A reopened kept folder: the transient space key lands on the kept slot.
  const renames = new Map([["space:9", "|/k"]]);
  assert.deepEqual(
    stableFolderOrder(["|/k", "a", "space:9"], ["a", "|/k"], [], { renames, retain: ["|/k"] }),
    ["|/k", "a"],
  );
});

test("stableFolderOrder does not rename a key another item still uses", () => {
  const renames = new Map([["|/r", "|/r2"]]);
  assert.deepEqual(stableFolderOrder(["|/r", "a"], ["|/r", "a", "|/r2"], [], { renames }), ["|/r", "a", "|/r2"]);
});

test("moveKey moves before or after the target", () => {
  assert.deepEqual(moveKey(["a", "b", "c"], "c", "a", "before"), ["c", "a", "b"]);
  assert.deepEqual(moveKey(["a", "b", "c"], "a", "c", "after"), ["b", "c", "a"]);
  assert.deepEqual(moveKey(["a", "b", "c"], "a", "b", "after"), ["b", "a", "c"]);
  assert.equal(moveKey(["a", "b"], "a", "a", "before"), null);
  assert.equal(moveKey(["a", "b"], "a", "z", "before"), null);
});

test("normalizeFolderNames keeps trimmed non-empty strings only", () => {
  assert.deepEqual(normalizeFolderNames({ a: " x ", b: "", c: 3, d: "y" }), { a: "x", d: "y" });
  assert.deepEqual(normalizeFolderNames(null), {});
  assert.deepEqual(normalizeFolderNames([1]), {});
});
