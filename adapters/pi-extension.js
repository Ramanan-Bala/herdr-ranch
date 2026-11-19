// ranch-tasks plugin
// Ranch task reporting for the Pi coding agent. This file is copied alone into
// ~/.pi/agent/extensions/, so it must not import the repo (only node:
// built-ins): it spawns `ranch-tasks pi` and sends normalized hook payloads.
// Pi already reports working/idle/blocked to Herdr itself (OSC 7501), so this
// extension never writes terminal escape codes.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const STATUS = new Set(TODO_STATUSES);
const SEND_TIMEOUT_MS = 5000;

/** [cmd, args] of the installed ranch-tasks CLI for this platform. */
export function ranchCommand(env = process.env, platform = process.platform, home = env.RANCH_HOME || homedir()) {
  const bin = join(home, ".herdr", "ranch", "bin", "ranch-tasks");
  if (platform === "win32") return ["node", [`${bin}.js`.replace(/\\/g, "/"), "pi"]];
  return [bin, ["pi"]];
}

/** The normalized tool response: all text parts joined, exit code from isError. */
export function toolResponse(event) {
  const parts = Array.isArray(event?.content) ? event.content : [];
  const stdout = parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return { stdout, exit_code: event?.isError ? 1 : 0 };
}

/** The todos Pi's todo_write got, cleaned to what the store keeps. */
export function normalizeTodos(todos) {
  return (Array.isArray(todos) ? todos : []).flatMap((todo) => {
    if (!todo || typeof todo !== "object" || Array.isArray(todo)) return [];
    const content = typeof todo.content === "string" ? todo.content.trim() : "";
    if (!content) return [];
    const status = STATUS.has(todo.status) ? todo.status : "pending";
    const activeForm = typeof todo.activeForm === "string" ? todo.activeForm.trim() : "";
    return [activeForm ? { content, status, activeForm } : { content, status }];
  });
}

/** Short result text for one todo_write call. */
export function todoSummary(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return "Task list cleared.";
  const done = todos.filter((todo) => todo.status === "completed").length;
  const marks = { completed: "x", in_progress: ">", cancelled: "-", pending: " " };
  const lines = todos.map((todo) => `[${marks[todo.status] ?? " "}] ${todo.content}`);
  return `Task list updated (${done}/${todos.length} done):\n${lines.join("\n")}`;
}

/** Plain text of a message's content (a string or text blocks). */
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * What Ranch shows for the current session, read from Pi's session manager:
 * its name, the active branch's latest todo_write list and its first prompt.
 * A field is left out when it can't be read, so the store keeps what it has.
 */
export function sessionSnapshot(sessionManager) {
  const snapshot = {};
  try {
    if (typeof sessionManager?.getSessionName !== "function") throw new Error("no name API");
    const name = sessionManager.getSessionName();
    snapshot.session_name = typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    // name unknown: leave it out
  }
  try {
    const branch = sessionManager?.getBranch?.();
    if (Array.isArray(branch)) {
      let todos = [];
      let first = "";
      for (const entry of branch) {
        const message = entry?.type === "message" ? entry.message : null;
        if (!message) continue;
        if (!first && message.role === "user") first = messageText(message.content).trim();
        if (message.role === "toolResult" && message.toolName === "todo_write" && !message.isError &&
          Array.isArray(message.details?.todos)) {
          todos = message.details.todos;
        }
      }
      snapshot.todos = normalizeTodos(todos);
      if (first) snapshot.first_prompt = first.slice(0, 500);
    }
  } catch {
    // branch unreadable: leave tasks as they are
  }
  return snapshot;
}

// ------------------------------------------------------------ auto session name

const TITLE_TIMEOUT_MS = 20000;
const TITLE_MAX_TRIES = 3;

/** Auto-name steps go to ~/.herdr/ranch/pi-debug.log when RANCH_PI_DEBUG=1 or the file exists. */
function debugLog(...parts) {
  try {
    const file = join(process.env.RANCH_HOME || homedir(), ".herdr", "ranch", "pi-debug.log");
    if (!process.env.RANCH_PI_DEBUG && !existsSync(file)) return;
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // debug only
  }
}

/** True unless RANCH_PI_AUTONAME turns automatic session names off. */
export function autoNameEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.RANCH_PI_AUTONAME ?? "").trim());
}

