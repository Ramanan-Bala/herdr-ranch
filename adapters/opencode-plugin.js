// ranch-tasks plugin
// Ranch task reporting for OpenCode (requirements.md §7.4). This file is
// copied alone into ~/.config/opencode/plugins/, so it must not import ../lib:
// it inlines a minimal store read/normalise/atomic-write. It runs inside the
// OpenCode process and only ever writes the store file — nothing else.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STORE_VERSION = 1;
const TASKS_DIR = ".herdr/ranch/tasks";
const TASK_STATUS = new Set(["pending", "in_progress", "completed"]);

function homeDir() {
  return process.env.RANCH_HOME || homedir();
}

function storeFileName(address) {
  const safe = String(address ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe ? `${safe}.json` : null;
}

function storePath() {
  const name = storeFileName(process.env.HC_TERMINAL_ID);
  return name ? join(homeDir(), TASKS_DIR, name) : null;
}

function emptyStore(terminal) {
  return {
    version: STORE_VERSION,
    terminal,
    agent: "opencode",
    updated_at: null,
    session: null,
    tasks: [],
    subagents: [],
  };
}

/** Minimal normalisation; the mod's parser re-checks everything anyway. */
function normalizeStore(raw, terminal) {
  if (!raw || typeof raw !== "object" || (typeof raw.version === "number" && raw.version > STORE_VERSION)) {
    return emptyStore(terminal);
  }
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
    .filter((t) => t && typeof t.title === "string" && t.title.trim())
    .map((t) => ({
      id: t.id === undefined || t.id === null ? "" : String(t.id),
      title: t.title,
      status: TASK_STATUS.has(t.status) ? t.status : "pending",
      active_form: typeof t.active_form === "string" ? t.active_form : null,
    }));
  const subagents = (Array.isArray(raw.subagents) ? raw.subagents : [])
    .filter((s) => s && s.id !== undefined && s.id !== null && String(s.id) !== "")
    .map((s) => ({
      id: String(s.id),
      name: typeof s.name === "string" && s.name ? s.name : String(s.id),
      status: s.status === "done" || s.status === "failed" ? s.status : "running",
      started_at: typeof s.started_at === "string" ? s.started_at : null,
      ended_at: typeof s.ended_at === "string" ? s.ended_at : null,
    }));
  const session = raw.session && typeof raw.session === "object"
    ? {
        id: typeof raw.session.id === "string" ? raw.session.id : null,
        title: typeof raw.session.title === "string" && raw.session.title ? raw.session.title : null,
        title_source: raw.session.title_source === "user" ? "user" : raw.session.title ? "agent" : null,
        first_prompt: typeof raw.session.first_prompt === "string" ? raw.session.first_prompt : null,
        state: raw.session.state === "ended" ? "ended" : "running",
      }
    : null;
  return {
    version: STORE_VERSION,
    terminal: typeof raw.terminal === "string" ? raw.terminal : terminal,
    agent: typeof raw.agent === "string" ? raw.agent : "opencode",
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    session,
    tasks,
    subagents,
  };
}

function loadStore(path) {
  try {
    return normalizeStore(JSON.parse(readFileSync(path, "utf8")), process.env.HC_TERMINAL_ID);
  } catch {
    return emptyStore(process.env.HC_TERMINAL_ID);
  }
}

function saveStore(path, store) {
  store.updated_at = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, path);
}

/**
 * Pure reducer for OpenCode events (and the "chat.message" hook, expressed as
 * { type: "chat.message", properties: { sessionID, text } }). Returns the next
 * store, or the same store when the event changes nothing.
 */
/**
 * Activity for an OpenCode event, for the main session only:
 * busy/retry -> working, idle -> done, permission asked -> blocked,
 * permission replied -> working. Null when the event says nothing.
 */
export function opencodeActivity(store, event) {
  const props = event?.properties && typeof event.properties === "object" ? event.properties : {};
  const main = store?.session?.id ?? null;
  const sid = props.sessionID ?? props.info?.id ?? null;
  if (main && sid && sid !== main) return null;
  switch (event?.type) {
    case "session.status": {
      const t = props.status?.type;
      return t === "busy" || t === "retry" ? "working" : t === "idle" ? "done" : null;
    }
    case "session.idle":
      return "done";
    case "permission.updated":
    case "permission.asked":
      return "blocked";
    case "permission.replied":
      return "working";
    default:
      return null;
  }
}

