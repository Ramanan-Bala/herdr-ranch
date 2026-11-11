// Claude Code adapter: pure reducer over hook payloads (requirements.md §7.4).
// applyClaude(store, payload) returns the next store. Transcript text, when
// needed, is passed in as payload.transcript by the CLI — this module never
// touches the filesystem.

import { tasksFingerprint } from "../lib/tasks.js";

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const KNOWN_EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "SessionEnd", "Stop",
]);

// Tools that mean the agent did real work this turn (fixes §3.7).
const WORK_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

/**
 * Whether the transcript shows a write/edit/shell tool use since the last
 * real user prompt (fixes §3.7). Transcript JSONL, as passed by the CLI.
 */
export function transcriptWorkTools(text) {
  if (typeof text !== "string" || !text) return false;
  let inTurn = false;
  let worked = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record?.message?.content;
    if (record?.type === "user") {
      const toolResult = Array.isArray(content) && content.some((part) => part?.type === "tool_result");
      const prompt = typeof content === "string" ||
        (Array.isArray(content) && !toolResult && content.some((part) => part?.type === "text"));
      if (prompt) {
        inTurn = true; // a new turn starts: earlier tool use no longer counts
        worked = false;
      }
      continue;
    }
    if (inTurn && record?.type === "assistant" && Array.isArray(content)
      && content.some((part) => part?.type === "tool_use" && WORK_TOOLS.has(part?.name))) {
      worked = true;
    }
  }
  return worked;
}

function ensureSession(store) {
  const base = store.session && typeof store.session === "object" ? store.session : {};
  const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...base };
  store.session = session;
  return session;
}

/** First present value among the given payload keys (field names vary). */
function pick(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value) !== "") return value;
  }
  return null;
}

/** Last custom-title wins ("user"), else the last ai-title ("agent"). */
function scanTitle(text) {
  if (typeof text !== "string" || !text) return null;
  let user = null;
  let agent = null;
  for (const line of text.split("\n")) {
    if (!line.includes("custom-title") && !line.includes("ai-title")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) {
      user = record.customTitle.trim();
    } else if (record?.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) {
      agent = record.aiTitle.trim();
    }
  }
  if (user) return { title: user, source: "user" };
  if (agent) return { title: agent, source: "agent" };
  return null;
}

/** A user-set title is never downgraded to an agent title. */
function refreshTitle(store, payload) {
  const found = scanTitle(payload.transcript);
  if (!found) return;
  const session = ensureSession(store);
  if (found.source === "user" || session.title_source !== "user") {
    session.title = found.title;
    session.title_source = found.source;
  }
}

