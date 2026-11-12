// Golden payload fixtures (fixes 3.9) and reader-side scenarios (fixes 3.3,
// 3.5): every fixture is a real hook payload shape, run through the adapter
// that would receive it; the scenarios exercise the store's identity rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyStore, listLifecycle, listVisible, parseStore, pointerSession } from "../lib/tasks.js";
import { applyClaude } from "../adapters/claude.js";
import { applyCodex } from "../adapters/codex.js";
import { RanchTasks, reduceOpencode } from "../adapters/opencode-plugin.js";
import { readStore, terminalPath, updateStore } from "../adapters/store.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

// ---------------------------------------------------------------- fixtures

test("fixture: Claude TodoWrite replaces tasks, keeps active_form (3.2)", () => {
  const store = applyClaude(emptyStore("t1", "claude"), load("claude-todowrite.json"));
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Read the spec", status: "completed", active_form: "reading the spec" },
    { id: "2", title: "Implement the fix", status: "in_progress", active_form: "implementing the fix" },
    { id: "3", title: "Write the tests", status: "pending", active_form: "writing the tests" },
  ]);
});

test("fixture: Claude SessionStart with startup clears the list", () => {
  let store = applyClaude(emptyStore("t1", "claude"), load("claude-todowrite.json"));
  store = applyClaude(store, load("claude-session-start.json"));
  assert.equal(store.tasks.length, 0);
  assert.equal(store.session.id, "ses_golden1");
  assert.equal(store.session.state, "running");
});

test("fixture: Claude Stop marks the session done without adding a hook", () => {
  let store = applyClaude(emptyStore("t1", "claude"), load("claude-todowrite.json"));
  store = applyClaude(store, load("claude-stop.json"));
  assert.equal(store.session.activity.state, "done");
  // Close-out is a reader-side flag (3.5), never a blocking Stop hook here.
  assert.deepEqual(store.tasks.map((t) => t.status), ["completed", "in_progress", "pending"]);
});

test("fixture: Codex update_plan replaces tasks without active_form", () => {
  const store = applyCodex(emptyStore("t1", "codex"), load("codex-update-plan.json"));
  assert.deepEqual(store.tasks, [
    { id: "1", title: "Survey the repo", status: "completed", active_form: null },
    { id: "2", title: "Patch the reducer", status: "in_progress", active_form: null },
    { id: "3", title: "Run the tests", status: "pending", active_form: null },
  ]);
});

test("fixture: OpenCode todowrite tool hook replaces tasks", () => {
  const payload = load("opencode-todowrite.json");
  const store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "todo.updated",
    properties: { sessionID: payload.sessionID, todos: payload.input.todos },
  });
  assert.deepEqual(store.tasks.map((t) => [t.id, t.status]), [
    ["1", "completed"],
    ["2", "in_progress"],
    ["3", "pending"],
  ]);
});

test("fixture: OpenCode v2 bus todo.updated is recorded (3.1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-fixtures-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    RANCH_HOME: process.env.RANCH_HOME,
    HC_TERMINAL_ID: process.env.HC_TERMINAL_ID,
  };
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "fx";
  // HOME and USERPROFILE both: on Windows os.homedir() reads USERPROFILE, so
  // the isolation must cover it too (no AGENTS.md block: the rule hook stays
  // silent).
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const plugin = await RanchTasks({});
    await plugin.event({ event: load("opencode-todo-updated.json") });
    const disk = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", "ses_golden2.json"), "utf8"));
    assert.equal(disk.ok, true);
    assert.deepEqual(disk.store.tasks.map((t) => [t.id, t.status]), [
      ["1", "completed"],
      ["2", "completed"],
      ["3", "in_progress"],
    ]);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ------------------------------------------------------- reader scenarios

