// Unit tests for lib/diff.js (shared unified-diff helpers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { diffRows, hunkLines, addedLines, diffStats, diffArgs, countLines, untab, MAX_LINES } = await import(
  pathToFileURL(join(root, "lib/diff.js")).href
);

test("diffRows: numbers old and new lines from each hunk header", () => {
  const rows = diffRows(["@@ -3,2 +3,3 @@", " a", "-b", "+c", "+d"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.number ?? null]), [["@", null], [" ", 3], ["-", 4], ["+", 4], ["+", 5]]);
});

test("hunkLines: drops the file header, notes an empty diff, caps the length", () => {
  assert.deepEqual(hunkLines("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"), ["@@ -1 +1 @@", "-a", "+b"]);
  assert.deepEqual(hunkLines("", "Nothing"), ["Nothing"]);
  assert.equal(hunkLines("@@ -1 +1 @@\n" + "+x\n".repeat(MAX_LINES + 50)).length, MAX_LINES);
});

test("addedLines: an untracked file as one all-added hunk", () => {
  assert.deepEqual(addedLines("a\nb\n"), ["@@ -0,0 +1,2 @@", "+a", "+b"]);
});

test("diffStats counts added and removed rows only", () => {
  assert.deepEqual(diffStats(diffRows(["@@ -1,2 +1,2 @@", " k", "-a", "+b", "+c"])), { add: 2, del: 1 });
});

test("diffArgs: staged uses --cached; the path follows --", () => {
  assert.deepEqual(diffArgs("staged", "a b.js").slice(0, 2), ["diff", "--cached"]);
  assert.equal(diffArgs("unstaged", "x")[0], "diff");
  assert.deepEqual(diffArgs("unstaged", "x").slice(-2), ["--", "x"]);
});

test("countLines and untab", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(untab("a\tb"), "a   b");
});
