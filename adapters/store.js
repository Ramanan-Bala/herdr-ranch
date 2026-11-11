// Store plumbing for the task adapters (requirements.md §7.2, fixes §3.3).
// Session-keyed layout under ~/.herdr/ranch/tasks/:
//   sessions/<session>.json   full store document (schema 2)
//   terminals/<terminal>.json pointer to the session, or the store itself
//                             until the agent reports a session id
// Legacy flat stores (tasks/<terminal>.json, schema 1) are still read.
// Writes are atomic and refuse to overwrite a newer `seq`.
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { STORE_VERSION, agentApp, emptyStore, parseStore, storeFileName } from "../lib/tasks.js";

// Mirrors lib/settings.js TASKS_DIR; lib/settings.js is not copied to the
// installed layout, so the adapters keep their own copy of the path.
const TASKS_DIR = ".herdr/ranch/tasks";
const LOG_MAX = 1024 * 1024;

/** Home directory, overridable via RANCH_HOME for tests. */
export function homeDir() {
  return process.env.RANCH_HOME || homedir();
}

/**
 * One line per error to ~/.herdr/ranch/logs/adapter.log (fixes §3.8), rotated
 * to adapter.log.1 when it passes 1 MB — never to stdout, which the agent
 * would read as context.
 */
export function hookError(err) {
  try {
    const dir = join(homeDir(), ".herdr", "ranch", "logs");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "adapter.log");
    try {
      if (statSync(log).size > LOG_MAX) renameSync(log, `${log}.1`);
    } catch {
      // no log yet (or unrotatable): just append
    }
    appendFileSync(log, `${new Date().toISOString()} ${err?.stack ?? String(err)}\n`);
  } catch {
    // out of options; stay silent
  }
}

/** Legacy flat store path for a terminal (schema-1 layout), or null. */
export function storePath(home, terminal) {
  const name = storeFileName(terminal);
  return name ? join(home, TASKS_DIR, name) : null;
}

/** Session-keyed store path (fixes §3.3), or null when the id is unusable. */
export function sessionPath(home, session) {
  const name = storeFileName(session);
  return name ? join(home, TASKS_DIR, "sessions", name) : null;
}

