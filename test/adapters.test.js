import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyStore, parseStore } from "../lib/tasks.js";
import { applyClaude } from "../adapters/claude.js";
import { applyCodex } from "../adapters/codex.js";
import opencodePlugin, { RanchTasks, reduceOpencode } from "../adapters/opencode-plugin.js";
import { terminalPath, updateStore } from "../adapters/store.js";
import { enableOpencodeTodo, install, statusSummary, uninstall } from "../adapters/install.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Temp dirs live in os.tmpdir() and are left for the OS to clean; tests must
// never delete anything outside them, so no cleanup is attempted here.
function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-adapters-"));
}

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ---------------------------------------------------------------- applyClaude

test("applyClaude TodoWrite keeps a cancelled todo", () => {
  const store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: {
      todos: [
        { content: "a", status: "completed", activeForm: null },
        { content: "b", status: "cancelled", activeForm: null },
      ],
    },
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "a", status: "completed", active_form: null },
    { id: "2", title: "b", status: "cancelled", active_form: null },
  ]);
});

test("applyClaude TodoWrite replaces tasks entirely", () => {
  const store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: {
      todos: [
        { content: "Read the spec", status: "completed", activeForm: null },
        { content: "Write it", status: "in_progress", activeForm: "Writing it" },
        { content: "", status: "pending" },
      ],
    },
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Read the spec", status: "completed", active_form: null },
    { id: "2", title: "Write it", status: "in_progress", active_form: "Writing it" },
  ]);
});

test("applyClaude TaskCreate picks the id from tool_response", () => {
  const base = emptyStore("t1", "claude-code");
  const fromString = applyClaude(base, {
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: "Write code", activeForm: "Writing code" },
    tool_response: "Task #7 created successfully",
  });
  assert.deepEqual(fromString.tasks.at(-1), { id: "7", title: "Write code", status: "pending", active_form: "Writing code" });

  const fromObject = applyClaude(base, {
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: "Test it" },
    tool_response: { text: "Task #9 created successfully" },
  });
  assert.equal(fromObject.tasks.at(-1).id, "9");

  const noId = applyClaude(base, {
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: "Alone" },
  });
  assert.equal(noId.tasks.at(-1).id, "1");
});

test("applyClaude TaskUpdate changes, deletes and appends", () => {
  let store = emptyStore("t1", "claude-code");
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "pending" }, { content: "B", status: "pending" }] },
  });

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: 1, status: "completed", subject: "A done", activeForm: "Doing A" },
  });
  assert.deepEqual(store.tasks[0], { id: "1", title: "A done", status: "completed", active_form: "Doing A" });

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "2", status: "deleted" },
  });
  assert.deepEqual(store.tasks.map((t) => t.id), ["1"]);

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "42", status: "in_progress", subject: "New one" },
  });
  assert.deepEqual(store.tasks.at(-1), { id: "42", title: "New one", status: "in_progress", active_form: null });

  // unknown id without a subject: nothing appended
  const n = store.tasks.length;
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "99", status: "completed" },
  });
  assert.equal(store.tasks.length, n);
});

test("applyClaude session lifecycle", () => {
  const base = emptyStore("t1", "claude-code");
  let store = applyClaude(base, {
    hook_event_name: "SessionStart", session_id: "s1", source: "startup",
  });
  assert.equal(store.session.id, "s1");
  assert.equal(store.session.state, "running");

  store = applyClaude(store, {
    hook_event_name: "UserPromptSubmit", prompt: "fix the login loop",
  });
  assert.equal(store.session.first_prompt, "fix the login loop");
  store = applyClaude(store, {
    hook_event_name: "UserPromptSubmit", prompt: "second prompt should not win",
  });
  assert.equal(store.session.first_prompt, "fix the login loop");

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "pending" }] },
  });
  store = applyClaude(store, {
    hook_event_name: "SessionEnd", session_id: "s1",
  });
  assert.equal(store.session.state, "ended");
  assert.equal(store.tasks.length, 1);

  // resume keeps tasks, title and prompt
  const resumed = applyClaude(store, {
    hook_event_name: "SessionStart", session_id: "s1", source: "resume",
  });
  assert.equal(resumed.tasks.length, 1);
  assert.equal(resumed.session.first_prompt, "fix the login loop");

  // startup clears them
  const fresh = applyClaude(store, {
    hook_event_name: "SessionStart", session_id: "s2", source: "startup",
  });
  assert.deepEqual(fresh.tasks, []);
  assert.deepEqual(fresh.subagents, []);
  assert.equal(fresh.session.id, "s2");
});

test("applyClaude subagents accept varied field names", () => {
  let store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "SubagentStart", subagent_id: "a1", description: "explore auth",
  });
  assert.deepEqual(store.subagents, [
    { id: "a1", name: "explore auth", status: "running", started_at: store.subagents[0].started_at, ended_at: null },
  ]);

  store = applyClaude(store, {
    hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "explore repo",
  });
  assert.equal(store.subagents.length, 1);
  assert.equal(store.subagents[0].name, "explore repo");

  store = applyClaude(store, { hook_event_name: "SubagentStop", id: "a1" });
  assert.equal(store.subagents[0].status, "done");
  assert.ok(store.subagents[0].ended_at);

  // stop for an unknown id changes nothing
  const same = applyClaude(store, { hook_event_name: "SubagentStop", id: "zz" });
  assert.equal(same.subagents.length, 1);
});

