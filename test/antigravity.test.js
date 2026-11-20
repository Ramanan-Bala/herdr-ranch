// Antigravity adapter tests: pure reducer (adapters/antigravity.js) and
// CLI hook integration (`ranch-tasks antigravity` in adapters/cli.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyStore, parseStore } from "../lib/tasks.js";
import { antigravityActivity, applyAntigravity } from "../adapters/antigravity.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repoRoot, "bin", "ranch-tasks");

function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-agy-"));
}

function runCli(args, input, home, terminal = "t1", extraEnv = {}) {
  const env = { ...process.env, RANCH_HOME: home, HOME: home, ...extraEnv };
  if (terminal === null) delete env.HC_TERMINAL_ID;
  else env.HC_TERMINAL_ID = terminal;
  return spawnSync(process.execPath, [bin, ...args], { input: input ?? "", encoding: "utf8", env });
}

const base = () => ({
  ...emptyStore("t1", "antigravity"),
  session: { id: "old", title: "Old", title_source: "user", first_prompt: "old prompt", state: "running" },
  tasks: [{ id: "1", title: "Keep", status: "pending", active_form: null }],
  subagents: [{ id: "sub-old", name: "old-sub", status: "running", started_at: null, ended_at: null }],
  missed_turns: 2,
  antigravity_task_md: "oldhash",
});

// ------------------------------------------------------------ reducer: session

test("antigravity SessionStart sets session.id and resets on different conversation", () => {
  const s1 = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "SessionStart",
    conversationId: "c1",
  });
  assert.equal(s1.session.id, "c1");
  assert.equal(s1.session.state, "running");
  assert.equal(s1.session.activity.state, "idle");

  const switched = applyAntigravity(base(), {
    hookEventName: "SessionStart",
    conversationId: "c2",
  });
  assert.equal(switched.session.id, "c2");
  assert.equal(switched.session.title, null);
  assert.equal(switched.session.title_source, null);
  assert.equal(switched.session.first_prompt, null);
  assert.equal(switched.missed_turns, 0);
  assert.deepEqual(switched.tasks, []);
  assert.deepEqual(switched.subagents, []);
  assert.equal(switched.antigravity_task_md, undefined);
});

test("antigravity /resume (conversationId change on PreInvocation) resets store", () => {
  const resumed = applyAntigravity(base(), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c-resumed",
    lastUserInput: "continue here",
  });
  assert.equal(resumed.session.id, "c-resumed");
  assert.equal(resumed.session.title, null);
  assert.equal(resumed.session.first_prompt, "continue here");
  assert.equal(resumed.missed_turns, 0);
  assert.deepEqual(resumed.tasks, []);
  assert.deepEqual(resumed.subagents, []);
  assert.equal(resumed.antigravity_task_md, undefined);
});

// ----------------------------------------------------------- reducer: subagent

test("antigravity subagent events do not switch session or change main activity, and finish on Stop", () => {
  let store = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "main-1",
    lastUserInput: "main prompt",
  });
  const mainActivity = store.session.activity;

  store = applyAntigravity(store, {
    hookEventName: "SessionStart",
    conversationId: "sub-1",
    parent_conversation_id: "main-1",
    session_title: "Research helper",
  });
  assert.equal(store.session.id, "main-1");
  assert.equal(store.session.first_prompt, "main prompt");
  assert.equal(store.session.activity, mainActivity);
  assert.equal(store.subagents.length, 1);
  assert.equal(store.subagents[0].id, "sub-1");
  assert.equal(store.subagents[0].name, "Research helper");
  assert.equal(store.subagents[0].status, "running");
  assert.ok(store.subagents[0].started_at);
  assert.equal(store.subagents[0].ended_at, null);

  store = applyAntigravity(store, {
    hookEventName: "PreToolUse",
    conversationId: "sub-1",
    parent_conversation_id: "main-1",
    toolCall: { id: "t1", name: "read_file", args: {} },
  });
  assert.equal(store.subagents[0].status, "running");
  assert.equal(store.session.activity, mainActivity);

  store = applyAntigravity(store, {
    hookEventName: "Stop",
    conversationId: "sub-1",
    parent_conversation_id: "main-1",
  });
  assert.equal(store.session.id, "main-1");
  assert.equal(store.session.activity, mainActivity);
  assert.equal(store.subagents[0].status, "done");
  assert.ok(store.subagents[0].ended_at);
});

