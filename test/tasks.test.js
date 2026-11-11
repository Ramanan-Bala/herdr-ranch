import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStore, orderTasks, progress, storeFileName, emptyStore, withActivity, normalizeActivity } from "../lib/tasks.js";

test("parseStore handles missing, invalid and newer files", () => {
  assert.deepEqual(parseStore(null), { ok: false, reason: "missing" });
  assert.deepEqual(parseStore("{nope"), { ok: false, reason: "invalid" });
  assert.deepEqual(parseStore(JSON.stringify({ version: 2 })), { ok: false, reason: "newer" });
});

test("parseStore normalizes tasks, subagents and session", () => {
  const r = parseStore(JSON.stringify({
    version: 1, terminal: "t6", agent: "claude-code",
    session: { id: "s1", title: "Fix login", first_prompt: "fix it" },
    tasks: [{ title: "A", status: "completed" }, { title: "", status: "pending" }, { id: "x", title: "B", status: "weird" }],
    subagents: [{ id: "a1", status: "done" }, { name: "no id" }],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.store.tasks, [
    { id: "1", title: "A", status: "completed", active_form: null },
    { id: "x", title: "B", status: "pending", active_form: null },
  ]);
  assert.deepEqual(r.store.subagents, [{ id: "a1", name: "a1", status: "done", started_at: null, ended_at: null }]);
  assert.deepEqual(r.store.session, { id: "s1", title: "Fix login", title_source: "agent", first_prompt: "fix it", state: "running", activity: null });
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