test("applyClaude title from transcript: last custom-title wins, user is never downgraded", () => {
  const transcript = [
    '{"type":"ai-title","aiTitle":"Early guess","sessionId":"s1"}',
    '{"type":"custom-title","customTitle":"My name","sessionId":"s1"}',
    '{"type":"ai-title","aiTitle":"Later agent","sessionId":"s1"}',
    '{"type":"assistant","message":{}}',
  ].join("\n");
  const base = emptyStore("t1", "claude-code");
  let store = applyClaude(base, {
    hook_event_name: "UserPromptSubmit", prompt: "hi", transcript,
  });
  assert.equal(store.session.title, "My name");
  assert.equal(store.session.title_source, "user");

  // only an ai-title -> agent source
  store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "Stop",
    transcript: '{"type":"ai-title","aiTitle":"Auto title"}',
  });
  assert.equal(store.session.title, "Auto title");
  assert.equal(store.session.title_source, "agent");

  // a user title is never downgraded by a later agent title
  store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "Stop",
    transcript: ['{"type":"custom-title","customTitle":"My name"}', '{"type":"ai-title","aiTitle":"Newer auto"}'].join("\n"),
  });
  assert.equal(store.session.title, "My name");
  assert.equal(store.session.title_source, "user");
  store = applyClaude(store, {
    hook_event_name: "PostToolUse",
    transcript: '{"type":"ai-title","aiTitle":"Even newer auto"}',
  });
  assert.equal(store.session.title, "My name");
  assert.equal(store.session.title_source, "user");
});

test("applyClaude ignores unknown events and non-object payloads", () => {
  const base = emptyStore("t1", "claude-code");
  assert.equal(applyClaude(base, { hook_event_name: "Notification" }), base);
  assert.equal(applyClaude(base, null), base);
  assert.equal(applyClaude(base, "nope"), base);
});

// ----------------------------------------------------------------- applyCodex

test("applyCodex update_plan keeps a cancelled step", () => {
  const store = applyCodex(emptyStore("t1", "codex"), {
    hook_event_name: "PostToolUse",
    tool_name: "update_plan",
    tool_input: {
      plan: [
        { step: "Read spec", status: "completed" },
        { step: "Dropped", status: "cancelled" },
      ],
    },
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Read spec", status: "completed", active_form: null },
    { id: "2", title: "Dropped", status: "cancelled", active_form: null },
  ]);
});

test("applyCodex update_plan replaces tasks", () => {
  let store = applyCodex(emptyStore("t1", "codex"), {
    hook_event_name: "SessionStart", session_id: "s1", source: "startup",
  });
  store = applyCodex(store, {
    hook_event_name: "UserPromptSubmit", prompt: "ship it",
  });
  store = applyCodex(store, {
    hook_event_name: "PostToolUse",
    tool_name: "update_plan",
    tool_input: {
      explanation: "plan",
      plan: [
        { step: "Read spec", status: "completed" },
        { step: "Write code", status: "in_progress" },
      ],
    },
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Read spec", status: "completed", active_form: null },
    { id: "2", title: "Write code", status: "in_progress", active_form: null },
  ]);
  assert.equal(store.session.first_prompt, "ship it");
  assert.equal(store.session.title, null);

  // other tools do nothing
  const same = applyCodex(store, {
    hook_event_name: "PostToolUse", tool_name: "shell", tool_input: { command: "ls" },
  });
  assert.deepEqual(same.tasks, store.tasks);
});

test("applyCodex subagents and session end", () => {
  let store = applyCodex(emptyStore("t1", "codex"), {
    hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "reviewer",
  });
  assert.deepEqual(store.subagents, [
    { id: "a1", name: "reviewer", status: "running", started_at: store.subagents[0].started_at, ended_at: null },
  ]);
  store = applyCodex(store, {
    hook_event_name: "SessionEnd", reason: "exit",
  });
  assert.equal(store.session.state, "ended");
  store = applyCodex(store, { hook_event_name: "SubagentStop", agent_id: "a1" });
  assert.equal(store.subagents[0].status, "done");
});

for (const [name, apply] of [["claude", applyClaude], ["codex", applyCodex]]) {
  test(`${name} SessionStart resets titles for a different conversation`, () => {
    const base = {
      ...emptyStore("t1", name),
      session: { id: "old", title: "Old title", title_source: "user", first_prompt: "old prompt", state: "ended" },
      tasks: [{ id: "1", title: "Keep me", status: "pending", active_form: null }],
      subagents: [{ id: "a1", name: "agent", status: "running", started_at: null, ended_at: null }],
    };
    for (const source of ["startup", "clear"]) {
      const fresh = apply(base, { hook_event_name: "SessionStart", session_id: "new", source });
      { const { activity, ...rest } = fresh.session; assert.deepEqual(rest, { id: "new", title: null, title_source: null, first_prompt: null, state: "running" }); assert.equal(activity.state, "idle"); }
      assert.deepEqual(fresh.tasks, []);
      assert.deepEqual(fresh.subagents, []);
    }

    const resumed = apply(base, { hook_event_name: "SessionStart", session_id: "new", source: "resume" });
    { const { activity, ...rest } = resumed.session; assert.deepEqual(rest, { id: "new", title: null, title_source: null, first_prompt: null, state: "running" }); assert.equal(activity.state, "idle"); }
    assert.deepEqual(resumed.tasks, base.tasks);
    assert.deepEqual(resumed.subagents, base.subagents);

    const compact = apply(base, { hook_event_name: "SessionStart", session_id: "new", source: "compact" });
    assert.equal(compact.session.id, "new");
    assert.equal(compact.session.title, "Old title");
    assert.equal(compact.session.first_prompt, "old prompt");
    assert.deepEqual(compact.tasks, base.tasks);
  });
}

// -------------------------------------------------------------- OpenCode

test("reduceOpencode todo.updated replaces tasks and keeps cancelled", () => {
  const store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "todo.updated",
    properties: {
      sessionID: "s1",
      todos: [
        { id: "1", content: "a", status: "completed" },
        { id: "2", content: "b", status: "cancelled" },
        { id: "3", content: "c", status: "pending" },
      ],
    },
  });
  assert.deepEqual(store.tasks, [
    { id: "1", title: "a", status: "completed", active_form: null },
    { id: "2", title: "b", status: "cancelled", active_form: null },
    { id: "3", title: "c", status: "pending", active_form: null },
  ]);
});

