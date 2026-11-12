// ranch-tasks plugin
// Ranch task reporting for OpenCode (requirements.md §7.4, fixes §3.3). This
// file is copied alone into ~/.config/opencode/plugins/, so it must not import
// ../lib: it inlines a minimal store read/normalise/atomic-write with the same
// session-keyed layout the other adapters use (sessions/<session>.json plus a
// terminals/<terminal>.json pointer; legacy flat stores are still read). It
// runs inside the OpenCode process and only ever writes the store files —
// nothing else.
// One file, both hosts: OpenCode 2.x schema-validates the default export as
// an object ({ id, setup, server }) and calls setup(ctx); v1 calls server(),
// which returns the classic hooks object.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STORE_VERSION = 2;
const TASKS_DIR = ".herdr/ranch/tasks";
const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
// The marked block the installer writes to ~/.config/opencode/AGENTS.md; when
// it is there, the plugin does not also inject its rule (fixes F13: one
// instruction source).
const BLOCK_MARK = "<!-- ranch-tasks:begin -->";

function homeDir() {
  return process.env.RANCH_HOME || homedir();
}

function storeFileName(address) {
  const safe = String(address ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe ? `${safe}.json` : null;
}

function sessionPath(session) {
  const name = storeFileName(session);
  return name ? join(homeDir(), TASKS_DIR, "sessions", name) : null;
}

function terminalPath() {
  const name = storeFileName(process.env.HC_TERMINAL_ID);
  return name ? join(homeDir(), TASKS_DIR, "terminals", name) : null;
}

function legacyPath() {
  const name = storeFileName(process.env.HC_TERMINAL_ID);
  return name ? join(homeDir(), TASKS_DIR, name) : null;
}

/** When the terminal started, from `hc get --json` (created_ms); best effort. */
function terminalStartedAt(terminal) {
  try {
    const out = execFileSync("hc", ["get", "--json", String(terminal)], {
      timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const ms = JSON.parse(out)?.created_ms;
    if (typeof ms === "number" && ms > 0) return new Date(ms).toISOString();
  } catch {
    // No hc on PATH or unknown terminal: keep what the store already had.
  }
  return null;
}

function emptyStore(terminal) {
  return {
    version: STORE_VERSION,
    terminal,
    agent: { app: "opencode", session: null, pid: process.pid },
    terminal_started_at: null,
    seq: 0,
    missed_turns: 0,
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
  // The store belongs to another agent (terminal reuse, I10): never continue
  // its session, tasks or sub-agents.
  const owner = typeof raw.agent === "string" ? raw.agent : raw.agent?.app;
  if (typeof owner === "string" && owner && owner !== "opencode") return emptyStore(terminal);
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
      ...(typeof s.parent_terminal === "string" && s.parent_terminal ? { parent_terminal: s.parent_terminal } : {}),
      ...(typeof s.parent_session === "string" && s.parent_session ? { parent_session: s.parent_session } : {}),
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
        ...(raw.session.turn && typeof raw.session.turn.tasks === "string"
          ? {
              turn: {
                tasks: raw.session.turn.tasks,
                tools: raw.session.turn.tools === true,
                ...(raw.session.turn.aborted === true ? { aborted: true } : {}),
              },
            }
          : {}),
      }
    : null;
  const agent = raw.agent && typeof raw.agent === "object" && typeof raw.agent.app === "string"
    ? { app: raw.agent.app, session: typeof raw.agent.session === "string" ? raw.agent.session : null, pid: raw.agent.pid }
    : null;
  return {
    version: STORE_VERSION,
    terminal: typeof raw.terminal === "string" ? raw.terminal : terminal,
    agent: agent ?? { app: "opencode", session: null, pid: process.pid },
    terminal_started_at: typeof raw.terminal_started_at === "string" ? raw.terminal_started_at : null,
    seq: typeof raw.seq === "number" && Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    missed_turns: typeof raw.missed_turns === "number" && Number.isInteger(raw.missed_turns) && raw.missed_turns >= 0 ? raw.missed_turns : 0,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
    session,
    tasks,
    subagents,
  };
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function loadStore(path) {
  const raw = readJsonFile(path);
  return raw ? normalizeStore(raw, process.env.HC_TERMINAL_ID) : emptyStore(process.env.HC_TERMINAL_ID);
}

function saveStore(path, store) {
  store.updated_at = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  // The rename is retried a few times: AV/indexers (notably on Windows) hold
  // the target open for a moment (I8).
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || i >= 10) {
        try { unlinkSync(tmp); } catch {}
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

/** Per-store lock: bounded wait, stale break, release fn or null. */
function takeLock(path) {
  const lock = `${path}.lock`;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return null;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lock, "wx");
      return () => {
        try { closeSync(fd); } catch {}
        try { unlinkSync(lock); } catch {}
      };
    } catch (err) {
      if (err?.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          unlinkSync(lock);
          continue;
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return null;
}

/**
 * Runs one read-modify-write under the store lock. When the lock cannot be
 * taken it is retried once; failing that the write is skipped, so the store
 * is never written without the lock (I9). Write errors propagate to the
 * caller, which catches everything.
 */
function withLock(path, fn) {
  if (!path) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = takeLock(path);
    if (!release) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      fn();
      return;
    } finally {
      release();
    }
  }
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
/** Task-list fingerprint for missed-turn detection (§3.7). */
function fingerprint(tasks) {
  return JSON.stringify((Array.isArray(tasks) ? tasks : []).map((t) => [t.id, t.status, t.title]));
}

export function reduceOpencode(store, event) {
  const next = reduceOpencodeCore(store, event);
  const state = opencodeActivity(next ?? store, event);
  let base = next ?? store;
  // Missed turns (§3.7): the session did work this turn but the task list did
  // not change since the prompt. Judged once at the turn's end; interrupted
  // or failed turns are consumed without counting, and the turn is always
  // consumed so repeated idle events never recount.
  const props = event?.properties && typeof event.properties === "object" ? event.properties : {};
  const turn = base.session?.turn;
  if (state === "done" && turn) {
    const missed = turn.tools && !turn.aborted
      && props.outcome !== "interrupted" && props.outcome !== "failed"
      && fingerprint(base.tasks) === turn.tasks;
    base = {
      ...base,
      missed_turns: missed
        ? (Number.isInteger(base.missed_turns) ? base.missed_turns : 0) + 1
        : base.missed_turns,
      session: { ...base.session, turn: undefined },
    };
  }
  if (!state) return base;
  // Only write when the state changes: events arrive many times a second.
  if (base.session?.activity?.state === state) return base;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

/** Stable short id for tasks the host leaves without one (I13). */
function hashId(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

/** Tools that mean the agent did real work this turn (§3.7). */
const WORK_TOOLS = new Set(["bash", "edit", "write", "patch", "multiedit", "apply_patch"]);

function reduceOpencodeCore(store, event) {
  if (!event || typeof event !== "object") return store;
  const type = event.type;
  const props = event.properties && typeof event.properties === "object" ? event.properties : {};
  const now = new Date().toISOString();
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };

  if (type === "todo.updated") {
    if (props.sessionID && store.session?.id && props.sessionID !== store.session.id) return store;
    const before = fingerprint(store.tasks);
    // Replace tasks; cancelled ones are kept and struck through by the mod.
    // Tasks without an id get a stable position+title-hash id (I13).
    const todos = Array.isArray(props.todos) ? props.todos : [];
    next.tasks = todos.flatMap((todo, index) => {
      if (!todo) return [];
      const title = typeof todo.content === "string" ? todo.content.trim() : "";
      if (!title) return [];
      return [{
        id: todo.id === undefined || todo.id === null || todo.id === ""
          ? `${index + 1}-${hashId(title)}`
          : String(todo.id),
        title,
        status: TASK_STATUS.has(todo.status) ? todo.status : "pending",
        active_form: null,
      }];
    });
    // Any task-list change clears the missed-turn nudge (§3.7).
    if (fingerprint(next.tasks) !== before) next.missed_turns = 0;
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
        next.missed_turns = 0;
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
    if (session.id && props.sessionID && props.sessionID !== session.id) return store;
    // New turn (§3.7): remember the list as it stood at the prompt.
    session.turn = { tasks: fingerprint(next.tasks), tools: false };
    if (!session.first_prompt) session.first_prompt = text.slice(0, 500);
    next.session = session;
    return next;
  }

  if (type === "tool.used") {
    // The turn did real work (§3.7): only write/edit/shell tools count.
    if (props.sessionID && store.session?.id && props.sessionID !== store.session.id) return store;
    const turn = store.session?.turn;
    const tool = typeof props.tool === "string" ? props.tool.toLowerCase() : null;
    // Already marked: return the same store so recordEvent skips the write.
    if (turn && !turn.tools && tool && WORK_TOOLS.has(tool)) {
      return { ...next, session: { ...next.session, turn: { ...turn, tools: true } } };
    }
    return store;
  }

  if (type === "session.error") {
    // v1 interrupt: the open turn failed mid-flight; it is never judged as
    // missed (the wrapper drops it at idle).
    if (props.sessionID && store.session?.id && props.sessionID !== store.session.id) return store;
    const turn = store.session?.turn;
    if (turn) {
      return { ...next, session: { ...next.session, turn: { ...turn, aborted: true } } };
    }
    return store;
  }

  return store;
}

// Mandatory task reporting (also in ~/.config/opencode/AGENTS.md): added to
// the system prompt of every request so the model sees it each turn.
const TASK_RULE = "Task reporting is mandatory (Ranch): for EVERY user message, before anything else record the work as tasks with the todowrite tool (at least one task per message, one per step when there are several), mark each in_progress when you start it and completed the moment it is done, and complete all of them before you end your reply.";

/** True when the installer's marked rule block is already in AGENTS.md (F13). */
function agentsBlockInstalled() {
  try {
    return readFileSync(join(homedir(), ".config", "opencode", "AGENTS.md"), "utf8").includes(BLOCK_MARK);
  } catch {
    return false;
  }
}

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
    withLock(terminalPath(), () => {
      const terminal = process.env.HC_TERMINAL_ID;
      const tPath = terminalPath();
      if (!terminal || !tPath) return;
      const raw = readJsonFile(tPath);
      let sessionFile = null;
      let loaded;
      if (raw && typeof raw.session === "string" && raw.session) {
        // Terminal pointer → the store lives in sessions/<session>.json.
        sessionFile = sessionPath(raw.session) ?? tPath;
        loaded = loadStore(sessionFile);
      } else if (raw) {
        // No session id yet: the terminal file itself is the store.
        loaded = loadStore(tPath);
      } else {
        // First event in this terminal: adopt a legacy flat store if one exists
        // (e.g. the session was resumed in a new terminal).
        const legacy = legacyPath();
        const legacyRaw = legacy ? readJsonFile(legacy) : null;
        const legacyApp = typeof legacyRaw?.agent === "string" ? legacyRaw.agent : legacyRaw?.agent?.app;
        const candidate = legacyRaw ? normalizeStore(legacyRaw, terminal) : null;
        const legacySession = candidate?.session?.id ?? candidate?.agent?.session ?? null;
        const incomingSession = pickSessionID(event);
        const sameSession = !legacySession || !incomingSession || legacySession === incomingSession;
        loaded = candidate && legacyApp === "opencode" && sameSession ? candidate : emptyStore(terminal);
        loaded.terminal = terminal;
      }
      const adopted = adoptSession(loaded, event);
      const next = reduceOpencode(adopted, event);
      if (next === adopted && adopted === loaded) return;

      // Identity (§3.3): schema 2, monotonic seq, this agent run.
      const updated = { ...next };
      updated.version = STORE_VERSION;
      updated.terminal = terminal;
      const sid = typeof updated.session?.id === "string" && updated.session.id ? updated.session.id : null;
      updated.agent = { app: "opencode", session: sid, pid: process.pid };
      updated.seq = Math.max(Number.isInteger(loaded.seq) ? loaded.seq : 0, Number.isInteger(updated.seq) ? updated.seq : 0) + 1;
      updated.terminal_started_at = loaded.terminal_started_at ?? terminalStartedAt(terminal) ?? new Date().toISOString();
      updated.updated_at = new Date().toISOString();
      if (sid) {
        saveStore(sessionPath(sid) ?? sessionFile, updated); // the incoming session's file, so the pointer matches after a session change
        // Terminal pointer so the mod can find the session store again.
        saveStore(tPath, {
          version: STORE_VERSION,
          terminal,
          terminal_started_at: updated.terminal_started_at,
          agent: updated.agent,
          session: sid,
          updated_at: updated.updated_at,
        });
      } else {
        saveStore(tPath, updated);
      }
    });
  } catch {
    // Never break the host: task reporting fails silently.
  }
}

/**
 * Maps a v2 bus event onto the v1 event shapes reduceOpencode already
 * understands. Returns null when the event says nothing worth recording.
 */
export function normalizeV2(event) {
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
      return { type: "session.idle", properties: { sessionID: sid } };
    case "session.execution.failed":
      return { type: "session.idle", properties: { sessionID: sid, outcome: "failed" } };
    case "session.execution.interrupted":
      return { type: "session.idle", properties: { sessionID: sid, outcome: "interrupted" } };
    case "permission.asked":
    case "permission.replied":
    case "session.idle":
      return { type, properties: { sessionID: sid } };
    case "session.status":
      return { type, properties: { sessionID: sid, status: raw.status } };
    case "todo.updated": {
      // Bus todo updates (v2): the tool hook already records the tool-based
      // path; this catches session-scoped todo events.
      const todos = Array.isArray(raw.todos) ? raw.todos
        : Array.isArray(raw.info?.todos) ? raw.info.todos : null;
      if (!todos) return null;
      return { type: "todo.updated", properties: { sessionID: sid, todos } };
    }
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
      // One instruction source (fixes F13): the installer's AGENTS.md block
      // already carries the rule, so skip the plugin copy when it exists.
      if (agentsBlockInstalled()) return;
      if (Array.isArray(output?.system) && !output.system.includes(TASK_RULE)) output.system.push(TASK_RULE);
    } catch {
      // Never break the host.
    }
  },

  event: async ({ event }) => {
    // v1 hosts deliver v1 events; a bus-shaped (v2) event still records.
    recordEvent(normalizeV2(event) ?? event);
  },

  "chat.message": async (input, output) => {
    try {
      const parts = Array.isArray(output?.parts) ? output.parts : [];
      const text = parts
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
      if (!text) return;
      recordEvent({ type: "chat.message", properties: { sessionID: input?.sessionID, text } });
    } catch {
      // Never break the host: task reporting fails silently.
    }
  },

  // Missed-turn detection (§3.7): any tool other than todowrite marks the
  // open turn as having done real work.
  "tool.execute.after": async (input) => {
    try {
      if (input?.tool === "todowrite") return;
      // A tool event without a usable name says nothing.
      if (typeof input?.tool !== "string" || !input.tool) return;
      recordEvent({
        type: "tool.used",
        properties: {
          sessionID: typeof input?.sessionID === "string" ? input.sessionID : null,
          tool: input.tool,
        },
      });
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
      // reducer once the main session is known. Every other tool marks the
      // open turn as having done real work (missed-turn detection, §3.7).
      quiet(ctx?.tool?.hook?.("execute.after", safeCall((event) => {
        if (event?.tool === "todowrite") {
          const todos = event?.input && typeof event.input === "object" ? event.input.todos : null;
          if (!Array.isArray(todos)) return;
          recordEvent({
            type: "todo.updated",
            properties: {
              sessionID: typeof event.sessionID === "string" ? event.sessionID : null,
              todos,
            },
          });
          return;
        }
        // A tool event without a usable name says nothing; recording it
        // would only touch the store directory.
        if (typeof event?.tool !== "string" || !event.tool) return;
        recordEvent({
          type: "tool.used",
          properties: {
            sessionID: typeof event?.sessionID === "string" ? event.sessionID : null,
            tool: event.tool,
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

      // System prompt: the mandatory task rule, exactly once — skipped when
      // the installer's AGENTS.md block already carries it (fixes F13). v2
      // system parts are objects ({ type: "text", text }), never bare strings.
      quiet(ctx?.session?.hook?.("context", safeCall((event) => {
        if (!Array.isArray(event?.system)) return;
        if (agentsBlockInstalled()) return;
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