const PR_URL = /https:\/\/github\.com\/[^\s"'<>()]+\/pull\/(\d+)/;

/** Records a PR URL created by `gh pr create` into store.prs (I4). */
function recordCreatedPr(store, payload) {
  const input = payload.tool_input;
  const command = Array.isArray(input?.command) ? input.command.join(" ") : input?.command;
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return;
  const response = typeof payload.tool_response === "string"
    ? payload.tool_response
    : JSON.stringify(payload.tool_response ?? "");
  const match = PR_URL.exec(response ?? "");
  if (!match) return;
  const url = match[0];
  if (store.prs?.some((p) => p.url === url)) return;
  store.prs = [...(store.prs ?? []), { url, number: Number(match[1]), at: new Date().toISOString() }].slice(-10);
}

function applyTool(store, payload) {
  if (payload.tool_name === "Bash") recordCreatedPr(store, payload);
  const input = payload.tool_input;
  if (!input || typeof input !== "object") return;

  if (payload.tool_name === "TodoWrite" && Array.isArray(input.todos)) {
    // Replace tasks entirely; ids are the positions in the agent's list.
    store.tasks = input.todos.flatMap((todo, i) => {
      const title = typeof todo?.content === "string" ? todo.content.trim() : "";
      if (!title) return [];
      return [{
        id: String(i + 1),
        title,
        status: TASK_STATUS.has(todo.status) ? todo.status : "pending",
        active_form: typeof todo.activeForm === "string" && todo.activeForm ? todo.activeForm : null,
      }];
    });
    return;
  }

  if (payload.tool_name === "TaskCreate") {
    const subject = typeof input.subject === "string" ? input.subject.trim() : "";
    if (!subject) return;
    // Current Claude returns a structured { task: { id } }; older builds
    // print "Task #7 created successfully" (I1).
    const task = payload.tool_response?.task;
    const structuredId = task && typeof task === "object" && task.id !== undefined && task.id !== null
      ? String(task.id)
      : null;
    // tool_response may also be a string or an object; search its JSON text.
    const match = /Task #(\S+) created successfully/.exec(JSON.stringify(payload.tool_response ?? ""));
    const id = structuredId ?? (match ? match[1] : String(store.tasks.length + 1));
    store.tasks = [...store.tasks, {
      id,
      title: subject,
      status: "pending",
      active_form: typeof input.activeForm === "string" && input.activeForm ? input.activeForm : null,
    }];
    return;
  }

  if (payload.tool_name === "TaskUpdate") {
    const id = input.taskId !== undefined && input.taskId !== null ? String(input.taskId) : null;
    if (!id) return;
    const index = store.tasks.findIndex((t) => t.id === id);
    if (input.status === "deleted") {
      if (index >= 0) store.tasks = store.tasks.filter((_, i) => i !== index);
      else store.hook_error = `TaskUpdate: unknown task id ${id}`;
    } else if (index >= 0) {
      store.tasks = store.tasks.map((task, i) => {
        if (i !== index) return task;
        const next = { ...task };
        if (TASK_STATUS.has(input.status)) next.status = input.status;
        if (typeof input.subject === "string" && input.subject.trim()) next.title = input.subject.trim();
        if (typeof input.activeForm === "string" && input.activeForm) next.active_form = input.activeForm;
        return next;
      });
    } else if (typeof input.subject === "string" && input.subject.trim()) {
      store.tasks = [...store.tasks, {
        id,
        title: input.subject.trim(),
        status: TASK_STATUS.has(input.status) ? input.status : "pending",
        active_form: typeof input.activeForm === "string" && input.activeForm ? input.activeForm : null,
      }];
    } else {
      // Nothing to apply: the update targets a task we never saw (I1).
      store.hook_error = `TaskUpdate: unknown task id ${id}`;
    }
  }
}

/**
 * Activity for an event (requirements §4: card status when Herdr shows none):
 * prompt / tool use -> working; permission prompt -> blocked; Stop -> done;
 * session end -> idle. Returns null when the event says nothing about it.
 */
export function claudeActivity(payload) {
  switch (payload?.hook_event_name) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SubagentStart":
      return "working";
    case "PermissionRequest":
      return "blocked";
    case "Notification": {
      const text = `${payload.notification_type ?? ""} ${payload.message ?? ""}`.toLowerCase();
      return /permission|approv|needs your|waiting for your/.test(text) ? "blocked" : null;
    }
    case "Stop":
      return "done";
    case "SessionStart":
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

export function applyClaude(store, payload) {
  const next = applyClaudeCore(store, payload);
  const state = claudeActivity(payload);
  if (!state) return next;
  const base = next && typeof next === "object" ? next : store;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

function applyClaudeCore(store, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return store;
  const event = payload.hook_event_name;
  if (!KNOWN_EVENTS.has(event)) return store;
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };
  const now = new Date().toISOString();

  if (event !== "SessionStart") {
    const sid = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    if (sid && next.session?.id && next.session.id !== sid) {
      // Session reuse without a SessionStart event (I10): start fresh.
      next.session = { id: sid, title: null, title_source: null, first_prompt: null, state: "running" };
      next.tasks = [];
      next.subagents = [];
    } else if (sid && !next.session?.id) {
      // Keep session.id in sync on every event (I12).
      ensureSession(next).id = sid;
    }
  }

  if (event === "SessionStart") {
    const id = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    const fresh = payload.source === "startup" || payload.source === "clear" ||
      (id && id !== next.session?.id && payload.source !== "compact");
    if (fresh) {
      next.session = { id, title: null, title_source: null, first_prompt: null, state: "running" };
    } else {
      const session = ensureSession(next);
      if (id) session.id = id;
      session.state = "running";
    }
    if (payload.source === "startup" || payload.source === "clear") {
      next.tasks = [];
      next.subagents = [];
    }
    return next;
  }

  if (event === "SubagentStart" || event === "SubagentStop") {
    const id = pick(payload, ["agent_id", "subagent_id", "id"]);
    if (id !== null) {
      const sid = String(id);
      if (event === "SubagentStart") {
        const name = pick(payload, ["agent_type", "subagent_type", "description"]);
        next.subagents = [
          ...next.subagents.filter((s) => s.id !== sid),
          { id: sid, name: name !== null ? String(name) : sid, status: "running", started_at: now, ended_at: null },
        ];
      } else {
        next.subagents = next.subagents.map((s) => (s.id === sid ? { ...s, status: "done", ended_at: now } : s));
      }
    }
    return next;
  }

  // UserPromptSubmit / PostToolUse / Stop / SessionEnd also refresh the title.
  refreshTitle(next, payload);
  if (event === "UserPromptSubmit" && typeof payload.prompt === "string" && payload.prompt) {
    const session = ensureSession(next);
    if (!session.first_prompt) session.first_prompt = payload.prompt.slice(0, 500);
  }
  if (event === "UserPromptSubmit") {
    // Turn tracking (fixes §3.7): remember the list as it stood when the
    // prompt arrived; Stop compares against it.
    const session = ensureSession(next);
    session.turn = { tasks: tasksFingerprint(next.tasks), tools: false };
  }
  if (event === "PostToolUse") {
    applyTool(next, payload);
    const session = next.session;
    if (session?.turn) session.turn.tools = true;
  }
  if (event === "Stop") {
    // Miss detection (fixes §3.7): the turn used write/edit/shell tools but
    // the task list did not change -> count a missed turn.
    const session = ensureSession(next);
    if (session.turn && transcriptWorkTools(payload.transcript)
      && tasksFingerprint(next.tasks) === session.turn.tasks) {
      next.missed_turns = (Number.isInteger(store.missed_turns) ? store.missed_turns : 0) + 1;
    }
  }
  if (event === "SessionEnd") ensureSession(next).state = "ended";
  return next;
}
