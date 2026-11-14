// The Ranch task store contract (requirements.md §7.3, fixes §3.2/§3.3/§3.5).
// Pure module, no imports: used by the mods (to read) and by bin/ranch-tasks +
// adapters (to write).

/** Store schema version this build understands (fixes §3.3: schema 2). */
export const STORE_VERSION = 2;

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const SUB_STATUS = new Set(["running", "done", "failed"]);

/** Reader-side lifecycle knobs (fixes §3.5). */
export const STALE = {
  /** A list younger than this counts as fresh; older it greys out (§3.6). */
  FRESH_MS: 2 * 60 * 1000,
  /** All done + agent idle for longer than this -> fade, then remove. */
  HIDE_DONE_MS: 10 * 60 * 1000,
  /** Terminal gone for longer than this -> gc may delete the list. */
  GONE_MS: 2 * 60 * 1000,
  /** Session file untouched for longer than this -> gc prunes it. */
  PRUNE_MS: 14 * 24 * 60 * 60 * 1000,
};

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonNegInt(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * The agent identity block (fixes §3.3): { app, session, pid }. Schema-1
 * stores kept a plain app string; both are accepted on read.
 */
export function normalizeAgent(agent, fallbackApp = null) {
  if (typeof agent === "string") {
    const app = str(agent);
    return app ? { app, session: null, pid: null } : null;
  }
  if (isPlainObject(agent)) {
    const app = str(agent.app) ?? (typeof fallbackApp === "string" ? fallbackApp : null);
    return app ? { app, session: str(agent.session), pid: nonNegInt(agent.pid) } : null;
  }
  return null;
}

/** Herdr reports Claude as "claude-code"; mods sometimes shorten it to "claude". */
function sameApp(a, b) {
  const key = (x) => (x === "claude-code" ? "claude" : x);
  return key(a) === key(b);
}

/** The app name of a store's agent block, whatever shape it is in. */
export function agentApp(agent) {
  return normalizeAgent(agent)?.app ?? null;
}

/**
 * Strict task validation (fixes §3.2): anything malformed rejects the whole
 * file, so half-parsed data is never rendered. Returns null when malformed.
 */
export function normalizeTask(t, index = 0) {
  if (!isPlainObject(t)) return null;
  const title = str(t.title);
  if (!title) return null;
  if (t.status !== undefined && !TASK_STATUS.has(t.status)) return null;
  if (t.active_form !== undefined && t.active_form !== null && typeof t.active_form !== "string") return null;
  if (t.id !== undefined && t.id !== null && typeof t.id !== "string" && typeof t.id !== "number") return null;
  const id = typeof t.id === "number" && Number.isFinite(t.id) ? String(t.id) : str(t.id);
  return {
    id: id ?? String(index + 1),
    title,
    status: TASK_STATUS.has(t.status) ? t.status : "pending",
    active_form: str(t.active_form),
  };
}

/** Strict sub-agent record; returns null when malformed (§3.2). */
export function normalizeSubagent(s) {
  if (!isPlainObject(s)) return null;
  const id = typeof s.id === "number" && Number.isFinite(s.id) ? String(s.id) : str(s.id);
  if (!id) return null;
  if (s.status !== undefined && !SUB_STATUS.has(s.status)) return null;
  return {
    id,
    name: str(s.name) ?? id,
    status: SUB_STATUS.has(s.status) ? s.status : "running",
    started_at: str(s.started_at),
    ended_at: str(s.ended_at),
    // Where the sub-agent was nested from, when the agent reported it (§3.6).
    parent_terminal: str(s.parent_terminal),
    parent_session: str(s.parent_session),
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

/** The per-turn block used for missed-turn detection (fixes §3.7). */
function normalizeTurn(t) {
  if (!isPlainObject(t) || typeof t.tasks !== "string") return null;
  return { tasks: t.tasks, tools: t.tools === true };
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
    turn: normalizeTurn(s.turn),
  };
}

/** Normalizes one recorded pull request ({url, number, at}); null when unusable. */
export function normalizePrRecord(p) {
  if (!p || typeof p !== "object") return null;
  const url = str(p.url);
  const number = Number.isInteger(p.number) ? p.number : null;
  if (!url || !url.startsWith("https://") || number === null) return null;
  return { url, number, at: str(p.at) };
}

/** An empty store document for a terminal. */
export function emptyStore(terminal, agent) {
  return {
    version: STORE_VERSION,
    terminal,
    agent: normalizeAgent(agent),
    terminal_started_at: null,
    seq: 0,
    missed_turns: 0,
    updated_at: null,
    session: null,
    tasks: [],
    subagents: [],
    prs: [],
  };
}

/**
 * Parses a store file's text, strictly (fixes §3.2): malformed content is
 * rejected whole, never half-rendered. Reads schema-1 files as well as
 * schema-2. Returns { ok: true, store } |
 * { ok: false, reason: "missing" | "invalid" | "newer" }.
 */
export function parseStore(text) {
  if (text == null || text === "") return { ok: false, reason: "missing" };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: "invalid" };
  const version = typeof raw.version === "number" ? raw.version : typeof raw.schema === "number" ? raw.schema : null;
  if (version == null) return { ok: false, reason: "invalid" };
  if (version > STORE_VERSION) return { ok: false, reason: "newer" };
  // Strict: tasks/subagents must be arrays of well-formed records.
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) return { ok: false, reason: "invalid" };
  if (raw.subagents !== undefined && !Array.isArray(raw.subagents)) return { ok: false, reason: "invalid" };
  const tasks = (raw.tasks ?? []).map(normalizeTask);
  if (tasks.includes(null)) return { ok: false, reason: "invalid" };
  const subagents = (raw.subagents ?? []).map(normalizeSubagent);
  if (subagents.includes(null)) return { ok: false, reason: "invalid" };
  if (raw.session !== undefined && raw.session !== null && !isPlainObject(raw.session)) return { ok: false, reason: "invalid" };
  if (raw.updated_at !== undefined && raw.updated_at !== null && typeof raw.updated_at !== "string") return { ok: false, reason: "invalid" };
  if (raw.terminal_started_at !== undefined && raw.terminal_started_at !== null && typeof raw.terminal_started_at !== "string") return { ok: false, reason: "invalid" };
  if (raw.seq !== undefined && raw.seq !== null && nonNegInt(raw.seq) == null) return { ok: false, reason: "invalid" };
  if (raw.missed_turns !== undefined && raw.missed_turns !== null && nonNegInt(raw.missed_turns) == null) return { ok: false, reason: "invalid" };
  // Recorded PRs (I4) are optional extras: unusable entries are dropped, not fatal.
  const prs = (Array.isArray(raw.prs) ? raw.prs : []).map(normalizePrRecord).filter(Boolean);
  return {
    ok: true,
    store: {
      version,
      terminal: str(raw.terminal),
      agent: normalizeAgent(raw.agent),
      terminal_started_at: str(raw.terminal_started_at),
      seq: nonNegInt(raw.seq) ?? 0,
      missed_turns: nonNegInt(raw.missed_turns) ?? 0,
      updated_at: str(raw.updated_at),
      session: normalizeSession(raw.session),
      tasks,
      subagents,
      prs,
    },
  };
}