test("reduceOpencode ignores todo updates from child sessions", () => {
  const base = {
    ...emptyStore("t1", "opencode"),
    session: { id: "main1", title: null, title_source: null, first_prompt: null, state: "running" },
    tasks: [{ id: "1", title: "main task", status: "pending", active_form: null }],
  };
  const event = {
    type: "todo.updated",
    properties: { sessionID: "child1", todos: [{ id: "2", content: "child task", status: "pending" }] },
  };
  assert.equal(reduceOpencode(base, event), base);
  const main = reduceOpencode(base, {
    ...event,
    properties: { ...event.properties, sessionID: "main1" },
  });
  assert.equal(main.tasks[0].title, "child task");
});

test("reduceOpencode main session tracks id and title", () => {
  let store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "session.created",
    properties: { info: { id: "ses1", title: "New session - x" } },
  });
  assert.equal(store.session.id, "ses1");
  assert.equal(store.session.title, null);

  store = reduceOpencode(store, {
    type: "session.updated",
    properties: { info: { id: "ses1", title: "Fix login" } },
  });
  assert.equal(store.session.title, "Fix login");
  assert.equal(store.session.title_source, "agent");
});

test("reduceOpencode a newly created main session starts fresh", () => {
  const base = {
    ...emptyStore("t1", "opencode"),
    session: { id: "old", title: "Old", title_source: "user", first_prompt: "old prompt", state: "running" },
    tasks: [{ id: "1", title: "old task", status: "pending", active_form: null }],
    subagents: [{ id: "sub1", name: "old agent", status: "running", started_at: null, ended_at: null }],
  };
  const fresh = reduceOpencode(base, {
    type: "session.created",
    properties: { info: { id: "new", title: "New work" } },
  });
  assert.deepEqual(fresh.session, { id: "new", title: "New work", title_source: "agent", first_prompt: null, state: "running" });
  assert.deepEqual(fresh.tasks, []);
  assert.deepEqual(fresh.subagents, []);
});

test("reduceOpencode session.updated ignores another live main session", () => {
  const base = {
    ...emptyStore("t1", "opencode"),
    session: { id: "old", title: "Old", title_source: "user", first_prompt: "old prompt", state: "running" },
    tasks: [{ id: "1", title: "old task", status: "pending", active_form: null }],
    subagents: [{ id: "sub1", name: "old agent", status: "running", started_at: null, ended_at: null }],
  };
  const event = { type: "session.updated", properties: { info: { id: "new", title: "New work" } } };
  assert.equal(reduceOpencode(base, event), base);

  const ended = { ...base, session: { ...base.session, state: "ended" } };
  const fresh = reduceOpencode(ended, event);
  assert.deepEqual(fresh.session, { id: "new", title: "New work", title_source: "agent", first_prompt: null, state: "running" });
  assert.deepEqual(fresh.tasks, []);
  assert.deepEqual(fresh.subagents, []);
});

test("reduceOpencode subagent sessions", () => {
  let store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "session.created",
    properties: { info: { id: "sub1", title: "explore auth", parentID: "main1" } },
  });
  assert.deepEqual(store.subagents, [
    { id: "sub1", name: "explore auth", status: "running", started_at: store.subagents[0].started_at, ended_at: null },
  ]);

  // updates keep status and started_at
  store = reduceOpencode(store, {
    type: "session.updated",
    properties: { info: { id: "sub1", title: "explore repo", parentID: "main1" } },
  });
  assert.equal(store.subagents[0].name, "explore repo");
  assert.equal(store.subagents[0].status, "running");

  store = reduceOpencode(store, { type: "session.idle", properties: { sessionID: "sub1" } });
  assert.equal(store.subagents[0].status, "done");
  assert.ok(store.subagents[0].ended_at);

  // idle for an unknown session changes nothing
  assert.equal(reduceOpencode(store, { type: "session.idle", properties: { sessionID: "nope" } }), store);
});

test("reduceOpencode session.deleted ends main and subagents", () => {
  let store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "session.created",
    properties: { info: { id: "main1" } },
  });
  store = reduceOpencode(store, {
    type: "session.created",
    properties: { info: { id: "sub1", parentID: "main1" } },
  });
  store = reduceOpencode(store, { type: "session.deleted", properties: { info: { id: "sub1" } } });
  assert.equal(store.subagents[0].status, "done");
  assert.equal(store.session.state, "running");
  store = reduceOpencode(store, { type: "session.deleted", properties: { info: { id: "main1" } } });
  assert.equal(store.session.state, "ended");

  const legacy = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "session.created", properties: { info: { id: "legacy" } },
  });
  const fallback = reduceOpencode(legacy, { type: "session.deleted", properties: { sessionID: "legacy" } });
  assert.equal(fallback.session.state, "ended");
});

test("reduceOpencode chat.message records the first prompt only", () => {
  let store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "chat.message",
    properties: { sessionID: "main1", text: "first message" },
  });
  assert.equal(store.session.first_prompt, "first message");
  store = reduceOpencode(store, {
    type: "chat.message",
    properties: { sessionID: "main1", text: "second" },
  });
  assert.equal(store.session.first_prompt, "first message");
});

test("reduceOpencode ignores unknown events", () => {
  const base = emptyStore("t1", "opencode");
  assert.equal(reduceOpencode(base, { type: "file.changed", properties: {} }), base);
  assert.equal(reduceOpencode(base, null), base);
});

