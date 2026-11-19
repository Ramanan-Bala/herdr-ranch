// Pi adapter: pure reducer over the normalized payloads the Ranch Pi extension (adapters/pi-extension.js) sends.
// session.title is Pi's session name (/name, --name, pi.setSessionName()). The
// extension sends a session snapshot (name, the branch's latest todo list, its
// first prompt) on SessionStart and SessionSync (rename, /tree), so a resumed,
// forked or re-branched session shows its own name and tasks.

import { tasksFingerprint } from "../lib/tasks.js";
import { detectCreatedPr } from "../lib/prs.js";

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const KNOWN_EVENTS = new Set(["SessionStart", "SessionSync", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);

/** Store tasks from Pi todo_write todos (ids are list positions). */
function tasksFromTodos(todos) {
  return todos.flatMap((todo, i) => {
    const title = typeof todo?.content === "string" ? todo.content.trim() : "";
    if (!title) return [];
    const activeForm = typeof todo.activeForm === "string" ? todo.activeForm.trim() : "";
    return [{
      id: String(i + 1),
      title,
      status: TASK_STATUS.has(todo.status) ? todo.status : "pending",
      active_form: activeForm || null,
    }];
  });
}

/**
 * Applies the extension's session snapshot. Each field is optional so older
 * extensions (which send none) keep the previous behaviour:
 * - session_name: string sets the title (a Pi name is user-chosen); null clears it.
 * - todos: the branch's latest todo list; replaces the tasks (an empty array clears them).
 * - first_prompt: the branch's first user message, used when none is recorded.
 */
function applySnapshot(next, payload) {
  const session = ensureSession(next);
  if (Object.prototype.hasOwnProperty.call(payload, "session_name")) {
    const name = typeof payload.session_name === "string" ? payload.session_name.trim() : "";
    session.title = name || null;
    session.title_source = name ? "user" : null;
  }
  if (Array.isArray(payload.todos)) {
    const before = tasksFingerprint(next.tasks);
    next.tasks = tasksFromTodos(payload.todos);
    if (tasksFingerprint(next.tasks) !== before) next.missed_turns = 0;
  }
  if (!session.first_prompt && typeof payload.first_prompt === "string" && payload.first_prompt.trim()) {
    session.first_prompt = payload.first_prompt.slice(0, 500);
  }
}

function ensureSession(store) {
  const base = store.session && typeof store.session === "object" ? store.session : {};
  const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...base };
  store.session = session;
  return session;
}

/** Activity for a Pi hook event (same meaning as claudeActivity). */
export function piActivity(payload) {
  switch (payload?.hook_event_name) {
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "Stop":
      return "done";
    case "SessionStart":
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

export function applyPi(store, payload) {
  const next = applyPiCore(store, payload);
  const state = piActivity(payload);
  if (!state) return next;
  const base = next && typeof next === "object" ? next : store;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

/** Records a PR URL created by `gh pr create` into store.prs (I4). Pi reports
 * the shell tool as "bash" with a command string. */
function recordCreatedPr(store, payload) {
  const found = detectCreatedPr(payload);
  if (!found || store.prs?.some((p) => p.url === found.url)) return;
  store.prs = [...(store.prs ?? []), { ...found, at: new Date().toISOString() }].slice(-10);
}

function applyPiCore(store, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return store;
  const event = payload.hook_event_name;
  if (!KNOWN_EVENTS.has(event)) return store;
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };

  if (event !== "SessionStart") {
    const sid = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    if (sid && next.session?.id && next.session.id !== sid) {
      // Session reuse without a SessionStart event (I10): start fresh.
      next.session = { id: sid, title: null, title_source: null, first_prompt: null, state: "running" };
      next.tasks = [];
      next.subagents = [];
      next.missed_turns = 0;
    } else if (sid && !next.session?.id) {
      // Keep session.id in sync on every event (I12).
      ensureSession(next).id = sid;
    }
  }

  if (event === "SessionStart") {
    const id = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    const fresh = payload.source === "startup" || payload.source === "new" ||
      (id && id !== next.session?.id && payload.source !== "reload");
    if (fresh) {
      next.session = { id, title: null, title_source: null, first_prompt: null, state: "running" };
      next.missed_turns = 0;
    } else {
      const session = ensureSession(next);
      if (id) session.id = id;
      session.state = "running";
    }
    if (payload.source === "startup" || payload.source === "new") {
      next.tasks = [];
      next.subagents = [];
    }
    applySnapshot(next, payload);
    return next;
  }

  if (event === "SessionSync") {
    applySnapshot(next, payload);
    return next;
  }

  if (event === "UserPromptSubmit") {
    const session = ensureSession(next);
    if (!session.first_prompt && typeof payload.prompt === "string" && payload.prompt) {
      session.first_prompt = payload.prompt.slice(0, 500);
    }
    // Turn tracking (fixes §3.7); Stop compares against it.
    session.turn = { tasks: tasksFingerprint(next.tasks), tools: false };
    return next;
  }

  if (event === "PostToolUse") {
    if (payload.tool_name === "bash") recordCreatedPr(next, payload);
    const before = tasksFingerprint(next.tasks);
    const todos = payload.tool_name === "todo_write" ? payload.tool_input?.todos : null;
    if (Array.isArray(todos)) {
      // Replace tasks entirely from the todo list.
      next.tasks = tasksFromTodos(todos);
    }
    // A todo list that changed clears the missed-turn nudge (fixes 3.7);
    // any other tool means the turn did real work.
    if (tasksFingerprint(next.tasks) !== before) next.missed_turns = 0;
    else if (payload.tool_name !== "todo_write") {
      const turn = next.session?.turn;
      if (turn) next.session = { ...next.session, turn: { ...turn, tools: true } };
    }
    return next;
  }

  if (event === "Stop") {
    // Miss detection (fixes §3.7). Pi exposes no transcript, so a turn is
    // judged by the tools it ran: one that worked but left the task list
    // unchanged counts as missed. The turn is consumed either way.
    const session = ensureSession(next);
    if (session.turn) {
      if (session.turn.tools && tasksFingerprint(next.tasks) === session.turn.tasks) {
        next.missed_turns = (Number.isInteger(store.missed_turns) ? store.missed_turns : 0) + 1;
      }
      delete session.turn;
    }
    return next;
  }

  // SessionEnd
  ensureSession(next).state = "ended";
  return next;
}
