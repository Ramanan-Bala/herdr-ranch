// Unit tests for the Ranch sidebar integrity fixes (audit findings 12, 16, 19):
// corrupted folded state is normalized per key, repo-root negatives expire,
// and PR badges follow card.pr alone while line3 controls the diff stats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { normalizeCollapsed, topOfFresh, TOP_OF_RETRY_MS, cardRows } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

const NOW = Date.parse("2026-11-11T10:00:00Z");

// ---- finding 12: normalizeCollapsed ----

test("normalizeCollapsed returns all-empty maps for null, arrays and strings", () => {
  const empty = { m: {}, s: {}, w: {}, settled: {} };
  assert.deepEqual(normalizeCollapsed(null), empty);
  assert.deepEqual(normalizeCollapsed(["m"]), empty);
  assert.deepEqual(normalizeCollapsed("nope"), empty);
  assert.deepEqual(normalizeCollapsed(3), empty);
});

test("normalizeCollapsed replaces a wrong-shaped map with {} but keeps its neighbours", () => {
  assert.deepEqual(
    normalizeCollapsed({ m: null, s: { sp1: true }, w: { wt1: true }, settled: { "m:box": true } }),
    { m: {}, s: { sp1: true }, w: { wt1: true }, settled: { "m:box": true } });
  assert.deepEqual(
    normalizeCollapsed({ m: {}, s: { sp1: true }, w: [1], settled: "x" }),
    { m: {}, s: { sp1: true }, w: {}, settled: {} });
});

test("normalizeCollapsed drops unknown keys and keeps the four known maps", () => {
  assert.deepEqual(
    normalizeCollapsed({ m: { a: true }, junk: { b: true } }),
    { m: { a: true }, s: {}, w: {}, settled: {} });
});

// ---- finding 16: topOfFresh ----

test("topOfFresh: a missing entry needs discovery", () => {
  assert.equal(topOfFresh(undefined, NOW), false);
  assert.equal(topOfFresh(null, NOW), false);
});

test("topOfFresh: a positive result never expires", () => {
  assert.equal(topOfFresh({ top: "/repo", at: NOW - 10 * 60_000 }, NOW), true);
});

test("topOfFresh: a fresh negative is trusted inside the window", () => {
  assert.equal(topOfFresh({ top: null, at: NOW - 1000 }, NOW), true);
  assert.equal(topOfFresh({ top: null, at: NOW - TOP_OF_RETRY_MS + 1000 }, NOW), true);
});

test("topOfFresh: a negative older than the window is re-discovered", () => {
  assert.equal(topOfFresh({ top: null, at: NOW - TOP_OF_RETRY_MS }, NOW), false);
  assert.equal(topOfFresh({ top: null, at: NOW - TOP_OF_RETRY_MS - 1 }, NOW), false);
});

test("topOfFresh: timeout then success re-discovers after expiry and stays", () => {
  // A timeout records a negative result at t0.
  const at = NOW - TOP_OF_RETRY_MS - 5_000;
  // Inside the window nothing is re-discovered; after it, the entry is unknown.
  assert.equal(topOfFresh({ top: null, at }, NOW - (at + 1000)), true);
  assert.equal(topOfFresh({ top: null, at }, NOW), false);
  // A later discovery finds the repo: the positive result is kept forever.
  const hit = { top: "/repo", at: NOW };
  assert.equal(topOfFresh(hit, NOW + 60_000), true);
});

test("topOfFresh: a non-repo later becomes a repo after expiry", () => {
  const at = NOW - TOP_OF_RETRY_MS - 1_000;
  assert.equal(topOfFresh({ top: null, at }, NOW), false); // re-discover
  // The re-discovery answers positive: it is now trusted without expiry.
  assert.equal(topOfFresh({ top: "/repo", at: NOW }, NOW + 30_000), true);
});

// ---- finding 19: cardRows (all four line3 x pr combinations) ----

test("cardRows: line3 on + pr on shows each row when it has content", () => {
  assert.deepEqual(cardRows({ line3: true, pr: true, hasDiff: true, hasPr: true }),
    { stats: true, pr: true, row: true });
  assert.deepEqual(cardRows({ line3: true, pr: true, hasDiff: true, hasPr: false }),
    { stats: true, pr: false, row: true });
  assert.deepEqual(cardRows({ line3: true, pr: true, hasDiff: false, hasPr: true }),
    { stats: false, pr: true, row: true });
});

test("cardRows: line3 on + pr off keeps the diff stats and drops PR badges", () => {
  assert.deepEqual(cardRows({ line3: true, pr: false, hasDiff: true, hasPr: true }),
    { stats: true, pr: false, row: true });
  assert.deepEqual(cardRows({ line3: true, pr: false, hasDiff: false, hasPr: true }),
    { stats: false, pr: false, row: false });
});

test("cardRows: line3 off + pr on still shows PR badges, compact row", () => {
  assert.deepEqual(cardRows({ line3: false, pr: true, hasDiff: true, hasPr: true }),
    { stats: false, pr: true, row: true });
  assert.deepEqual(cardRows({ line3: false, pr: true, hasDiff: true, hasPr: false }),
    { stats: false, pr: false, row: false });
});

test("cardRows: line3 off + pr off shows nothing", () => {
  assert.deepEqual(cardRows({ line3: false, pr: false, hasDiff: true, hasPr: true }),
    { stats: false, pr: false, row: false });
});

test("cardRows: a grouped tab (no diff, no PR allowed) renders no line 3", () => {
  assert.deepEqual(cardRows({ line3: true, pr: true, hasDiff: false, hasPr: false }),
    { stats: false, pr: false, row: false });
});

test("cardRows: a worktree row keeps its stat gated on line3, badges on pr", () => {
  // Worktree row shape: stats iff line3 && stat, badges iff pr && present.
  assert.deepEqual(cardRows({ line3: true, pr: true, hasDiff: true, hasPr: true }),
    { stats: true, pr: true, row: true });
  assert.deepEqual(cardRows({ line3: false, pr: true, hasDiff: true, hasPr: false }),
    { stats: false, pr: false, row: false });
  assert.deepEqual(cardRows({ line3: false, pr: true, hasDiff: false, hasPr: true }),
    { stats: false, pr: true, row: true });
});
