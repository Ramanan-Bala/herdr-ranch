// End to end: the shared PR registry (~/.herdr/ranch/prs.json) must file a
// created PR under the checkout the PR actually belongs to (the checkout the
// gh command ran in, whose remotes contain the PR's repo), or not at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseStore } from "../lib/tasks.js";
import { parsePrRegistry } from "../lib/prs.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A bare-ish git checkout with one origin remote and one branch. */
function makeRepo(base, name, branch) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/o/${name}.git`], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: dir });
  return dir;
}

const topOf = (dir) => execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();

function readRegistry(home) {
  try {
    return parsePrRegistry(readFileSync(join(home, ".herdr", "ranch", "prs.json"), "utf8"));
  } catch {
    return parsePrRegistry(null);
  }
}

/** Runs the claude hook on one PostToolUse payload in its own temp home. */
function runHook(home, terminal, payload) {
  return spawnSync(process.execPath, [join(repoRoot, "bin", "ranch-tasks"), "claude"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: terminal, RANCH_REMIND: "0" },
  });
}

test("a created PR is filed under the checkout it belongs to", () => {
  const base = mkdtempSync(join(tmpdir(), "ranch-shared-prs-"));
  const repoA = makeRepo(base, "render", "dev"); // agent sits here
  const repoB = makeRepo(base, "profile-api", "fix/x"); // PR belongs here
  const topA = topOf(repoA);
  const topB = topOf(repoB);
  const cases = [];
  try {
    // (1) cd into B and create B's PR from A: filed under B|fix/x, not A.
    const home1 = mkdtempSync(join(tmpdir(), "ranch-shared-home-"));
    cases.push(home1);
    let r = runHook(home1, "t1", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      cwd: repoA,
      tool_input: { command: `cd ${repoB} && gh pr create --head fix/x --fill` },
      tool_response: "https://github.com/o/profile-api/pull/5\n",
    });
    assert.equal(r.status, 0, r.stderr);
    let reg = readRegistry(home1);
    assert.deepEqual(reg.entries[`${topB}|fix/x`]?.map((p) => p.url), ["https://github.com/o/profile-api/pull/5"]);
    assert.equal(reg.entries[`${topA}|dev`], undefined);

    // (2) -R another repo from A without cd: ownership unconfirmed -> the
    // registry says nothing, but the creating terminal's store still lists it.
    const home2 = mkdtempSync(join(tmpdir(), "ranch-shared-home-"));
    cases.push(home2);
    r = runHook(home2, "t2", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      cwd: repoA,
      tool_input: { command: "gh pr create -R o/profile-api --fill" },
      tool_response: "https://github.com/o/profile-api/pull/5\n",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readRegistry(home2).entries, {});
    const store = parseStore(readFileSync(join(home2, ".herdr", "ranch", "tasks", "terminals", "t2.json"), "utf8"));
    assert.equal(store.ok, true);
    assert.deepEqual(store.store.prs?.map((p) => p.url), ["https://github.com/o/profile-api/pull/5"]);

    // (3) A's own PR from A: filed under A|dev.
    const home3 = mkdtempSync(join(tmpdir(), "ranch-shared-home-"));
    cases.push(home3);
    r = runHook(home3, "t3", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      cwd: repoA,
      tool_input: { command: "gh pr create --fill" },
      tool_response: "https://github.com/o/render/pull/3\n",
    });
    assert.equal(r.status, 0, r.stderr);
    reg = readRegistry(home3);
    assert.deepEqual(reg.entries[`${topA}|dev`]?.map((p) => p.url), ["https://github.com/o/render/pull/3"]);

    // (4) tool_input.workdir points at B: filed under B|fix/x.
    const home4 = mkdtempSync(join(tmpdir(), "ranch-shared-home-"));
    cases.push(home4);
    r = runHook(home4, "t4", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      cwd: repoA,
      tool_input: { command: "gh pr create --fill", workdir: repoB },
      tool_response: "https://github.com/o/profile-api/pull/5\n",
    });
    assert.equal(r.status, 0, r.stderr);
    reg = readRegistry(home4);
    assert.deepEqual(reg.entries[`${topB}|fix/x`]?.map((p) => p.url), ["https://github.com/o/profile-api/pull/5"]);

    // (5) a failed create (gh's "already exists" error on stderr): no entry.
    const home5 = mkdtempSync(join(tmpdir(), "ranch-shared-home-"));
    cases.push(home5);
    r = runHook(home5, "t5", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      cwd: repoA,
      tool_input: { command: "gh pr create --fill" },
      tool_response: { stdout: "", stderr: 'a pull request for branch "dev" into branch "main" already exists:\nhttps://github.com/o/render/pull/3' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readRegistry(home5).entries, {});
    assert.equal(existsSync(join(home5, ".herdr", "ranch", "prs.json")), false);
  } finally {
    for (const dir of [base, ...cases]) rmSync(dir, { recursive: true, force: true });
  }
});
