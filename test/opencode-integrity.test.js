// Store-writer integrity for the OpenCode plugin (fixes §3.3, I9, F13):
// resuming a saved session in a new terminal must load it instead of
// overwriting it, the session file is written under its own lock, unreadable
// or newer-schema stores are never overwritten, malformed ones are
// quarantined, and failures are logged. Drives the plugin the same way
// test/adapters.test.js does (v1 RanchTasks host + env sandboxing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStore } from "../lib/tasks.js";
import opencodePlugin, { RanchTasks } from "../adapters/opencode-plugin.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-integrity-"));
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

function tasksDir(home) {
  return join(home, ".herdr", "ranch", "tasks");
}

function sessionFile(home, sid) {
  return join(tasksDir(home), "sessions", `${sid}.json`);
}

function pointerFile(home, terminal) {
  return join(tasksDir(home), "terminals", `${terminal}.json`);
}

function logFile(home) {
  return join(home, ".herdr", "ranch", "logs", "adapter.log");
}

/** A saved OpenCode session store with everything worth keeping. */
function savedStore(terminal) {
  return {
    version: 2,
    terminal,
    agent: { app: "opencode", session: "s1", pid: 1 },
    terminal_started_at: "2026-01-01T00:00:00.000Z",
    seq: 42,
    missed_turns: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    session: { id: "s1", title: "work", title_source: "agent", first_prompt: "p", state: "running" },
    tasks: [
      { id: "1", title: "a", status: "pending", active_form: null },
      { id: "2", title: "b", status: "completed", active_form: null },
    ],
    subagents: [{ id: "sub1", name: "sub", status: "running", started_at: "2026-01-01T00:00:00.000Z", ended_at: null }],
    prs: [{ url: "https://github.com/o/r/pull/1", number: 1, at: "2026-01-01T00:00:00.000Z" }],
  };
}

function writePointer(home, terminal, sid) {
  mkdirSync(join(tasksDir(home), "terminals"), { recursive: true });
  writeFileSync(pointerFile(home, terminal), JSON.stringify({
    version: 2,
    terminal,
    terminal_started_at: "2026-01-01T00:00:00.000Z",
    agent: { app: "opencode", session: sid, pid: 1 },
    session: sid,
    updated_at: "2026-01-01T00:00:00.000Z",
  }));
}

async function record(event) {
  const plugin = await RanchTasks({});
  await plugin.event({ event });
}

// ------------------------------------------------------- resume in new terminal

test("resuming session s1 in a new terminal keeps tasks, subagents and prs", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t2", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  writeFileSync(sessionFile(home, "s1"), JSON.stringify(savedStore("t1"), null, 2) + "\n");

  // First event in terminal t2 (no pointer, no legacy flat store): an idle for
  // the main session must adopt the saved store, not start from empty.
  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  const disk = parseStore(readFileSync(sessionFile(home, "s1"), "utf8"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.seq, 43);
  assert.deepEqual(disk.store.tasks.map((task) => task.title), ["a", "b"]);
  assert.deepEqual(disk.store.subagents.map((s) => s.id), ["sub1"]);
  assert.deepEqual(disk.store.prs, [{ url: "https://github.com/o/r/pull/1", number: 1, at: "2026-01-01T00:00:00.000Z" }]);
  assert.equal(disk.store.terminal, "t2");
  assert.deepEqual(disk.store.agent, { app: "opencode", session: "s1", pid: process.pid });
  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t2"), "utf8")).session, "s1");
});

test("a child event (parentID) as first event never touches the saved session store", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t2", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const before = JSON.stringify(savedStore("t1"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "s1"), before);

  await record({ type: "session.created", properties: { info: { id: "s1-child", parentID: "s1" } } });

  assert.equal(readFileSync(sessionFile(home, "s1"), "utf8"), before);
  // The terminal file (store until a main session is known) must not bind the
  // child id as the main session.
  const terminalStore = JSON.parse(readFileSync(pointerFile(home, "t2"), "utf8"));
  assert.notEqual(terminalStore.session?.id, "s1-child");
  assert.notEqual(terminalStore.agent?.session, "s1-child");
});