test("opencode plugin writes the store from events and chat.message", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "top";
  try {
    const plugin = await RanchTasks({});
    await plugin.event({
      event: { type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "1", content: "a", status: "in_progress" }] } },
    });
    // Session-keyed layout (fixes 3.3): a terminal pointer plus the store.
    const pointer = join(home, ".herdr", "ranch", "tasks", "terminals", "top.json");
    const file = join(home, ".herdr", "ranch", "tasks", "sessions", "s1.json");
    assert.equal(JSON.parse(readFileSync(pointer, "utf8")).session, "s1");
    let disk = parseStore(readFileSync(file, "utf8"));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.tasks[0].title, "a");
    assert.ok(disk.store.updated_at);
    assert.deepEqual(disk.store.agent, { app: "opencode", session: "s1", pid: process.pid });
    assert.ok(disk.store.seq >= 1);

    await plugin["chat.message"](
      { sessionID: "s1" },
      { parts: [{ type: "text", text: "hello " }, { type: "text", text: "world" }, { type: "file", path: "x" }] },
    );
    disk = parseStore(readFileSync(file, "utf8"));
    assert.equal(disk.store.session.first_prompt, "hello world");
    // Every prompt starts a new turn for missed-turn detection (fixes 3.7).
    assert.equal(disk.store.session.turn.tools, false);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

