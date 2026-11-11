// Launch helpers for the ranch-launch dialog. Pure module (no herdr imports)
// so it can be copied into every mod and tested in Node.

/** Branch prefix for agent worktrees. */
const PREFIX = "agent/";
const MAX_LEN = 40;

/** Words that carry no meaning for a branch name. */
const FILLERS = new Set(["please", "can", "you", "help", "me", "i", "want", "to", "the", "a", "an"]);

/** Lowercase ASCII letters and digits of one word: everything else is dropped. */
function wordSlug(word) {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Branch name from a task prompt: "agent/" + kebab slug of the first 5
 * meaningful words (filler words dropped, lowercase ASCII), max 40 chars
 * total, no trailing dash. Empty or all-filler prompt: "agent/" + a short
 * base36 timestamp (`now`, ms since the epoch).
 */
export function branchFromPrompt(text, now) {
  if (!text || !text.trim()) return PREFIX + Number(now).toString(36);
  const words = [];
  for (const raw of text.split(/\s+/)) {
    const w = wordSlug(raw);
    if (!w || FILLERS.has(w)) continue;
    words.push(w);
    if (words.length === 5) break;
  }
  let slug = words.join("-");
  if (PREFIX.length + slug.length > MAX_LEN) {
    slug = slug.slice(0, MAX_LEN - PREFIX.length).replace(/-+$/, "");
  }
  return PREFIX + slug;
}

/**
 * Where a checkout goes, the shipped worktree mod's convention:
 * <home>/.herdr/worktrees/<repo name>/<branch, every run of chars outside
 * [A-Za-z0-9._-] replaced by "-", trimmed of dashes>.
 */
export function worktreePath(home, repoTop, branch) {
  const slug = String(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const repo = String(repoTop).replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  return `${home}/.herdr/worktrees/${repo}/${slug}`;
}

/**
 * The agent keys to offer, in Ranch settings order, excluding "terminal",
 * keeping only keys present in `known` with installed !== false. If that
 * leaves nothing, all installed known agents with agent:true.
 */
export function launchOrder(settingsAgents, known) {
  const list = Array.isArray(known) ? known : [];
  const byKey = new Map(list.map((a) => [a.key, a]));
  const seen = new Set();
  const offered = [];
  for (const key of Array.isArray(settingsAgents) ? settingsAgents : []) {
    if (key === "terminal" || seen.has(key)) continue;
    const agent = byKey.get(key);
    if (agent && agent.installed !== false) {
      seen.add(key);
      offered.push(key);
    }
  }
  if (offered.length) return offered;
  return list.filter((a) => a.agent && a.installed !== false).map((a) => a.key);
}
