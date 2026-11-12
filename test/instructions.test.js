import { test } from "node:test";
import assert from "node:assert/strict";
import { planCommandLine, reminderFor, rulesFor } from "../adapters/instructions.js";

// Codex plan command line: absolute ranch-tasks plan invocation, shell-ready.

test("planCommandLine posix home", () => {
  assert.equal(planCommandLine("/Users/a"), "/Users/a/.herdr/ranch/bin/ranch-tasks plan");
});

test("planCommandLine quotes a spaced posix home", () => {
  assert.equal(planCommandLine("/Users/a b"), '"/Users/a b/.herdr/ranch/bin/ranch-tasks" plan');
});

test("planCommandLine windows home uses node on the .js entry", () => {
  assert.equal(planCommandLine("C:/Users/x"), 'node "C:/Users/x/.herdr/ranch/bin/ranch-tasks.js" plan');
  // Backslash homes (what os.homedir() returns on Windows) come out forward-slashed.
  assert.equal(planCommandLine("C:\\Users\\x"), 'node "C:/Users/x/.herdr/ranch/bin/ranch-tasks.js" plan');
  assert.equal(planCommandLine("\\\\srv\\home\\x"), 'node "//srv/home/x/.herdr/ranch/bin/ranch-tasks.js" plan');
});

test("planCommandLine falsy home falls back to the generic command", () => {
  assert.equal(planCommandLine(undefined), "ranch-tasks plan");
  assert.equal(planCommandLine(null), "ranch-tasks plan");
});

// Codex rules mention update_plan plus the absolute plan command.

test("rulesFor codex posix home", () => {
  const rules = rulesFor("codex", "/Users/a");
  assert.match(rules, /update_plan/);
  assert.match(rules, /\/Users\/a\/\.herdr\/ranch\/bin\/ranch-tasks plan "doing: <first task>" "todo: <next task>"/);
  assert.match(rules, /one quoted argument per task/);
  assert.match(rules, /each run replaces the whole list/);
});

test("rulesFor codex windows home", () => {
  const rules = rulesFor("codex", "C:/Users/x");
  assert.match(rules, /node "C:\/Users\/x\/\.herdr\/ranch\/bin\/ranch-tasks\.js" plan/);
});

// Codex hook reminders carry the absolute plan command and keep update_plan.

test("reminderFor codex SessionStart posix home", () => {
  const text = reminderFor("codex", "SessionStart", { tasks: [] }, "/Users/a");
  assert.match(text, /update_plan/);
  assert.match(text, /\/Users\/a\/\.herdr\/ranch\/bin\/ranch-tasks plan "doing: \.\.\." "todo: \.\.\."/);
});

test("reminderFor codex UserPromptSubmit windows home", () => {
  const text = reminderFor("codex", "UserPromptSubmit", { tasks: [] }, "C:/Users/x");
  assert.match(text, /node "C:\/Users\/x\/\.herdr\/ranch\/bin\/ranch-tasks\.js" plan/);
});

test("reminderFor codex stays silent once the list is fresh", () => {
  const store = { tasks: [{ id: "1", title: "X", status: "pending", active_form: null }], missed_turns: 0 };
  assert.equal(reminderFor("codex", "UserPromptSubmit", store, "/Users/a"), null);
  assert.equal(reminderFor("codex", "SessionStart", store, "/Users/a"), null);
});

// Claude and OpenCode wording is pinned byte for byte and must not change.

const CODEX_HOME = undefined; // fallback wording below still pins today's strings

test("rulesFor claude is byte-identical", () => {
  assert.equal(
    rulesFor("claude"),
    `# Task reporting (Ranch) - mandatory for every message

The person watches your progress in Herdr's Ranch panel, which shows your task
list live. This rule is non-negotiable and applies to EVERY message the person
sends, with no exceptions (questions and one-line answers included):

1. Before doing anything else in your reply, record the work as tasks with
   your task tool (TaskCreate to add tasks, TaskUpdate to change status; TodoWrite if that is what you have): at least one task per message, one task per concrete step when
   there are several.
2. Mark a task in_progress when you start it and completed the moment it is
   done. Exactly one task is in_progress while you are working.
3. Before you end your reply, every task for that message is completed (or
   explicitly left pending with the reason stated). Never leave finished work
   marked pending or in_progress.
4. When the plan changes, update the list (add, reword or remove tasks) before
   continuing.
`,
  );
});

test("rulesFor opencode is byte-identical", () => {
  assert.equal(
    rulesFor("opencode"),
    `# Task reporting (Ranch) - mandatory for every message

The person watches your progress in Herdr's Ranch panel, which shows your task
list live. This rule is non-negotiable and applies to EVERY message the person
sends, with no exceptions (questions and one-line answers included):

1. Before doing anything else in your reply, record the work as tasks with
   the todowrite tool: at least one task per message, one task per concrete step when
   there are several.
2. Mark a task in_progress when you start it and completed the moment it is
   done. Exactly one task is in_progress while you are working.
3. Before you end your reply, every task for that message is completed (or
   explicitly left pending with the reason stated). Never leave finished work
   marked pending or in_progress.
4. When the plan changes, update the list (add, reword or remove tasks) before
   continuing.
`,
  );
});

test("rulesFor codex without home still mentions update_plan", () => {
  const rules = rulesFor("codex");
  assert.match(rules, /update_plan/);
  assert.match(rules, /ranch-tasks plan "doing: <first task>" "todo: <next task>"/);
});

test("reminderFor claude is byte-identical", () => {
  assert.equal(
    reminderFor("claude", "SessionStart", { tasks: [] }),
    "Ranch task reporting is mandatory: for EVERY user message, first record the work as tasks with TaskCreate/TaskUpdate, mark each in_progress then completed, and finish all of them before ending your reply.",
  );
  assert.equal(
    reminderFor("claude", "UserPromptSubmit", { tasks: [] }),
    "Ranch (mandatory): before anything else, add task(s) for this message with TaskCreate/TaskUpdate; mark in_progress, then completed before you finish.",
  );
});

test("reminderFor opencode is byte-identical", () => {
  assert.equal(
    reminderFor("opencode", "SessionStart", { tasks: [] }),
    "Ranch task reporting is mandatory: for EVERY user message, first record the work as tasks with todowrite, mark each in_progress then completed, and finish all of them before ending your reply.",
  );
  assert.equal(
    reminderFor("opencode", "UserPromptSubmit", { tasks: [] }),
    "Ranch (mandatory): before anything else, add task(s) for this message with todowrite; mark in_progress, then completed before you finish.",
  );
});

test("reminderFor codex without home keeps the generic fallback", () => {
  assert.match(reminderFor("codex", "SessionStart", { tasks: [] }), /update_plan \(or, without it: ranch-tasks plan "doing: \.\.\." "todo: \.\.\."\)/);
});

test("other hook events stay silent", () => {
  assert.equal(reminderFor("codex", "PostToolUse", { tasks: [] }, "/Users/a"), null);
});