/** Terminal pointer path (fixes §3.3), or null when the address is unusable. */
export function terminalPath(home, terminal) {
  const name = storeFileName(terminal);
  return name ? join(home, TASKS_DIR, "terminals", name) : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A malformed store is renamed beside itself with a .error suffix (fixes
 * §3.2), so the broken content stays inspectable and is never re-parsed.
 */
export function quarantine(path) {
  try {
    renameSync(path, `${path}.error`);
  } catch {
    // Keep the original file; parseStore already rejected it.
  }
}

/** Reads the store at `path`, falling back to an empty store. */
export function readStore(path, agent, terminal) {
  let text = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return emptyStore(terminal, agent); // missing or unreadable: start fresh
  }
  const parsed = parseStore(text);
  if (parsed.ok) {
    // Terminal reuse by another agent (I10): never continue someone else's
    // session, tasks or PR records.
    const owner = agentApp(parsed.store.agent);
    if (owner && agent && owner !== agent) return emptyStore(terminal, agent);
    return parsed.store;
  }
  if (parsed.reason === "invalid") {
    hookError(`quarantined invalid task store: ${path}`);
    quarantine(path);
  }
  return emptyStore(terminal, agent);
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Atomic write: temp file next to the target, then rename. The rename is
 * retried a few times because AV/indexers (notably on Windows) hold the
 * target open for a moment (I8). */
export function writeStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
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

/**
 * When the terminal started, from `hc get --json` (created_ms). Null when hc
 * is unavailable — the writer then keeps whatever the store already had.
 */
export function terminalStartedAt(terminal) {
  try {
    const out = execFileSync("hc", ["get", "--json", String(terminal)], {
      timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const ms = JSON.parse(out)?.created_ms;
    if (typeof ms === "number" && ms > 0) return new Date(ms).toISOString();
  } catch {
    // No hc on PATH or unknown terminal: best effort only.
  }
  return null;
}

/** One line per agent in ~/.herdr/ranch/health.json (fixes §3.8). */
export function recordHealth(agent) {
  try {
    const path = join(homeDir(), ".herdr/ranch/health.json");
    let health = readJson(path);
    if (!health || typeof health !== "object" || typeof health.agents !== "object" || !health.agents) {
      health = { version: 1, agents: {} };
    }
    health.version = 1;
    health.agents[agent] = { last_event_at: new Date().toISOString() };
    writeStore(path, health);
  } catch {
    // Health is best effort; never fail a hook over it.
  }
}

/** Takes the per-store lock; waiting is bounded so hooks never hang. */
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
 * Read-modify-write for the current terminal (env HC_TERMINAL_ID, home via
 * RANCH_HOME or os.homedir()). Reads the session the terminal points at (or
 * the legacy flat store), lets `fn` map it to its next state, then writes the
 * session-keyed store and re-points the terminal (fixes §3.3: the first event
 * of a resumed session re-points it). updated_at and a monotonically
 * increasing seq are stamped here; a newer seq on disk is never overwritten.
 * Returns the store, or null when HC_TERMINAL_ID is unset (agent not running
 * inside Herdr). When the lock cannot be taken, the whole read-modify-write
 * is retried once; failing that it throws: the caller logs and the store is
 * left untouched rather than written without the lock (I9).
 */
export function updateStore(agent, fn, lookupStartedAt = terminalStartedAt) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return null;
  const home = homeDir();
  const tPath = terminalPath(home, terminal);
  if (!tPath) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const release = takeLock(tPath);
    if (!release) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      continue;
    }
    try {
      const raw = readJson(tPath);
      let sessionFile = null;
      let current;
      let legacySession = null;
      if (raw && typeof raw.session === "string" && raw.session) {
        sessionFile = sessionPath(home, raw.session);
        current = readStore(sessionFile ?? tPath, agent, terminal);
      } else if (raw) {
        current = readStore(tPath, agent, terminal); // no session yet: the terminal file is the store
      } else {
        // First event in this terminal: adopt the legacy flat store if present
        // (a session resumed in a new terminal keeps its tasks), else start empty.
        const legacy = storePath(home, terminal);
        const candidate = legacy ? readStore(legacy, agent, terminal) : null;
        current = candidate && agentApp(candidate.agent) === agent ? candidate : emptyStore(terminal, agent);
        if (current === candidate) legacySession = candidate.session?.id ?? candidate.agent?.session ?? null;
        current.terminal = terminal;
      }
      if (!current || typeof current !== "object") current = emptyStore(terminal, agent);
      let next = fn(current);
      const incomingSession = next?.session && typeof next.session === "object" ? next.session.id : null;
      if (legacySession && incomingSession && legacySession !== incomingSession) {
        current = emptyStore(terminal, agent);
        next = fn(current);
      }
      if (!next || typeof next !== "object") return current;

      // Identity (§3.3): schema 2, this terminal, this agent run, monotonic seq.
      next.version = STORE_VERSION;
      next.terminal = terminal;
      const sid = next.session && typeof next.session === "object" && typeof next.session.id === "string"
        ? next.session.id
        : null;
      next.agent = { app: agent, session: sid, pid: process.pid };
      const diskSeq = Number.isInteger(current.seq) ? current.seq : 0;
      const nextSeq = Number.isInteger(next.seq) ? next.seq : 0;
      next.seq = Math.max(nextSeq, diskSeq) + 1; // refuses to overwrite a newer seq
      next.terminal_started_at = current.terminal_started_at
        ?? lookupStartedAt(terminal)
        ?? (typeof next.terminal_started_at === "string" ? next.terminal_started_at : null)
        ?? (raw ? current.terminal_started_at ?? null : new Date().toISOString());
      next.updated_at = new Date().toISOString();

      if (sid) {
        // Always the incoming session's file: after /clear the id changes and
        // the pointer below must lead to where this store was written.
        writeStore(sessionPath(home, sid) ?? sessionFile, next);
        writeStore(tPath, {
          version: STORE_VERSION,
          terminal,
          terminal_started_at: next.terminal_started_at,
          agent: next.agent,
          session: sid,
          updated_at: next.updated_at,
        });
      } else {
        writeStore(tPath, next); // store lives in the terminal file until the session is known
      }
      recordHealth(agent);
      return next;
    } finally {
      release();
    }
  }
  throw new Error(`store lock busy: ${tPath}`);
}