/** Display order (R-SD-1): in_progress first, so that row is always visible. */
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

/** Cap for a store's task list: keeps the files bounded on long sessions. */
export const MAX_TASKS = 50;

/**
 * Caps a task list at `max` entries (default MAX_TASKS). Non-arrays are
 * returned unchanged; a list at or under the cap is returned as the SAME
 * array. Over the cap, the oldest (lowest index) finished entries
 * ("completed" then "cancelled") are dropped one at a time, then the oldest
 * "pending" ones; "in_progress" is never dropped. The kept entries keep
 * their relative order. Pure: the input array is never mutated.
 */
export function capTasks(tasks, max = MAX_TASKS) {
  if (!Array.isArray(tasks)) return tasks;
  if (tasks.length <= max) return tasks;
  const keep = [...tasks];
  for (const status of ["completed", "cancelled", "pending"]) {
    for (let i = 0; i < keep.length && keep.length > max; ) {
      if (keep[i].status === status) keep.splice(i, 1);
      else i += 1;
    }
    if (keep.length <= max) break;
  }
  return keep;
}

/** Store file name for a terminal address ("t6" -> "t6.json"); strips anything unsafe. */
export function storeFileName(address) {
  const safe = String(address ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe ? `${safe}.json` : null;
}

/** Cap for a terminal pointer's session index (most recent first). */
export const SESSION_INDEX_MAX = 20;

const GENERIC_TITLES = new Set(["new session", "opencode", "oc", "claude code"]);

/**
 * Comparison key for a session title, or null when the title says nothing
 * useful: an empty or generic agent title ("New session", the app's name).
 * Terminal titles are noisy — OpenCode prefixes them with "OC | ", agents add
 * a spinner glyph, and case/spacing drift — so they are normalized first.
 */
export function normalizeTitle(title) {
  if (typeof title !== "string") return null;
  const key = title
    .trim()
    .replace(/^oc\s*\|\s*/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return key && !GENERIC_TITLES.has(key) ? key : null;
}

/** One sanitized { id, title, at } session-index entry, or null when malformed. */
function sessionIndexEntry(v) {
  if (!isPlainObject(v) || typeof v.id !== "string" || !v.id) return null;
  return {
    id: v.id,
    title: typeof v.title === "string" ? v.title : null,
    at: typeof v.at === "string" ? v.at : null,
  };
}

/**
 * Puts `entry` first in a terminal pointer's session index, dropping the older
 * entry for the same id and capping the list at `max`. A null entry title
 * keeps the title the list already had for that id. Returns a new, sanitized
 * array (malformed items are dropped); the input is never mutated.
 */
export function mergeSessionIndex(list, entry, max = SESSION_INDEX_MAX) {
  const items = (Array.isArray(list) ? list : []).map(sessionIndexEntry).filter(Boolean);
  const limit = Number.isInteger(max) && max >= 0 ? max : SESSION_INDEX_MAX;
  const next = sessionIndexEntry(entry);
  if (!next) return items.slice(0, limit);
  const old = items.find((v) => v.id === next.id);
  if (next.title == null && old?.title != null) next.title = old.title;
  return [next, ...items.filter((v) => v.id !== next.id)].slice(0, limit);
}

/** The sanitized session index stored in a terminal pointer, or [] on error. */
export function pointerSessions(text) {
  try {
    const raw = JSON.parse(text);
    return (Array.isArray(raw?.sessions) ? raw.sessions : []).map(sessionIndexEntry).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The session whose store the panel should read for `liveTitle`. Normally the
 * pointed session; after a TUI session switch the pointer still names the old
 * one, so the terminal's title picks the first indexed session with the same
 * normalized title. Falls back to the pointed session when nothing matches.
 */
export function resolveSession(pointerText, liveTitle) {
  const pointed = pointerSession(pointerText);
  const key = normalizeTitle(liveTitle);
  if (key == null) return pointed;
  const index = pointerSessions(pointerText);
  const current = index.find((v) => v.id === pointed);
  if (current && normalizeTitle(current.title) === key) return pointed;
  const match = index.find((v) => normalizeTitle(v.title) === key);
  return match ? match.id : pointed;
}

/**
 * Terminal pointer file (fixes §3.3): a small document that says which
 * session's store this terminal is showing. Returns the session id when the
 * text is a pointer, null when the file itself is the store (no session yet).
 */
export function pointerSession(text) {
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && typeof raw.session === "string" && raw.session ? raw.session : null;
  } catch {
    return null;
  }
}

/**
 * Relative store paths to read next: without terminal text, the schema-2
 * terminal file and its legacy fallback; with a pointer, its session file
 * (chosen by `liveTitle` after a TUI session switch). An empty result means
 * the terminal text already is the store.
 */
export function storeCandidates(address, terminalText = null, liveTitle = null) {
  const name = storeFileName(address);
  if (!name) return [];
  if (terminalText != null) {
    const sid = resolveSession(terminalText, liveTitle);
    const session = sid ? storeFileName(sid) : null;
    return session ? [`sessions/${session}`] : [];
  }
  return [`terminals/${name}`, name];
}

/**
 * Reader-side overlay for two terminals sharing one session: when the
 * terminal text is a pointer, the pointer's terminal + start time are this
 * terminal's live identity — the session store's own values may belong to
 * the other terminal and would hide this one's list. Returns `parsed`
 * unchanged when it is not a valid store or the text is not a pointer with
 * a string terminal_started_at.
 */
export function withPointerIdentity(parsed, terminalText) {
  if (!parsed?.ok || !parsed.store || !pointerSession(terminalText)) return parsed;
  let pointer;
  try {
    pointer = JSON.parse(terminalText);
  } catch {
    return parsed; // pointerSession already accepted it; stay unchanged
  }
  if (typeof pointer?.terminal_started_at !== "string") return parsed;
  return {
    ...parsed,
    store: {
      ...parsed.store,
      terminal: typeof pointer.terminal === "string" ? pointer.terminal : parsed.store.terminal,
      terminal_started_at: pointer.terminal_started_at,
    },
  };
}

/**
 * Whether a parsed store belongs to the agent run now live in the terminal
 * (fixes §3.3/F4): the terminal must be live, its start time must match the
 * store's terminal_started_at, and the agent app must match. A session the
 * agent exited ("ended", set on SessionEnd / session.deleted) is never
 * visible: no active session means no list. `live` comes from
 * `hc get --json` (plus the panel's app); null skips that check.
 */
export function listVisible(parsed, live) {
  if (!parsed || !parsed.ok || !parsed.store) return false;
  if (parsed.store.session?.state === "ended") return false;
  const store = parsed.store;
  if (live) {
    if (live.state && live.state !== "live") return false; // terminal gone/finished
    if (live.app && agentApp(store.agent) && !sameApp(agentApp(store.agent), live.app)) return false;
    const started = typeof live.startedAt === "number"
      ? live.startedAt
      : typeof live.startedAt === "string" ? Date.parse(live.startedAt) : null;
    if (started != null && Number.isFinite(started)) {
      const mine = store.terminal_started_at ? Date.parse(store.terminal_started_at) : null;
      if (mine != null && Number.isFinite(mine)) {
        // Schema 2: the list is only ours if the terminal has not restarted since.
        if (mine !== started) return false;
      } else if (store.updated_at) {
        // Schema-1 fallback: hidden when written before this terminal started.
        const at = Date.parse(store.updated_at);
        if (!(Number.isFinite(at) && at >= started)) return false;
      }
    }
  }
  return true;
}

/**
 * Reader-side lifecycle rules (fixes §3.5). `status` is the agent's live
 * status word (idle | working | blocked | done) from the panel or the store's
 * own activity. Returns { flag, hide, fresh }:
 * - flag: agent stopped while items are still in_progress -> flag them;
 * - hide: everything done and the agent idle for over 10 min -> fade out;
 * - fresh: the list was updated within the last 2 min, else it greys out.
 */
export function listLifecycle(store, status = null, now = Date.now()) {
  const tasks = Array.isArray(store?.tasks) ? store.tasks : [];
  const idle = status === "idle" || status === "done";
  const updated = store?.updated_at ? Date.parse(store.updated_at) : null;
  const age = updated != null && Number.isFinite(updated) ? now - updated : null;
  return {
    flag: idle && tasks.some((t) => t.status === "in_progress"),
    hide: idle && tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "cancelled")
      && age != null && age > STALE.HIDE_DONE_MS,
    fresh: age != null && age <= STALE.FRESH_MS,
  };
}

/**
 * Stable fingerprint of the task list (ids + statuses), for missed-turn
 * detection (fixes §3.7): the list "changed" only when an id or status did.
 */
export function tasksFingerprint(tasks) {
  return JSON.stringify((Array.isArray(tasks) ? tasks : []).map((t) => [t.id, t.status, t.title]));
}
