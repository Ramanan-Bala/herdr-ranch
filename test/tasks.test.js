import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STORE_VERSION,
  STALE,
  capTasks,
  parseStore,
  orderTasks,
  progress,
  storeFileName,
  emptyStore,
  withActivity,
  normalizeActivity,
  pointerSession,
  listVisible,
  listLifecycle,
  tasksFingerprint,
  normalizeTitle,
  mergeSessionIndex,
  pointerSessions,
  resolveSession,
} from "../lib/tasks.js";

test("parseStore handles missing, invalid and newer files", () => {
  assert.deepEqual(parseStore(null), { ok: false, reason: "missing" });
  assert.deepEqual(parseStore("{nope"), { ok: false, reason: "invalid" });
  // Schema 2 is this build's version; 3 is newer.
  assert.deepEqual(parseStore(JSON.stringify({ version: 2 })), {
    ok: true,
    store: { version: 2, terminal: null, agent: null, terminal_started_at: null, seq: 0, missed_turns: 0, updated_at: null, session: null, tasks: [], subagents: [], prs: [] },
  });
  assert.deepEqual(parseStore(JSON.stringify({ version: 3 })), { ok: false, reason: "newer" });
  assert.deepEqual(parseStore(JSON.stringify({ tasks: [] })), { ok: false, reason: "invalid" });
});

test("parseStore is strict about malformed records (fixes 3.2)", () => {
  // An empty title invalidates the whole file instead of being dropped.
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, tasks: [{ title: "A" }, { title: "" }] })).reason, "invalid");
  // Unknown status invalidates instead of coercing to pending.
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, tasks: [{ title: "A", status: "weird" }] })).reason, "invalid");
  // A bad subagent record invalidates too.
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, subagents: [{ name: "no id" }] })).reason, "invalid");
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, tasks: "nope" })).reason, "invalid");
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, seq: -1 })).reason, "invalid");
  assert.deepEqual(parseStore(JSON.stringify({ version: 1, terminal_started_at: 5 })).reason, "invalid");
});

