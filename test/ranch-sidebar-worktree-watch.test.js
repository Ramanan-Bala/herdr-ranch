// Unit tests for touchesWorktrees: which watchFolder(.git) batches trigger an
// instant worktree rescan in the Ranch sidebar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { touchesWorktrees } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

const GIT = "/r/app/.git";

test("a path under .git/worktrees triggers a rescan", () => {
  assert.equal(touchesWorktrees(["/r/app/.git/worktrees/feat/HEAD"], GIT), true);
  assert.equal(touchesWorktrees(["/r/app/.git/worktrees/feat"], GIT), true);
  assert.equal(touchesWorktrees(["/r/app/.git/worktrees"], GIT), true);
});

test("the watched root itself (overflowed batch) triggers a rescan", () => {
  assert.equal(touchesWorktrees(["/r/app/.git"], GIT), true);
  assert.equal(touchesWorktrees(["/r/app/.git/"], "/r/app/.git/"), true);
});

test("other .git churn does not trigger a rescan", () => {
  assert.equal(touchesWorktrees([
    "/r/app/.git/index",
    "/r/app/.git/objects/ab/cdef",
    "/r/app/.git/refs/heads/main",
    "/r/app/.git/worktreesX/a",
  ], GIT), false);
});

test("any matching path in a mixed batch is enough", () => {
  assert.equal(touchesWorktrees(["/r/app/.git/index", "/r/app/.git/worktrees/x/gitdir"], GIT), true);
});

test("windows separators are normalised", () => {
  assert.equal(touchesWorktrees(["C:\\r\\app\\.git\\worktrees\\x"], "C:/r/app/.git"), true);
});

test("junk input is false, never throws", () => {
  assert.equal(touchesWorktrees(null, GIT), false);
  assert.equal(touchesWorktrees([], GIT), false);
  assert.equal(touchesWorktrees([null, 3, ""], GIT), false);
  assert.equal(touchesWorktrees(["/r/app/.git/worktrees/x"], ""), false);
  assert.equal(touchesWorktrees(["/r/app/.git/worktrees/x"], null), false);
});