// ------------------------------------------------------ reducer: prompt & title

test("antigravity PreInvocation invocationNum===0 sets first_prompt (max 500) once", () => {
  let store = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
    lastUserInput: "a".repeat(600),
  });
  assert.equal(store.session.first_prompt, "a".repeat(500));

  store = applyAntigravity(store, {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
    lastUserInput: "second prompt",
  });
  assert.equal(store.session.first_prompt, "a".repeat(500));
});

test("antigravity session_title sets agent title without overwriting user title", () => {
  let store = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
    session_title: "  Agent Title  ",
  });
  assert.equal(store.session.title, "Agent Title");
  assert.equal(store.session.title_source, "agent");

  const userOwned = {
    ...store,
    session: { ...store.session, title: "User Title", title_source: "user" },
  };
  const next = applyAntigravity(userOwned, {
    hookEventName: "PostInvocation",
    invocationNum: 0,
    conversationId: "c1",
    session_title: "New Agent Title",
  });
  assert.equal(next.session.title, "User Title");
  assert.equal(next.session.title_source, "user");
});

// ----------------------------------------------------------- reducer: task.md

test("antigravity task_md parses checklists incl. [/], caps at 50 tasks and 500 chars, and skips unchanged hash", () => {
  const md = [
    "# Plan",
    "Some intro line",
    "- [ ] Pending item",
    "- [/] Working item",
    "- [x] Done lower",
    "- [X] Done upper",
    "- [-] Cancelled dash",
    "  * [~] Nested cancelled tilde",
    `- [ ] ${"z".repeat(600)}`,
    "- [ ]   ",
  ].join("\n");

  let store = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PostInvocation",
    invocationNum: 0,
    conversationId: "c1",
    task_md: md,
  });
  assert.equal(store.tasks.length, 7);
  assert.deepEqual(
    store.tasks.map((t) => [t.id, t.status, t.title.length <= 500]),
    [
      ["1", "pending", true],
      ["2", "in_progress", true],
      ["3", "completed", true],
      ["4", "completed", true],
      ["5", "cancelled", true],
      ["6", "cancelled", true],
      ["7", "pending", true],
    ],
  );
  assert.equal(store.tasks[5].title, "Nested cancelled tilde");
  assert.equal(store.tasks[6].title.length, 500);
  assert.equal(typeof store.antigravity_task_md, "string");

  // RanchPlan replaces tasks; an unchanged task_md must NOT overwrite it.
  store = applyAntigravity(store, {
    hookEventName: "RanchPlan",
    plan: [{ step: "Manual plan task", status: "in_progress" }],
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Manual plan task", status: "in_progress", active_form: null },
  ]);

  store = applyAntigravity(store, {
    hookEventName: "PreInvocation",
    invocationNum: 1,
    conversationId: "c1",
    task_md: md,
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Manual plan task", status: "in_progress", active_form: null },
  ]);

  // 50-task cap
  const sixty = Array.from({ length: 60 }, (_, i) => `- [ ] Task ${i + 1}`).join("\n");
  const capped = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
    task_md: sixty,
  });
  assert.equal(capped.tasks.length, 50);
  assert.equal(capped.tasks[49].title, "Task 50");
});

// --------------------------------------------------------- reducer: missed_turns

