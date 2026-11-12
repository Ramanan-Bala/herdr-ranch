import test from "node:test";
import assert from "node:assert/strict";
import { launchDecision } from "../lib/launch.js";

test("launchDecision: worktree off launches normally, whatever the probe says", () => {
  assert.equal(launchDecision({ worktree: false, probe: "pending" }), "plain");
  assert.equal(launchDecision({ worktree: false, probe: "repo", homeOk: true }), "plain");
  assert.equal(launchDecision({ worktree: false, probe: "none" }), "plain");
});

test("launchDecision: Enter before the repo probe resolves waits", () => {
  assert.equal(launchDecision({ worktree: true, probe: "pending", homeOk: true }), "wait");
  assert.equal(launchDecision({ worktree: true }), "wait");
});

test("launchDecision: remembered worktree preference in a non-repo is an error", () => {
  assert.equal(launchDecision({ worktree: true, probe: "none" }), "error:no-repo");
  assert.equal(launchDecision({ worktree: true, probe: "error" }), "error:probe");
});

test("launchDecision: failed remote home probe is an error", () => {
  assert.equal(
    launchDecision({ worktree: true, probe: "repo", homeOk: false }),
    "error:home",
  );
});

test("launchDecision: repo probed and home reachable creates a worktree", () => {
  assert.equal(launchDecision({ worktree: true, probe: "repo", homeOk: true }), "worktree");
  // homeOk not yet known: main.js re-checks homeFor before creating anything.
  assert.equal(launchDecision({ worktree: true, probe: "repo" }), "worktree");
});
