// Unit tests for Ranch sidebar dormantPrimary helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { dormantPrimary } =
  await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

test("dormantPrimary returns git:true with branch and folder name for a main-only scan", () => {
  const scanned = [
    { path: "/r/app", branch: "main", detached: false, bare: false, prunable: false, main: true },
  ];
  assert.deepEqual(dormantPrimary(scanned, "/r/app"), {
    path: "/r/app",
    branch: "main",
    detached: false,
    name: "app",
    git: true,
  });
});

test("dormantPrimary prefers the kept folder path when present and falls back to entry path when falsy", () => {
  const scanned = [
    { path: "/real/r/app", branch: "dev", detached: false, bare: false, prunable: false, main: true },
  ];
  assert.deepEqual(dormantPrimary(scanned, "/link/my-app"), {
    path: "/link/my-app",
    branch: "dev",
    detached: false,
    name: "my-app",
    git: true,
  });
  assert.deepEqual(dormantPrimary(scanned, null), {
    path: "/real/r/app",
    branch: "dev",
    detached: false,
    name: "app",
    git: true,
  });
  assert.deepEqual(dormantPrimary(scanned, ""), {
    path: "/real/r/app",
    branch: "dev",
    detached: false,
    name: "app",
    git: true,
  });
});

test("dormantPrimary picks only the main entry from a scan with main and linked worktrees", () => {
  const scanned = [
    { path: "/r/app-feat", branch: "feat", detached: false, bare: false, prunable: false, main: false },
    { path: "/r/app", branch: "main", detached: false, bare: false, prunable: false, main: true },
    { path: "/r/app-fix", branch: "fix", detached: false, bare: false, prunable: false, main: false },
  ];
  assert.deepEqual(dormantPrimary(scanned, "/r/app"), {
    path: "/r/app",
    branch: "main",
    detached: false,
    name: "app",
    git: true,
  });
});

test("dormantPrimary handles a detached main checkout", () => {
  const scanned = [
    { path: "/r/app", branch: null, detached: true, bare: false, prunable: false, main: true },
  ];
  assert.deepEqual(dormantPrimary(scanned, "/r/app"), {
    path: "/r/app",
    branch: null,
    detached: true,
    name: "app",
    git: true,
  });
});

test("dormantPrimary returns git:false with folder name for null, empty, or no-main scans", () => {
  const expected = {
    path: "/r/notes",
    branch: null,
    detached: false,
    name: "notes",
    git: false,
  };
  assert.deepEqual(dormantPrimary(null, "/r/notes"), expected);
  assert.deepEqual(dormantPrimary(undefined, "/r/notes"), expected);
  assert.deepEqual(dormantPrimary([], "/r/notes"), expected);
  assert.deepEqual(
    dormantPrimary(
      [{ path: "/r/wt", branch: "feat", detached: false, bare: false, prunable: false, main: false }],
      "/r/notes",
    ),
    expected,
  );
  assert.deepEqual(dormantPrimary([], "/"), {
    path: "/",
    branch: null,
    detached: false,
    name: "/",
    git: false,
  });
});

test("dormantPrimary returns null when folder is falsy and there is no main entry", () => {
  assert.equal(dormantPrimary(null, null), null);
  assert.equal(dormantPrimary(null, ""), null);
  assert.equal(dormantPrimary([], undefined), null);
  assert.equal(
    dormantPrimary(
      [{ path: "/r/wt", branch: "feat", detached: false, bare: false, prunable: false, main: false }],
      "",
    ),
    null,
  );
});

test("dormantPrimary does not mutate input array or entries", () => {
  const entry = Object.freeze({
    path: "/r/app",
    branch: "main",
    detached: false,
    bare: false,
    prunable: false,
    main: true,
  });
  const linked = Object.freeze({
    path: "/r/app-wt",
    branch: "feat",
    detached: false,
    bare: false,
    prunable: false,
    main: false,
  });
  const scanned = Object.freeze([entry, linked]);
  const res = dormantPrimary(scanned, "/r/app");
  assert.deepEqual(res, {
    path: "/r/app",
    branch: "main",
    detached: false,
    name: "app",
    git: true,
  });
  assert.equal(scanned.length, 2);
});
