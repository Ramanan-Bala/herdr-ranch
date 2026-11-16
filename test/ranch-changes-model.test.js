// Unit tests for mods/ranch-changes/model.js (pure helpers only).
// Regression tests for the audit fix: a context switch while a git read is in
// flight must never show the old workspace's files/diff/root/message, and the
// newer context's read must start as soon as the older one settles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const {
  requestGate,
  headerLabel,
  STATUS_ARGS,
  parseStatusV2,
  parseBranches,
  STASH_FORMAT,
  parseStashList,
  commitPlan,
  branchNameError,
  fileActions,
  actionArgs,
} = await import(pathToFileURL(join(root, "mods/ranch-changes/model.js")).href);

test("requestGate: starts the first request with token 1", () => {
  const gate = requestGate();
  assert.deepEqual(gate.plan("A"), { action: "start", token: 1, context: "A" });
});

test("requestGate: refresh while the same context is loading waits, no new token", () => {
  const gate = requestGate();
  gate.plan("A");
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
});

test("hold A open, switch to B: B is queued, A's result is rejected, B starts immediately", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  assert.equal(a.action, "start");
  // Context switches to B while A's read is in flight.
  assert.deepEqual(gate.plan("B"), { action: "queue", token: 1, context: "B" });
  // A's read finishes but the focused context is now B: nothing applies.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
  // The pending read starts right away (not on the 10s timer).
  assert.deepEqual(gate.plan("B"), { action: "start", token: 2, context: "B" });
  assert.deepEqual(gate.settle(2, "B"), { apply: true, restart: false });
});

test("an old completion must not clear a newer request's loading state", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  gate.plan("B"); // queued
  gate.settle(a.token, "B"); // A settles, B restarts
  const b = gate.plan("B");
  assert.equal(b.token, 2);
  // A duplicate/late completion for token 1 arrives after token 2 started.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: false });
  assert.deepEqual(gate.settle(b.token, "B"), { apply: true, restart: false });
});

test("rapid A->B->A: only the final A request's result is applied", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  assert.equal(gate.plan("B").action, "queue");
  // Back to A while A is still in flight: the queued B is dropped.
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
  assert.deepEqual(gate.settle(a.token, "A"), { apply: true, restart: false });
});

test("a duplicate stale completion after a newer request started is a no-op", () => {
  const gate = requestGate();
  const a = gate.plan("A"); // token 1, in flight
  gate.plan("B"); // queued
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
  const b = gate.plan("B"); // token 2 starts immediately
  assert.equal(b.action, "start");
  // A late duplicate completion for token 1 must not apply or restart anything.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: false });
});

test("commit in progress: the new context is queued and starts when the commit settles", () => {
  const gate = requestGate();
  assert.deepEqual(gate.plan("A", true), { action: "queue", token: null, context: "A" });
  assert.deepEqual(gate.plan("B", true), { action: "queue", token: null, context: "B" });
  // Commit finishes; the next refresh starts the queued context immediately.
  assert.deepEqual(gate.plan("B", false), { action: "start", token: 1, context: "B" });
});

test("commit settling lets the very next refresh start a read", () => {
  const gate = requestGate();
  gate.plan("A", true); // busy: queued
  gate.plan("A", false); // busy over: starts now, does not stay queued
  assert.deepEqual(gate.settle(1, "A"), { apply: true, restart: false });
});

test("headerLabel: folder name, machine only when remote", () => {
  assert.equal(headerLabel("/home/me/projects/ranch", null, "/home/me"), "ranch");
  assert.equal(headerLabel("/home/me/projects/ranch", "box1", "/home/me"), "ranch · box1");
  assert.equal(headerLabel(null, "box1", "/home/me"), null);
  assert.equal(headerLabel("/Volumes/disk/", null, "/home/me"), "disk");
});

