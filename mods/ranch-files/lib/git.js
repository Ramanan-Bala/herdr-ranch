/**
 * Git parsing and async helpers for Herdr mods.
 * Pure parsers, no imports. Async helpers take a `git` function
 * `(args: string[]) => Promise<{code, stdout, stderr}>` so callers can bind
 * it to Herdr's `exec("git", args, {cwd, on})` and tests can fake it.
 * Helpers never throw: any failure yields null fields.
 */

/**
 * Parse `git diff --shortstat` output.
 * @param {string} text
 * @returns {{files: number, add: number, del: number}}
 */
export function parseShortstat(text) {
  const files = /(\d+) files? changed/.exec(text);
  const add = /(\d+) insertions?\(/.exec(text);
  const del = /(\d+) deletions?\(/.exec(text);
  return {
    files: files ? Number(files[1]) : 0,
    add: add ? Number(add[1]) : 0,
    del: del ? Number(del[1]) : 0,
  };
}

/**
 * Resolve a numstat path to its post-rename location.
 * @param {string} path
 * @returns {string}
 */
function resolveRename(path) {
  const brace = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/.exec(path);
  if (brace) return brace[1] + brace[2] + brace[3];
  const arrow = path.lastIndexOf(" => ");
  if (arrow !== -1) return path.slice(arrow + 4);
  return path;
}

/**
 * Parse `git diff --numstat` output.
 * @param {string} text
 * @returns {Array<{path: string, add: number|null, del: number|null}>}
 */
export function parseNumstat(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    rows.push({
      add: parts[0] === "-" ? null : Number(parts[0]),
      del: parts[1] === "-" ? null : Number(parts[1]),
      path: resolveRename(parts.slice(2).join("\t")),
    });
  }
  return rows;
}

/** `git log --format=` template: sha, short sha, subject, author, unix time. */
export const LOG_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e";

/**
 * Parse `git log` output produced with LOG_FORMAT.
 * @param {string} text
 * @returns {Array<{sha: string, short: string, subject: string, author: string, time: number}>}
 */
export function parseLog(text) {
  const commits = [];
  for (const record of text.split("\x1e")) {
    const trimmed = record.replace(/^\s+|\s+$/g, "");
    if (!trimmed) continue;
    const [sha, short, subject, author, at] = trimmed.split("\x1f");
    commits.push({
      sha: sha ?? "",
      short: short ?? "",
      subject: subject ?? "",
      author: author ?? "",
      time: at ? Number(at) * 1000 : 0,
    });
  }
  return commits;
}

/**
 * Parse `git rev-list --left-right --count HEAD...@{u}` output.
 * @param {string} text
 * @returns {{ahead: number, behind: number}|null}
 */
export function parseAheadBehind(text) {
  const m = /^(\d+)\s+(\d+)$/.exec(text.trim());
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

/**
 * Map a git remote URL to a web host.
 * @param {string} remoteUrl
 * @returns {{kind: "github"|"gitlab", base: string}|null}
 */
export function webHost(remoteUrl) {
  if (!remoteUrl) return null;
  let rest = remoteUrl.trim();
  let path;
  let host;
  if (rest.startsWith("ssh://")) {
    // ssh://git@github.com/o/r.git  |  ssh://git@host:2222/o/r
    const m = /^ssh:\/\/[^@]*@([^/:]+)(?::\d+)?\/(.+)$/.exec(rest);
    if (!m) return null;
    host = m[1];
    path = m[2];
  } else if (/^https?:\/\//.test(rest)) {
    // https://user@gitlab.com/group/sub/r.git
    const m = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/.exec(rest);
    if (!m) return null;
    host = m[1];
    path = m[2];
  } else {
    // git@github.com:o/r.git (scp-like)
    const m = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(rest);
    if (!m) return null;
    host = m[1];
    path = m[2];
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!path) return null;
  let kind = null;
  if (host.includes("github.com")) kind = "github";
  else if (host.includes("gitlab")) kind = "gitlab";
  else return null;
  return { kind, base: `https://${host}/${path}` };
}

/**
 * URL builders for a web host from webHost().
 * @param {{kind: string, base: string}} host
 * @returns {{branch: (name: string) => string,
 *            commit: (sha: string) => string,
 *            compare: (from: string, to: string) => string,
 *            pr: (number: number) => string}}
 */
export function links(host) {
  const isGitlab = host.kind === "gitlab";
  const sep = isGitlab ? "/-" : "";
  return {
    branch(name) {
      const encoded = name.split("/").map(encodeURIComponent).join("/");
      return `${host.base}${sep}/tree/${encoded}`;
    },
    commit(sha) {
      return `${host.base}${sep}/commit/${sha}`;
    },
    compare(from, to) {
      const spec = `${from}...${to}`;
      return isGitlab
        ? `${host.base}/-/compare/${spec}`
        : `${host.base}/compare/${spec}?expand=1`;
    },
    pr(number) {
      return isGitlab
        ? `${host.base}/-/merge_requests/${number}`
        : `${host.base}/pull/${number}`;
    },
  };
}

/**
 * Wraps a git runner so a rejected promise (timeout, unreachable machine)
 * becomes a failed result instead of an exception.
 */
function safe(git) {
  if (git.__safe) return git;
  const wrapped = async (args) => {
    try {
      const r = await git(args);
      return r && typeof r === "object" ? r : { code: -1, stdout: "", stderr: "" };
    } catch (e) {
      return { code: -1, stdout: "", stderr: String(e) };
    }
  };
  wrapped.__safe = true;
  return wrapped;
}

/**
 * The ref to compare against for a default branch: `origin/<name>` when that
 * remote-tracking ref exists (it reflects the remote), else the local branch.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @param {string|null} name
 * @returns {Promise<string|null>}
 */
export async function defaultRef(git, name) {
  if (!name) return null;
  git = safe(git);
  const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
  if (remote.code === 0) return `origin/${name}`;
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return local.code === 0 ? name : null;
}

/**
 * The default branch of the repo: origin HEAD, else main, else master.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @returns {Promise<string|null>}
 */
export async function defaultBranch(git) {
  git = safe(git);
  const sym = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym.code === 0 && sym.stdout.trim()) {
    return sym.stdout.trim().replace(/^origin\//, "");
  }
  for (const branch of ["main", "master"]) {
    const probe = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (probe.code === 0) return branch;
  }
  return null;
}

/**
 * Snapshot of the repo state at the current directory.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @returns {Promise<object|null>} null when not inside a git repo.
 */
export async function repoSummary(git) {
  git = safe(git);
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;

  const branchOut = await git(["branch", "--show-current"]);
  const branch = branchOut.code === 0 ? branchOut.stdout.trim() : "";
  const detached = !branch;

  const headOut = await git(["rev-parse", "--short", "HEAD"]);
  const head = headOut.code === 0 ? headOut.stdout.trim() : null;

  const def = await defaultBranch(git);
  const ref = await defaultRef(git, def);

  let base = null;
  if (ref) {
    const baseOut = await git(["merge-base", "HEAD", ref]);
    base = baseOut.code === 0 ? baseOut.stdout.trim() : null;
  }

  // Commits HEAD has that the default branch doesn't (ahead), and vice versa.
  let vsDefault = null;
  if (ref) {
    const out = await git(["rev-list", "--left-right", "--count", `HEAD...${ref}`]);
    const counts = out.code === 0 ? parseAheadBehind(out.stdout) : null;
    if (counts) vsDefault = { ahead: counts.ahead, behind: counts.behind, ref };
  }

  let stat = null;
  if (base) {
    const statOut = await git(["diff", "--shortstat", base]);
    stat = statOut.code === 0 ? parseShortstat(statOut.stdout) : null;
  }

  let ahead = null;
  let behind = null;
  const countOut = await git([
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...@{u}",
  ]);
  if (countOut.code === 0) {
    const counts = parseAheadBehind(countOut.stdout);
    if (counts) {
      ahead = counts.ahead;
      behind = counts.behind;
    }
  }

  const urlOut = await git(["remote", "get-url", "origin"]);
  const host = urlOut.code === 0 ? webHost(urlOut.stdout.trim()) : null;

  return {
    top: top.stdout.trim(),
    branch: detached ? null : branch,
    detached,
    head,
    default: def,
    base,
    vsDefault,
    stat,
    ahead,
    behind,
    host,
  };
}

/**
 * Files changed and recent commits against a base commit.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @param {string|null} base merge-base sha, or null for HEAD-only history
 * @param {{commits?: number}} [options]
 * @returns {Promise<{files: Array, commits: Array}>}
 */
export async function repoDetails(git, base, { commits = 5 } = {}) {
  git = safe(git);
  let files = [];
  if (base) {
    const numstat = await git(["diff", "--numstat", base]);
    if (numstat.code === 0) files = parseNumstat(numstat.stdout);
  }
  let logArgs;
  if (base) {
    logArgs = ["log", "-n", String(commits), `--format=${LOG_FORMAT}`, `${base}..HEAD`];
  } else {
    logArgs = ["log", "-n", String(commits), `--format=${LOG_FORMAT}`];
  }
  const log = await git(logArgs);
  return {
    files,
    commits: log.code === 0 ? parseLog(log.stdout) : [],
  };
}

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAIL = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

/** Fields to request from `gh pr view --json` for parsePr(). */
export const PR_JSON_FIELDS =
  "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,author,baseRefName,updatedAt,mergeStateStatus,reviewRequests";

/**
 * Where `gh` usually lives. Herdr runs programs with the login shell's PATH,
 * which may lack Homebrew; mods try PATH first, then these.
 */
export const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"];

/**
 * Runs gh with `run(cmd, args)` (bind it to Herdr's exec with cwd/on),
 * trying each GH_CANDIDATES entry until one starts. Returns the result plus
 * `missing: true` when none could be started. Never throws.
 */
export async function runGh(run, args) {
  for (const cmd of GH_CANDIDATES) {
    try {
      const r = await run(cmd, args);
      if (r && r.code !== 127) return { ...r, missing: false };
    } catch {
      // not found / not startable: try the next location
    }
  }
  return { code: 127, stdout: "", stderr: "gh not found", missing: true };
}

/** One check's state: "pass" | "fail" | "pending" | "skipped". */
function checkState(item) {
  const c = item.conclusion;
  if (c === "SKIPPED" || c === "NEUTRAL") return "skipped";
  if (c) return PASS.has(c) ? "pass" : FAIL.has(c) ? "fail" : "pending";
  const st = item.state;
  if (st === "SUCCESS") return "pass";
  if (st === "FAILURE" || st === "ERROR") return "fail";
  return "pending";
}

/**
 * Parse `gh pr view --json <PR_JSON_FIELDS>` output.
 * checks: counts; checkList: [{ name, workflow, state }] failed first, then
 * pending, passed, skipped. reviewers: requested reviewer logins/team names.
 * @param {object|null} json
 * @returns {object|null}
 */
export function parsePr(json) {
  if (!json || typeof json !== "object") return null;
  const state = json.isDraft && json.state === "OPEN"
    ? "draft"
    : json.state
      ? json.state.toLowerCase()
      : null;
  const review = json.reviewDecision ? json.reviewDecision.toLowerCase() : null;
  const checks = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  const checkList = [];
  for (const item of json.statusCheckRollup ?? []) {
    if (!item || typeof item !== "object") continue;
    const s = checkState(item);
    checks[s] += 1;
    checkList.push({
      name: item.name ?? item.context ?? "check",
      workflow: item.workflowName ?? null,
      state: s,
      url: item.detailsUrl ?? item.targetUrl ?? null,
    });
  }
  const order = { fail: 0, pending: 1, pass: 2, skipped: 3 };
  checkList.sort((a, b) => order[a.state] - order[b.state]);
  const reviewers = [];
  for (const r of json.reviewRequests ?? []) {
    const name = r?.login ?? r?.name ?? r?.slug ?? null;
    if (name) reviewers.push(name);
  }
  return {
    number: json.number ?? null,
    title: json.title ?? null,
    url: json.url ?? null,
    state,
    review,
    checks,
    checkList,
    author: json.author?.name || json.author?.login || null,
    base: json.baseRefName ?? null,
    updatedAt: json.updatedAt ? Date.parse(json.updatedAt) || null : null,
    behind: json.mergeStateStatus === "BEHIND",
    mergeState: json.mergeStateStatus ? String(json.mergeStateStatus).toLowerCase() : null,
    reviewers,
  };
}

/**
 * A tiny TTL cache for values that are expensive to compute.
 * Timestamps come from callers, never from Date.now().
 * @param {number} ttlMs
 * @returns {{get: (key: string, now: number) => any,
 *            set: (key: string, value: any, now: number) => void,
 *            delete: (key: string) => void}}
 */
export function createTtlCache(ttlMs) {
  const entries = new Map();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now - entry.at > ttlMs) return undefined;
      return entry.value;
    },
    set(key, value, now) {
      entries.set(key, { value, at: now });
    },
    delete(key) {
      entries.delete(key);
    },
  };
}