test("antigravity missed_turns follows turn tracking (PreInvocation 0 -> PreToolUse -> Stop)", () => {
  // Pure Q&A turn (no PreToolUse): not a miss
  let store = applyAntigravity(emptyStore("t1", "antigravity"), {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
    lastUserInput: "question",
  });
  store = applyAntigravity(store, { hookEventName: "PostInvocation", invocationNum: 0, conversationId: "c1" });
  store = applyAntigravity(store, { hookEventName: "Stop", conversationId: "c1" });
  assert.equal(store.missed_turns, 0);

  // Tool turn with unchanged tasks: 1 miss; second Stop never recounts
  store = applyAntigravity(store, {
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: "c1",
  });
  store = applyAntigravity(store, {
    hookEventName: "PreToolUse",
    stepIdx: 1,
    conversationId: "c1",
    toolCall: { id: "tc1", name: "run_command", args: { CommandLine: "ls" } },
  });
  // Subsequent invocationNum > 0 must not reset session.turn
  store = applyAntigravity(store, {
    hookEventName: "PreInvocation",
    invocationNum: 1,
    conversationId: "c1",
  });
  assert.equal(store.session.turn.tools, true);
  store = applyAntigravity(store, { hookEventName: "Stop", conversationId: "c1" });
  assert.equal(store.missed_turns, 1);
  store = applyAntigravity(store, { hookEventName: "Stop", conversationId: "c1" });
  assert.equal(store.missed_turns, 1);

  // RanchPlan resets missed_turns
  store = applyAntigravity(store, {
    hookEventName: "RanchPlan",
    plan: [{ step: "Tracked", status: "in_progress" }],
  });
  assert.equal(store.missed_turns, 0);
});

// ---------------------------------------------------------- reducer: activity

test("antigravityActivity maps hookEventName values and ignores unknown events", () => {
  assert.equal(antigravityActivity({ hookEventName: "SessionStart" }), "idle");
  assert.equal(antigravityActivity({ hookEventName: "PreInvocation" }), "working");
  assert.equal(antigravityActivity({ hookEventName: "PreToolUse" }), "working");
  assert.equal(antigravityActivity({ hookEventName: "PostToolUse" }), "working");
  assert.equal(antigravityActivity({ hookEventName: "PostInvocation" }), "working");
  assert.equal(antigravityActivity({ hookEventName: "Stop" }), "done");
  assert.equal(antigravityActivity({ hookEventName: "RanchPlan" }), null);
  assert.equal(antigravityActivity({ hookEventName: "Other" }), null);

  const store = emptyStore("t1", "antigravity");
  assert.equal(applyAntigravity(store, null), store);
  assert.equal(applyAntigravity(store, []), store);
  assert.equal(applyAntigravity(store, { hookEventName: "Unknown" }), store);
});

// ------------------------------------------------------------------ CLI tests

test("ranch-tasks antigravity always outputs valid JSON and exits 0", () => {
  const home = tempHome();

  // No HC_TERMINAL_ID
  const noTerm = runCli(["antigravity"], JSON.stringify({ hookEventName: "SessionStart", conversationId: "c1" }), home, null);
  assert.equal(noTerm.status, 0);
  assert.deepEqual(JSON.parse(noTerm.stdout), {});

  // Bad JSON on stdin
  const badStdin = runCli(["antigravity"], "not json{{{", home, "t1");
  assert.equal(badStdin.status, 0);
  assert.deepEqual(JSON.parse(badStdin.stdout), {});

  // Empty stdin
  const emptyStdin = runCli(["antigravity"], "", home, "t1");
  assert.equal(emptyStdin.status, 0);
  assert.deepEqual(JSON.parse(emptyStdin.stdout), {});

  // Array JSON on stdin
  const arrStdin = runCli(["antigravity"], "[1, 2]", home, "t1");
  assert.equal(arrStdin.status, 0);
  assert.deepEqual(JSON.parse(arrStdin.stdout), {});
});

