// Pi adapter: the normalized hook payloads the Ranch Pi extension sends
// (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) reduced onto
// the store exactly like the Codex path, plus its missed-turn bookkeeping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore } from "../lib/tasks.js";
import { applyPi, piActivity } from "../adapters/pi.js";

const base = () => ({
  ...emptyStore("t1", "pi"),
  session: { id: "old", title: "Old", title_source: "user", first_prompt: "old prompt", state: "ended" },
  tasks: [{ id: "1", title: "Keep", status: "pending", active_form: null }],
  subagents: [{ id: "a1", name: "agent", status: "running", started_at: null, ended_at: null }],
  missed_turns: 2,
});

const prompt = (sid, text = "hi") => ({ hook_event_name: "UserPromptSubmit", session_id: sid, prompt: text });
const bash = (sid) => ({
  hook_event_name: "PostToolUse", session_id: sid, tool_name: "bash", tool_input: { command: "ls" },
});
const todo = (sid, todos) => ({
  hook_event_name: "PostToolUse", session_id: sid, tool_name: "todo_write", tool_input: { todos },
});

// ---------------------------------------------------------- SessionStart

test("pi SessionStart startup and new clear tasks and subagents", () => {
  for (const source of ["startup", "new"]) {
    const fresh = applyPi(base(), { hook_event_name: "SessionStart", session_id: "new", source });
    assert.equal(fresh.session.id, "new");
    assert.equal(fresh.session.title, null);
    assert.equal(fresh.session.first_prompt, null);
    assert.equal(fresh.session.state, "running");
    assert.equal(fresh.missed_turns, 0);
    assert.deepEqual(fresh.tasks, []);
    assert.deepEqual(fresh.subagents, []);
  }
});

test("pi SessionStart resume with a new id resets the session but keeps tasks", () => {
  const resumed = applyPi(base(), { hook_event_name: "SessionStart", session_id: "new", source: "resume" });
  assert.equal(resumed.session.id, "new");
  assert.equal(resumed.session.title, null);
  assert.equal(resumed.session.first_prompt, null);
  assert.equal(resumed.missed_turns, 0);
  assert.deepEqual(resumed.tasks, base().tasks);
});

test("pi SessionStart reload with the same id only marks the session running", () => {
  const store = base();
  const reloaded = applyPi(store, { hook_event_name: "SessionStart", session_id: "old", source: "reload" });
  assert.equal(reloaded.session.id, "old");
  assert.equal(reloaded.session.title, "Old");
  assert.equal(reloaded.session.first_prompt, "old prompt");
  assert.equal(reloaded.session.state, "running");
  assert.equal(reloaded.missed_turns, 2);
  assert.deepEqual(reloaded.tasks, store.tasks);
});

// ------------------------------------------------------ UserPromptSubmit

test("pi UserPromptSubmit records the first prompt truncated to 500 and works", () => {
  let store = applyPi(emptyStore("t1", "pi"), prompt("s1", "x".repeat(600)));
  assert.equal(store.session.first_prompt.length, 500);
  assert.equal(store.session.activity.state, "working");
  store = applyPi(store, prompt("s1", "second prompt should not win"));
  assert.equal(store.session.first_prompt, "x".repeat(500));
});

// ----------------------------------------------------------- todo_write

test("pi todo_write replaces tasks, maps status and activeForm, drops empty content", () => {
  const store = applyPi(emptyStore("t1", "pi"), todo("s1", [
    { content: "Read spec", status: "completed", activeForm: "Reading spec" },
    { content: " Write it ", status: "in_progress", activeForm: " Writing it " },
    { content: "Dropped", status: "cancelled" },
    { content: "   ", status: "pending" },
    { content: "Odd", status: "bogus", activeForm: "" },
  ]));
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Read spec", status: "completed", active_form: "Reading spec" },
    { id: "2", title: "Write it", status: "in_progress", active_form: "Writing it" },
    { id: "3", title: "Dropped", status: "cancelled", active_form: null },
    { id: "5", title: "Odd", status: "pending", active_form: null },
  ]);
});

// --------------------------------------------------------- missed turns

test("pi non-todo tool marks the turn as worked", () => {
  let store = applyPi(emptyStore("t1", "pi"), prompt("s1"));
  store = applyPi(store, bash("s1"));
  assert.equal(store.session.turn.tools, true);
  assert.deepEqual(store.tasks, []);
});

test("pi Stop counts a miss only when tools ran and the tasks are unchanged", () => {
  // no tools: not a miss
  let store = applyPi(emptyStore("t1", "pi"), prompt("s1"));
  store = applyPi(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 0);

  // tools, unchanged list: one miss; a second Stop never recounts
  store = applyPi(emptyStore("t1", "pi"), prompt("s1"));
  store = applyPi(store, bash("s1"));
  store = applyPi(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 1);
  store = applyPi(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 1);
});

test("pi a todo_write that changes the list resets missed_turns", () => {
  let store = applyPi(emptyStore("t1", "pi"), prompt("s1"));
  store = applyPi(store, bash("s1"));
  store = applyPi(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 1);

  store = applyPi(store, todo("s1", [{ content: "A", status: "in_progress" }]));
  assert.equal(store.missed_turns, 0);
});