test("parseStore normalizes tasks, subagents and session", () => {
  const r = parseStore(JSON.stringify({
    version: 1, terminal: "t6", agent: "claude-code",
    session: { id: "s1", title: "Fix login", first_prompt: "fix it" },
    tasks: [{ title: "A", status: "completed" }, { title: "B", status: "pending", active_form: "doing B" }],
    subagents: [{ id: "a1", status: "done" }, { id: "a2", parent_terminal: "t9" }],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.store.tasks, [
    { id: "1", title: "A", status: "completed", active_form: null },
    { id: "2", title: "B", status: "pending", active_form: "doing B" },
  ]);
  assert.deepEqual(r.store.subagents, [
    { id: "a1", name: "a1", status: "done", started_at: null, ended_at: null, parent_terminal: null, parent_session: null },
    { id: "a2", name: "a2", status: "running", started_at: null, ended_at: null, parent_terminal: "t9", parent_session: null },
  ]);
  assert.deepEqual(r.store.session, { id: "s1", title: "Fix login", title_source: "agent", first_prompt: "fix it", state: "running", activity: null, turn: null });
  // Schema-1 agent string becomes the identity block (fixes 3.3).
  assert.deepEqual(r.store.agent, { app: "claude-code", session: null, pid: null });
});

test("pointerSession and the schema-2 identity fields survive a round trip", () => {
  const pointer = JSON.stringify({ version: 2, terminal: "t6", session: "ses_1", updated_at: "now" });
  assert.equal(pointerSession(pointer), "ses_1");
  const store = emptyStore("t6", "codex");
  assert.equal(store.version, STORE_VERSION);
  assert.deepEqual(store.agent, { app: "codex", session: null, pid: null });
  const r = parseStore(JSON.stringify({ ...store, seq: 4, missed_turns: 2, terminal_started_at: "2026-01-01T00:00:00.000Z" }));
  assert.equal(r.ok, true);
  assert.equal(r.store.seq, 4);
  assert.equal(r.store.missed_turns, 2);
  assert.equal(r.store.terminal_started_at, "2026-01-01T00:00:00.000Z");
});

test("storeCandidates resolves terminal, session and legacy store paths", async () => {
  const { storeCandidates } = await import("../lib/tasks.js");
  assert.deepEqual(storeCandidates?.("t6"), ["terminals/t6.json", "t6.json"]);
  assert.deepEqual(storeCandidates("t6", JSON.stringify({ version: 2, tasks: [] })), []);
  assert.deepEqual(
    storeCandidates("t6", JSON.stringify({ version: 2, session: "ses/1" })),
    ["sessions/ses_1.json"],
  );
  assert.deepEqual(storeCandidates(""), []);
});

test("listVisible guards against a reused terminal (fixes 3.3/F4)", () => {
  const started = Date.parse("2026-01-01T10:00:00.000Z");
  const ok = () => ({ ok: true, store: emptyStore("t6", "claude") });
  const live = { state: "live", app: "claude", startedAt: started };
  // No identity info: checks skipped.
  assert.equal(listVisible(ok(), null), true);
  // Terminal not live: hidden.
  assert.equal(listVisible(ok(), { ...live, state: "finished" }), false);
  // App mismatch: hidden.
  assert.equal(listVisible(ok(), { ...live, app: "codex" }), false);
  // Store written before the terminal started (schema-1 fallback): hidden.
  const old = ok();
  old.store.updated_at = "2025-06-01T00:00:00.000Z";
  assert.equal(listVisible(old, live), false);
  // Store written after the terminal started: shown.
  const fresh = ok();
  fresh.store.updated_at = "2026-06-01T00:00:00.000Z";
  assert.equal(listVisible(fresh, live), true);
  // Schema 2: terminal_started_at must match exactly.
  const mine = ok();
  mine.store.terminal_started_at = new Date(started).toISOString();
  assert.equal(listVisible(mine, live), true);
  const other = ok();
  other.store.terminal_started_at = "2026-02-01T00:00:00.000Z";
  assert.equal(listVisible(other, live), false);
  // A malformed parse result is never visible.
  assert.equal(listVisible({ ok: false, reason: "invalid" }, null), false);
});

test("listVisible hides an ended session and shows a running one", () => {
  const mk = (state) => ({ ok: true, store: { ...emptyStore("t6", "claude"), session: { id: "s1", state } } });
  // The agent exited (SessionEnd / session.deleted): no active session, no list.
  assert.equal(listVisible(mk("ended"), null), false);
  assert.equal(listVisible(mk("running"), null), true);
});

test("listLifecycle applies the reader-side rules (fixes 3.5)", () => {
  const now = Date.now();
  const mk = (tasks, updated_at) => ({ tasks, updated_at });
  const inProgress = [{ status: "in_progress" }];
  const allDone = [{ status: "completed" }, { status: "completed" }];
  // Flag: agent idle (or done) with work still in progress.
  assert.equal(listLifecycle(mk(inProgress, new Date(now).toISOString()), "idle", now).flag, true);
  assert.equal(listLifecycle(mk(inProgress, new Date(now).toISOString()), "done", now).flag, true);
  assert.equal(listLifecycle(mk(inProgress, new Date(now).toISOString()), "working", now).flag, false);
  // Hide: all done and idle for over 10 min.
  assert.equal(listLifecycle(mk(allDone, new Date(now - STALE.HIDE_DONE_MS - 1000).toISOString()), "idle", now).hide, true);
  assert.equal(listLifecycle(mk(allDone, new Date(now - STALE.HIDE_DONE_MS + 60_000).toISOString()), "idle", now).hide, false);
  assert.equal(listLifecycle(mk(allDone, new Date(now - STALE.HIDE_DONE_MS - 1000).toISOString()), "working", now).hide, false);
  // Fresh: updated within 2 min.
  assert.equal(listLifecycle(mk(allDone, new Date(now).toISOString()), "working", now).fresh, true);
  assert.equal(listLifecycle(mk(allDone, new Date(now - STALE.FRESH_MS - 1000).toISOString()), "working", now).fresh, false);
});

test("tasksFingerprint changes only when a task id, status or title does", () => {
  const a = [{ id: "1", status: "pending", title: "A" }];
  assert.equal(tasksFingerprint(a), tasksFingerprint([a[0]]));
  assert.notEqual(tasksFingerprint(a), tasksFingerprint([{ ...a[0], status: "completed" }]));
  assert.notEqual(tasksFingerprint(a), tasksFingerprint([{ ...a[0], id: "2" }]));
});

test("parseStore keeps cancelled tasks (F7)", () => {
  const r = parseStore(JSON.stringify({
    version: 1, terminal: "t6", agent: "claude-code",
    tasks: [{ title: "A", status: "cancelled" }, { title: "B", status: "pending" }],
  }));
  assert.deepEqual(r.store.tasks, [
    { id: "1", title: "A", status: "cancelled", active_form: null },
    { id: "2", title: "B", status: "pending", active_form: null },
  ]);
});

test("orderTasks and progress", () => {
  const t = [
    { id: "1", status: "completed" }, { id: "2", status: "pending" },
    { id: "3", status: "in_progress" }, { id: "4", status: "pending" },
  ];
  assert.deepEqual(orderTasks(t).map((x) => x.id), ["3", "2", "4", "1"]);
  assert.deepEqual(progress(t), { done: 1, total: 4 });
});

test("storeFileName and emptyStore", () => {
  assert.equal(storeFileName("t6"), "t6.json");
  assert.equal(storeFileName("../x"), ".._x.json");
  assert.equal(storeFileName(""), null);
  assert.equal(emptyStore("t1", "codex").tasks.length, 0);
});

test("activity is normalized and set immutably", () => {
  assert.equal(normalizeActivity({ state: "nope" }), null);
  assert.deepEqual(normalizeActivity({ state: "working", at: 5 }), { state: "working", at: 5 });
  const base = emptyStore("t1", "codex");
  const next = withActivity(base, "blocked", 9);
  assert.equal(base.session, null);
  assert.deepEqual(next.session.activity, { state: "blocked", at: 9 });
  const r = parseStore(JSON.stringify(next));
  assert.deepEqual(r.store.session.activity, { state: "blocked", at: 9 });
});

test("progress and orderTasks leave cancelled tasks out of the count and last in order", () => {
  const tasks = [
    { id: "1", title: "a", status: "cancelled", active_form: null },
    { id: "2", title: "b", status: "completed", active_form: null },
    { id: "3", title: "c", status: "pending", active_form: null },
  ];
  assert.deepEqual(progress(tasks), { done: 1, total: 2 });
  assert.deepEqual(orderTasks(tasks).map((t) => t.id), ["3", "2", "1"]);
});

test("capTasks keeps lists at or under the cap untouched", () => {
  const small = [{ id: "1", status: "pending" }];
  assert.equal(capTasks(small), small); // same array, no copy
  assert.equal(capTasks(null), null);
  assert.equal(capTasks("nope"), "nope");
  assert.equal(capTasks(small, 5), small);
  const exactly = Array.from({ length: 50 }, (_, i) => ({ id: String(i), status: "completed" }));
  assert.equal(capTasks(exactly, 50), exactly);
});

test("capTasks drops the oldest finished entries first, then pending", () => {
  const many = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, status: "completed" })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, status: "pending" })),
  ];
  const capped = capTasks(many, 50);
  // 10 oldest completed dropped; order of the rest preserved.
  assert.equal(capped.length, 50);
  assert.deepEqual(capped.map((t) => t.id), [
    ...Array.from({ length: 20 }, (_, i) => `c${i + 10}`),
    ...Array.from({ length: 30 }, (_, i) => `p${i}`),
  ]);
});

