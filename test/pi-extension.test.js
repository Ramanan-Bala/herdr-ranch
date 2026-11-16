// Pi extension: standalone helpers plus the default export driven by a fake
// `pi` object, against a fake ranch-tasks executable in a temp RANCH_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ranchTasks, { TODO_TOOL, normalizeTodos, ranchCommand, todoSummary, toolResponse } from "../adapters/pi-extension.js";

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

const fakePi = () => {
  const handlers = {};
  const tools = [];
  return {
    handlers,
    tools,
    pi: {
      on: (name, fn) => { (handlers[name] ??= []).push(fn); },
      registerTool: (tool) => tools.push(tool),
    },
  };
};

// --------------------------------------------------------------- ranchCommand

test("ranchCommand uses the installed launcher on POSIX", () => {
  const [cmd, args] = ranchCommand({ RANCH_HOME: "/tmp/ranch-home" }, "darwin");
  assert.equal(cmd, "/tmp/ranch-home/.herdr/ranch/bin/ranch-tasks");
  assert.deepEqual(args, ["pi"]);
});

test("ranchCommand runs node on the .js entry with forward slashes on win32", () => {
  const [cmd, args] = ranchCommand({ RANCH_HOME: "/tmp/ranch-home" }, "win32");
  assert.equal(cmd, "node");
  assert.deepEqual(args, ["/tmp/ranch-home/.herdr/ranch/bin/ranch-tasks.js", "pi"]);
  assert.ok(!args[0].includes("\\"));
});

// --------------------------------------------------------------- toolResponse

test("toolResponse joins text parts and maps isError to an exit code", () => {
  const event = {
    content: [{ type: "text", text: "first" }, { type: "image", data: "x" }, { type: "text", text: "second" }],
    isError: false,
  };
  assert.deepEqual(toolResponse(event), { stdout: "first\nsecond", exit_code: 0 });
  assert.deepEqual(toolResponse({ ...event, isError: true }), { stdout: "first\nsecond", exit_code: 1 });
  assert.deepEqual(toolResponse({}), { stdout: "", exit_code: 0 });
});

// -------------------------------------------------------------- normalizeTodos

test("normalizeTodos drops junk, defaults bad status, keeps activeForm", () => {
  assert.deepEqual(normalizeTodos([
    null,
    "not an object",
    { content: "   ", status: "pending" },
    { content: " a ", status: "completed" },
    { content: "b", status: "in_progress", activeForm: " B " },
    { content: "c", status: "bogus", activeForm: "" },
  ]), [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress", activeForm: "B" },
    { content: "c", status: "pending" },
  ]);
  assert.deepEqual(normalizeTodos(null), []);
});

// ---------------------------------------------------------------- todoSummary

test("todoSummary marks every status and reports the done count", () => {
  const todos = [
    { content: "a", status: "completed" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "pending" },
    { content: "d", status: "cancelled" },
    { content: "e", status: "completed" },
  ];
  assert.equal(todoSummary(todos), "Task list updated (2/5 done):\n[x] a\n[>] b\n[ ] c\n[-] d\n[x] e");
  assert.equal(todoSummary([]), "Task list cleared.");
});

// ------------------------------------------------------------------ TODO_TOOL

test("TODO_TOOL is the todo_write schema with required todos", () => {
  assert.equal(TODO_TOOL.name, "todo_write");
  assert.equal(TODO_TOOL.label, "Tasks");
  assert.match(TODO_TOOL.description, /replaces the previous list/);
  assert.deepEqual(TODO_TOOL.parameters.required, ["todos"]);
  assert.equal(TODO_TOOL.parameters.additionalProperties, false);
  const item = TODO_TOOL.parameters.properties.todos.items;
  assert.deepEqual(item.required, ["content", "status"]);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.status.enum, ["pending", "in_progress", "completed", "cancelled"]);
  assert.ok(TODO_TOOL.promptGuidelines.length > 0);
  for (const line of TODO_TOOL.promptGuidelines) assert.match(line, /todo_write/);
});

