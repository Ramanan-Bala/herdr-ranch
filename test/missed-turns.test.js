// Missed-turn semantics (fixes 3.7): a turn starts at a real user prompt,
// is judged once at its end, counts only when it did real work while the
// task list stayed unchanged, and is consumed after judging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStore } from "../lib/tasks.js";
import { applyClaude } from "../adapters/claude.js";
import { applyCodex } from "../adapters/codex.js";
import { normalizeV2, reduceOpencode } from "../adapters/opencode-plugin.js";

// Transcript JSONL: a user prompt, then the assistant runs Bash.
const transcript = [
  '{"type":"user","message":{"content":[{"type":"text","text":"fix the bug"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
].join("\n");

const claudePrompt = (sid) => ({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug", session_id: sid });
const claudeStop = (sid) => ({ hook_event_name: "Stop", transcript, session_id: sid });

// ------------------------------------------------------------------ Claude

test("claude miss counts once, then a task-list change resets it", () => {
  let store = applyClaude(emptyStore("t1", "claude-code"), claudePrompt("s1"));
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1",
  });
  store = applyClaude(store, claudeStop("s1"));
  assert.equal(store.missed_turns, 1);

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite", session_id: "s1",
    tool_input: { todos: [{ content: "A", status: "in_progress" }] },
  });
  assert.equal(store.missed_turns, 0);
});

test("claude duplicate Stop after a miss does not recount", () => {
  let store = applyClaude(emptyStore("t1", "claude-code"), claudePrompt("s1"));
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1",
  });
  store = applyClaude(store, claudeStop("s1"));
  assert.equal(store.missed_turns, 1);
  store = applyClaude(store, claudeStop("s1"));
  assert.equal(store.missed_turns, 1);
});

test("claude work turn with an unchanged in_progress list still counts", () => {
  let store = applyClaude(emptyStore("t1", "claude-code"), {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "in_progress" }] },
  });
  store = applyClaude(store, claudePrompt("s1"));
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1",
  });
  store = applyClaude(store, claudeStop("s1"));
  assert.equal(store.missed_turns, 1);
});

test("claude fresh sessions reset missed_turns to 0", () => {
  let store = applyClaude(emptyStore("t1", "claude-code"), claudePrompt("s1"));
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s1",
  });
  store = applyClaude(store, claudeStop("s1"));
  assert.equal(store.missed_turns, 1);

  const startup = applyClaude(store, {
    hook_event_name: "SessionStart", session_id: "s1", source: "startup",
  });
  assert.equal(startup.missed_turns, 0);

  // An event from a different session id starts fresh too (I10).
  const reused = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: "s2",
  });
  assert.equal(reused.missed_turns, 0);
});

// ------------------------------------------------------------------- Codex

const codexPrompt = (sid) => ({ hook_event_name: "UserPromptSubmit", prompt: "hi", session_id: sid });
const codexBash = (sid) => ({
  hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, session_id: sid,
});

test("codex pure Q&A turn without tools does not count", () => {
  let store = applyCodex(emptyStore("t1", "codex"), codexPrompt("s1"));
  store = applyCodex(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 0);
});

test("codex tool turn judged once, plan change and fresh session reset", () => {
  let store = applyCodex(emptyStore("t1", "codex"), codexPrompt("s1"));
  store = applyCodex(store, codexBash("s1"));
  store = applyCodex(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 1);

  // A second Stop without a new prompt never recounts.
  store = applyCodex(store, { hook_event_name: "Stop", session_id: "s1" });
  assert.equal(store.missed_turns, 1);

  // An update_plan that changes the list resets the counter.
  store = applyCodex(store, {
    hook_event_name: "PostToolUse", tool_name: "update_plan", session_id: "s1",
    tool_input: { plan: [{ step: "A", status: "in_progress" }] },
  });
  assert.equal(store.missed_turns, 0);

  // A fresh session starts at 0.
  store = applyCodex(store, { hook_event_name: "SessionStart", session_id: "s2", source: "startup" });
  assert.equal(store.missed_turns, 0);
});

// ---------------------------------------------------------------- OpenCode

const mainCreated = () => reduceOpencode(emptyStore("t1", "opencode"), {
  type: "session.created",
  properties: { info: { id: "main1" } },
});
const ocPrompt = () => ({ type: "chat.message", properties: { sessionID: "main1", text: "hi" } });
const ocTool = (tool) => ({ type: "tool.used", properties: { sessionID: "main1", tool } });
const ocIdle = () => ({ type: "session.idle", properties: { sessionID: "main1" } });

test("opencode turn without work does not count", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, { type: "session.status", properties: { sessionID: "main1", status: { type: "busy" } } });
  store = reduceOpencode(store, { type: "session.status", properties: { sessionID: "main1", status: { type: "idle" } } });
  assert.equal(store.missed_turns, 0);
  assert.equal(store.session.turn, undefined);
});

test("opencode work turn counts once; a second idle without a prompt does not recount", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, ocTool("bash"));
  store = reduceOpencode(store, ocIdle());
  assert.equal(store.missed_turns, 1);

  store = reduceOpencode(store, { type: "session.status", properties: { sessionID: "main1", status: { type: "busy" } } });
  store = reduceOpencode(store, { type: "session.status", properties: { sessionID: "main1", status: { type: "idle" } } });
  assert.equal(store.missed_turns, 1);
});

test("opencode interrupted and failed executions do not count", () => {
  for (const type of ["session.execution.interrupted", "session.execution.failed"]) {
    let store = mainCreated();
    store = reduceOpencode(store, ocPrompt());
    store = reduceOpencode(store, ocTool("bash"));
    const idle = normalizeV2({ type, properties: { sessionID: "main1" } });
    assert.equal(idle.type, "session.idle");
    store = reduceOpencode(store, idle);
    assert.equal(store.missed_turns, 0, type);
    assert.equal(store.session.turn, undefined);
  }
});

test("opencode session.error aborts the open turn", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, ocTool("bash"));
  store = reduceOpencode(store, { type: "session.error", properties: { sessionID: "main1" } });
  store = reduceOpencode(store, ocIdle());
  assert.equal(store.missed_turns, 0);
  assert.equal(store.session.turn, undefined);
});

test("opencode task-list change and a new main session reset missed_turns", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, ocTool("bash"));
  store = reduceOpencode(store, ocIdle());
  assert.equal(store.missed_turns, 1);

  const changed = reduceOpencode(store, {
    type: "todo.updated",
    properties: { sessionID: "main1", todos: [{ id: "1", content: "A", status: "in_progress" }] },
  });
  assert.equal(changed.missed_turns, 0);

  const fresh = reduceOpencode(changed, {
    type: "session.created", properties: { info: { id: "main2" } },
  });
  assert.equal(fresh.missed_turns, 0);
});

test("opencode read-only tools do not count as work", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, ocTool("read"));
  store = reduceOpencode(store, ocIdle());
  assert.equal(store.missed_turns, 0);
});

test("opencode repeated work tools in one turn leave the store unchanged", () => {
  let store = mainCreated();
  store = reduceOpencode(store, ocPrompt());
  store = reduceOpencode(store, ocTool("bash"));
  assert.equal(store.session.turn.tools, true);
  // already marked: same object back, so recordEvent skips the write
  assert.equal(reduceOpencode(store, ocTool("edit")), store);
});