test("a stale completion restarts even when no refresh queued the new context", async () => {
  const { requestGate } = await import(pathToFileURL(join(root, "mods/ranch-changes/model.js")).href);
  const gate = requestGate();
  const a = gate.plan("A");
  // Focus moved to B but no render called plan("B") yet.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
});

const record = (...fields) => fields.join("\0");
const space = (...fields) => fields.join(" ");

test("parseStatusV2: branch headers, both groups, spaces, conflict, untracked, ignored", () => {
  const text = [
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    space("1", "M.", "N...", "100644", "100644", "100644", "aaa", "bbb", "dir/only staged.js"),
    space("1", ".M", "N...", "100644", "100644", "100644", "aaa", "bbb", "dir/only unstaged.txt"),
    space("1", "MM", "N...", "100644", "100644", "100644", "aaa", "bbb", "both.js"),
    space("u", "UU", "N...", "100644", "100644", "100644", "100644", "a1", "b1", "c1", "dir/conflict file.txt"),
    "? new file.txt",
    "! ignored.txt",
  ].join("\0") + "\0";
  assert.deepEqual(parseStatusV2(text), {
    branch: { head: "main", detached: false, upstream: "origin/main", ahead: 2, behind: 3 },
    staged: [
      { path: "both.js", status: "M" },
      { path: "dir/only staged.js", status: "M" },
    ],
    unstaged: [
      { path: "both.js", status: "M" },
      { path: "dir/only unstaged.txt", status: "M" },
      { path: "new file.txt", status: "A", fresh: true },
    ],
    conflicts: [{ path: "dir/conflict file.txt", status: "U" }],
    limited: false,
  });
});

test("parseStatusV2: detached head and missing ab header", () => {
  const status = parseStatusV2("# branch.head (detached)\0");
  assert.deepEqual(status.branch, {
    head: null,
    detached: true,
    upstream: null,
    ahead: 0,
    behind: 0,
  });
  assert.deepEqual(parseStatusV2("").branch, {
    head: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
  });
});

test("parseBranches: current first, locals then remotes by time, origin/HEAD and tracked remotes hidden", () => {
  const text = [
    record("refs/heads/main", "*", "origin/main", "1700000100"),
    record("refs/heads/feat", " ", "", "1700000200"),
    record("refs/remotes/origin/HEAD", " ", "", "0"),
    record("refs/remotes/origin/main", " ", "", "1700000300"),
    record("refs/remotes/origin/feat", " ", "", "1700000400"),
  ].join("\n");
  assert.deepEqual(parseBranches(text), [
    { name: "main", current: true, upstream: "origin/main", remote: false, time: 1700000100000 },
    { name: "feat", current: false, upstream: null, remote: false, time: 1700000200000 },
    { name: "origin/feat", current: false, upstream: null, remote: true, time: 1700000400000 },
  ]);
});

test("parseStashList: parses ref, message and time and strips the WIP/On prefix", () => {
  assert.equal(STASH_FORMAT, "%gd%x00%gs%x00%ct");
  const text = [
    record("stash@{0}", "WIP on main: abc123 fix bug", "1700000100"),
    record("stash@{1}", "On feature/x: wip", "1700000000"),
  ].join("\n");
  assert.deepEqual(parseStashList(text), [
    { ref: "stash@{0}", message: "abc123 fix bug", time: 1700000100000 },
    { ref: "stash@{1}", message: "wip", time: 1700000000000 },
  ]);
  assert.deepEqual(parseStashList(""), []);
});