test("opencode takes over and overwrites a claude-owned session file when it binds that session", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t2", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  writeFileSync(sessionFile(home, "s1"), JSON.stringify({
    version: 2,
    terminal: "t1",
    agent: { app: "claude", session: "s1", pid: 2 },
    seq: 99,
    session: { id: "s1", title: "claude work", title_source: "user", first_prompt: "c", state: "running" },
    tasks: [{ id: "1", title: "claude task", status: "pending", active_form: null }],
  }));

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  // The claude store is never loaded (its tasks do not leak in), and because
  // OpenCode really binds s1 here, the file is rewritten as an opencode store.
  const disk = parseStore(readFileSync(sessionFile(home, "s1"), "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.agent, { app: "opencode", session: "s1", pid: process.pid });
  assert.deepEqual(disk.store.tasks, []);
  assert.equal(disk.store.seq, 1);
});

// ------------------------------------------------------- missing / broken stores

test("a missing session file is created fresh", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  const disk = parseStore(readFileSync(sessionFile(home, "s1"), "utf8"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.session.id, "s1");
  assert.equal(disk.store.seq, 1);
  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "s1");
});

test("a malformed session store is quarantined as .error and replaced", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const broken = "{this is not json\n";
  writeFileSync(sessionFile(home, "s1"), broken);

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  assert.equal(readFileSync(`${sessionFile(home, "s1")}.error`, "utf8"), broken);
  const disk = parseStore(readFileSync(sessionFile(home, "s1"), "utf8"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.session.id, "s1");
  assert.match(readFileSync(logFile(home), "utf8"), /quarantined invalid task store/);
});

test("a newer-schema store (version 3) is never overwritten", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const newer = JSON.stringify({ ...savedStore("t1"), version: 3 }, null, 2) + "\n";
  writeFileSync(sessionFile(home, "s1"), newer);

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  assert.equal(readFileSync(sessionFile(home, "s1"), "utf8"), newer);
  assert.match(readFileSync(logFile(home), "utf8"), /newer schema/);
});

test("an unreadable store (chmod 000) is never overwritten", async (t) => {
  if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
    return t.skip("needs unprivileged POSIX permissions");
  }
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const saved = JSON.stringify(savedStore("t1"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "s1"), saved);
  chmodSync(sessionFile(home, "s1"), 0o000);
  try {
    await record({ type: "session.idle", properties: { sessionID: "s1" } });
  } finally {
    // Restore first: the assertion itself must be able to read the file.
    chmodSync(sessionFile(home, "s1"), 0o644);
  }
  assert.equal(readFileSync(sessionFile(home, "s1"), "utf8"), saved);
  assert.match(readFileSync(logFile(home), "utf8"), /store unreadable/);
});

// ------------------------------------------------------- session switching

test("session.created for a new main session starts a complete empty store", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const before = JSON.stringify({
    ...savedStore("t1"),
    missed_turns: 2,
  }, null, 2) + "\n";
  writeFileSync(sessionFile(home, "s1"), before);

  await record({ type: "session.created", properties: { info: { id: "s2" } } });

  const fresh = parseStore(readFileSync(sessionFile(home, "s2"), "utf8"));
  assert.equal(fresh.ok, true);
  assert.equal(fresh.store.session.id, "s2");
  assert.deepEqual(fresh.store.tasks, []);
  assert.deepEqual(fresh.store.subagents, []);
  assert.deepEqual(fresh.store.prs, []);
  assert.equal(fresh.store.missed_turns, 0);
  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "s2");
  assert.equal(readFileSync(sessionFile(home, "s1"), "utf8"), before);
});

// ------------------------------------------------------- TUI session select

/** A saved store for an arbitrary session id (same shape as savedStore). */
function savedStoreFor(terminal, sid, taskTitle) {
  return {
    ...savedStore(terminal),
    agent: { app: "opencode", session: sid, pid: 1 },
    session: { id: sid, title: `work ${sid}`, title_source: "agent", first_prompt: "p", state: "running" },
    tasks: [{ id: "1", title: taskTitle, status: "pending", active_form: null }],
  };
}

