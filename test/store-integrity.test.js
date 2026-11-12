// Store-integrity tests (fixes: session locks, cross-session binds, refusal to
// overwrite unreadable/newer stores, shared-PR registry hardening, and the
// reader-side pointer identity overlay). Tests run against temp RANCH_HOME
// dirs only; see test/adapters.test.js for the withEnv pattern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyStore, listVisible, parseStore, withPointerIdentity } from "../lib/tasks.js";
import { applyClaude } from "../adapters/claude.js";
import { applyCodex } from "../adapters/codex.js";
import { recordSharedPr, sessionPath, terminalPath, updateStore } from "../adapters/store.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Temp dirs live in os.tmpdir() and are left for the OS to clean; tests must
// never delete anything outside them, so no cleanup is attempted here.
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

function writeStoreFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function writePointer(home, terminal, session, app = "claude-code") {
  writeStoreFile(terminalPath(home, terminal), {
    version: 2,
    terminal,
    terminal_started_at: "2026-01-01T00:00:00.000Z",
    agent: { app, session, pid: 1 },
    session,
    updated_at: "2026-01-01T00:01:00.000Z",
  });
}

/** A full schema-2 store bound to session A, with data that must not leak. */
function storeA(overrides = {}) {
  return {
    version: 2,
    terminal: "t1",
    agent: { app: "claude-code", session: "A", pid: 1 },
    terminal_started_at: "2026-01-01T00:00:00.000Z",
    seq: 5,
    missed_turns: 3,
    updated_at: "2026-01-01T00:01:00.000Z",
    session: {
      id: "A", title: "A", title_source: "user", first_prompt: "hi",
      state: "running", activity: null,
      turn: { tasks: "[[\"1\",\"pending\",\"one\"]]", tools: true },
    },
    tasks: [
      { id: "1", title: "one", status: "pending", active_form: null },
      { id: "2", title: "two", status: "in_progress", active_form: "Two" },
    ],
    subagents: [],
    prs: [{ url: "https://github.com/o/r/pull/9", number: 9, at: "2026-01-01T00:02:00.000Z" }],
    ...overrides,
  };
}

const noLookup = () => null;

// ------------------------------------------------------------- cross-session

test("resume binds a terminal to an existing different session without copying the old one's data", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  const bPath = sessionPath(home, "B");
  writeStoreFile(aPath, storeA({ seq: 5 }));
  writeStoreFile(bPath, {
    ...emptyStore("t0", "claude-code"),
    agent: { app: "claude-code", session: "B", pid: 2 },
    session: { id: "B", title: null, title_source: null, first_prompt: null, state: "running", activity: null, turn: null },
    seq: 7,
    tasks: [{ id: "1", title: "b task", status: "pending", active_form: null }],
  });
  writePointer(home, "t1", "A");
  const aBytes = readFileSync(aPath);

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "SessionStart",
    session_id: "B",
    source: "resume",
  }), noLookup);

  assert.deepEqual(next.tasks.map((task) => task.title), ["b task"]);
  assert.deepEqual(next.prs, []);
  assert.equal(next.missed_turns, 0);
  assert.equal(next.seq, 8);
  assert.equal(next.session?.id, "B");
  assert.deepEqual(readFileSync(aPath), aBytes); // A untouched byte-for-byte
  const disk = parseStore(readFileSync(bPath, "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.tasks.map((task) => task.title), ["b task"]);
  assert.equal(disk.store.seq, 8);
  const pointer = JSON.parse(readFileSync(terminalPath(home, "t1"), "utf8"));
  assert.equal(pointer.session, "B");
  assert.equal(pointer.agent?.session, "B");
});

test("Claude /clear into a new session starts completely empty", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, storeA());
  writePointer(home, "t1", "A");
  const aBytes = readFileSync(aPath);

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "SessionStart",
    session_id: "C",
    source: "clear",
  }), noLookup);

  assert.deepEqual(next.tasks, []);
  assert.deepEqual(next.subagents, []);
  assert.deepEqual(next.prs, []);
  assert.equal(next.missed_turns, 0);
  assert.equal(next.session?.id, "C");
  assert.equal(next.session?.turn, undefined);
  assert.deepEqual(readFileSync(aPath), aBytes);
});

test("Codex startup into a new session starts completely empty", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  writeStoreFile(sessionPath(home, "A"), {
    ...storeA(),
    agent: { app: "codex", session: "A", pid: 1 },
  });
  writePointer(home, "t1", "A", "codex");

  const next = updateStore("codex", (store) => applyCodex(store, {
    hook_event_name: "SessionStart",
    session_id: "D",
    source: "startup",
  }), noLookup);

  assert.deepEqual(next.tasks, []);
  assert.deepEqual(next.prs, []);
  assert.equal(next.missed_turns, 0);
  assert.equal(next.session?.id, "D");
});