/** The model's raw reply cleaned to a short session title, or null. */
export function cleanSessionTitle(raw) {
  let text = String(raw ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  text = text.replace(/^(session\s+)?(title|name)\s*:\s*/i, "").replace(/^["'`*#\s]+|["'`*.\s]+$/g, "").replace(/\s+/g, " ");
  if (!text || /^(skip|none|n\/a)$/i.test(text)) return null;
  if (text.length > 60) text = text.slice(0, 60).replace(/\s+\S*$/, "");
  return text || null;
}

/** The instruction sent with the first prompt. */
export function titlePrompt(prompt) {
  return [
    "Name this coding-agent session from the user's first request.",
    "Reply with ONLY a 2-5 word title in Title Case: no quotes, no punctuation at the end.",
    "Asking to check, test, verify, explain or explore something IS a task: name it.",
    "Reply SKIP only for a bare greeting or small talk with nothing to do (\"hi\", \"hello, how are you\").",
    "",
    "<request>",
    String(prompt).slice(0, 2000),
    "</request>",
  ].join("\n");
}

/**
 * Asks the session's current model for a title for `prompt`. Resolves to the
 * title, or null when the model answered without one (SKIP) or no model is
 * set up; rejects when the call failed (provider error, abort) so it can be
 * retried.
 */
export async function generateSessionTitle(ctx, prompt, signal) {
  const registry = ctx?.modelRegistry;
  const model = ctx?.model; // the model the person is already using: always present and authorized
  if (!model || !registry) return null;
  if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) return null;
  const context = { messages: [{ role: "user", content: [{ type: "text", text: titlePrompt(prompt) }], timestamp: Date.now() }] };
  // Thinking off: a reasoning model would otherwise spend the small budget
  // thinking and stop ("length") before any text. streamSimple without
  // `reasoning` disables it provider-neutrally; complete() needs the flag.
  const options = { maxTokens: 512, cacheRetention: "none", signal }; // room for forced thinking
  // Some providers route by session and reject calls without one (opencode-go:
  // 400 MissingSessionID), so send the Pi session's id like Pi's own requests.
  let sessionId = null;
  try {
    sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
  } catch {
    sessionId = null;
  }
  if (sessionId) options.sessionId = sessionId;
  let response;
  if (typeof registry.streamSimple === "function") {
    response = await registry.streamSimple(model, context, options).result();
  } else if (typeof registry.complete === "function") {
    response = await registry.complete(model, context, { ...options, thinkingEnabled: false });
  } else {
    return null;
  }
  debugLog("title reply", { model: model.id, stop: response?.stopReason, error: response?.errorMessage, content: response?.content });
  if (!response || response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response?.errorMessage || `title call ${response?.stopReason ?? "returned nothing"}`);
  }
  return cleanSessionTitle(messageText(response.content));
}

/** The todo_write tool definition (execute is added by the default export). */
export const TODO_TOOL = {
  name: "todo_write",
  label: "Tasks",
  description: "Records the WHOLE task list shown live in the Ranch panel. Every call replaces the previous list, so pass every task each time.",
  promptSnippet: "todo_write records the whole task list shown live in the Ranch panel.",
  promptGuidelines: [
    "Use todo_write at the start of every reply to record the work as tasks.",
    "Pass the whole list to todo_write every time; it replaces the previous list.",
    "Mark tasks in_progress and completed with todo_write as the work moves.",
  ],
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: [...TODO_STATUSES] },
            activeForm: { type: "string" },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
};

/** Sends one payload to `ranch-tasks pi`; resolves to trimmed stdout or "". */
function runSend(payload) {
  if (!process.env.HC_TERMINAL_ID) return Promise.resolve("");
  const [cmd, args] = ranchCommand();
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish("");
      return;
    }
    let out = "";
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish("");
    }, SEND_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.on("error", () => finish(""));
    child.on("close", (code) => finish(code === 0 ? out.trim() : ""));
    try {
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      finish("");
    }
  });
}

