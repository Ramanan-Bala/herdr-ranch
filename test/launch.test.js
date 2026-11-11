import test from "node:test";
import assert from "node:assert/strict";
import { branchFromPrompt, worktreePath, launchOrder } from "../lib/launch.js";

test("branchFromPrompt from the spec examples", () => {
  assert.equal(branchFromPrompt("Fix the login redirect loop on Safari"), "agent/fix-login-redirect-loop-on");
  assert.equal(branchFromPrompt("please add #123 retries"), "agent/add-123-retries");
});

test("branchFromPrompt drops fillers and takes the first 5 meaningful words", () => {
  assert.equal(branchFromPrompt("I want to ship the new billing page"), "agent/ship-new-billing-page");
  assert.equal(branchFromPrompt("  Fix   the  bug  "), "agent/fix-bug");
});

test("branchFromPrompt caps at 40 chars with no trailing dash", () => {
  const b = branchFromPrompt("refactor the entire authentication and session handling pipeline");
  assert.ok(b.length <= 40, `too long: ${b}`);
  assert.ok(!b.endsWith("-"), `trailing dash: ${b}`);
  assert.ok(b.startsWith("agent/"));
});

test("branchFromPrompt of an empty prompt is agent/ + base36 timestamp", () => {
  assert.equal(branchFromPrompt("", 1_750_000_000_000), `agent/${(1_750_000_000_000).toString(36)}`);
  assert.equal(branchFromPrompt("   \n\t ", 42), `agent/${(42).toString(36)}`);
});

const KNOWN = [
  { key: "claude", name: "Claude", installed: true, agent: true },
  { key: "codex", name: "Codex", installed: false, agent: true },
  { key: "opencode", name: "OpenCode", installed: true, agent: true },
  { key: "editor", name: "Editor", installed: true, agent: false },
];

test("launchOrder follows settings order, drops terminal and uninstalled", () => {
  assert.deepEqual(
    launchOrder(["terminal", "codex", "opencode", "claude"], KNOWN),
    ["opencode", "claude"],
  );
});

test("launchOrder falls back to all installed agents when settings match none", () => {
  assert.deepEqual(launchOrder(["gemini", "terminal"], KNOWN), ["claude", "opencode"]);
});

test("launchOrder with empty inputs", () => {
  assert.deepEqual(launchOrder([], []), []);
  assert.deepEqual(launchOrder(undefined, KNOWN), ["claude", "opencode"]);
});

test("worktreePath follows the worktree mod convention", () => {
  assert.equal(
    worktreePath("/Users/me", "/Users/me/Projects/ranch", "agent/fix-login"),
    "/Users/me/.herdr/worktrees/ranch/agent-fix-login",
  );
  assert.equal(
    worktreePath("/home/me", "/home/me/proj/my app", "agent/weird branch/name!"),
    "/home/me/.herdr/worktrees/my app/agent-weird-branch-name",
  );
  assert.equal(
    worktreePath("C:\\Users\\me", "C:\\Users\\me\\repo", "agent/fix"),
    "C:\\Users\\me/.herdr/worktrees/repo/agent-fix",
  );
});