test('ranch-tasks antigravity with PreToolUse prints {"decision":"ask"} and writes no store', () => {
  const home = tempHome();
  const payload = JSON.stringify({
    hookEventName: "PreToolUse",
    conversationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    toolCall: { id: "tc1", name: "run_command", args: { CommandLine: "ls" } },
  });

  const inside = runCli(["antigravity"], payload, home, "t1");
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout, '{"decision":"ask"}\n');
  assert.equal(existsSync(join(home, ".herdr", "ranch", "tasks")), false);

  // Even without HC_TERMINAL_ID, stale PreToolUse must still reply ask (never {}).
  const outside = runCli(["antigravity"], payload, home, null);
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, '{"decision":"ask"}\n');
  assert.equal(existsSync(join(home, ".herdr", "ranch", "tasks")), false);

  // Malformed JSON that still identifies PreToolUse must also reply ask.
  const truncated = runCli(["antigravity"], '{"hookEventName":"PreToolUse","toolCall":{', home, "t1");
  assert.equal(truncated.status, 0);
  assert.equal(truncated.stdout, '{"decision":"ask"}\n');
  assert.equal(existsSync(join(home, ".herdr", "ranch", "tasks")), false);
});

test("ranch-tasks antigravity outputs injectSteps reminder on SessionStart and PreInvocation 0", () => {
  const home = tempHome();
  const cid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const artDir = join(home, ".gemini", "antigravity-cli", "brain", cid);
  const expectedTaskFile = join(artDir, "task.md");

  const start = runCli(["antigravity"], JSON.stringify({
    hookEventName: "SessionStart",
    conversationId: cid,
    artifactDirectoryPath: artDir,
  }), home, "t1");
  assert.equal(start.status, 0);
  const startOut = JSON.parse(start.stdout);
  assert.ok(Array.isArray(startOut.injectSteps));
  const startMsg = startOut.injectSteps[0].systemMessage.systemMessage;
  assert.ok(startMsg.includes(expectedTaskFile), startMsg);
  assert.doesNotMatch(startMsg, /ranch-tasks plan/);

  const prompt = runCli(["antigravity"], JSON.stringify({
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: cid,
    artifactDirectoryPath: artDir,
    lastUserInput: "hello",
  }), home, "t1");
  assert.equal(prompt.status, 0);
  const promptOut = JSON.parse(prompt.stdout);
  assert.ok(Array.isArray(promptOut.injectSteps));
  const promptMsg = promptOut.injectSteps[0].systemMessage.systemMessage;
  assert.ok(promptMsg.includes(expectedTaskFile), promptMsg);
  assert.doesNotMatch(promptMsg, /ranch-tasks plan/);

  // Non-reminder event (Stop) returns {}
  const stop = runCli(["antigravity"], JSON.stringify({
    hookEventName: "Stop",
    conversationId: cid,
  }), home, "t1");
  assert.equal(stop.status, 0);
  assert.deepEqual(JSON.parse(stop.stdout), {});

  // RANCH_REMIND=0 suppresses reminder
  const quiet = runCli(["antigravity"], JSON.stringify({
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: cid,
    artifactDirectoryPath: artDir,
    lastUserInput: "hello",
  }), home, "t1", { RANCH_REMIND: "0" });
  assert.equal(quiet.status, 0);
  assert.deepEqual(JSON.parse(quiet.stdout), {});
});

test("ranch-tasks antigravity decodes pbtxt title with octal UTF-8 escapes and reads task.md inside ~/.gemini", () => {
  const home = tempHome();
  const cid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const annDir = join(home, ".gemini", "antigravity-cli", "annotations");
  const artDir = join(home, ".gemini", "antigravity-cli", "brain", cid);
  mkdirSync(annDir, { recursive: true });
  mkdirSync(artDir, { recursive: true });

  // "Caf\303\251 \342\200\224 \"Ranch\"\n" -> Café — "Ranch"
  writeFileSync(
    join(annDir, `${cid}.pbtxt`),
    'title:"Caf\\303\\251 \\342\\200\\224 \\"Ranch\\""\n',
  );
  writeFileSync(
    join(artDir, "task.md"),
    "- [x] Read spec\n- [/] Implement hook\n- [ ] Write tests\n",
  );

  const res = runCli(["antigravity"], JSON.stringify({
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: cid,
    artifactDirectoryPath: artDir,
    lastUserInput: "ship it",
  }), home, "t1");
  assert.equal(res.status, 0);
  assert.doesNotThrow(() => JSON.parse(res.stdout));

  const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", `${cid}.json`), "utf8"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.session.title, 'Café — "Ranch"');
  assert.equal(disk.store.session.title_source, "agent");
  assert.equal(disk.store.session.first_prompt, "ship it");
  assert.deepEqual(
    disk.store.tasks.map((t) => [t.title, t.status]),
    [
      ["Read spec", "completed"],
      ["Implement hook", "in_progress"],
      ["Write tests", "pending"],
    ],
  );
});