test("opencode plugin adopts legacy stores only for the same agent and session", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "unused", HOME: home });
  const cases = [
    ["oc-matching", "opencode", "s1", "s1", true],
    ["oc-legacy-without-session", "opencode", null, "s2", true],
    ["oc-other-agent", "claude", "s3", "s3", false],
    ["oc-other-session", "opencode", "old", "s4", false],
  ];
  for (const [terminal, legacyAgent, legacySession, incomingSession, adopt] of cases) {
    process.env.HC_TERMINAL_ID = terminal;
    const dir = join(home, ".herdr", "ranch", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${terminal}.json`), JSON.stringify({
      version: 1,
      agent: legacyAgent,
      session: legacySession ? { id: legacySession } : null,
      tasks: [{ id: "1", title: "legacy", status: "pending" }],
    }));
    const plugin = await RanchTasks({});
    await plugin["chat.message"](
      { sessionID: incomingSession },
      { parts: [{ type: "text", text: "fresh" }] },
    );
    const disk = parseStore(readFileSync(join(dir, "sessions", `${incomingSession}.json`), "utf8"));
    assert.equal(disk.ok, true, terminal);
    assert.deepEqual(disk.store.tasks.map((task) => task.title), adopt ? ["legacy"] : [], terminal);
    assert.equal(disk.store.session.first_prompt, "fresh", terminal);
  }
});

test("opencode plugin does nothing without HC_TERMINAL_ID", async () => {
  delete process.env.HC_TERMINAL_ID;
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  process.env.RANCH_HOME = home;
  const plugin = await RanchTasks({});
  await plugin.event({
    event: { type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "1", content: "a", status: "pending" }] } },
  });
  assert.equal(existsSync(join(home, ".herdr", "ranch", "tasks")), false);
  delete process.env.RANCH_HOME;
});

// ------------------------------------------------------ OpenCode 2.x plugin

/** Fake v2 host: records hook registrations, exposes a controllable bus. */
function fakeV2Ctx() {
  const hooks = { tool: {}, session: {} };
  const queue = [];
  let waiter = null;
  const ctx = {
    tool: { hook: (name, fn) => { hooks.tool[name] = fn; } },
    session: { hook: (name, fn) => { hooks.session[name] = fn; } },
    event: {
      subscribe: ({ signal }) => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => new Promise((resolve) => {
          if (queue.length) return resolve({ value: queue.shift(), done: false });
          waiter = (event) => {
            waiter = null;
            resolve({ value: event, done: false });
          };
          signal?.addEventListener("abort", () => {
            waiter = null;
            resolve({ done: true });
          }, { once: true });
        }),
      }),
    },
    emit: (event) => {
      if (waiter) waiter(event);
      else queue.push(event);
    },
  };
  return { ctx, hooks };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("opencode 2.x default export is the schema-valid object", () => {
  assert.equal(typeof opencodePlugin, "object");
  assert.notEqual(opencodePlugin, null);
  assert.equal(opencodePlugin.id, "ranch-tasks");
  assert.equal(typeof opencodePlugin.setup, "function");
  assert.equal(typeof opencodePlugin.server, "function");
});

test("opencode 2.x setup registers hooks and records todowrite + prompt", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t99" });
  const { ctx, hooks } = fakeV2Ctx();
  const cleanup = await opencodePlugin.setup(ctx);
  assert.equal(typeof cleanup, "function");
  assert.equal(typeof hooks.tool["execute.after"], "function");
  assert.equal(typeof hooks.session.prompt, "function");
  assert.equal(typeof hooks.session.context, "function");

  await hooks.tool["execute.after"]({
    tool: "todowrite",
    sessionID: "s1",
    status: "completed",
    input: {
      todos: [
        { id: "1", content: "read", status: "completed" },
        { id: "2", content: "write", status: "in_progress" },
        { id: "3", content: "ship", status: "pending" },
      ],
    },
  });
  const file = join(home, ".herdr", "ranch", "tasks", "sessions", "s1.json");
  assert.equal(JSON.parse(readFileSync(join(home, ".herdr", "ranch", "tasks", "terminals", "t99.json"), "utf8")).session, "s1");
  const disk = parseStore(readFileSync(file, "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.tasks.map((task) => [task.id, task.status]), [
    ["1", "completed"],
    ["2", "in_progress"],
    ["3", "pending"],
  ]);

  // The prompt hook records the first user message (text parts only).
  await hooks.session.prompt({
    sessionID: "s1",
    parts: [{ type: "text", text: "fix the " }, { type: "file", path: "x" }, { type: "text", text: "bug" }],
  });
  const after = parseStore(readFileSync(file, "utf8"));
  assert.equal(after.store.session.id, "s1");
  assert.equal(after.store.session.first_prompt, "fix the bug");

  cleanup();
});

test("opencode 2.x bus events drive session activity", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t99" });
  const { ctx, hooks } = fakeV2Ctx();
  const cleanup = await opencodePlugin.setup(ctx);
  const file = join(home, ".herdr", "ranch", "tasks", "sessions", "s1.json");

  ctx.emit({ type: "session.execution.started", properties: { sessionID: "s1" } });
  await flush();
  await flush();
  let disk = parseStore(readFileSync(file, "utf8"));
  assert.equal(disk.store.session.id, "s1");
  assert.equal(disk.store.session.activity.state, "working");

  ctx.emit({ type: "session.execution.succeeded", properties: { sessionID: "s1" } });
  await flush();
  await flush();
  disk = parseStore(readFileSync(file, "utf8"));
  assert.equal(disk.store.session.activity.state, "done");

  cleanup();
});

test("opencode 2.x context hook adds the task rule exactly once", async (t) => {
  // HOME points at a bare temp dir so no installer AGENTS.md block exists.
  withEnv(t, { RANCH_HOME: tempHome(), HC_TERMINAL_ID: "t99", HOME: tempHome() });
  const { ctx, hooks } = fakeV2Ctx();
  await opencodePlugin.setup(ctx);
  const out = { system: [{ type: "text", text: "base" }] };
  await hooks.session.context(out);
  await hooks.session.context(out);
  assert.equal(out.system.length, 2);
  assert.equal(out.system[1].type, "text");
  assert.match(out.system[1].text, /mandatory/);
});

test("opencode skips its rule when the installer block is in AGENTS.md (fixes F13)", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(home, ".config", "opencode", "AGENTS.md"),
    "# rules\n\n<!-- ranch-tasks:begin -->\nranch block\n<!-- ranch-tasks:end -->\n",
  );
  withEnv(t, { RANCH_HOME: tempHome(), HC_TERMINAL_ID: "t99", HOME: home });
  const { ctx, hooks } = fakeV2Ctx();
  await opencodePlugin.setup(ctx);
  const out = { system: [{ type: "text", text: "base" }] };
  await hooks.session.context(out);
  assert.equal(out.system.length, 1);
  // Same for the v1 host.
  const v1 = await RanchTasks({});
  const system = ["base"];
  await v1["experimental.chat.system.transform"]({}, { system });
  assert.deepEqual(system, ["base"]);
});

test("opencode 2.x hooks survive garbage input", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t99" });
  const { ctx, hooks } = fakeV2Ctx();
  const cleanup = await opencodePlugin.setup(ctx);
  for (const garbage of [null, {}, { tool: "todowrite" }, { tool: "todowrite", input: { todos: "no" } }]) {
    await hooks.tool["execute.after"](garbage);
    await hooks.session.prompt(garbage);
    await hooks.session.context(garbage);
    ctx.emit(garbage);
    ctx.emit({ type: "unknown.event", data: 42 });
  }
  await flush();
  assert.equal(existsSync(join(home, ".herdr", "ranch", "tasks")), false);
  assert.doesNotThrow(cleanup);
});

// ---------------------------------------------------------------- store / CLI

test("updateStore writes atomically under RANCH_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "t9";
  try {
    const path = terminalPath(home, "t9");
    assert.equal(path, join(home, ".herdr", "ranch", "tasks", "terminals", "t9.json"));

    updateStore("codex", (store) => applyCodex(store, {
      hook_event_name: "SessionStart", session_id: "s1", source: "startup",
    }));
    // A session id moves the store to sessions/ and leaves a pointer behind.
    const pointer = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(pointer.session, "s1");
    const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", "s1.json"), "utf8"));
    assert.equal(disk.ok, true);
    assert.deepEqual(disk.store.agent, { app: "codex", session: "s1", pid: process.pid });
    assert.equal(disk.store.session.id, "s1");
    assert.ok(disk.store.updated_at);
    assert.ok(disk.store.seq >= 1);
    for (const sub of ["terminals", "sessions"]) {
      assert.deepEqual(
        readdirSync(join(home, ".herdr", "ranch", "tasks", sub)).filter((f) => f.includes(".tmp-")),
        [],
      );
    }

    // corrupt pointer: start from an empty store
    writeFileSync(path, "{corrupt");
    updateStore("codex", (store) => {
      assert.deepEqual(store, emptyStore("t9", "codex"));
      return store;
    });
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

test("updateStore looks up terminal start time only when it is missing", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t-start" });
  const started = "2026-01-01T00:00:00.000Z";
  let calls = 0;
  const lookup = () => {
    calls += 1;
    return calls === 1 ? started : "2026-02-01T00:00:00.000Z";
  };
  updateStore("codex", (store) => ({ ...store }), lookup);
  updateStore("codex", (store) => ({ ...store }), lookup);
  assert.equal(calls, 1, "the stored start time is reused on the second event");
  const disk = parseStore(readFileSync(terminalPath(home, "t-start"), "utf8"));
  assert.equal(disk.store.terminal_started_at, started);
});

test("updateStore adopts legacy stores only for the same agent and session", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "unused" });
  const cases = [
    ["matching", "claude", "s1", "s1", true],
    ["legacy-without-session", "claude", null, "s2", true],
    ["other-agent", "codex", "s3", "s3", false],
    ["other-session", "claude", "old", "s4", false],
  ];
  for (const [terminal, legacyAgent, legacySession, incomingSession, adopt] of cases) {
    process.env.HC_TERMINAL_ID = terminal;
    const dir = join(home, ".herdr", "ranch", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${terminal}.json`), JSON.stringify({
      version: 1,
      agent: legacyAgent,
      session: legacySession ? { id: legacySession } : null,
      tasks: [{ id: "1", title: "legacy", status: "pending" }],
    }));
    const next = updateStore("claude", (store) => ({
      ...store,
      session: { id: incomingSession, title: null, title_source: null, first_prompt: null, state: "running" },
    }));
    assert.deepEqual(next.tasks.map((task) => task.title), adopt ? ["legacy"] : [], terminal);
  }
});

