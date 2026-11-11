// ranch-tasks plugin
// Ranch task reporting for OpenCode (requirements.md §7.4). This file is
// copied alone into ~/.config/opencode/plugins/, so it must not import ../lib:
// it inlines a minimal store read/normalise/atomic-write. It runs inside the
// OpenCode process and only ever writes the store file — nothing else.
// One file, both hosts: OpenCode 2.x schema-validates the default export as
// an object ({ id, setup, server }) and calls setup(ctx); v1 calls server(),
// which returns the classic hooks object.
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
        // Keep the recorded activity: dropping it here erased it on every later event.
        ...(raw.session.activity && typeof raw.session.activity.state === "string" && typeof raw.session.activity.at === "number"
          ? { activity: { state: raw.session.activity.state, at: raw.session.activity.at } }
          : {}),
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

/**
 * Pure reducer for OpenCode events (and the "chat.message" hook, expressed as
 * { type: "chat.message", properties: { sessionID, text } }). Returns the next
 * store, or the same store when the event changes nothing.
 */
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

// ---- OpenCode 2.x -----------------------------------------------------------
// v2's bus-event payload shapes are undocumented, so every read is defensive
// and anything unusable is dropped rather than thrown.

/** The event's payload: documented as .properties, seen as .data or bare. */
function pickRaw(event) {
  if (!event || typeof event !== "object") return {};
  if (event.properties && typeof event.properties === "object") return event.properties;
  if (event.data && typeof event.data === "object") return event.data;
  return event;
}

function pickInfo(raw) {
  return [raw.info, raw.session].find((v) => v && typeof v === "object") ?? {};
}