test("ranch-tasks antigravity ignores task.md outside ~/.gemini and enriches subagents from sqlite", async () => {
  const home = tempHome();
  const mainId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const subId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const agyDir = join(home, ".gemini", "antigravity-cli");
  mkdirSync(agyDir, { recursive: true });

  // Outside ~/.gemini: must be ignored
  const outsideDir = join(home, "outside");
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, "task.md"), "- [ ] Should not load\n");

  // Populate conversation_summaries.db for fallback title and subagent parent lookup
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(agyDir, "conversation_summaries.db"));
  db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, parent_conversation_id TEXT)");
  const insert = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?)");
  insert.run(mainId, "SQLite Fallback Title", null);
  insert.run(subId, "Subagent Worker", mainId);
  db.close();

  // Main session event
  const r1 = runCli(["antigravity"], JSON.stringify({
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: mainId,
    artifactDirectoryPath: outsideDir,
    lastUserInput: "run task",
  }), home, "t1");
  assert.equal(r1.status, 0);

  // Subagent event
  const r2 = runCli(["antigravity"], JSON.stringify({
    hookEventName: "PreInvocation",
    invocationNum: 0,
    conversationId: subId,
    lastUserInput: "subtask",
  }), home, "t1");
  assert.equal(r2.status, 0);

  const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", `${mainId}.json`), "utf8"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.session.id, mainId);
  assert.equal(disk.store.session.title, "SQLite Fallback Title");
  assert.deepEqual(disk.store.tasks, []);
  assert.equal(disk.store.subagents.length, 1);
  assert.equal(disk.store.subagents[0].id, subId);
  assert.equal(disk.store.subagents[0].name, "Subagent Worker");
  assert.equal(disk.store.subagents[0].status, "running");
});

test("ranch-tasks antigravity: an unchanged task.md never overwrites a later `ranch-tasks plan` list across hook runs", () => {
  const home = tempHome();
  const cid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const artDir = join(home, ".gemini", "antigravity-cli", "brain", cid);
  mkdirSync(artDir, { recursive: true });
  writeFileSync(join(artDir, "task.md"), "- [/] From planner\n");
  const hook = (extra) => runCli(["antigravity"], JSON.stringify({
    conversationId: cid, artifactDirectoryPath: artDir, ...extra,
  }), home, "t1");

  assert.equal(hook({ hookEventName: "PreInvocation", invocationNum: 0, lastUserInput: "go" }).status, 0);
  const plan = runCli(["plan", "doing: From plan command"], "", home, "t1");
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(hook({ hookEventName: "PostInvocation", invocationNum: 0 }).status, 0);

  const read = () => parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", `${cid}.json`), "utf8")).store;
  assert.deepEqual(read().tasks.map((t) => t.title), ["From plan command"]);

  // A changed task.md is newer information and replaces the list again.
  writeFileSync(join(artDir, "task.md"), "- [x] From planner\n- [ ] Next\n");
  assert.equal(hook({ hookEventName: "PostInvocation", invocationNum: 1 }).status, 0);
  assert.deepEqual(read().tasks.map((t) => [t.title, t.status]), [["From planner", "completed"], ["Next", "pending"]]);
});