test("scenario: terminal reuse hides the previous run's list (3.3/F4)", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-scen-"));
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "t-reuse";
  try {
    updateStore("claude", (store) => applyClaude(store, load("claude-todowrite.json")));
    // The store lives in the terminal file until a session id exists.
    const text = readFileSync(terminalPath(home, "t-reuse"), "utf8");
    const sid = pointerSession(text);
    const disk = parseStore(
      sid
        ? readFileSync(join(home, ".herdr", "ranch", "tasks", "sessions", `${sid}.json`), "utf8")
        : text,
    );
    assert.equal(disk.ok, true);
    // Simulate terminal reuse: the terminal restarted with a different start
    // time, so the previous run's store no longer matches the live terminal.
    const started = Date.parse(disk.store.terminal_started_at) - 60_000;
    const live = { state: "live", app: "claude", startedAt: started };
    const mine = { ok: true, store: { ...disk.store, terminal_started_at: new Date(started).toISOString() } };
    assert.equal(listVisible(mine, live), true);
    // ...but the run in the NEW terminal is not this one: hidden.
    assert.equal(listVisible(disk, live), false);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

test("scenario: a session resumed in a new terminal keeps its tasks (3.3)", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-scen-"));
  try {
    // Legacy flat store under the new terminal's address, left there by the
    // previous run in this terminal.
    mkdirSync(join(home, ".herdr", "ranch", "tasks"), { recursive: true });
    writeFileSync(
      join(home, ".herdr", "ranch", "tasks", "t-new.json"),
      JSON.stringify({ version: 1, terminal: "t-new", agent: "claude", updated_at: "2026-01-01T00:00:00.000Z", tasks: [{ id: "1", title: "Carried over", status: "pending", active_form: null }], subagents: [] }),
    );
    process.env.RANCH_HOME = home;
    process.env.HC_TERMINAL_ID = "t-new";
    updateStore("claude", (store) => ({ ...store, tasks: [...store.tasks] }));
    const flat = parseStore(readFileSync(join(home, ".herdr", "ranch", "tasks", "terminals", "t-new.json"), "utf8"));
    assert.equal(flat.ok, true);
    assert.deepEqual(flat.store.tasks.map((t) => t.title), ["Carried over"]);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

test("scenario: out-of-order events never lower the seq (3.3)", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-scen-"));
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "t-seq";
  try {
    updateStore("claude", (store) => ({ ...store, seq: 5 }));
    // A stale reducer result (e.g. an out-of-order replay) cannot overwrite
    // the newer seq on disk: the writer takes the max and increments.
    updateStore("claude", (store) => ({ ...store, seq: 0 }));
    const disk = parseStore(readFileSync(terminalPath(home, "t-seq"), "utf8"));
    assert.equal(disk.ok, true);
    assert.ok(disk.store.seq > 5, `seq ${disk.store.seq} should exceed 5`);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

test("scenario: idle with in_progress work flags the list (3.5)", () => {
  const store = applyClaude(emptyStore("t1", "claude"), load("claude-todowrite.json"));
  const stopped = applyClaude(store, load("claude-stop.json"));
  const disk = parseStore(JSON.stringify(stopped));
  assert.equal(disk.ok, true);
  const lc = listLifecycle(disk.store, "done", Date.now());
  assert.equal(lc.flag, true, "in_progress task + idle agent -> flag");
  assert.equal(lc.hide, false);
});

test("scenario: a corrupt store is quarantined, logged and re-read empty (3.2)", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-scen-"));
  const savedHome = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  try {
    mkdirSync(join(home, ".herdr", "ranch", "tasks", "terminals"), { recursive: true });
    const path = join(home, ".herdr", "ranch", "tasks", "terminals", "t-bad.json");
    writeFileSync(path, "{corrupt");
    const store = readStore(path, "claude", "t-bad");
    assert.deepEqual(store, emptyStore("t-bad", "claude"));
    assert.equal(existsSync(path), false, "malformed file moved aside");
    assert.equal(existsSync(`${path}.error`), true);
    const log = join(home, ".herdr", "ranch", "logs", "adapter.log");
    assert.equal(existsSync(log), true, "quarantine is visible in the adapter log");
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /quarantined invalid task store/);

    // A newer schema is left intact for the newer writer, without a log entry.
    const newer = join(home, ".herdr", "ranch", "tasks", "terminals", "t-newer.json");
    writeFileSync(newer, JSON.stringify({ version: 3, tasks: [{ title: "keep" }] }));
    assert.deepEqual(readStore(newer, "claude", "t-newer"), emptyStore("t-newer", "claude"));
    assert.equal(parseStore(readFileSync(newer, "utf8")).reason, "newer");
    assert.equal(existsSync(`${newer}.error`), false);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  } finally {
    if (savedHome === undefined) delete process.env.RANCH_HOME;
    else process.env.RANCH_HOME = savedHome;
  }
});

test("listVisible treats claude-code and claude as the same app", async () => {
  const { listVisible, parseStore } = await import("../lib/tasks.js");
  const parsed = parseStore(JSON.stringify({ version: 2, agent: { app: "claude-code", session: "s", pid: 1 }, tasks: [] }));
  assert.equal(listVisible(parsed, { state: "live", app: "claude" }), true);
  assert.equal(listVisible(parsed, { state: "live", app: "claude-code" }), true);
  assert.equal(listVisible(parsed, { state: "live", app: "codex" }), false);
});

test("a new session id in the same terminal writes the new session file the pointer names", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-sid-"));
  const saved = { RANCH_HOME: process.env.RANCH_HOME, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID };
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "tclear";
  try {
    const started = () => "2026-01-01T00:00:00.000Z";
    const withSession = (sid, title) => (s) => ({ ...s, session: { ...(s.session ?? {}), id: sid }, tasks: [{ id: "1", title, status: "pending", active_form: null }] });
    updateStore("claude-code", withSession("s-old", "old"), started);
    updateStore("claude-code", withSession("s-new", "new"), started);
    const pointer = JSON.parse(readFileSync(terminalPath(home, "tclear"), "utf8"));
    assert.equal(pointer.session, "s-new");
    const store = JSON.parse(readFileSync(join(home, ".herdr/ranch/tasks/sessions/s-new.json"), "utf8"));
    assert.equal(store.tasks[0].title, "new");
    const old = JSON.parse(readFileSync(join(home, ".herdr/ranch/tasks/sessions/s-old.json"), "utf8"));
    assert.equal(old.tasks[0].title, "old");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("cancelled tasks parse under strict validation and count as finished for the hide rule", () => {
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const parsed = parseStore(JSON.stringify({
    version: 2, updated_at: old,
    tasks: [{ id: "1", title: "a", status: "completed" }, { id: "2", title: "b", status: "cancelled" }],
  }));
  assert.equal(parsed.ok, true);
  assert.equal(listLifecycle(parsed.store, "idle", Date.now()).hide, true);
});