function pickSessionID(event) {
  const raw = pickRaw(event);
  const info = pickInfo(raw);
  for (const id of [raw.sessionID, info.id, info.sessionID]) {
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function pickParentID(event) {
  const raw = pickRaw(event);
  const info = pickInfo(raw);
  for (const id of [info.parentID, raw.parentID]) {
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Adopts the first session seen as the main session, so tasks are not dropped
 * when session.created was missed (or does not exist, as on v2). Sub-agent
 * sessions (with a parentID) never become the main session.
 */
function adoptSession(store, event) {
  if (!store || store.session?.id) return store;
  const id = pickSessionID(event);
  if (!id || pickParentID(event)) return store;
  const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...(store.session ?? {}), id };
  return { ...store, session };
}

/** One store read → reduce → conditional atomic write, shared by both hosts. */
function recordEvent(event) {
  try {
    const path = storePath();
    if (!path) return;
    const loaded = loadStore(path);
    const adopted = adoptSession(loaded, event);
    const next = reduceOpencode(adopted, event);
    if (next !== adopted || adopted !== loaded) saveStore(path, next);
  } catch {
    // Never break the host: task reporting fails silently.
  }
}

/**
 * Maps a v2 bus event onto the v1 event shapes reduceOpencode already
 * understands. Returns null when the event says nothing worth recording.
 */
function normalizeV2(event) {
  const type = typeof event?.type === "string" ? event.type
    : typeof event?.name === "string" ? event.name : null;
  if (!type) return null;
  const raw = pickRaw(event);
  const sid = pickSessionID(event);
  switch (type) {
    case "session.created":
    case "session.updated": {
      const info = pickInfo(raw);
      const id = typeof info.id === "string" && info.id ? info.id : sid;
      if (!id) return null;
      const mapped = { id };
      if (typeof info.parentID === "string" && info.parentID) mapped.parentID = info.parentID;
      if (typeof info.title === "string" && info.title) mapped.title = info.title;
      return { type, properties: { info: mapped } };
    }
    case "session.renamed": {
      // v2.2: { data: { sessionID, title } } — OpenCode's own session title.
      const title = typeof raw.title === "string" ? raw.title.trim() : "";
      if (!sid || !title) return null;
      return { type: "session.updated", properties: { info: { id: sid, title } } };
    }
    case "session.deleted": {
      const info = pickInfo(raw);
      const id = typeof info.id === "string" && info.id ? info.id : sid;
      if (!id) return null;
      return { type, properties: { info: { id } } };
    }
    case "session.execution.started":
      return { type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } };
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { type: "session.idle", properties: { sessionID: sid } };
    case "permission.asked":
    case "permission.replied":
    case "session.idle":
      return { type, properties: { sessionID: sid } };
    case "session.status":
      return { type, properties: { sessionID: sid, status: raw.status } };
    default:
      return null;
  }
}

/** Prompt text from a v2 prompt hook event: .prompt or text parts. */
function pickPromptText(event) {
  const raw = pickRaw(event);
  if (typeof raw.prompt === "string" && raw.prompt.trim()) return raw.prompt;
  // v2.2: the prompt hook carries { prompt: { text, files, ... } }.
  if (typeof raw.prompt?.text === "string" && raw.prompt.text.trim()) return raw.prompt.text;
  const parts = Array.isArray(raw.parts) ? raw.parts
    : raw.message && typeof raw.message === "object" && Array.isArray(raw.message.parts)
      ? raw.message.parts
      : [];
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}


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

/** Hook registration returns a promise on v2: swallow its rejection. */
function quiet(result) {
  if (result && typeof result.catch === "function") result.catch(() => {});
  return result;
}

/** Sync callback wrapper: a failing hook must never break OpenCode. */
function safeCall(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch {
      // Task reporting fails silently.
    }
  };
}

/**
 * Ranch task reporting for OpenCode 1.x and 2.x. A plain object, because the
 * 2.x loader schema-validates `default` as an object ({ id, setup, server });
 * v2 calls setup(ctx), v1 (>= 1.18.29) calls server().
 */
const RanchTasksPlugin = {
  id: "ranch-tasks",

  async setup(ctx) {
    const controller = new AbortController();
    try {
      // Tool results: todowrite replaces the task list. The todo tool carries
      // its session id on the event; a sub-agent's todowrite is dropped by the
      // reducer once the main session is known.
      quiet(ctx?.tool?.hook?.("execute.after", safeCall((event) => {
        if (event?.tool !== "todowrite") return;
        const todos = event?.input && typeof event.input === "object" ? event.input.todos : null;
        if (!Array.isArray(todos)) return;
        recordEvent({
          type: "todo.updated",
          properties: {
            sessionID: typeof event.sessionID === "string" ? event.sessionID : null,
            todos,
          },
        });
      })));

      // Prompts: the first user message names the session.
      quiet(ctx?.session?.hook?.("prompt", safeCall((event) => {
        const text = pickPromptText(event);
        if (!text) return;
        const raw = pickRaw(event);
        const sid = typeof event.sessionID === "string" && event.sessionID
          ? event.sessionID
          : typeof raw.sessionID === "string" ? raw.sessionID : null;
        recordEvent({ type: "chat.message", properties: { sessionID: sid, text } });
      })));

      // System prompt: the mandatory task rule, exactly once. v2 system parts
      // are objects ({ type: "text", text }), never bare strings.
      quiet(ctx?.session?.hook?.("context", safeCall((event) => {
        if (!Array.isArray(event?.system)) return;
        const has = event.system.some((part) => part === TASK_RULE || part?.text === TASK_RULE);
        if (!has) event.system.push({ type: "text", text: TASK_RULE });
      })));

      // Bus events: session lifecycle and activity, mapped onto v1 shapes.
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              const mapped = normalizeV2(event);
              if (mapped) recordEvent(mapped);
            } catch {
              // Task reporting fails silently.
            }
          }
        } catch {
          // Aborted or the bus went away; nothing to record.
        }
      })();
    } catch {
      // Task reporting fails silently.
    }
    return () => {
      try {
        controller.abort();
      } catch {
        // Task reporting fails silently.
      }
    };
  },

  async server() {
    try {
      return await RanchTasks({});
    } catch {
      return {};
    }
  },
};

export default RanchTasksPlugin;
