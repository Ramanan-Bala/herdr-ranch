// ranch-tasks plugin
// Ranch task reporting for the Pi coding agent. This file is copied alone into
// ~/.pi/agent/extensions/, so it must not import the repo (only node:
// built-ins): it spawns `ranch-tasks pi` and sends normalized hook payloads.
// Pi already reports working/idle/blocked to Herdr itself (OSC 7501), so this
// extension never writes terminal escape codes.
import { spawn } from "node:child_process";
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
const SMALL_MODEL = [/haiku/i, /flash-lite/i, /\bmini\b|-mini/i, /nano/i, /flash/i, /\bsmall\b|-small/i, /\blite\b|-lite/i];

/** True unless RANCH_PI_AUTONAME turns automatic session names off. */
export function autoNameEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.RANCH_PI_AUTONAME ?? "").trim());
}

/** A cheap model from the current provider for titles, else the current model. */
export function pickTitleModel(registry, current) {
  if (!current) return null;
  let available = [];
  try {
    available = registry?.getAvailable?.() ?? [];
  } catch {
    available = [];
  }
  const sameProvider = available.filter((m) => m && m.provider === current.provider && typeof m.id === "string");
  for (const pattern of SMALL_MODEL) {
    // Newest-looking id first (claude-haiku-4-5 over claude-3-haiku).
    const found = sameProvider.filter((m) => pattern.test(m.id))
      .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
    if (found.length) return found[0];
  }
  return current;
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
    "If the request has no clear task (a greeting, a test message), reply SKIP.",
    "",
    "<request>",
    String(prompt).slice(0, 2000),
    "</request>",
  ].join("\n");
}

/** Asks a model for a title for `prompt`; resolves to the title or null. */
export async function generateSessionTitle(ctx, prompt, signal) {
  const registry = ctx?.modelRegistry;
  const model = pickTitleModel(registry, ctx?.model);
  if (!model || typeof registry?.complete !== "function") return null;
  if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) return null;
  const response = await registry.complete(
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: titlePrompt(prompt) }], timestamp: Date.now() }] },
    { maxTokens: 40, cacheRetention: "none", signal },
  );
  if (!response || response.stopReason === "error" || response.stopReason === "aborted") return null;
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

  // Automatic session names: one attempt per session, cancelled on shutdown.
  const titled = new Set();
  let titleAbort = new AbortController();
  const autoName = (ctx, prompt) => {
    if (!autoNameEnabled()) return;
    const sid = sessionIdOf(ctx);
    if (!sid || titled.has(sid)) return;
    titled.add(sid);
    if (pi.getSessionName?.()) return; // already named (/name, --name)
    const first = sessionSnapshot(ctx?.sessionManager).first_prompt || String(prompt ?? "");
    if (first.trim().length < 12 || first.trim().startsWith("/")) return;
    const { signal } = titleAbort;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), TITLE_TIMEOUT_MS).unref?.());
    Promise.race([generateSessionTitle(ctx, first, signal), timeout])
      .then((title) => {
        if (!title || signal.aborted) return;
        if (sessionIdOf(ctx) !== sid || pi.getSessionName?.()) return; // switched or named meanwhile
        pi.setSessionName(title);
      })
      .catch(() => {});
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