test("Claude PostToolUse for a different session resets without a SessionStart", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  writeStoreFile(sessionPath(home, "A"), storeA());
  writePointer(home, "t1", "A");

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "PostToolUse",
    session_id: "C2",
    tool_name: "Bash",
  }), noLookup);

  assert.deepEqual(next.prs, []);
  assert.equal(next.missed_turns, 0);
  assert.equal(next.session?.id, "C2");
});

test("same-session resume in a NEW terminal adopts the existing session store", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t2" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, { ...storeA({ seq: 4, missed_turns: 0 }) });

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "UserPromptSubmit",
    session_id: "A",
    prompt: "continue",
  }), noLookup);

  assert.deepEqual(next.tasks.map((task) => task.title), ["one", "two"]);
  assert.deepEqual(next.prs.map((pr) => pr.number), [9]);
  assert.equal(next.seq, 5);
  assert.equal(next.terminal, "t2");
});

test("a terminal sharing a session keeps its own start time in its pointer (finding 3)", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t2" });
  // sessions/A.json was last written by t1 (start 2026-01-01); t2's pointer has its own start.
  writeStoreFile(sessionPath(home, "A"), storeA());
  writePointer(home, "t1", "A");
  const t1Before = readFileSync(terminalPath(home, "t1"), "utf8");
  writeStoreFile(terminalPath(home, "t2"), {
    version: 2, terminal: "t2", terminal_started_at: "2026-02-02T00:00:00.000Z",
    agent: { app: "claude-code", session: "A", pid: 2 }, session: "A", updated_at: "2026-02-02T00:01:00.000Z",
  });

  updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "UserPromptSubmit", session_id: "A", prompt: "go",
  }), noLookup);

  const t2Pointer = JSON.parse(readFileSync(terminalPath(home, "t2"), "utf8"));
  assert.equal(t2Pointer.terminal_started_at, "2026-02-02T00:00:00.000Z");
  assert.equal(t2Pointer.session, "A");
  assert.equal(readFileSync(terminalPath(home, "t1"), "utf8"), t1Before);
  // Each reader sees the list through its own pointer's identity.
  const parsed = parseStore(readFileSync(sessionPath(home, "A"), "utf8"));
  const forT1 = withPointerIdentity(parsed, t1Before);
  const forT2 = withPointerIdentity(parsed, JSON.stringify(t2Pointer));
  assert.equal(listVisible(forT1, { startedAt: "2026-01-01T00:00:00.000Z" }), true);
  assert.equal(listVisible(forT2, { startedAt: "2026-02-02T00:00:00.000Z" }), true);
});

test("compaction keeps tasks and prs", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, { ...storeA({ seq: 4, missed_turns: 1 }) });
  writePointer(home, "t1", "A");

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "SessionStart",
    session_id: "A",
    source: "compact",
  }), noLookup);

  assert.deepEqual(next.tasks.map((task) => task.title), ["one", "two"]);
  assert.deepEqual(next.prs.map((pr) => pr.number), [9]);
  assert.equal(next.missed_turns, 1);
  assert.equal(next.seq, 5);
});

// ------------------------------------------------------------------- locking

test("an update from t2 refuses to write session A while t1 holds its lock", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t2" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, { ...storeA({ seq: 4 }) });
  writePointer(home, "t2", "A");
  const aBytes = readFileSync(aPath);
  mkdirSync(dirname(aPath), { recursive: true });
  writeFileSync(`${aPath}.lock`, "held by t1"); // fresh mtime, never stolen

  assert.throws(() => updateStore("claude-code", (store) => ({
    ...store,
    tasks: [...store.tasks, { id: "9", title: "sneaky", status: "pending", active_form: null }],
  }), noLookup), /store lock busy/);
  assert.deepEqual(readFileSync(aPath), aBytes); // nothing written without the lock
});

test("eight processes on two terminals keep every task of the shared session", async () => {
  const home = tempHome();
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, {
    ...emptyStore("t1", "claude-code"),
    agent: { app: "claude-code", session: "A", pid: 1 },
    session: { id: "A", title: null, title_source: null, first_prompt: null, state: "running", activity: null, turn: null },
  });
  const bin = join(repoRoot, "bin", "ranch-tasks");
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, "claude"], {
      env: { ...process.env, RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: i % 2 ? "t2" : "t1" },
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr: child.stderr.read() }));
    child.stdin.end(JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "TaskCreate",
      tool_input: { subject: `Task ${i + 1}` },
      tool_response: `Task #${i + 1} created successfully`,
      session_id: "A",
    }));
  }));
  const results = await Promise.all(runs);
  for (const result of results) assert.equal(result.code, 0);
  const disk = parseStore(readFileSync(aPath, "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(disk.store.tasks.map((task) => task.id).sort(), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.equal(disk.store.seq, 8);
  for (const terminal of ["t1", "t2"]) {
    const pointer = JSON.parse(readFileSync(terminalPath(home, terminal), "utf8"));
    assert.equal(pointer.session, "A");
  }
});

// ------------------------------------------------------------ writer refusal