/** Ranch task reporting for Pi: registers todo_write and forwards hook events. */
export default function ranchTasks(pi) {
  const sessionIdOf = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? null;
    } catch {
      return null;
    }
  };
  const cwdOf = (ctx) => ctx?.cwd ?? process.cwd();

  // Automatic session names, cancelled on shutdown. A model answer (a title
  // or SKIP) settles the session; a failed or timed-out call is retried on
  // the next prompt, up to TITLE_MAX_TRIES calls per session.
  const settled = new Set();
  const tries = new Map();
  const inFlight = new Set();
  let titleAbort = new AbortController();
  const autoName = (ctx, prompt) => {
    if (!autoNameEnabled()) return;
    const sid = sessionIdOf(ctx);
    debugLog("autoName", { sid, settled: settled.has(sid), tries: tries.get(sid) ?? 0, name: pi.getSessionName?.() ?? null, model: ctx?.model?.id });
    if (!sid || settled.has(sid) || inFlight.has(sid)) return;
    if (pi.getSessionName?.()) { settled.add(sid); return; } // already named (/name, --name)
    const first = sessionSnapshot(ctx?.sessionManager).first_prompt || String(prompt ?? "");
    if (first.trim().length < 12 || first.trim().startsWith("/")) { settled.add(sid); return; }
    const n = (tries.get(sid) ?? 0) + 1;
    tries.set(sid, n);
    if (n >= TITLE_MAX_TRIES) settled.add(sid);
    inFlight.add(sid);
    const { signal } = titleAbort;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("title call timed out")), TITLE_TIMEOUT_MS);
      timer.unref?.();
    });
    Promise.race([generateSessionTitle(ctx, first, signal), timeout])
      .then((title) => {
        settled.add(sid);
        debugLog("title", { title, aborted: signal.aborted, sidNow: sessionIdOf(ctx), name: pi.getSessionName?.() ?? null });
        if (!title || signal.aborted) return;
        if (sessionIdOf(ctx) !== sid || pi.getSessionName?.()) return; // switched or named meanwhile
        pi.setSessionName(title);
      })
      .catch((err) => debugLog("title error", { try: n, error: String(err?.message ?? err) }))
      .finally(() => {
        clearTimeout(timer);
        inFlight.delete(sid);
      });
  };

  let pendingReminder = "";
  let sessionStart = Promise.resolve("");
  // One promise chain, so payloads reach the CLI in event order.
  let queue = Promise.resolve();
  const send = (payload) => {
    const run = queue.then(() => runSend(payload), () => runSend(payload));
    queue = run.then(() => {}, () => {});
    return run;
  };

  pi.registerTool({
    ...TODO_TOOL,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        const todos = normalizeTodos(params?.todos);
        return { content: [{ type: "text", text: todoSummary(todos) }], details: { todos } };
      } catch {
        return { content: [{ type: "text", text: "Task list cleared." }], details: { todos: [] } };
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    debugLog("session_start", { reason: event?.reason, sid: sessionIdOf(ctx), model: ctx?.model?.id });
    try {
      sessionStart = send({
        hook_event_name: "SessionStart",
        session_id: sessionIdOf(ctx),
        source: event?.reason,
        cwd: cwdOf(ctx),
        ...sessionSnapshot(ctx?.sessionManager),
      });
      pendingReminder = await sessionStart;
    } catch {
      // never disturb the agent
    }
  });

  // /name, --name or pi.setSessionName(): the tab follows the session name.
  pi.on("session_info_changed", (event, ctx) => {
    try {
      const name = typeof event?.name === "string" && event.name.trim() ? event.name.trim() : null;
      send({ hook_event_name: "SessionSync", session_id: sessionIdOf(ctx), session_name: name });
    } catch {
      // never disturb the agent
    }
  });

  // /tree moved to another branch: its own todo list applies.
  pi.on("session_tree", (event, ctx) => {
    try {
      send({ hook_event_name: "SessionSync", session_id: sessionIdOf(ctx), ...sessionSnapshot(ctx?.sessionManager) });
    } catch {
      // never disturb the agent
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // Wait for session_start's send (ordering), then use its reminder once.
      await sessionStart;
      const reminder = pendingReminder;
      pendingReminder = "";
      try {
        autoName(ctx, event?.prompt);
      } catch {
        // naming is best effort
      }
      const prompt = await send({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionIdOf(ctx),
        prompt: event?.prompt ?? "",
        cwd: cwdOf(ctx),
      });
      const text = [reminder, prompt].filter(Boolean).join("\n\n");
      if (!text) return undefined;
      return { systemPrompt: `${event?.systemPrompt ?? ""}\n\n${text}` };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    try {
      const name = event?.toolName;
      const relevant = name === "bash" || name === "todo_write";
      send({
        hook_event_name: "PostToolUse",
        session_id: sessionIdOf(ctx),
        tool_name: name,
        tool_input: relevant ? event?.input ?? {} : {},
        tool_response: relevant ? toolResponse(event) : { stdout: "", exit_code: 0 },
        cwd: cwdOf(ctx),
      });
    } catch {
      // never disturb the agent
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    try {
      send({ hook_event_name: "Stop", session_id: sessionIdOf(ctx) });
    } catch {
      // never disturb the agent
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    titleAbort.abort();
    titleAbort = new AbortController();
    try {
      // Awaited: on quit Pi exits right after its handlers settle, which
      // would otherwise kill the send (and anything still queued) mid-flight.
      if (event?.reason === "quit") await send({ hook_event_name: "SessionEnd", session_id: sessionIdOf(ctx) });
    } catch {
      // never disturb the agent
    }
  });
}