test("concurrent Claude TaskCreate hooks keep every task", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  const bin = join(repoRoot, "bin", "ranch-tasks");
  const env = { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: "parallel" };
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "claude"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "TaskCreate",
      tool_input: { subject: `Task ${i + 1}` },
      tool_response: `Task #${i + 1} created successfully`,
    }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "terminals", "parallel.json"), "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.tasks.map((task) => task.id).sort(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
});

test("updateStore without HC_TERMINAL_ID writes nothing", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  delete process.env.HC_TERMINAL_ID;
  process.env.RANCH_HOME = home;
  try {
    assert.equal(updateStore("codex", (s) => s), null);
    assert.equal(existsSync(join(home, ".herdr")), false);
  } finally {
    delete process.env.RANCH_HOME;
  }
});

test("hook subcommands print nothing and exit 0", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  const bin = join(repoRoot, "bin", "ranch-tasks");
  const base = { ...process.env, RANCH_HOME: home };
  delete base.HC_TERMINAL_ID;

  const run = (subcommand, input, terminal) => {
    const env = { ...base };
    if (terminal === undefined) delete env.HC_TERMINAL_ID;
    else env.HC_TERMINAL_ID = terminal;
    return spawnSync(process.execPath, [bin, subcommand], { input, encoding: "utf8", env });
  };

  // valid payload: silent, exit 0, store written
  const good = run("claude", JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "X", status: "pending" }] },
  }), "tcli");
  assert.equal(good.status, 0);
  assert.equal(good.stdout, "");
  assert.equal(good.stderr, "");
  const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "terminals", "tcli.json"), "utf8"));
  assert.equal(disk.store.tasks[0].title, "X");

  // garbage stdin: silent, exit 0, no crash
  for (const subcommand of ["claude", "codex"]) {
    const bad = run(subcommand, "not json{{", "tcli");
    assert.equal(bad.status, 0, `${subcommand} garbage stdin`);
    assert.equal(bad.stdout, "");
    assert.equal(bad.stderr, "");
  }

  // no HC_TERMINAL_ID: silent no-op
  const noTerm = run("claude", JSON.stringify({
    hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: [] },
  }), undefined);
  assert.equal(noTerm.status, 0);
  assert.equal(noTerm.stdout, "");
  assert.equal(noTerm.stderr, "");
});

// ---------------------------------------------------------------- install

// Real-world shape: comments, trailing commas.
const OPENCODE_JSONC = `{
  "$schema": "https://opencode.ai/config.json",
  // "disabled_providers": ["opencode"],
  "shell": "zsh",
  "plugins": [
    "@tarquinen/opencode-dcp@latest",
  ],
  "lsp": true,
}`;

test("enableOpencodeTodo inserts the experimental block into JSONC, keeps comments, is idempotent", () => {
  const first = enableOpencodeTodo(OPENCODE_JSONC);
  assert.equal(first.inserted, '\n  "experimental": { "todo": true },');
  assert.ok(first.text.startsWith('{\n  "experimental": { "todo": true },'));
  // comments and trailing commas survive
  assert.ok(first.text.includes('// "disabled_providers": ["opencode"],'));
  assert.ok(first.text.includes('"@tarquinen/opencode-dcp@latest",'));
  assert.ok(first.text.includes('"lsp": true,'));

  const second = enableOpencodeTodo(first.text);
  assert.deepEqual(second, { text: first.text, inserted: null });
});

test("enableOpencodeTodo inserts todo inside an existing experimental object", () => {
  const r = enableOpencodeTodo('{\n  "experimental": {\n    "background_compaction": true\n  }\n}');
  assert.equal(r.inserted, '"todo": true, ');
  assert.ok(r.text.includes('"experimental": {"todo": true, \n    "background_compaction": true'));
});

test("enableOpencodeTodo leaves todo off when the person set it", () => {
  const text = '{ "experimental": { "todo": false } }';
  const r = enableOpencodeTodo(text);
  assert.equal(r.inserted, null);
  assert.equal(r.text, text);
  assert.equal(r.action, "left todo off (set by you)");
});

test("enableOpencodeTodo ignores experimental words in comments and strings", () => {
  const comment = '{\n  // "experimental": { "todo": true }\n  "shell": "zsh",\n}';
  assert.equal(enableOpencodeTodo(comment).inserted, '\n  "experimental": { "todo": true },');
  const string = '{ "note": "turn on experimental todo here", "shell": "zsh" }';
  assert.equal(enableOpencodeTodo(string).inserted, '\n  "experimental": { "todo": true },');
});