test("commitPlan: every branch", () => {
  const staged = [{ path: "a.txt" }];
  const unstaged = [{ path: "b.txt" }];
  assert.equal(commitPlan({ message: "  ", amend: false, staged: [], unstaged: [] }), null);
  assert.deepEqual(commitPlan({ message: "  fix  ", amend: false, staged, unstaged }), [
    ["commit", "-m", "fix"],
  ]);
  assert.deepEqual(commitPlan({ message: "fix", amend: true, staged, unstaged }), [
    ["commit", "--amend", "-m", "fix"],
  ]);
  assert.deepEqual(commitPlan({ message: "", amend: true, staged, unstaged: [] }), [
    ["commit", "--amend", "--no-edit"],
  ]);
  assert.deepEqual(commitPlan({ message: "fix", amend: false, staged: [], unstaged }), [
    ["add", "-A"],
    ["commit", "-m", "fix"],
  ]);
  assert.deepEqual(commitPlan({ message: " ", amend: true, staged: [], unstaged }), [
    ["add", "-A"],
    ["commit", "--amend", "--no-edit"],
  ]);
  assert.deepEqual(commitPlan({ message: "fix", amend: true, staged: [], unstaged: [] }), [
    ["commit", "--amend", "-m", "fix"],
  ]);
  assert.deepEqual(commitPlan({ message: "", amend: true, staged: [], unstaged: [] }), [
    ["commit", "--amend", "--no-edit"],
  ]);
  assert.equal(commitPlan({ message: "fix", amend: false, staged: [], unstaged: [] }), null);
});

test("branchNameError: accepts normal names, rejects the obvious mistakes", () => {
  for (const name of ["main", "feature/x", "fix-1.2"]) {
    assert.equal(branchNameError(name), null, name);
  }
  for (const name of [
    "",
    "   ",
    "has space",
    "-dash",
    "/leading",
    "trailing/",
    "thing.lock",
    "trailing.",
    "a..b",
    "a@{b",
    "a//b",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a\u0001b",
  ]) {
    assert.ok(branchNameError(name), name);
  }
});

test("fileActions: per-group actions", () => {
  assert.deepEqual(fileActions("staged"), ["unstage"]);
  assert.deepEqual(fileActions("unstaged"), ["stage", "discard"]);
  assert.deepEqual(fileActions("conflicts"), ["stage"]);
  assert.deepEqual(fileActions("other"), []);
});

test("actionArgs: each action, including discard of a fresh untracked file", () => {
  assert.deepEqual(actionArgs("stage", { path: "a.txt" }), [["add", "--", "a.txt"]]);
  assert.deepEqual(actionArgs("unstage", { path: "a.txt" }), [
    ["restore", "--staged", "--", "a.txt"],
  ]);
  assert.deepEqual(actionArgs("discard", { path: "new file.txt", fresh: true }), [
    ["clean", "-f", "--", "new file.txt"],
  ]);
  assert.deepEqual(actionArgs("discard", { path: "a.txt" }), [
    ["restore", "--worktree", "--", "a.txt"],
  ]);
});

test("parseStatusV2: reads a real repo's staged, unstaged and untracked files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranch-status-"));
  try {
    const git = (...args) =>
      execFileSync(
        "git",
        ["-c", "user.name=Ranch Test", "-c", "user.email=test@example.com", ...args],
        { cwd: dir, encoding: "utf8" },
      );
    git("init");
    writeFileSync(join(dir, "tracked.txt"), "base\n");
    git("add", "tracked.txt");
    git("commit", "-m", "base");
    writeFileSync(join(dir, "tracked.txt"), "staged\n");
    git("add", "tracked.txt");
    writeFileSync(join(dir, "tracked.txt"), "unstaged\n");
    writeFileSync(join(dir, "untracked file.txt"), "new\n");
    const text = execFileSync("git", STATUS_ARGS, { cwd: dir, encoding: "utf8" });
    const status = parseStatusV2(text);
    assert.equal(status.branch.detached, false);
    assert.ok(status.branch.head);
    assert.deepEqual(status.staged, [{ path: "tracked.txt", status: "M" }]);
    assert.deepEqual(status.unstaged, [
      { path: "tracked.txt", status: "M" },
      { path: "untracked file.txt", status: "A", fresh: true },
    ]);
    assert.deepEqual(status.conflicts, []);
    assert.equal(status.limited, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