test("updateStore refuses to overwrite a newer-schema store", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  const newer = { ...storeA(), version: 3 };
  writeStoreFile(aPath, newer);
  writePointer(home, "t1", "A");
  const bytes = readFileSync(aPath);

  assert.throws(() => updateStore("claude-code", (store) => store, noLookup),
    /store has a newer schema, not overwritten/);
  assert.deepEqual(readFileSync(aPath), bytes);
});

test("updateStore refuses to overwrite an unreadable store", { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) }, (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, storeA());
  writePointer(home, "t1", "A");
  const bytes = readFileSync(aPath);
  chmodSync(aPath, 0o000);

  assert.throws(() => updateStore("claude-code", (store) => store, noLookup),
    /store unreadable, not overwritten/);
  // Unreadable to us too, so compare by stat: same bytes, no quarantine.
  assert.equal(statSync(aPath).size, bytes.length);
  assert.equal(existsSync(`${aPath}.error`), false);
});

test("updateStore quarantines an invalid store and writes a fresh one", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "t1" });
  const aPath = sessionPath(home, "A");
  writeStoreFile(aPath, { not: "json at all" });
  writeFileSync(aPath, "this is not json"); // raw invalid bytes
  const broken = readFileSync(aPath);
  writePointer(home, "t1", "A");

  const next = updateStore("claude-code", (store) => applyClaude(store, {
    hook_event_name: "UserPromptSubmit",
    session_id: "A",
    prompt: "fresh start",
  }), noLookup);

  assert.equal(next.session?.id, "A");
  assert.deepEqual(next.tasks, []);
  const disk = parseStore(readFileSync(aPath, "utf8"));
  assert.equal(disk.ok, true);
  assert.deepEqual(readFileSync(`${aPath}.error`), broken);
});

// -------------------------------------------------------------- shared PRs

test("recordSharedPr quarantines an invalid registry and writes the record", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home });
  const prsPath = join(home, ".herdr", "ranch", "prs.json");
  mkdirSync(dirname(prsPath), { recursive: true });
  writeFileSync(prsPath, "not json {");
  const broken = readFileSync(prsPath);

  recordSharedPr("top", "branch", { url: "https://github.com/o/r/pull/1", number: 1, at: "2026-01-01T00:00:00.000Z" });

  assert.deepEqual(readFileSync(`${prsPath}.error`), broken);
  const text = readFileSync(prsPath, "utf8");
  assert.match(text, /pull\/1/);
});

test("recordSharedPr throws on an unreadable registry", { skip: process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0) }, (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home });
  const prsPath = join(home, ".herdr", "ranch", "prs.json");
  mkdirSync(dirname(prsPath), { recursive: true });
  writeFileSync(prsPath, "{}");
  const bytes = readFileSync(prsPath);
  chmodSync(prsPath, 0o000);

  assert.throws(() => recordSharedPr("top", "branch", { url: "https://github.com/o/r/pull/1", number: 1, at: null }),
    /unreadable/);
  assert.equal(statSync(prsPath).size, bytes.length);
});

test("recordSharedPr throws on a newer-schema registry", (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, HOME: home });
  const prsPath = join(home, ".herdr", "ranch", "prs.json");
  mkdirSync(dirname(prsPath), { recursive: true });
  writeFileSync(prsPath, JSON.stringify({ version: 99, entries: {} }));
  const bytes = readFileSync(prsPath);

  assert.throws(() => recordSharedPr("top", "branch", { url: "https://github.com/o/r/pull/1", number: 1, at: null }),
    /newer schema|not overwritten/);
  assert.deepEqual(readFileSync(prsPath), bytes);
});

// ------------------------------------------------------- pointer identity UI

test("withPointerIdentity overlays the pointer's terminal identity", (t) => {
  const sessionText = JSON.stringify({ ...storeA(), terminal: "t-other", terminal_started_at: "2026-01-01T00:00:00.000Z" });
  const parsed = parseStore(sessionText);
  const pointerText = JSON.stringify({
    version: 2, terminal: "t1", terminal_started_at: "2026-02-01T00:00:00.000Z",
    agent: { app: "claude-code", session: "A", pid: 1 }, session: "A", updated_at: "2026-02-01T00:01:00.000Z",
  });

  const overlaid = withPointerIdentity(parsed, pointerText);
  assert.equal(overlaid.store.terminal, "t1");
  assert.equal(overlaid.store.terminal_started_at, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(overlaid.store.tasks, parsed.store.tasks); // everything else untouched

  // Non-pointer text and failed parses pass through unchanged.
  assert.equal(withPointerIdentity(parsed, sessionText), parsed);
  const broken = { ok: false, reason: "missing" };
  assert.equal(withPointerIdentity(broken, pointerText), broken);

  // The overlay makes the shared session visible from this terminal only.
  const started = Date.parse("2026-02-01T00:00:00.000Z");
  assert.equal(listVisible(overlaid, { state: "live", app: "claude-code", startedAt: started }), true);
  assert.equal(listVisible(parsed, { state: "live", app: "claude-code", startedAt: started }), false);
});
