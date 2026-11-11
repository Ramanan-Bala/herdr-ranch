// Claude Code adapter: pure reducer over hook payloads (requirements.md §7.4).
// applyClaude(store, payload) returns the next store. Transcript text, when
// needed, is passed in as payload.transcript by the CLI — this module never
// touches the filesystem.

const TASK_STATUS = new Set(["pending", "in_progress", "completed"]);
const KNOWN_EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "SessionEnd", "Stop",
]);

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

function applyTool(store, payload) {
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
    // tool_response may be a string or an object; search its JSON text.
    const match = /Task #(\S+) created successfully/.exec(JSON.stringify(payload.tool_response ?? ""));
    const id = match ? match[1] : String(store.tasks.length + 1);
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
  if (event === "PostToolUse") applyTool(next, payload);
  if (event === "SessionEnd") ensureSession(next).state = "ended";
  return next;
}
