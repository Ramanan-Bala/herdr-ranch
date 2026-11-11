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
  });
}

/** Prompt sent to the optional summarizer model (R-TN-6); first 500 chars. */
export function buildModelPrompt(firstPrompt) {
  return `Reply with only a 3-5 word title for this coding task: ${String(firstPrompt).slice(0, 500)}`;
}