export function reduceOpencode(store, event) {
  const next = reduceOpencodeCore(store, event);
  const state = opencodeActivity(next ?? store, event);
  if (!state) return next;
  const base = next ?? store;
  // Only write when the state changes: events arrive many times a second.
  if (base.session?.activity?.state === state) return next;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

function reduceOpencodeCore(store, event) {
  if (!event || typeof event !== "object") return store;
  const type = event.type;
  const props = event.properties && typeof event.properties === "object" ? event.properties : {};
  const now = new Date().toISOString();
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };

  if (type === "todo.updated") {
    if (props.sessionID && store.session?.id && props.sessionID !== store.session.id) return store;
    // Replace tasks; cancelled ones are dropped.
    const todos = Array.isArray(props.todos) ? props.todos : [];
    next.tasks = todos.flatMap((todo) => {
      if (!todo || todo.status === "cancelled") return [];
      const title = typeof todo.content === "string" ? todo.content.trim() : "";
      if (!title) return [];
      return [{
        id: todo.id === undefined || todo.id === null ? "" : String(todo.id),
        title,
        status: TASK_STATUS.has(todo.status) ? todo.status : "pending",
        active_form: null,
      }];
    });
    return next;
  }

  if (type === "session.created" || type === "session.updated") {
    const info = props.info;
    if (!info || typeof info.id !== "string" || !info.id) return store;
    if (info.parentID) {
      // Sub-agent session: add it, or refresh its name without resetting state.
      const existing = next.subagents.find((s) => s.id === info.id);
      if (existing) {
        next.subagents = next.subagents.map((s) =>
          s.id === info.id ? { ...s, name: info.title || s.name } : s);
      } else {
        next.subagents = [...next.subagents, {
          id: info.id,
          name: info.title || "sub-agent",
          status: "running",
          started_at: now,
          ended_at: null,
        }];
      }
    } else {
      // Main session: track its id so instances in other terminals never mix.
      const different = Boolean(store.session?.id && store.session.id !== info.id);
      if (type === "session.updated" && different && store.session.state !== "ended") return store;
      let session;
      if (different) {
        next.tasks = [];
        next.subagents = [];
        session = { id: info.id, title: null, title_source: null, first_prompt: null, state: "running" };
      } else {
        session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...(store.session ?? {}), id: info.id };
      }
      const title = typeof info.title === "string" ? info.title.trim() : "";
      if (title && !/^New session/i.test(title) && session.title_source !== "user") {
        session.title = title;
        session.title_source = "agent";
      }
      next.session = session;
    }
    return next;
  }

  if (type === "session.idle") {
    if (typeof props.sessionID === "string" && next.subagents.some((s) => s.id === props.sessionID)) {
      next.subagents = next.subagents.map((s) =>
        s.id === props.sessionID ? { ...s, status: "done", ended_at: now } : s);
      return next;
    }
    return store;
  }

  if (type === "session.deleted") {
    const id = typeof props.info?.id === "string" ? props.info.id : props.sessionID;
    if (typeof id !== "string") return store;
    if (store.session && store.session.id === id) {
      next.session = { ...store.session, state: "ended" };
      return next;
    }
    if (next.subagents.some((s) => s.id === id)) {
      next.subagents = next.subagents.map((s) =>
        s.id === id ? { ...s, status: "done", ended_at: now } : s);
      return next;
    }
    return store;
  }

  if (type === "chat.message") {
    const text = typeof props.text === "string" ? props.text : "";
    if (!text) return store;
    const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...(store.session ?? {}) };
    // Only the main session's first message counts.
    if (!session.first_prompt && (!session.id || props.sessionID === session.id)) {
      session.first_prompt = text.slice(0, 500);
      next.session = session;
      return next;
    }
    return store;
  }

  return store;
}

// Mandatory task reporting (also in ~/.config/opencode/AGENTS.md): added to
// the system prompt of every request so the model sees it each turn.
const TASK_RULE = "Task reporting is mandatory (Ranch): for EVERY user message, before anything else record the work as tasks with the todowrite tool (at least one task per message, one per step when there are several), mark each in_progress when you start it and completed the moment it is done, and complete all of them before you end your reply.";

export const RanchTasks = async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    try {
      if (Array.isArray(output?.system) && !output.system.includes(TASK_RULE)) output.system.push(TASK_RULE);
    } catch {
      // Never break the host.
    }
  },

  event: async ({ event }) => {
    try {
      const path = storePath();
      if (!path) return;
      const store = loadStore(path);
      const next = reduceOpencode(store, event);
      if (next !== store) saveStore(path, next);
    } catch {
      // Never break the host: task reporting fails silently.
    }
  },

  "chat.message": async (input, output) => {
    try {
      const path = storePath();
      if (!path) return;
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!text) return;
      const store = loadStore(path);
      const next = reduceOpencode(store, {
        type: "chat.message",
        properties: { sessionID: input?.sessionID, text },
      });
      if (next !== store) saveStore(path, next);
    } catch {
      // Never break the host: task reporting fails silently.
    }
  },
});

export default RanchTasks;
