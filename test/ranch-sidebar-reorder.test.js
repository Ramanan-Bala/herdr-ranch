// Unit tests for moveIndex (drag-and-drop reorder arithmetic) in
// mods/ranch-sidebar/model.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { moveIndex } = await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

test("moveIndex: drag down, after the target", () => {
  // a lands where c ends: [a,b,c] -> [b,c,a], a is now 3rd.
  assert.equal(moveIndex(["a", "b", "c"], "a", "c", "after"), 3);
});

test("moveIndex: drag down, before the target", () => {
  // [a,b,c] -> [b,a,c], a is now 2nd.
  assert.equal(moveIndex(["a", "b", "c"], "a", "c", "before"), 2);
});

test("moveIndex: drag up, after the target", () => {
  // [a,b,c] -> [a,c,b], c is now 2nd.
  assert.equal(moveIndex(["a", "b", "c"], "c", "a", "after"), 2);
});

test("moveIndex: drag up, before the target", () => {
  // [a,b,c] -> [a,c,b], c is now 2nd.
  assert.equal(moveIndex(["a", "b", "c"], "c", "b", "before"), 2);
});

test("moveIndex: first and last positions", () => {
  // Move to the very front (before the first).
  assert.equal(moveIndex(["a", "b", "c"], "c", "a", "before"), 1);
  // Move to the very end (after the last).
  assert.equal(moveIndex(["a", "b", "c"], "a", "c", "after"), 3);
});

test("moveIndex: missing ids return null", () => {
  assert.equal(moveIndex(["a", "b"], "x", "a", "before"), null);
  assert.equal(moveIndex(["a", "b"], "a", "x", "after"), null);
  assert.equal(moveIndex([], "a", "b", "before"), null);
});

test("moveIndex: dragging onto itself returns null", () => {
  assert.equal(moveIndex(["a", "b", "c"], "b", "b", "before"), null);
  assert.equal(moveIndex(["a", "b", "c"], "b", "b", "after"), null);
});
