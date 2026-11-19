// Pi extension: standalone helpers plus the default export driven by a fake
// `pi` object, against a fake ranch-tasks executable in a temp RANCH_HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ranchTasks, {
  TODO_TOOL, autoNameEnabled, cleanSessionTitle, generateSessionTitle, normalizeTodos, pickTitleModel, ranchCommand,
  sessionSnapshot, titlePrompt, todoSummary, toolResponse,
} from "../adapters/pi-extension.js";

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

// ------------------------------------------------------------ sessionSnapshot

const msg = (message) => ({ type: "message", message });
const todoResult = (todos, isError = false) => msg({ role: "toolResult", toolName: "todo_write", details: { todos }, isError });

test("sessionSnapshot reads the name, the branch's latest todo list and first prompt", () => {
  const snap = sessionSnapshot({
    getSessionName: () => " Auth refactor ",
    getBranch: () => [
      { type: "session_info", name: "x" },
      msg({ role: "user", content: [{ type: "text", text: "fix the login loop" }] }),
      todoResult([{ content: "old", status: "pending" }]),
      msg({ role: "user", content: "later prompt" }),
      todoResult([{ content: "a", status: "completed" }, { content: "b", status: "in_progress", activeForm: "Doing b" }]),
      todoResult([{ content: "ignored", status: "pending" }], true),
      msg({ role: "toolResult", toolName: "bash", details: { todos: [{ content: "no", status: "pending" }] } }),
    ],
  });
  assert.deepEqual(snap, {
    session_name: "Auth refactor",
    todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress", activeForm: "Doing b" }],
    first_prompt: "fix the login loop",
  });
});

test("sessionSnapshot: no name is null, no todo_write is an empty list, unreadable parts are left out", () => {
  assert.deepEqual(sessionSnapshot({ getSessionName: () => undefined, getBranch: () => [] }), { session_name: null, todos: [] });
  assert.deepEqual(sessionSnapshot({
    getSessionName: () => { throw new Error("x"); },
    getBranch: () => { throw new Error("x"); },
  }), {});
  assert.deepEqual(sessionSnapshot(undefined), {});
});

test("the extension sends the snapshot on start and SessionSync on rename and /tree", { skip: process.platform === "win32" ? "POSIX fake executable" : false }, async (t) => {
  const { log } = fakeCliHome(t, "");
  const { pi, handlers } = fakePi();
  ranchTasks(pi);
  let branch = [todoResult([{ content: "a", status: "pending" }])];
  const ctx = {
    sessionManager: { getSessionId: () => "ses-pi", getSessionName: () => "Named", getBranch: () => branch },
    cwd: "/tmp/project",
  };
  await handlers.session_start[0]({ reason: "resume" }, ctx);
  handlers.session_info_changed[0]({ name: " Renamed " }, ctx);
  handlers.session_info_changed[0]({}, ctx);
  branch = [];
  handlers.session_tree[0]({ newLeafId: "x" }, ctx);

  const payloads = (await waitForLines(log, 4)).map((line) => JSON.parse(line));
  assert.deepEqual(payloads[0], {
    hook_event_name: "SessionStart", session_id: "ses-pi", source: "resume", cwd: "/tmp/project",
    session_name: "Named", todos: [{ content: "a", status: "pending" }],
  });
  assert.deepEqual(payloads[1], { hook_event_name: "SessionSync", session_id: "ses-pi", session_name: "Renamed" });
  assert.deepEqual(payloads[2], { hook_event_name: "SessionSync", session_id: "ses-pi", session_name: null });
  assert.deepEqual(payloads[3], { hook_event_name: "SessionSync", session_id: "ses-pi", session_name: "Named", todos: [] });
});

// ------------------------------------------------------- automatic session name

test("autoNameEnabled is on unless RANCH_PI_AUTONAME turns it off", () => {
  assert.equal(autoNameEnabled({}), true);
  assert.equal(autoNameEnabled({ RANCH_PI_AUTONAME: "1" }), true);
  for (const v of ["0", "false", "OFF", "no"]) assert.equal(autoNameEnabled({ RANCH_PI_AUTONAME: v }), false);
});