test("capTasks never drops in_progress and keeps order", () => {
  const many = [
    ...Array.from({ length: 45 }, (_, i) => ({ id: `c${i}`, status: "completed" })),
    { id: "live1", status: "in_progress" },
    { id: "live2", status: "in_progress" },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, status: "pending" })),
  ];
  const capped = capTasks(many, 50);
  assert.equal(capped.length, 50);
  assert.deepEqual(capped.filter((t) => t.status === "in_progress").map((t) => t.id), ["live1", "live2"]);
  // Oldest completed dropped first, everything kept in original order.
  assert.equal(capped[0].id, "c5");
  for (let i = 1; i < capped.length; i++) {
    assert.ok(many.indexOf(capped[i]) > many.indexOf(capped[i - 1]));
  }
});

test("normalizeTitle strips the OC prefix, spinner glyphs and generic titles", () => {
  assert.equal(normalizeTitle("OC | Fix Login"), "fix login");
  assert.equal(normalizeTitle("oc|fix login"), "fix login");
  assert.equal(normalizeTitle("OC  |  Fix   Login"), "fix login");
  assert.equal(normalizeTitle("✳ Fix Login"), "fix login");
  assert.equal(normalizeTitle("⠂  Fix   Login  "), "fix login");
  assert.equal(normalizeTitle("FIX  login"), "fix login");
  // Generic or empty titles identify no session.
  assert.equal(normalizeTitle(""), null);
  assert.equal(normalizeTitle("   "), null);
  assert.equal(normalizeTitle("New Session"), null);
  assert.equal(normalizeTitle("OC | New session"), null);
  assert.equal(normalizeTitle("OpenCode"), null);
  assert.equal(normalizeTitle("OC"), null);
  assert.equal(normalizeTitle("Claude Code"), null);
  assert.equal(normalizeTitle(null), null);
  assert.equal(normalizeTitle(42), null);
});