// --------------------------------------------------------------- integration

function fakeCliHome(t, output) {
  const home = mkdtempSync(join(tmpdir(), "ranch-pi-"));
  const bin = join(home, ".herdr", "ranch", "bin");
  const log = join(home, "payloads.jsonl");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "ranch-tasks"),
    `#!/bin/sh\ncat >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\nprintf '${output}\\n'\n`,
  );
  chmodSync(join(bin, "ranch-tasks"), 0o755);
  withEnv(t, { RANCH_HOME: home, HC_TERMINAL_ID: "t1" });
  return { home, log };
}

async function waitForLines(path, count) {
  for (let i = 0; i < 200; i++) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= count) return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("the extension forwards hook events in order and injects the reminder", { skip: process.platform === "win32" ? "POSIX fake executable" : false }, async (t) => {
  const { log } = fakeCliHome(t, "REMINDER");
  const { pi, handlers, tools } = fakePi();
  ranchTasks(pi);

  assert.equal(tools.length, 1);
  const ctx = { sessionManager: { getSessionId: () => "ses-pi" }, cwd: "/tmp/project" };
  await handlers.session_start[0]({ reason: "startup" }, ctx);
  const start = await handlers.before_agent_start[0]({ prompt: "hello", systemPrompt: "BASE" }, ctx);
  assert.match(start.systemPrompt, /REMINDER/);
  assert.ok(start.systemPrompt.startsWith("BASE\n\n"));
  handlers.tool_result[0]({
    toolName: "todo_write",
    toolCallId: "c1",
    input: { todos: [{ content: "a", status: "completed" }] },
    content: [{ type: "text", text: "Task list updated" }],
    isError: false,
  }, ctx);
  handlers.agent_settled[0]({}, ctx);
  handlers.session_shutdown[0]({ reason: "quit" }, ctx);

  const lines = await waitForLines(log, 5);
  const payloads = lines.map((line) => JSON.parse(line));
  assert.equal(payloads.length, 5);
  assert.deepEqual(payloads.map((p) => p.hook_event_name), [
    "SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd",
  ]);
  assert.deepEqual(payloads[0], { hook_event_name: "SessionStart", session_id: "ses-pi", source: "startup", cwd: "/tmp/project" });
  assert.deepEqual(payloads[1], { hook_event_name: "UserPromptSubmit", session_id: "ses-pi", prompt: "hello", cwd: "/tmp/project" });
  assert.equal(payloads[2].tool_name, "todo_write");
  assert.deepEqual(payloads[2].tool_input, { todos: [{ content: "a", status: "completed" }] });
  assert.deepEqual(payloads[2].tool_response, { stdout: "Task list updated", exit_code: 0 });
  assert.deepEqual(payloads[3], { hook_event_name: "Stop", session_id: "ses-pi" });
  assert.deepEqual(payloads[4], { hook_event_name: "SessionEnd", session_id: "ses-pi" });
});

test("without HC_TERMINAL_ID the tool is registered and nothing is spawned", { skip: process.platform === "win32" ? "POSIX fake executable" : false }, async (t) => {
  const { log } = fakeCliHome(t, "REMINDER");
  delete process.env.HC_TERMINAL_ID;
  const { pi, handlers, tools } = fakePi();
  ranchTasks(pi);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "todo_write");

  const ctx = { sessionManager: { getSessionId: () => "ses-pi" }, cwd: "/tmp" };
  await handlers.session_start[0]({ reason: "startup" }, ctx);
  await handlers.before_agent_start[0]({ prompt: "hello", systemPrompt: "BASE" }, ctx);
  handlers.tool_result[0]({ toolName: "bash", input: { command: "ls" }, content: [] }, ctx);
  handlers.agent_settled[0]({}, ctx);
  handlers.session_shutdown[0]({ reason: "quit" }, ctx);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existsSync(log), false);
});
