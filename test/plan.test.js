// Tests for the `ranch-tasks plan` subcommand (adapters/plan.js + cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePlanArgs, planSummary } from "../adapters/plan.js";
import { parseStore } from "../lib/tasks.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "ranch-tasks");

// Temp dirs live in os.tmpdir() and are left for the OS to clean.
function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-plan-"));
}

/** Runs the CLI like the hooks do: RANCH_HOME at a temp dir, HC_TERMINAL_ID set. */
function run(args, input, home, terminal = "t1") {
  const env = { ...process.env, RANCH_HOME: home };
  if (terminal === null) delete env.HC_TERMINAL_ID;
  else env.HC_TERMINAL_ID = terminal;
  return spawnSync(process.execPath, [bin, ...args], { input: input ?? "", encoding: "utf8", env });
}

const tasksDir = (home) => join(home, ".herdr", "ranch", "tasks");

/** Every file under RANCH_HOME/.herdr, byte for byte — for no-write assertions. */
function snapshot(home) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${prefix}${e.name}/`);
      else out[`${prefix}${e.name}`] = readFileSync(p);
    }
  };
  try {
    walk(join(home, ".herdr"), "");
  } catch {
    // nothing written yet
  }
  return out;
}

// ------------------------------------------------------------- parsePlanArgs

test("parsePlanArgs maps all prefixes, keeps order and normalises titles", () => {
  const r = parsePlanArgs([
    "todo: a", "pending: b", "doing: c", "in_progress : d",
    "done: e", "completed: f", "skip: g", "cancelled: h",
  ]);
  assert.deepEqual(r.plan.map((t) => [t.status, t.step]), [
    ["pending", "a"], ["pending", "b"], ["in_progress", "c"], ["in_progress", "d"],
    ["completed", "e"], ["completed", "f"], ["cancelled", "g"], ["cancelled", "h"],
  ]);

  // case-insensitive prefix, colon inside the title kept, whitespace collapsed
  const r2 = parsePlanArgs(["DONE: ship: the: thing", "  doing  :\nmulti\nline\ttitle  "]);
  assert.deepEqual(r2.plan, [
    { step: "ship: the: thing", status: "completed" },
    { step: "multi line title", status: "in_progress" },
  ]);
});

test("parsePlanArgs rejects bad input without throwing", () => {
  // no args at all
  assert.equal(parsePlanArgs([]).ok, false);

  // missing colon names the argument number
  const noColon = parsePlanArgs(["done: fine", "no colon here"]);
  assert.equal(noColon.ok, false);
  assert.match(noColon.error, /2/);

  // unknown prefix lists the valid ones
  const unknown = parsePlanArgs(["wip: half done"]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /task 1/);
  assert.match(unknown.error, /todo/);
  assert.match(unknown.error, /doing/);
  assert.match(unknown.error, /done/);
  assert.match(unknown.error, /skip/);

  // empty title after normalising
  assert.equal(parsePlanArgs(["doing:   "]).ok, false);

  // title longer than 500 characters
  assert.equal(parsePlanArgs([`todo: ${"x".repeat(501)}`]).ok, false);

  // more than 50 tasks
  const many = Array.from({ length: 51 }, (_, i) => `todo: task ${i + 1}`);
  assert.equal(parsePlanArgs(many).ok, false);

  // a non-string argument
  const nonString = parsePlanArgs(["done: fine", 42]);
  assert.equal(nonString.ok, false);
  assert.match(nonString.error, /2/);
});

// --------------------------------------------------------------- planSummary

test("planSummary counts in display order and omits zeroes", () => {
  const plan = parsePlanArgs(["done: A", "doing: B", "todo: C"]).plan;
  assert.equal(planSummary(plan), "ranch: 3 tasks (1 doing, 1 done, 1 todo)");

  // singular wording for one task
  assert.equal(planSummary(parsePlanArgs(["done: A"]).plan), "ranch: 1 task (1 done)");

  // zero counts omitted, skip included last
  const mixed = parsePlanArgs(["skip: gone", "doing: now", "skip: gone too"]).plan;
  assert.equal(planSummary(mixed), "ranch: 3 tasks (1 doing, 2 skip)");
});

// ------------------------------------------------------------------ CLI e2e

test("ranch-tasks plan writes the session store after a codex SessionStart", () => {
  const home = tempHome();
  const started = run(["codex"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home);
  assert.equal(started.status, 0);

  const out = run(["plan", "done: A", "doing: B", "todo: C"], null, home);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /3 tasks/);

  const disk = parseStore(readFileSync(join(tasksDir(home), "sessions", "s1.json"), "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.tasks.map((t) => [t.id, t.status]), [
    ["1", "completed"], ["2", "in_progress"], ["3", "pending"],
  ]);
});

test("plan does not count as a missed turn", () => {
  const home = tempHome();
  run(["codex"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home);
  run(["codex"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", prompt: "go", session_id: "s1",
  }), home);
  assert.equal(run(["plan", "done: A", "doing: B"], null, home).status, 0);
  run(["codex"], JSON.stringify({
    hook_event_name: "Stop", session_id: "s1",
  }), home);
  const read = () => parseStore(readFileSync(join(tasksDir(home), "sessions", "s1.json"), "utf8")).store;
  assert.ok(!read().missed_turns || read().missed_turns === 0);
  // Control: a turn that does not run plan is counted, so the check above is meaningful.
  run(["codex"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "again", session_id: "s1" }), home);
  run(["codex"], JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }), home);
  assert.equal(read().missed_turns, 1);
});

test("plan refuses without HC_TERMINAL_ID and writes nothing", () => {
  const home = tempHome();
  run(["codex"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home, "seed");
  const before = snapshot(home);
  const out = run(["plan", "done: A"], null, home, null);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not inside Herdr/);
  assert.deepEqual(snapshot(home), before);
});

test("plan refuses a bad prefix and writes nothing", () => {
  const home = tempHome();
  run(["codex"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home);
  const before = snapshot(home);
  const out = run(["plan", "wip: A"], null, home);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /ranch:/);
  assert.deepEqual(snapshot(home), before);
});

test("plan refuses a Claude terminal and writes nothing", () => {
  const home = tempHome();
  run(["claude"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home);
  const before = snapshot(home);
  const out = run(["plan", "done: A"], null, home);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not running a Codex session/);
  assert.deepEqual(snapshot(home), before);
});

test("plan refuses a terminal with no pointer file and writes nothing", () => {
  const home = tempHome();
  const before = snapshot(home);
  const out = run(["plan", "done: A"], null, home);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /not running a Codex session/);
  assert.deepEqual(snapshot(home), before);
});

test("the old codex update_plan hook path still replaces tasks", () => {
  const home = tempHome();
  run(["codex"], JSON.stringify({
    hook_event_name: "SessionStart", source: "startup", session_id: "s1",
  }), home);
  const fixture = JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "codex-update-plan.json"), "utf8"));
  const out = run(["codex"], JSON.stringify({ ...fixture, session_id: "s1" }), home);
  assert.equal(out.status, 0);
  const disk = parseStore(readFileSync(join(tasksDir(home), "sessions", "s1.json"), "utf8"));
  assert.deepEqual(disk.store.tasks.map((t) => t.title), [
    "Survey the repo", "Patch the reducer", "Run the tests",
  ]);
});
