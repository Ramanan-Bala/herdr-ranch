// Unit tests for mods/ranch-topbar/state.js (audit finding 12: corrupted
// persisted panel state must not break the top bar's layout controls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { readPanels } =
  await import(pathToFileURL(join(root, "mods/ranch-topbar/state.js")).href);

// Same list the top bar renders its panel toggles from.
const PANELS = ["session", "files", "changes", "settings"];

test("readPanels keeps a valid space -> known panel id map", () => {
  assert.deepEqual(
    readPanels(JSON.stringify({ sp1: "files", sp2: "session" }), PANELS),
    { sp1: "files", sp2: "session" });
});

test("readPanels drops entries whose value is not a known panel id", () => {
  assert.deepEqual(
    readPanels(JSON.stringify({ a: "files", b: "nope", c: 3, d: null }), PANELS),
    { a: "files" });
});

test("readPanels drops non-string values, even known ids", () => {
  assert.deepEqual(readPanels(JSON.stringify({ a: ["files"] }), PANELS), {});
});

test("readPanels returns {} for invalid JSON", () => {
  assert.deepEqual(readPanels("{oops", PANELS), {});
});

test("readPanels returns {} for null, arrays and plain strings", () => {
  assert.deepEqual(readPanels("null", PANELS), {});
  assert.deepEqual(readPanels('["files"]', PANELS), {});
  assert.deepEqual(readPanels('"files"', PANELS), {});
  assert.deepEqual(readPanels("undefined", PANELS), {});
});

test("readPanels treats missing text as empty", () => {
  assert.deepEqual(readPanels(null, PANELS), {});
  assert.deepEqual(readPanels(undefined, PANELS), {});
});