test("tui.session.select re-points the terminal to a session with a store, keeping that store's tasks", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const aBefore = JSON.stringify(savedStoreFor("t1", "sA", "a"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "sA"), aBefore);
  writeFileSync(sessionFile(home, "sB"), JSON.stringify(savedStoreFor("t1", "sB", "b"), null, 2) + "\n");
  writePointer(home, "t1", "sA");

  await record({ type: "tui.session.select", properties: { sessionID: "sB" } });

  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "sB");
  const b = parseStore(readFileSync(sessionFile(home, "sB"), "utf8"));
  assert.equal(b.ok, true);
  assert.equal(b.store.session.id, "sB");
  assert.deepEqual(b.store.tasks.map((task) => task.title), ["b"]);
  // A's own store is untouched, so selecting it again restores its tasks.
  assert.equal(readFileSync(sessionFile(home, "sA"), "utf8"), aBefore);
});

test("tui.session.select to a session without a store starts fresh and leaves the old store untouched", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const aBefore = JSON.stringify(savedStoreFor("t1", "sA", "a"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "sA"), aBefore);
  writePointer(home, "t1", "sA");

  await record({ type: "tui.session.select", properties: { sessionID: "sC" } });

  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "sC");
  const c = parseStore(readFileSync(sessionFile(home, "sC"), "utf8"));
  assert.equal(c.ok, true);
  assert.equal(c.store.session.id, "sC");
  assert.deepEqual(c.store.tasks, []);
  assert.deepEqual(c.store.subagents, []);
  assert.equal(c.store.missed_turns, 0);
  assert.equal(readFileSync(sessionFile(home, "sA"), "utf8"), aBefore);
});

test("tui.session.select back to a previously stored session shows its tasks again", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const aBefore = JSON.stringify(savedStoreFor("t1", "sA", "a"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "sA"), aBefore);
  writeFileSync(sessionFile(home, "sC"), JSON.stringify(savedStoreFor("t1", "sC", "c"), null, 2) + "\n");
  writePointer(home, "t1", "sC");

  await record({ type: "tui.session.select", properties: { sessionID: "sA" } });

  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "sA");
  const a = parseStore(readFileSync(sessionFile(home, "sA"), "utf8"));
  assert.deepEqual(a.store.tasks.map((task) => task.title), ["a"]);
});

test("selecting the session already shown is a no-op (no write, no seq bump)", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const aBefore = JSON.stringify(savedStoreFor("t1", "sA", "a"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "sA"), aBefore);
  writePointer(home, "t1", "sA");

  await record({ type: "tui.session.select", properties: { sessionID: "sA" } });

  assert.equal(readFileSync(sessionFile(home, "sA"), "utf8"), aBefore);
  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "sA");
});

test("a todo.updated for a session without a store never mixes into the selected session's store", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  writeFileSync(sessionFile(home, "sA"), JSON.stringify(savedStoreFor("t1", "sA", "a"), null, 2) + "\n");
  writeFileSync(sessionFile(home, "sB"), JSON.stringify(savedStoreFor("t1", "sB", "b"), null, 2) + "\n");
  writePointer(home, "t1", "sA");
  await record({ type: "tui.session.select", properties: { sessionID: "sB" } });

  await record({ type: "todo.updated", properties: { sessionID: "sX", todos: [{ id: "1", content: "stray", status: "pending" }] } });

  // The never-mix guard: B's store keeps only B's tasks, nothing is written
  // for sX, and the pointer stays on the selected session.
  const b = parseStore(readFileSync(sessionFile(home, "sB"), "utf8"));
  assert.deepEqual(b.store.tasks.map((task) => task.title), ["b"]);
  assert.equal(JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8")).session, "sB");
  assert.equal(existsSync(join(tasksDir(home), "sessions", "sX.json")), false);
});

// ------------------------------------------------------- locking

