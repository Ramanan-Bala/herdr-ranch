// The shared recorded-PR registry: `~/.herdr/ranch/prs.json`, written by the
// adapters' hook after `gh pr create` and read by the mods, so every terminal
// on the same repo + branch sees the PRs any of them opened (the task store's
// `prs` field only lives in the creating terminal). Pure module, no imports:
// used by the adapters (to write) and copied into every mod (to read).

export const PRS_FILE = ".herdr/ranch/prs.json";

const REGISTRY_VERSION = 1;
const MAX_PER_KEY = 10;

/** Matches the PR URL in a `gh pr create` tool response (I4). */
export const PR_URL = /https:\/\/github\.com\/[^\s"'<>()]+\/pull\/(\d+)/;

function str(v) {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** The registry key for a repo top + branch, or null when either is unusable. */
export function prKey(top, branch) {
  const t = str(top);
  const b = str(branch);
  return t && b ? `${t}|${b}` : null;
}

/**
 * Tolerant reader: anything unreadable (missing text, bad JSON, wrong shape)
 * becomes an empty registry; malformed entries are dropped, valid ones kept.
 * @returns {{ version: number, entries: Record<string, Array<{url: string, number: number|null, at: string|null}>> }}
 */
export function parsePrRegistry(text) {
  const empty = () => ({ version: REGISTRY_VERSION, entries: {} });
  if (typeof text !== "string" || text.trim() === "") return empty();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty();
  }
  if (!isPlainObject(raw) || !isPlainObject(raw.entries)) return empty();
  const entries = {};
  for (const [key, list] of Object.entries(raw.entries)) {
    if (typeof key !== "string" || key.trim() === "" || !Array.isArray(list)) continue;
    const kept = list.flatMap((p) => {
      if (!isPlainObject(p)) return [];
      const url = str(p.url);
      if (!url) return [];
      return [{
        url,
        number: Number.isInteger(p.number) && p.number > 0 ? p.number : null,
        at: str(p.at),
      }];
    });
    if (kept.length) entries[key] = kept;
  }
  return { version: REGISTRY_VERSION, entries };
}

/**
 * Adds one record for `top|branch`, newest last, deduped by url, capped at
 * MAX_PER_KEY per key. Pure: returns a new registry, input untouched.
 */
export function addPr(registry, top, branch, record) {
  const base = isPlainObject(registry) && isPlainObject(registry.entries)
    ? registry
    : { version: REGISTRY_VERSION, entries: {} };
  const url = isPlainObject(record) ? str(record.url) : null;
  if (!url) return base;
  const key = prKey(top, branch);
  if (!key) return base;
  const record2 = {
    url,
    number: isPlainObject(record) && Number.isInteger(record.number) && record.number > 0 ? record.number : null,
    at: isPlainObject(record) ? str(record.at) : null,
  };
  const list = (base.entries[key] ?? []).filter((p) => p?.url !== url);
  return { version: REGISTRY_VERSION, entries: { ...base.entries, [key]: [...list, record2].slice(-MAX_PER_KEY) } };
}

/** The records recorded for `top|branch` (oldest first), or []. */
export function prsFor(registry, top, branch) {
  const key = prKey(top, branch);
  if (!key || !isPlainObject(registry) || !isPlainObject(registry.entries)) return [];
  return Array.isArray(registry.entries[key]) ? registry.entries[key] : [];
}

/**
 * Pure detection of a `gh pr create` in a PostToolUse hook payload: returns
 * { url, number } when the command created a PR, else null. Shared by the
 * reducers (they record it in the store) and by the CLI (shared registry).
 */
export function detectCreatedPr(payload) {
  const input = payload?.tool_input;
  const command = Array.isArray(input?.command) ? input.command.join(" ") : input?.command;
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return null;
  const response = typeof payload.tool_response === "string"
    ? payload.tool_response
    : JSON.stringify(payload.tool_response ?? "");
  const match = PR_URL.exec(response ?? "");
  return match ? { url: match[0], number: Number(match[1]) } : null;
}
