// Store plumbing for the task adapters (requirements.md §7.2): one JSON file
// per agent terminal under ~/.herdr/ranch/tasks/, written atomically.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { emptyStore, parseStore, storeFileName } from "../lib/tasks.js";

// Mirrors lib/settings.js TASKS_DIR; lib/settings.js is not copied to the
// installed layout, so the adapters keep their own copy of the path.
const TASKS_DIR = ".herdr/ranch/tasks";

/** Home directory, overridable via RANCH_HOME for tests. */
export function homeDir() {
  return process.env.RANCH_HOME || homedir();
}

/** Store file path for a terminal, or null when the address is unusable. */
export function storePath(home, terminal) {
  const name = storeFileName(terminal);
  return name ? join(home, TASKS_DIR, name) : null;
}

/** Reads the store at `path`, falling back to an empty store. */
export function readStore(path, agent, terminal) {
  try {
    const parsed = parseStore(readFileSync(path, "utf8"));
    if (parsed.ok) return parsed.store;
  } catch {
    // missing or unreadable: start fresh
  }
  return emptyStore(terminal, agent);
}

/** Atomic write: temp file next to the target, then rename. */
export function writeStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, path);
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
 * RANCH_HOME or os.homedir()). `fn` maps the store to its next state and
 * updated_at is stamped here. Returns the store, or null when HC_TERMINAL_ID
 * is unset (agent not running inside Herdr).
 */
export function updateStore(agent, fn) {
  const terminal = process.env.HC_TERMINAL_ID;
  if (!terminal) return null;
  const path = storePath(homeDir(), terminal);
  if (!path) return null;
  const release = takeLock(path);
  try {
    const next = fn(readStore(path, agent, terminal));
    if (!next || typeof next !== "object") return null;
    next.updated_at = new Date().toISOString();
    writeStore(path, next);
    return next;
  } finally {
    release?.();
  }
}