test("a held session lock blocks the write and is reported, without throwing", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });
  writePointer(home, "t1", "s1");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  const saved = JSON.stringify(savedStore("t1"), null, 2) + "\n";
  writeFileSync(sessionFile(home, "s1"), saved);
  // A freshly created lock file: never stale, so the wait times out.
  writeFileSync(`${sessionFile(home, "s1")}.lock`, "held");

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  assert.equal(readFileSync(sessionFile(home, "s1"), "utf8"), saved);
  assert.match(readFileSync(logFile(home), "utf8"), /store lock busy/);
});

test("two sessions served through one terminal both stay in the pointer index", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1", HOME: home });

  await record({ type: "session.created", properties: { info: { id: "sA", title: "Alpha" } } });
  await record({ type: "session.created", properties: { info: { id: "sB", title: "Beta" } } });

  const pointer = JSON.parse(readFileSync(pointerFile(home, "t1"), "utf8"));
  assert.equal(pointer.session, "sB");
  assert.deepEqual(pointer.sessions.map(({ id, title }) => ({ id, title })), [
    { id: "sB", title: "Beta" },
    { id: "sA", title: "Alpha" },
  ]);
});

// ------------------------------------------------------- AGENTS.md marker

/** Fake v2 host (same shape as test/adapters.test.js). */
function fakeV2Ctx() {
  const hooks = { tool: {}, session: {} };
  const ctx = {
    tool: { hook: (name, fn) => { hooks.tool[name] = fn; } },
    session: { hook: (name, fn) => { hooks.session[name] = fn; } },
    event: { subscribe: () => ({ [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }) }) },
  };
  return { ctx, hooks };
}

test("the AGENTS.md block is read from RANCH_HOME, not HOME", async (t) => {
  // HOME holds the installer's marked block; RANCH_HOME is a clean dir. The
  // plugin must follow RANCH_HOME and therefore add its own rule.
  const homeWithBlock = tempHome();
  mkdirSync(join(homeWithBlock, ".config", "opencode"), { recursive: true });
  writeFileSync(
    join(homeWithBlock, ".config", "opencode", "AGENTS.md"),
    "# rules\n\n<!-- ranch-tasks:begin -->\nranch block\n<!-- ranch-tasks:end -->\n",
  );
  withEnv(t, { RANCH_HOME: tempHome(), HC_TERMINAL_ID: "t99", HOME: homeWithBlock });

  const { ctx, hooks } = fakeV2Ctx();
  await opencodePlugin.setup(ctx);
  const out = { system: [{ type: "text", text: "base" }] };
  await hooks.session.context(out);
  assert.equal(out.system.length, 2);
  assert.match(out.system[1].text, /mandatory/);

  // Same for the v1 host.
  const v1 = await RanchTasks({});
  const system = ["base"];
  await v1["experimental.chat.system.transform"]({}, { system });
  assert.equal(system.length, 2);
  assert.match(system[1], /mandatory/);
});

test("a terminal sharing a session keeps its own start time in its pointer (finding 3)", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t2", HOME: home });
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  writeFileSync(sessionFile(home, "s1"), JSON.stringify({ ...savedStore("t1"), terminal_started_at: "2026-01-01T00:00:00.000Z" }, null, 2) + "\n");
  mkdirSync(join(tasksDir(home), "terminals"), { recursive: true });
  writeFileSync(pointerFile(home, "t2"), JSON.stringify({
    version: 2, terminal: "t2", terminal_started_at: "2026-02-02T00:00:00.000Z",
    agent: { app: "opencode", session: "s1", pid: 2 }, session: "s1", updated_at: "2026-02-02T00:00:00.000Z",
  }));

  await record({ type: "session.idle", properties: { sessionID: "s1" } });

  const pointer = JSON.parse(readFileSync(pointerFile(home, "t2"), "utf8"));
  assert.equal(pointer.session, "s1");
  assert.equal(pointer.terminal_started_at, "2026-02-02T00:00:00.000Z");
  assert.ok(parseStore(readFileSync(sessionFile(home, "s1"), "utf8")).store.seq > 42);
});
