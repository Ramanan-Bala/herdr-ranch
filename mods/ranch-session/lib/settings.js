// Ranch settings: one object kept in Herdr shared state under SETTINGS_KEY.
// Pure module (no imports) so it can be copied into every mod and tested in Node.

/** Shared-state key holding the user's Ranch settings (partial; merged over DEFAULTS). */
export const SETTINGS_KEY = "ranch.settings";

/** Shared-state key for which tab names Ranch set: { [tabId]: { name, source, at } }. */
export const AUTONAMES_KEY = "ranch.autoNames";

/** Shared-state key for remembered session names: { [sessionId]: name } (insertion = recency). */
export const SESSIONS_KEY = "ranch.sessions";

/** Shared-state key for the sidebar footer's status filter: null | "working" | "done" | "idle". */
export const FILTER_KEY = "ranch.filter";

/** Where adapters write one JSON file per agent terminal, relative to the machine's home. */
export const TASKS_DIR = ".herdr/ranch/tasks";

/** Built-in defaults. */
export const DEFAULTS = Object.freeze({
  // Program keys (programs.json / knownAgents()) shown as top-bar launch buttons, in order.
  // "terminal" is the plain-shell button.
  agents: ["claude", "codex", "opencode", "terminal"],
  card: { time: true, line3: true, pr: true },
  session: { tasks: true, git: true, commits: true, subagents: true },
  refresh: { remoteGitSec: 15, prSec: 120 },
  naming: { enabled: true, exitMode: "keep", followAgent: true, model: false, maxLen: 32 },
});

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    if (isObject(base[k])) out[k] = merge(base[k], v);
    else if (Array.isArray(base[k])) out[k] = Array.isArray(v) ? v.filter((x) => typeof x === "string") : base[k];
    else if (typeof v === typeof base[k]) out[k] = v;
  }
  return out;
}

/** Settings with defaults filled in. `stored` is whatever shared(SETTINGS_KEY) returned. */
export function resolveSettings(stored) {
  return merge(DEFAULTS, stored);
}

/** Returns a new stored object with `path` ("naming.exitMode") set to `value`. */
export function withSetting(stored, path, value) {
  const keys = path.split(".");
  const root = isObject(stored) ? { ...stored } : {};
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    node[keys[i]] = isObject(node[keys[i]]) ? { ...node[keys[i]] } : {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return root;
}
