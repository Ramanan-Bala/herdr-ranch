// Pure decision helpers for the smart tab namer (requirements §8).
// Imports only ./lib/*.js so it stays testable in plain Node.

import { bestCandidate } from "./lib/naming.js";

/** "Claude Code" -> "Claude": the first word of an agent program's display name. */
export function agentShort(name) {
  if (!name) return null;
  const first = String(name).trim().split(/\s+/)[0];
  return first || null;
}

/**
 * The agent that should name a tab: a sub-agent never wins over its parent.
 * Herdr lists sub-agents under the parent's tab id, so the tab's own agent
 * must be picked from the parents, preferring focus then a busy status.
 */
export function pickNamingAgent({ tabId, agents = [], panes = [], terminals = [] } = {}) {
  const candidates = agents.filter((a) => a.tab === tabId);
  if (!candidates.length) return null;
  const subs = new Set(terminals.filter((t) => t && t.parent).map((t) => t.address));
  const family = candidates.filter((a) => !subs.has(a.address));
  const pool = family.length ? family : candidates;
  const focusedPanes = new Set(panes.filter((p) => p.tab === tabId && p.focused).map((p) => p.pane));
  return (
    pool.find((a) => focusedPanes.has(a.pane) || a.focused)
    ?? pool.find((a) => a.status === "working" || a.status === "blocked")
    ?? pool[0]
  );
}

/**
 * Best candidate name for one tab from its live inputs and task store.
 * When settings.naming.followAgent is false, both agent-provided titles
 * (store session title and terminal title) are ignored.
 */
export function collectInputs({
  agentTitle = null,
  agentTitleSource = null,
  terminalTitle = null,
  firstPrompt = null,
  branch = null,
  agentName = null,
  repo = null,
  settings = null,
  context = [],
} = {}) {
  const follow = settings?.naming?.followAgent !== false;
  return bestCandidate({
    agentTitle: follow ? agentTitle ?? null : null,
    agentTitleSource: follow ? agentTitleSource ?? null : null,
    terminalTitle: follow ? terminalTitle ?? null : null,
    firstPrompt,
    branch,
    defaultBranch: null,
    agentName,
    repo,
    context,
  });
}

/** Prompt sent to the optional summarizer model (R-TN-6); first 500 chars. */
export function buildModelPrompt(firstPrompt) {
  return `Reply with only a 3-5 word title for this coding task: ${String(firstPrompt).slice(0, 500)}`;
}