test("install/uninstall round trip restores configs byte-for-byte", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-adapters-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  const opencodeConfig = join(home, ".config", "opencode", "opencode.jsonc");
  writeFileSync(opencodeConfig, OPENCODE_JSONC);
  const settings = join(home, ".claude", "settings.json");
  const original = JSON.stringify({
    model: "opus",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "rtk hook claude" }] }],
    },
  });
  writeFileSync(settings, original);

  process.env.RANCH_HOME = home;
  try {
    await install({ yes: true, agents: ["claude", "codex", "opencode"] });

    // existing hook untouched
    const merged = JSON.parse(readFileSync(settings, "utf8"));
    assert.deepEqual(merged.hooks.SessionStart[0], { hooks: [{ type: "command", command: "rtk hook claude" }] });
    assert.equal(merged.model, "opus");
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "SessionEnd", "Stop"]) {
      assert.ok(
        JSON.stringify(merged.hooks[event]).includes("/.herdr/ranch/bin/ranch-tasks"),
        `ranch handler for ${event}`,
      );
    }
    assert.equal(merged.hooks.PostToolUse.at(-1).matcher, "TodoWrite|TaskCreate|TaskUpdate|Bash");

    // codex hooks.json created with the update_plan + shell matcher (PR recording, I4)
    const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    assert.equal(codex.hooks.PostToolUse.at(-1).matcher, "update_plan|Bash|shell");
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "SessionEnd"]) {
      assert.ok(JSON.stringify(codex.hooks[event]).includes("/.herdr/ranch/bin/ranch-tasks"));
    }

    // opencode plugin copied, runtime copied, binary executable
    assert.ok(readFileSync(join(home, ".config", "opencode", "plugins", "ranch-tasks.js"), "utf8").includes("// ranch-tasks plugin"));
    assert.ok(existsSync(join(home, ".herdr", "ranch", "bin", "ranch-tasks")));
    assert.ok(existsSync(join(home, ".herdr", "ranch", "lib", "tasks.js")));

    // JSONC config got the todo flag without losing comments
    const enabled = readFileSync(opencodeConfig, "utf8");
    assert.ok(enabled.includes('"todo": true'));
    assert.ok(enabled.includes('// "disabled_providers": ["opencode"],'));
    assert.equal(statusSummary().opencodeTodo, true);

    // status: all installed while running from the repo
    assert.deepEqual(statusSummary().agents, { claude: "installed", codex: "installed", opencode: "installed" });

    // tamper with the installed cli.js -> outdated
    const installedCli = join(home, ".herdr", "ranch", "adapters", "cli.js");
    writeFileSync(installedCli, readFileSync(installedCli, "utf8") + "\n// tweaked\n");
    assert.equal(statusSummary().agents.claude, "outdated");

    // idempotent: a second install changes nothing
    const before = readFileSync(settings, "utf8");
    const configBefore = readFileSync(opencodeConfig, "utf8");
    await install({ yes: true, agents: ["claude", "codex", "opencode"] });
    assert.equal(readFileSync(settings, "utf8"), before);
    assert.equal(readFileSync(opencodeConfig, "utf8"), configBefore);
    // ...and the fresh runtime copy repairs the tampered one
    assert.deepEqual(statusSummary().agents, { claude: "installed", codex: "installed", opencode: "installed" });

    // uninstall restores everything
    await uninstall({ yes: true, agents: ["claude", "codex", "opencode"] });
    assert.equal(readFileSync(settings, "utf8"), original);
    assert.equal(readFileSync(opencodeConfig, "utf8"), OPENCODE_JSONC);
    assert.equal(existsSync(join(home, ".codex", "hooks.json")), false);
    assert.equal(existsSync(join(home, ".codex")), false);
    assert.equal(existsSync(join(home, ".config", "opencode", "plugins", "ranch-tasks.js")), false);
    assert.equal(statusSummary().opencodeTodo, false);
    assert.deepEqual(statusSummary().agents, { claude: "missing", codex: "missing", opencode: "missing" });
  } finally {
    delete process.env.RANCH_HOME;
  }
});

test("install creates a missing OpenCode config and uninstall deletes it", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["opencode"] });
  const file = join(home, ".config", "opencode", "opencode.json");
  assert.equal(readFileSync(file, "utf8"), '{\n  "experimental": { "todo": true }\n}\n');
  assert.equal(statusSummary().opencodeTodo, true);
  await uninstall({ yes: true, agents: ["opencode"] });
  assert.equal(existsSync(file), false);
  assert.equal(statusSummary().opencodeTodo, false);
});

test("uninstall keeps a Ranch-created OpenCode config the person has since edited", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["opencode"] });
  const file = join(home, ".config", "opencode", "opencode.json");
  writeFileSync(file, '{\n  "experimental": { "todo": true },\n  "shell": "zsh"\n}\n');
  await uninstall({ yes: true, agents: ["opencode"] });
  assert.equal(existsSync(file), true);
  const left = readFileSync(file, "utf8");
  assert.match(left, /"shell": "zsh"/);
  assert.doesNotMatch(left, /"todo"/);
  assert.equal(left, '{\n  "shell": "zsh"\n}\n');
});

test("hook events map to activity (status when Herdr shows none)", async () => {
  const { applyClaude, claudeActivity } = await import("../adapters/claude.js");
  const { applyCodex, codexActivity } = await import("../adapters/codex.js");
  const { emptyStore } = await import("../lib/tasks.js");
  assert.equal(claudeActivity({ hook_event_name: "UserPromptSubmit" }), "working");
  assert.equal(claudeActivity({ hook_event_name: "PermissionRequest" }), "blocked");
  assert.equal(claudeActivity({ hook_event_name: "Notification", message: "Claude needs your permission to use Bash" }), "blocked");
  assert.equal(claudeActivity({ hook_event_name: "Notification", message: "Claude is waiting for your input" }), "blocked");
  assert.equal(claudeActivity({ hook_event_name: "Notification", message: "hello" }), null);
  assert.equal(claudeActivity({ hook_event_name: "Stop" }), "done");
  assert.equal(codexActivity({ hook_event_name: "PermissionRequest" }), "blocked");
  const s1 = applyClaude(emptyStore("t1", "claude-code"), { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} });
  assert.equal(s1.session.activity.state, "working");
  assert.equal(typeof s1.session.activity.at, "number");
  const s2 = applyCodex(s1, { hook_event_name: "Stop" });
  assert.equal(s2.session.activity.state, "done");
  assert.equal(s1.session.activity.state, "working");
});

