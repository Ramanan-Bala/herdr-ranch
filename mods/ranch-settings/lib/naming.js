/**
 * Pure naming helpers for Herdr smart tab names (requirements §8).
 * No imports, no globals: time and context are always passed in.
 */

export const SOURCE_RANK = Object.freeze({
  user: 1,
  agent_user: 2,
  agent_auto: 3,
  prompt: 4,
  branch: 5,
  provisional: 6,
  default: 7,
});

const GENERIC_TITLES = [
  "zsh", "bash", "fish", "sh", "pwsh", "powershell", "nu", "claude", "codex",
  "opencode", "new session", "new chat", "untitled", "terminal", "shell",
];

const DEFAULT_BRANCHES = ["main", "master", "develop", "dev", "trunk", "head"];
const BRANCH_TYPES = [
  "feature", "feat", "fix", "bugfix", "hotfix", "chore", "refactor", "docs",
  "test", "release",
];

const EDGE_LEAD_RE = /^[^\p{L}\p{N}#(]+/u;
const EDGE_TAIL_RE = /[^\p{L}\p{N}#)]+$/u;
// Agent names are only stripped at the start or end ("Claude Code — Fix login"),
// never from the middle ("Fix Claude adapter" stays intact).
const AGENT_NAMES = "(?:Claude Code|OpenCode|Claude|Codex)";
const AGENT_LEAD_RE = new RegExp(`^${AGENT_NAMES}(?:[\\s·—–:|,\\-]+|$)`, "iu");
const AGENT_TAIL_RE = new RegExp(`(?:^|[\\s·—–:|,\\-]+)${AGENT_NAMES}$`, "iu");
const USER_HOST_RE = /^[\w.\-+%]+@[A-Za-z0-9.\-]+:\s*/u;
const ELLIPSIS_RE = /(?:\u2026|\.{3})$/;
const SENTENCE_RE = /^[\s\S]*?[.?!](?=\s|$)/u;
const FILLER_RE =
  /^(?:i want you to|i need you to|i(?:'|’)d like you to|i would like you to|we need to|i need to|i want to|can you|could you|would you|will you|help me|let(?:'|’)s|lets|okay|please|pls|hey|hi|ok|so)(?:[\s,]+|$)/i;
const SMALL_WORD_RE = /\b(?:the|a|an|please)\b\s?/gi;
const PUNCT_RE = /[^\p{L}\p{N}\s#\-\/.]/gu;
const DOT_RE = /\.(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\./gu;
const ISSUE_KEY_RE = /^(?:#\d+|[A-Z][A-Z0-9]+-\d+)$/;
const ISSUE_KEY_SEG_RE = /^([A-Z][A-Z0-9]+-\d+)(?:[-_](.+))?$/;

function trimEdges(s) {
  return s.replace(EDGE_LEAD_RE, "").replace(EDGE_TAIL_RE, "");
}

function isPathToken(token) {
  if (/^(?:\/|~\/|\.\.\/|\.\/)/.test(token)) return true;
  if (!token.includes("/")) return false;
  // contains "/" with no spaces: a path when multi-segment or carrying an extension
  return token.split("/").length > 2 || /\.[A-Za-z0-9]{1,6}(?:$|\/)/.test(token);
}

function sentenceCase(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Cap at maxLen without leaving a partial word: finish the word that crosses the
// limit when that overruns by at most SNAP chars, else drop it; hard-cut only
// when the first word alone is too long.
const SNAP = 8;
function capToLen(s, maxLen) {
  if (s.length <= maxLen) return s;
  const spaceAfter = s.indexOf(" ", maxLen);
  const wordEnd = spaceAfter === -1 ? s.length : spaceAfter;
  const wordStart = s.lastIndexOf(" ", maxLen);
  if (wordStart <= 0) return s.slice(0, maxLen).trimEnd();
  if (wordEnd <= maxLen + SNAP) return s.slice(0, wordEnd).trimEnd();
  return s.slice(0, wordStart).trimEnd();
}

/** Clean a raw terminal/agent title; null when empty or generic. */
export function cleanTitle(raw, { repo = null } = {}) {
  if (raw == null) return null;
  let s = trimEdges(String(raw).trim());
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = trimEdges(s.replace(AGENT_LEAD_RE, "").replace(AGENT_TAIL_RE, ""));
  }
  s = s.replace(USER_HOST_RE, "");
  s = s.split(/\s+/).filter((t) => t && !isPathToken(t)).join(" ");
  s = trimEdges(s.replace(/\s+/g, " ").trim()).replace(ELLIPSIS_RE, "").trim();
  if (!s || !/\p{L}/u.test(s)) return null;
  const low = s.toLowerCase();
  if (GENERIC_TITLES.includes(low)) return null;
  if (repo != null && low === String(repo).trim().toLowerCase()) return null;
  return s;
}

/** Summarise a first prompt / launch task into a short tab name; null if empty. */
export function summarizePrompt(prompt, { maxWords = 6, maxLen = 32 } = {}) {
  if (prompt == null) return null;
  const line = String(prompt).split("\n")[0].trim();
  if (!line) return null;
  const sentenceMatch = line.match(SENTENCE_RE);
  let s = sentenceMatch ? sentenceMatch[0] : line;
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(FILLER_RE, "");
  }
  s = s.replace(SMALL_WORD_RE, " ");
  s = s.replace(PUNCT_RE, "").replace(DOT_RE, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  const words = s.split(" ").filter(Boolean);
  const keys = words.filter((w) => ISSUE_KEY_RE.test(w));
  let out = capToLen(words.slice(0, maxWords).join(" "), maxLen);
  const have = new Set(out.split(" "));
  for (const key of keys) {
    if (!have.has(key)) out += ` ${key}`;
  }
  out = sentenceCase(out).trim();
  return /\p{L}/u.test(out) ? out : null;
}

/** Make a branch name readable; null for empty/default/well-known base branches. */
export function humanizeBranch(branch, defaultBranch) {
  if (branch == null) return null;
  const b = String(branch).trim();
  if (!b) return null;
  const low = b.toLowerCase();
  if (DEFAULT_BRANCHES.includes(low)) return null;
  if (defaultBranch != null && low === String(defaultBranch).trim().toLowerCase()) return null;
  let parts = b.split("/").map((p) => p.trim()).filter(Boolean);
  const stripTypes = (ps) => {
    while (ps.length > 1 && BRANCH_TYPES.includes(ps[0].toLowerCase())) ps.shift();
    return ps;
  };
  parts = stripTypes(parts);
  if (parts.length >= 2) parts = stripTypes(parts.slice(1)); // drop one username segment
  if (parts.length > 1) parts = [parts[parts.length - 1]]; // keep the last segment
  const seg = parts[0] ?? "";
  if (!seg) return null;
  const keyMatch = seg.match(ISSUE_KEY_SEG_RE);
  const text = keyMatch
    ? [keyMatch[1], keyMatch[2] ? keyMatch[2].replace(/[-_]+/g, " ") : ""]
      .filter(Boolean)
      .join(" ")
    : seg.replace(/[-_]+/g, " ");
  if (!text.trim()) return null;
  return sentenceCase(capToLen(text.trim(), 32));
}

/** Provisional "<Agent> · <repo>" name at session start. */
export function provisionalName(agentName, repo) {
  if (agentName && repo) return `${agentName} · ${repo}`;
  if (agentName) return String(agentName);
  if (repo) return String(repo);
  return null;
}

/** Best name for a tab from all available inputs, or null. */
export function bestCandidate(inputs = {}) {
  const {
    agentTitle,
    agentTitleSource = null,
    terminalTitle,
    firstPrompt,
    launchTask,
    branch,
    defaultBranch,
    agentName,
    repo,
  } = inputs;
  if (agentTitle) {
    const cleaned = cleanTitle(agentTitle);
    if (cleaned) {
      return { name: cleaned, source: agentTitleSource === "user" ? "agent_user" : "agent_auto" };
    }
  }
  if (terminalTitle) {
    const cleaned = cleanTitle(terminalTitle, { repo });
    if (cleaned) return { name: cleaned, source: "agent_auto" };
  }
  const prompt = firstPrompt ?? launchTask;
  if (prompt) {
    const cleaned = tidy(summarizePrompt(prompt));
    if (cleaned) return { name: cleaned, source: "prompt" };
  }
  if (branch) {
    const cleaned = tidy(humanizeBranch(branch, defaultBranch));
    if (cleaned) return { name: cleaned, source: "branch" };
  }
  const provisional = tidy(provisionalName(agentName, repo));
  if (provisional) return { name: provisional, source: "provisional" };
  return null;
}

function tidy(s) {
  if (s == null) return null;
  const out = String(s).replace(/\s+/g, " ").trim().replace(ELLIPSIS_RE, "").trim();
  return out || null;
}

/** Who owns the tab's current name: "unnamed", "auto" (Ranch set it) or "locked". */
export function ownership(tab, record) {
  if (!tab || !tab.named) return "unnamed";
  return record && record.name === tab.name ? "auto" : "locked";
}

/** Disambiguate against sibling tabs: branch suffix first, then " 2", " 3", ... */
export function dedupe(name, siblingNames, branch) {
  const taken = new Set((siblingNames || []).map((s) => String(s).toLowerCase()));
  if (!taken.has(String(name).toLowerCase())) return name;
  if (branch) {
    const withBranch = `${name} · ${branch}`;
    if (!taken.has(withBranch.toLowerCase())) return withBranch;
  }
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Rename decision for one tab, applying ownership, rank and throttle rules. */
export function decide(ctx = {}) {
  const {
    tab,
    record,
    candidate,
    now,
    editing = false,
    siblingNames = [],
    branch = null,
    minIntervalMs = 15000,
  } = ctx;
  if (editing) return { action: "none", reason: "editing" };
  const own = ownership(tab, record);
  if (own === "locked") return { action: "none", reason: "locked" };
  if (!candidate || !candidate.name) return { action: "none", reason: "no-candidate" };
  const ownName = tab && tab.name ? String(tab.name).toLowerCase() : "";
  const sibs = siblingNames.filter((s) => String(s).toLowerCase() !== ownName);
  const name = dedupe(candidate.name, sibs, branch);
  if (own === "auto" && SOURCE_RANK[candidate.source] > recordRank(record)) {
    return { action: "none", reason: "downgrade" };
  }
  if (name === tab.name) return { action: "none", reason: "same" };
  if (
    own === "auto" &&
    record &&
    record.at &&
    now - record.at < minIntervalMs &&
    candidate.source !== "agent_user"
  ) {
    return { action: "none", reason: "throttled" };
  }
  return { action: "rename", name, source: candidate.source };
}

function recordRank(record) {
  return record && record.source in SOURCE_RANK
    ? SOURCE_RANK[record.source]
    : SOURCE_RANK.default;
}

/** What to do with the tab name when the agent's session exits. */
export function exitAction({ didWork, mode = "keep", ownershipState, currentName } = {}) {
  if (ownershipState !== "auto") return { action: "none" };
  if (!didWork) return { action: "reset" };
  if (mode === "revert") return { action: "reset" };
  if (mode === "check") {
    const base = currentName ? String(currentName) : "";
    const name = base.startsWith("✓ ") ? base : `✓ ${base}`.trim();
    return { action: "rename", name };
  }
  return { action: "none" };
}

/** LRU insert of sessionId -> name into a new map (input not mutated). */
export function rememberSession(map, sessionId, name, cap = 200) {
  const next = { ...map };
  delete next[sessionId];
  next[sessionId] = name;
  const keys = Object.keys(next);
  const extra = keys.length - cap;
  for (let i = 0; i < extra; i++) delete next[keys[i]];
  return next;
}

/** Recall a session's last name, or null. */
export function recallSession(map, sessionId) {
  return map && Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : null;
}
