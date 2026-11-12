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
 * `gh pr create` as a command actually run: at the start of the command or of
 * a segment (after ; && || | ( $( or a newline), optionally after env
 * assignments and gh's global repo flags (-R o/r, --repo o/r, --repo=o/r) —
 * not the words inside a comment, string or heredoc body.
 */
const GH_PR_CREATE = /(?:^|[\n;&|(]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*gh(?:\s+(?:-R|--repo)(?:=|\s+)\S+)?\s+pr\s+create\b/;

/** The "owner/repo" in a github.com PR URL (lower-cased), else null. */
const GH_PR_REPO = /https:\/\/github\.com\/([^/\s"'<>()]+)\/([^/\s"'<>()]+)\/pull\/\d+/;

/** @returns {string|null} "owner/repo" of a github.com PR URL, else null. */
export function prRepoOf(url) {
  const m = typeof url === "string" ? GH_PR_REPO.exec(url) : null;
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** @returns {string|null} "owner/repo" of a web base like https://github.com/o/r, else null. */
export function repoOfWebBase(base) {
  const text = typeof base === "string"
    ? base.trim().replace(/\/+$/, "").replace(/\.git$/i, "")
    : "";
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(text);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Every "owner/repo" (lower-cased, unique) in `git remote -v` output. */
export function remoteReposOf(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/github\.com[/:]([^\s/:]+)\/([^\s]+?)(?:\.git)?(?=\s|$)/gi)) {
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    if (!out.includes(repo)) out.push(repo);
  }
  return out;
}

/** The command text of a tool_input: `command` or `cmd`, string or argv array. */
export function prCommandOf(input) {
  for (const key of ["command", "cmd"]) {
    const v = input?.[key];
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.join(" ");
  }
  return "";
}

/** The branch from `--head <b>` / `--head=<b>` / `-H <b>` in the gh segment, else null. */
export function prCreateHead(command) {
  const text = typeof command === "string" ? command : "";
  const at = text.search(GH_PR_CREATE);
  if (at < 0) return null;
  // Only the gh segment itself: stop at the next ; && || | or newline.
  const segment = text.slice(at).replace(/^[\n;&|(]|^\$\(/, "").split(/[\n;|]|&&/)[0];
  const m = segment.match(/(?:^|[\s])(?:--head(?:=|\s+)|-H\s+)("([^"]*)"|'([^']*)'|(\S+))/);
  const raw = m?.[2] ?? m?.[3] ?? m?.[4] ?? "";
  return raw.replace(/^["']|["']$/g, "").replace(/^[^:]+:/, "") || null;
}

/**
 * The directory a gh command ran in: `workdir` (resolved against `cwd` when
 * relative) or `cwd`, then the last `cd <dir>` segment before the `gh ...
 * pr create` segment. On win32, Git Bash paths /c/foo become C:/foo.
 * @returns {string|null}
 */
export function effectiveDir(command, cwd, workdir, platform = "") {
  const absolute = (p) => /^[~/]/.test(p ?? "") || /^[A-Za-z]:[\\/]/.test(p ?? "");
  let base = null;
  if (typeof workdir === "string" && workdir.trim() !== "") {
    base = absolute(workdir) || typeof cwd !== "string" || cwd.trim() === ""
      ? workdir
      : `${cwd.replace(/\/+$/, "")}/${workdir}`;
  } else if (typeof cwd === "string" && cwd.trim() !== "") {
    base = cwd;
  }
  const text = typeof command === "string" ? command : "";
  const ghAt = text.search(GH_PR_CREATE);
  const limit = ghAt >= 0 ? ghAt : text.length;
  for (const m of text.slice(0, limit).matchAll(/(?:^\s*|[;&|\n]\s*|\$\(\s*)cd\s+("[^"]*"|'[^']*'|\S+)/g)) {
    const dir = m[1].replace(/^["']|["']$/g, "");
    if (!dir) continue;
    if (absolute(dir)) base = dir;
    // a relative cd is only resolvable when a base is already known
    else if (base) base = `${base.replace(/\/+$/, "")}/${dir}`;
  }
  if (base && platform === "win32") base = base.replace(/^\/([A-Za-z])(\/|$)/, (_, d, sep) => `${d.toUpperCase()}:${sep}`);
  return base;
}

/**
 * Whether a registry record may be shown in a checkout: true when the
 * checkout's repo is unknown, the url is not a GitHub PR url, the repos match,
 * or only the repo NAME matches (a fork: me/app vs upstream/app).
 */
export function registryPrBelongs(url, checkoutRepo) {
  if (typeof checkoutRepo !== "string" || checkoutRepo.trim() === "") return true;
  const prRepo = prRepoOf(url);
  if (!prRepo) return true;
  if (prRepo === checkoutRepo.toLowerCase()) return true;
  const name = (r) => r.split("/")[1] ?? "";
  return name(prRepo) !== "" && name(prRepo) === name(checkoutRepo.toLowerCase());
}

/** The same PR: by url (case-insensitive) when both have one, else by number. */
export function samePr(a, b) {
  const au = a?.url;
  const bu = b?.url;
  if (typeof au === "string" && au !== "" && typeof bu === "string" && bu !== "") {
    return au.toLowerCase() === bu.toLowerCase();
  }
  const n = (v) => (Number.isInteger(v?.number) && v.number > 0 ? v.number : null);
  return n(a) !== null && n(a) === n(b);
}

/**
 * Pure detection of a `gh pr create` in a PostToolUse hook payload: returns
 * { url, number } when the command created a PR, else null. Shared by the
 * reducers (they record it in the store) and by the CLI (shared registry).
 */
export function detectCreatedPr(payload) {
  const input = payload?.tool_input;
  // Codex passes argv (["bash", "-lc", "gh pr create …"]) in `command` and
  // `cmd`: the joined line and each element (a shell's -c script) are
  // candidate commands.
  const commands = [];
  for (const key of ["command", "cmd"]) {
    const v = input?.[key];
    if (Array.isArray(v)) commands.push(v.join(" "), ...v);
    else if (typeof v === "string") commands.push(v);
  }
  if (!commands.some((c) => GH_PR_CREATE.test(c))) return null;
  const response = payload.tool_response;
  let text = null;
  if (typeof response === "string") {
    // gh's "a pull request for branch … already exists: <url>" error means
    // no new PR was created, even though it carries a URL.
    if (/already exists/i.test(response)) return null;
    text = response;
  } else if (isPlainObject(response)) {
    const code = response.exit_code ?? response.exitCode;
    if (typeof code === "number" && code !== 0) return null;
    // gh prints the created URL on stdout; only stdout is gh's success output.
    text = typeof response.stdout === "string" ? response.stdout : JSON.stringify(response ?? "");
  } else {
    text = JSON.stringify(response ?? "");
  }
  // gh prints the new PR's URL last; earlier URLs are other output.
  const matches = [...(text ?? "").matchAll(new RegExp(PR_URL.source, "g"))];
  const match = matches.at(-1);
  return match ? { url: match[0], number: Number(match[1]) } : null;
}
