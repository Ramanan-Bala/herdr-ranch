// Unit tests for Ranch sidebar worktree helpers: mainCheckoutOf and dormantWorktrees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { mainCheckoutOf, dormantWorktrees } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

// ---- mainCheckoutOf ----

test("mainCheckoutOf strips trailing .git on POSIX and Windows paths", () => {
  assert.equal(mainCheckoutOf("/r/app/.git"), "/r/app");
  assert.equal(mainCheckoutOf("/r/app/.git/"), "/r/app");
  assert.equal(mainCheckoutOf("/r/app/.git//"), "/r/app");
  assert.equal(mainCheckoutOf("C:\\r\\app\\.git"), "C:\\r\\app");
  assert.equal(mainCheckoutOf("C:\\r\\app\\.git\\"), "C:\\r\\app");
  assert.equal(mainCheckoutOf("/.git"), "/");
});

test("mainCheckoutOf strips only one trailing /.git", () => {
  assert.equal(mainCheckoutOf("/r/app/.git/.git"), "/r/app/.git");
});

test("mainCheckoutOf returns null for bare repos, non-.git paths, and junk input", () => {
  assert.equal(mainCheckoutOf("/r/app.git"), null);
  assert.equal(mainCheckoutOf("/r/app.git/"), null);
  assert.equal(mainCheckoutOf("/r/app/.git/worktrees/feat"), null);
  assert.equal(mainCheckoutOf("/r/app"), null);
  assert.equal(mainCheckoutOf(".git"), null);
  assert.equal(mainCheckoutOf(""), null);
  assert.equal(mainCheckoutOf(null), null);
  assert.equal(mainCheckoutOf(undefined), null);
  assert.equal(mainCheckoutOf(42), null);
  assert.equal(mainCheckoutOf({}), null);
});

// ---- dormantWorktrees ----

test("dormantWorktrees filters main, bare, and prunable entries", () => {
  const scanned = [
    { path: "/r/app", branch: "main", detached: false, bare: false, prunable: false, main: true },
    { path: "/r/bare.git", branch: null, detached: false, bare: true, prunable: false, main: false },
    { path: "/r/gone", branch: "old", detached: false, bare: false, prunable: true, main: false },
    { path: "/r/app-feat", branch: "feat", detached: false, bare: false, prunable: false, main: false },
    { path: "/r/app-det", branch: null, detached: true, bare: false, prunable: false, main: false },
  ];
  assert.deepEqual(dormantWorktrees(scanned, []), [
    { path: "/r/app-det", branch: null, detached: true, name: "app-det" },
    { path: "/r/app-feat", branch: "feat", detached: false, name: "app-feat" },
  ]);
});

test("dormantWorktrees excludes live tops regardless of trailing separators (Set or Array)", () => {
  const scanned = [
    { path: "/r/app", branch: "main", detached: false, bare: false, prunable: false, main: true },
    { path: "/r/wt-a/", branch: "a", detached: false, bare: false, prunable: false, main: false },
    { path: "/r/wt-b", branch: "b", detached: false, bare: false, prunable: false, main: false },
    { path: "/r/wt-c", branch: "c", detached: false, bare: false, prunable: false, main: false },
    { path: "C:\\r\\wt-win\\", branch: "w", detached: false, bare: false, prunable: false, main: false },
  ];
  assert.deepEqual(
    dormantWorktrees(scanned, new Set(["/r/wt-a", "/r/wt-b/", "C:\\r\\wt-win"])),
    [{ path: "/r/wt-c", branch: "c", detached: false, name: "wt-c" }],
  );
  assert.deepEqual(
    dormantWorktrees(scanned, ["/r/wt-a/", "/r/wt-b", "C:\\r\\wt-win\\"]),
    [{ path: "/r/wt-c", branch: "c", detached: false, name: "wt-c" }],
  );
});

test("dormantWorktrees sorts by path and extracts last segment as name", () => {
  const scanned = [
    { path: "/r/z-wt", branch: "z", detached: false, bare: false, prunable: false, main: false },
    { path: "/r/a-wt/", branch: "a", detached: false, bare: false, prunable: false, main: false },
    { path: "C:\\r\\m-wt", branch: "m", detached: false, bare: false, prunable: false, main: false },
  ];
  assert.deepEqual(dormantWorktrees(scanned, new Set()), [
    { path: "/r/a-wt/", branch: "a", detached: false, name: "a-wt" },
    { path: "/r/z-wt", branch: "z", detached: false, name: "z-wt" },
    { path: "C:\\r\\m-wt", branch: "m", detached: false, name: "m-wt" },
  ]);
});

test("dormantWorktrees handles null/undefined inputs without throwing or mutating", () => {
  assert.deepEqual(dormantWorktrees(null, null), []);
  assert.deepEqual(dormantWorktrees(undefined, undefined), []);

  const scanned = Object.freeze([
    Object.freeze({ path: "/r/wt-b", branch: "b", detached: false, bare: false, prunable: false, main: false }),
    Object.freeze({ path: "/r/wt-a", branch: "a", detached: false, bare: false, prunable: false, main: false }),
  ]);
  const live = ["/r/wt-b"];
  const liveBefore = [...live];
  const res = dormantWorktrees(scanned, live);
  assert.deepEqual(res, [{ path: "/r/wt-a", branch: "a", detached: false, name: "wt-a" }]);
  assert.deepEqual(live, liveBefore);
});
