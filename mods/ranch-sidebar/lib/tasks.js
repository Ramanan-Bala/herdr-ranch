// The Ranch task store contract (requirements.md §7.3). Pure module, no imports:
// used by the mods (to read) and by bin/ranch-tasks + adapters (to write).

/** Store schema version this build understands. */
export const STORE_VERSION = 1;

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const SUB_STATUS = new Set(["running", "done", "failed"]);

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Normalizes one task; returns null when it has no title. */
export function normalizeTask(t, index = 0) {
  if (!t || typeof t !== "object") return null;
  const title = str(t.title);
  if (!title) return null;
  return {
    id: str(t.id) ?? String(index + 1),
    title,
    status: TASK_STATUS.has(t.status) ? t.status : "pending",
    active_form: str(t.active_form),
  };
}

/** Normalizes one sub-agent record; returns null when it has no id. */
export function normalizeSubagent(s) {
  if (!s || typeof s !== "object") return null;
  const id = str(s.id);
  if (!id) return null;
  return {
    id,
    name: str(s.name) ?? id,
    status: SUB_STATUS.has(s.status) ? s.status : "running",
    started_at: str(s.started_at),
    ended_at: str(s.ended_at),
  };
}

const ACTIVITY = new Set(["idle", "working", "blocked", "done"]);

/**
 * What the agent is doing, from Ranch's own hooks: { state, at } with state
 * idle | working | blocked | done and `at` in ms since the epoch. Used when
 * Herdr shows no status for the terminal. Null when unknown.
 */
export function normalizeActivity(a) {
  if (!a || typeof a !== "object" || !ACTIVITY.has(a.state)) return null;
  const at = typeof a.at === "number" && Number.isFinite(a.at) ? a.at : null;
  return { state: a.state, at };
}

/** Returns a new store with session.activity set (session created if missing). */
export function withActivity(store, state, at) {
  const session = store.session && typeof store.session === "object"
    ? store.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...store, session: { ...session, activity: { state, at } } };
}

/** Normalizes the session block. */
export function normalizeSession(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: str(s.id),
    title: str(s.title),
    title_source: s.title_source === "user" ? "user" : s.title ? "agent" : null,
    first_prompt: str(s.first_prompt),
    state: s.state === "ended" ? "ended" : "running",
    activity: normalizeActivity(s.activity),
  };
}

/** An empty store document for a terminal. */
export function emptyStore(terminal, agent) {
  return { version: STORE_VERSION, terminal, agent, updated_at: null, session: null, tasks: [], subagents: [] };
}

/**
 * Parses a store file's text.
 * Returns { ok: true, store } | { ok: false, reason: "missing" | "invalid" | "newer" }.
 */
export function parseStore(text) {
  if (text == null || text === "") return { ok: false, reason: "missing" };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, reason: "invalid" };
  if (typeof raw.version === "number" && raw.version > STORE_VERSION) return { ok: false, reason: "newer" };
  const tasks = (Array.isArray(raw.tasks) ? raw.tasks : []).map(normalizeTask).filter(Boolean);
  const subagents = (Array.isArray(raw.subagents) ? raw.subagents : []).map(normalizeSubagent).filter(Boolean);
  return {
    ok: true,
    store: {
      version: STORE_VERSION,
      terminal: str(raw.terminal),
      agent: str(raw.agent),
      updated_at: str(raw.updated_at),
      session: normalizeSession(raw.session),
      tasks,
      subagents,
    },
  };
}

/** Display order (R-SD-1): in_progress, then pending, then completed; stable within each group. */
export function orderTasks(tasks) {
  const rank = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
  return tasks.map((t, i) => [t, i]).sort((a, b) => rank[a[0].status] - rank[b[0].status] || a[1] - b[1]).map(([t]) => t);
}

/** { done, total } for the progress header. */
export function progress(tasks) {
  // Cancelled tasks are shown but never counted (fixes doc F7).
  const live = tasks.filter((t) => t.status !== "cancelled");
  return { done: live.filter((t) => t.status === "completed").length, total: live.length };
}

/** Store file name for a terminal address ("t6" -> "t6.json"); strips anything unsafe. */
export function storeFileName(address) {
  const safe = String(address ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe ? `${safe}.json` : null;
}
