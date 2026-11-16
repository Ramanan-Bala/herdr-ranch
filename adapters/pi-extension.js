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
      });
      pendingReminder = await sessionStart;
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
    try {
      // Awaited: on quit Pi exits right after its handlers settle, which
      // would otherwise kill the send (and anything still queued) mid-flight.
      if (event?.reason === "quit") await send({ hook_event_name: "SessionEnd", session_id: sessionIdOf(ctx) });
    } catch {
      // never disturb the agent
    }
  });
}