test("mergeSessionIndex moves an entry to the front, dedupes and caps", () => {
  const list = [
    { id: "a", title: "Alpha", at: "1" },
    { id: "b", title: "Beta", at: "2" },
  ];
  const before = JSON.parse(JSON.stringify(list));
  assert.deepEqual(mergeSessionIndex(list, { id: "b", title: "Beta 2", at: "3" }), [
    { id: "b", title: "Beta 2", at: "3" },
    { id: "a", title: "Alpha", at: "1" },
  ]);
  assert.deepEqual(list, before); // never mutated
  assert.deepEqual(
    mergeSessionIndex(list, { id: "c", title: "C", at: "4" }, 2).map((v) => v.id),
    ["c", "a"],
  );
  // A null title keeps the one the list already had for that id.
  assert.deepEqual(mergeSessionIndex(list, { id: "a", title: null, at: "5" })[0], {
    id: "a", title: "Alpha", at: "5",
  });
  // Malformed items and a malformed entry are dropped, not fatal.
  assert.deepEqual(
    mergeSessionIndex([{ id: "a", title: "Alpha", at: "1" }, { id: "" }, null, { title: "x" }], { id: "b", title: "B", at: "2" }),
    [{ id: "b", title: "B", at: "2" }, { id: "a", title: "Alpha", at: "1" }],
  );
  assert.deepEqual(mergeSessionIndex(null, { id: "a", title: "A", at: "1" }), [{ id: "a", title: "A", at: "1" }]);
});

test("pointerSessions sanitizes the pointer's index and tolerates bad text", () => {
  assert.deepEqual(
    pointerSessions(JSON.stringify({ version: 2, session: "a", sessions: [
      { id: "a", title: "Alpha", at: "1" },
      { id: "" },
      { id: "b", title: 7 },
    ] })),
    [{ id: "a", title: "Alpha", at: "1" }, { id: "b", title: null, at: null }],
  );
  assert.deepEqual(pointerSessions("{nope"), []);
  assert.deepEqual(pointerSessions(JSON.stringify({ version: 2 })), []);
});

test("resolveSession picks the indexed session matching the live title", () => {
  const pointer = JSON.stringify({
    version: 2,
    session: "a",
    sessions: [
      { id: "a", title: "Alpha", at: "1" },
      { id: "b", title: "Beta", at: "2" },
      { id: "c", title: "Beta", at: "3" },
    ],
  });
  // No usable live title: the pointer's session.
  assert.equal(resolveSession(pointer, null), "a");
  assert.equal(resolveSession(pointer, "New session"), "a");
  // The pointed session's title already matches.
  assert.equal(resolveSession(pointer, "OC | Alpha"), "a");
  // Another indexed session matches: the first one wins (most recent first).
  assert.equal(resolveSession(pointer, "OC | Beta"), "b");
  // No match: stay on the pointed session.
  assert.equal(resolveSession(pointer, "Gamma"), "a");
  assert.equal(resolveSession("{nope", "Beta"), null);
});

test("storeCandidates uses the live title to pick the session file", async () => {
  const { storeCandidates } = await import("../lib/tasks.js");
  const pointer = JSON.stringify({
    version: 2,
    session: "a",
    sessions: [{ id: "a", title: "Alpha", at: "1" }, { id: "b", title: "Beta", at: "2" }],
  });
  assert.deepEqual(storeCandidates("t6", pointer), ["sessions/a.json"]);
  assert.deepEqual(storeCandidates("t6", pointer, null), ["sessions/a.json"]);
  assert.deepEqual(storeCandidates("t6", pointer, "OC | Beta"), ["sessions/b.json"]);
});