// ------------------------------------------------------------------- PRs

test("pi bash gh pr create records the PR; a failed run does not", () => {
  const created = applyPi(emptyStore("t1", "pi"), {
    hook_event_name: "PostToolUse", session_id: "s1", tool_name: "bash",
    tool_input: { command: "gh pr create --title x" },
    tool_response: { stdout: "https://github.com/o/r/pull/7\n", exit_code: 0 },
  });
  assert.deepEqual(created.prs.map(({ url, number }) => ({ url, number })), [
    { url: "https://github.com/o/r/pull/7", number: 7 },
  ]);
  assert.ok(created.prs[0].at);

  const failed = applyPi(emptyStore("t1", "pi"), {
    hook_event_name: "PostToolUse", session_id: "s1", tool_name: "bash",
    tool_input: { command: "gh pr create --title x" },
    tool_response: { stdout: "", exit_code: 1 },
  });
  assert.deepEqual(failed.prs, []);
});

// ------------------------------------------------------------- lifecycle

test("pi SessionEnd sets the session ended", () => {
  const store = applyPi(base(), { hook_event_name: "SessionEnd", session_id: "old" });
  assert.equal(store.session.state, "ended");
  assert.equal(store.session.activity.state, "idle");
});

test("pi unknown events and non-object payloads leave the store unchanged", () => {
  const store = emptyStore("t1", "pi");
  assert.equal(applyPi(store, { hook_event_name: "Notification" }), store);
  assert.equal(applyPi(store, null), store);
  assert.equal(applyPi(store, "nope"), store);
  assert.equal(applyPi(store, []), store);
});

test("pi session id change without SessionStart starts fresh (I10)", () => {
  const store = applyPi(base(), bash("s2"));
  assert.equal(store.session.id, "s2");
  assert.equal(store.session.first_prompt, null);
  assert.equal(store.missed_turns, 0);
  assert.deepEqual(store.tasks, []);
  assert.deepEqual(store.subagents, []);
});

// ------------------------------------------------- session name & switches

test("pi SessionStart takes the session name and the branch's todo list", () => {
  const started = applyPi(emptyStore("t1", "pi"), {
    hook_event_name: "SessionStart", session_id: "s1", source: "startup",
    session_name: "Auth refactor", first_prompt: "fix login",
    todos: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress", activeForm: "Doing B" }],
  });
  assert.equal(started.session.title, "Auth refactor");
  assert.equal(started.session.title_source, "user");
  assert.equal(started.session.first_prompt, "fix login");
  assert.deepEqual(started.tasks, [
    { id: "1", title: "A", status: "completed", active_form: null },
    { id: "2", title: "B", status: "in_progress", active_form: "Doing B" },
  ]);
});

test("pi SessionStart resume of another session loads its name and tasks, not the old ones", () => {
  const resumed = applyPi(base(), {
    hook_event_name: "SessionStart", session_id: "other", source: "resume",
    session_name: null, todos: [{ content: "Theirs", status: "pending" }],
  });
  assert.equal(resumed.session.id, "other");
  assert.equal(resumed.session.title, null);
  assert.equal(resumed.session.title_source, null);
  assert.deepEqual(resumed.tasks.map((t) => t.title), ["Theirs"]);
});

test("pi SessionStart new with an empty snapshot is a clean slate", () => {
  const fresh = applyPi(base(), { hook_event_name: "SessionStart", session_id: "n", source: "new", session_name: null, todos: [] });
  assert.equal(fresh.session.title, null);
  assert.deepEqual(fresh.tasks, []);
});

test("pi SessionSync renames, clears the name and re-loads tasks on /tree", () => {
  let store = applyPi(base(), { hook_event_name: "SessionSync", session_id: "old", session_name: "New name" });
  assert.equal(store.session.title, "New name");
  assert.equal(store.session.title_source, "user");
  assert.deepEqual(store.tasks, base().tasks); // a rename leaves tasks alone
  assert.equal(store.session.activity, undefined); // no activity change

  store = applyPi(store, { hook_event_name: "SessionSync", session_id: "old", session_name: null });
  assert.equal(store.session.title, null);
  assert.equal(store.session.title_source, null);

  store = applyPi(store, { hook_event_name: "SessionSync", session_id: "old", todos: [{ content: "Branch B", status: "pending" }] });
  assert.deepEqual(store.tasks.map((t) => t.title), ["Branch B"]);
  assert.equal(store.missed_turns, 0);
});

test("piActivity maps the event names", () => {
  assert.equal(piActivity({ hook_event_name: "SessionStart" }), "idle");
  assert.equal(piActivity({ hook_event_name: "UserPromptSubmit" }), "working");
  assert.equal(piActivity({ hook_event_name: "PostToolUse" }), "working");
  assert.equal(piActivity({ hook_event_name: "Stop" }), "done");
  assert.equal(piActivity({ hook_event_name: "SessionEnd" }), "idle");
  assert.equal(piActivity({ hook_event_name: "SessionSync" }), null);
  assert.equal(piActivity({ hook_event_name: "Other" }), null);
});