test("OpenCode events map to activity for the main session only", async () => {
  const { reduceOpencode } = await import("../adapters/opencode-plugin.js");
  const base = { version: 1, terminal: "t1", agent: "opencode", tasks: [], subagents: [],
    session: { id: "main", title: null, title_source: null, first_prompt: null, state: "running" } };
  const busy = reduceOpencode(base, { type: "session.status", properties: { sessionID: "main", status: { type: "busy" } } });
  assert.equal(busy.session.activity.state, "working");
  const again = reduceOpencode(busy, { type: "session.status", properties: { sessionID: "main", status: { type: "busy" } } });
  assert.equal(again, busy);
  const child = reduceOpencode(busy, { type: "permission.updated", properties: { id: "p", sessionID: "child" } });
  assert.equal(child.session.activity.state, "working");
  const perm = reduceOpencode(busy, { type: "permission.updated", properties: { id: "p", sessionID: "main" } });
  assert.equal(perm.session.activity.state, "blocked");
  const idle = reduceOpencode(perm, { type: "session.idle", properties: { sessionID: "main" } });
  assert.equal(idle.session.activity.state, "done");
});

test("mandatory task reporting: hook reminder, instruction files, OpenCode system prompt", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ranch-instr-"));
  const env = { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: "t1" };
  const run = (args, input) => spawnSync(process.execPath, ["bin/ranch-tasks", ...args], { env, input, encoding: "utf8" });

  // A prompt still gets the reminder while there is no list; other events
  // stay silent. Once a list exists and was updated this turn, it goes quiet.
  const prompt = run(["claude"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));
  assert.match(prompt.stdout, /Ranch \(mandatory\)/);
  assert.equal(run(["claude"], JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} })).stdout, "");
  assert.match(run(["codex"], JSON.stringify({ hook_event_name: "SessionStart", source: "startup" })).stdout, /update_plan/);
  fs.writeFileSync(
    path.join(home, ".herdr", "ranch", "tasks", "terminals", "t1.json"),
    JSON.stringify({ version: 2, terminal: "t1", agent: { app: "claude-code", session: null, pid: 1 }, seq: 1, missed_turns: 0, updated_at: "now", tasks: [{ id: "1", title: "X", status: "pending", active_form: null }], subagents: [] }) + "\n",
  );
  assert.equal(run(["claude"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), undefined).stdout, "");
  // A missed turn brings the nudge back even with a list.
  fs.writeFileSync(
    path.join(home, ".herdr", "ranch", "tasks", "terminals", "t1.json"),
    JSON.stringify({ version: 2, terminal: "t1", agent: { app: "claude-code", session: null, pid: 1 }, seq: 2, missed_turns: 1, updated_at: "now", tasks: [{ id: "1", title: "X", status: "pending", active_form: null }], subagents: [] }) + "\n",
  );
  assert.match(run(["claude"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" })).stdout, /Ranch \(mandatory\)/);
  // Silence it again by clearing the missed count.
  fs.writeFileSync(
    path.join(home, ".herdr", "ranch", "tasks", "terminals", "t1.json"),
    JSON.stringify({ version: 2, terminal: "t1", agent: { app: "claude-code", session: null, pid: 1 }, seq: 3, missed_turns: 0, updated_at: "now", tasks: [{ id: "1", title: "X", status: "pending", active_form: null }], subagents: [] }) + "\n",
  );
  assert.equal(run(["claude"], JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" })).stdout, "");

  // Install adds rules; uninstall restores CLAUDE.md byte for byte and deletes created files.
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const original = "# My rules\n\n@RTK.md\n";
  fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), original);
  assert.equal(run(["install", "--yes"]).status, 0);
  const claudeMd = fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(claudeMd, /@RANCH\.md/);
  assert.match(fs.readFileSync(path.join(home, ".claude", "RANCH.md"), "utf8"), /EVERY message/);
  assert.match(fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8"), /update_plan/);
  assert.match(fs.readFileSync(path.join(home, ".config", "opencode", "AGENTS.md"), "utf8"), /todowrite/);
  assert.equal(run(["install", "--yes"]).status, 0);
  assert.equal((fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8").match(/@RANCH\.md/g) ?? []).length, 1);
  assert.equal(run(["uninstall", "--yes"]).status, 0);
  assert.equal(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(home, ".claude", "RANCH.md")), false);
  assert.equal(fs.existsSync(path.join(home, ".config", "opencode", "AGENTS.md")), false);

  // OpenCode plugin adds the rule to the system prompt once — with HOME
  // redirected so the real AGENTS.md block (if any) is out of the picture.
  const savedHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ranch-home-"));
  try {
    const { RanchTasks } = await import("../adapters/opencode-plugin.js");
    const hooks = await RanchTasks({});
    const out = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({}, out);
    await hooks["experimental.chat.system.transform"]({}, out);
    assert.equal(out.system.length, 2);
    assert.match(out.system[1], /mandatory/);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  }
});

test("opencode 2.2 real payloads: prompt.text and session.renamed fill the session", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t98" });
  const { ctx, hooks } = fakeV2Ctx();
  const cleanup = await opencodePlugin.setup(ctx);
  const push = async (event) => { ctx.emit(event); await flush(); await flush(); };
  const sid = "ses_real1";
  // Shapes captured from OpenCode 2.2.6.
  await hooks.session.prompt({ sessionID: sid, messageID: "msg_1", prompt: { text: "Fix the login redirect loop", files: [] }, delivery: "steer" });
  await push({ id: "evt_1", type: "session.execution.started", data: { sessionID: sid } });
  await push({ id: "evt_2", type: "session.renamed", data: { sessionID: sid, title: "Login redirect fix" } });
  await flush();
  const store = JSON.parse(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", `${sid}.json`), "utf8"));
  assert.equal(store.session.id, sid);
  assert.equal(store.session.first_prompt, "Fix the login redirect loop");
  assert.equal(store.session.title, "Login redirect fix");
  assert.equal(store.session.activity.state, "working");
  if (typeof cleanup === "function") cleanup();
});