test("pickTitleModel prefers the newest small model of the current provider", () => {
  const current = { provider: "anthropic", id: "claude-opus-5-5" };
  const registry = { getAvailable: () => [
    { provider: "openai", id: "gpt-5-mini" },
    { provider: "anthropic", id: "claude-3-haiku" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
    current,
  ] };
  assert.equal(pickTitleModel(registry, current).id, "claude-haiku-4-5");
  const google = { provider: "google", id: "gemini-2.5-pro" };
  assert.equal(pickTitleModel({ getAvailable: () => [google, { provider: "google", id: "gemini-2.5-flash" }] }, google).id, "gemini-2.5-flash");
  assert.equal(pickTitleModel({ getAvailable: () => [google] }, google), google); // "gemini" is not "mini"
  assert.equal(pickTitleModel({ getAvailable: () => { throw new Error("x"); } }, current), current);
  assert.equal(pickTitleModel({}, null), null);
});

test("cleanSessionTitle keeps one short line and drops labels, quotes and SKIP", () => {
  assert.equal(cleanSessionTitle('"Fix Login Redirect Loop."'), "Fix Login Redirect Loop");
  assert.equal(cleanSessionTitle("Title: Pi Session Names\nextra"), "Pi Session Names");
  assert.equal(cleanSessionTitle("**Auth Refactor**"), "Auth Refactor");
  assert.equal(cleanSessionTitle("SKIP"), null);
  assert.equal(cleanSessionTitle("  "), null);
  assert.ok(cleanSessionTitle("word ".repeat(30)).length <= 60);
});

test("titlePrompt embeds the request", () => {
  assert.match(titlePrompt("fix the login loop"), /<request>\nfix the login loop\n<\/request>/);
});

test("generateSessionTitle asks the small model and cleans the reply", async () => {
  const calls = [];
  const ctx = {
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    modelRegistry: {
      getAvailable: () => [{ provider: "anthropic", id: "claude-haiku-4-5" }],
      hasConfiguredAuth: () => true,
      complete: async (model, context, options) => {
        calls.push({ model, context, options });
        return { stopReason: "stop", content: [{ type: "text", text: "Pi Session Auto Names" }] };
      },
    },
  };
  assert.equal(await generateSessionTitle(ctx, "make pi session names automatic"), "Pi Session Auto Names");
  assert.equal(calls[0].model.id, "claude-haiku-4-5");
  assert.match(calls[0].context.messages[0].content[0].text, /make pi session names automatic/);
  assert.equal(calls[0].options.thinkingEnabled, false); // complete() fallback disables thinking

  // streamSimple (preferred): no `reasoning` option, so thinking stays off
  const simple = [];
  const viaStream = {
    ...ctx,
    modelRegistry: {
      ...ctx.modelRegistry,
      streamSimple: (model, context, options) => {
        simple.push(options);
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Streamed Title" }] }) };
      },
    },
  };
  assert.equal(await generateSessionTitle(viaStream, "make pi session names automatic"), "Streamed Title");
  assert.equal(simple[0].reasoning, undefined);
  assert.equal(simple[0].maxTokens, 200);
  // a reply cut short while thinking has no text: no title
  viaStream.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason: "length", content: [{ type: "thinking", thinking: "hmm" }] }) });
  assert.equal(await generateSessionTitle(viaStream, "x"), null);

  ctx.modelRegistry.complete = async () => ({ stopReason: "error", content: [] });
  assert.equal(await generateSessionTitle(ctx, "x"), null);
  ctx.modelRegistry.hasConfiguredAuth = () => false;
  assert.equal(await generateSessionTitle(ctx, "x"), null);
  assert.equal(await generateSessionTitle({}, "x"), null);
});

test("the extension names an unnamed session once from its first prompt", async (t) => {
  withEnv(t, { HC_TERMINAL_ID: undefined, RANCH_PI_AUTONAME: undefined });
  const { pi, handlers } = fakePi();
  let name;
  const named = [];
  pi.getSessionName = () => name;
  pi.setSessionName = (n) => { name = n; named.push(n); };
  let calls = 0;
  const ctx = {
    sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    modelRegistry: { complete: async () => { calls++; return { stopReason: "stop", content: [{ type: "text", text: "Fix Login Loop" }] }; } },
  };
  ranchTasks(pi);
  await handlers.before_agent_start[0]({ prompt: "fix the login redirect loop", systemPrompt: "" }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(named, ["Fix Login Loop"]);
  await handlers.before_agent_start[0]({ prompt: "and another thing please", systemPrompt: "" }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1); // once per session
});

test("the extension leaves named sessions, short prompts and opted-out users alone", async (t) => {
  withEnv(t, { HC_TERMINAL_ID: undefined, RANCH_PI_AUTONAME: undefined });
  const run = async (prompt, { name, sid = "s1" } = {}) => {
    const { pi, handlers } = fakePi();
    const named = [];
    pi.getSessionName = () => name;
    pi.setSessionName = (n) => named.push(n);
    const ctx = {
      sessionManager: { getSessionId: () => sid, getBranch: () => [] },
      model: { provider: "p", id: "m" },
      modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Some Title" }] }) },
    };
    ranchTasks(pi);
    await handlers.before_agent_start[0]({ prompt, systemPrompt: "" }, ctx);
    await new Promise((r) => setTimeout(r, 20));
    return named;
  };
  assert.deepEqual(await run("fix the login redirect loop", { name: "Mine" }), []);
  assert.deepEqual(await run("hi"), []);
  assert.deepEqual(await run("/model something long enough"), []);
  process.env.RANCH_PI_AUTONAME = "0";
  assert.deepEqual(await run("fix the login redirect loop"), []);
});
