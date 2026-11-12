/**
 * Git parsing and async helpers for Herdr mods.
 * Pure parsers, no imports. Async helpers take a `git` function
 * `(args: string[]) => Promise<{code, stdout, stderr}>` so callers can bind
 * it to Herdr's `exec("git", args, {cwd, on})` and tests can fake it.
 * Helpers never throw: any failure yields null fields.
 *
 * Parsers: parseShortstat, parseNumstat (text) / parseNumstatZ (-z output),
 * numstatTotals, parseLog, parseAheadBehind, parseStatusBranch, parsePr.
 * Async helpers: defaultBranch, defaultRef, repoSnapshot (with repoSummary
 * and repoDetails built on it), runGh. Caching/queueing: createTtlCache,
 * createLimiter.
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
 * For `git diff --numstat -z` output use parseNumstatZ instead.
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

/**
 * Parse `git diff --numstat -z` output. Records are NUL-separated so paths
 * are verbatim (tabs, newlines, quotes, unicode, " => " all kept). Rename and
 * copy records have an empty third field, then the old and new path each as
 * their own NUL-terminated field; the row's path is the new path. `-` for
 * add/del (binary) becomes null.
 * @param {string} text
 * @returns {Array<{path: string, add: number|null, del: number|null}>}
 */
export function parseNumstatZ(text) {
  const rows = [];
  if (!text) return rows;
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; ) {
    const field = fields[i];
    if (!field) { i += 1; continue; }
    const t1 = field.indexOf("\t");
    const t2 = t1 === -1 ? -1 : field.indexOf("\t", t1 + 1);
    if (t2 === -1) { i += 1; continue; }
    const add = field.slice(0, t1) === "-" ? null : Number(field.slice(0, t1));
    const del = field.slice(t1 + 1, t2) === "-" ? null : Number(field.slice(t1 + 1, t2));
    const pathPart = field.slice(t2 + 1);
    if (pathPart === "") {
      // rename/copy record: old path and new path each follow as own fields
      rows.push({ path: fields[i + 2] ?? "", add, del });
      i += 3;
    } else {
      rows.push({ path: pathPart, add, del });
      i += 1;
    }
  }
  return rows;
}

/**
 * Totals for numstat rows (either parser's output): file count plus add/del
 * sums, with binary rows (null) counted as 0 lines — matches
 * `git diff --shortstat`, where binary files count as files with 0 lines.
 * @param {Array<{add: number|null, del: number|null}>} rows
 * @returns {{files: number, add: number, del: number}}
 */
export function numstatTotals(rows) {
  let add = 0;
  let del = 0;
  for (const row of rows) {
    add += row.add ?? 0;
    del += row.del ?? 0;
  }
  return { files: rows.length, add, del };
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
 * Parse `git status --porcelain=v2 --branch` output. Only lines starting with
 * "# branch." are read; changed-file entries are ignored.
 * @param {string} text
 * @returns {{oid: string|null, branch: string|null, detached: boolean,
 *            upstream: string|null, ahead: number|null, behind: number|null}}
 */
export function parseStatusBranch(text) {
  let oid = null;
  let branch = null;
  let detached = false;
  let upstream = null;
  let ahead = null;
  let behind = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("# branch.")) continue;
    const value = line.slice("# branch.".length).replace(/^\S+ ?/, "");
    if (line.startsWith("# branch.oid ")) {
      oid = value === "(initial)" ? null : value;
    } else if (line.startsWith("# branch.head ")) {
      if (value === "(detached)") {
        branch = null;
        detached = true;
      } else {
        branch = value || null;
      }
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = value || null;
    } else if (line.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(value);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    }
  }
  return { oid, branch, detached, upstream, ahead, behind };
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
  const hostname = host.toLowerCase().replace(/:\d+$/, "");
  let kind = null;
  let baseHost = host;
  if (hostname === "github.com" || hostname === "www.github.com" || hostname === "ssh.github.com") {
    kind = "github";
    baseHost = "github.com";
  } else if (hostname === "gitlab.com" || hostname.split(".").some((label) => label.startsWith("gitlab"))) {
    kind = "gitlab";
  } else {
    return null;
  }
  return { kind, base: `https://${baseHost}/${path}` };
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
      const enc = (ref) => ref.split("/").map(encodeURIComponent).join("/");
      const spec = `${enc(from)}...${enc(to)}`;
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
 * The default branch of the repo: origin HEAD, else the first of main/master
 * that exists as a remote-tracking ref (checked before the local branch for
 * each name).
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
    const remote = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (remote.code === 0) return branch;
    const local = await git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (local.code === 0) return branch;
  }
  return null;
}

/**
 * Full repo snapshot in a few small parallel rounds (at most 2 git processes
 * per round, never more than 4 concurrent). Reads repo metadata (default
 * branch, compare ref, web host) once and caches it via `meta` (a
 * createTtlCache) keyed by `metaKey|<common dir>`.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @param {{commits?: number, details?: boolean,
 *          meta?: object|null, metaKey?: string, now?: number}} [options]
 * @returns {Promise<{status: "ok"|"not-repo"|"failed",
 *            summary: object|null, details: {files: Array, commits: Array}|null}>}
 */
export async function repoSnapshot(
  git,
  { commits = 5, details = true, meta = null, metaKey = "", now = 0 } = {},
) {
  git = safe(git);

  // Round 1: where is the repo, and what does HEAD look like.
  const [revOut, statusOut] = await Promise.all([
    git(["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"]),
    git(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"]),
  ]);
  if (revOut.code === -1) return { status: "failed", summary: null, details: null };
  if (revOut.code !== 0) return { status: "not-repo", summary: null, details: null };
  const revLines = revOut.stdout.split("\n");
  const top = (revLines[0] ?? "").trim();
  const common = (revLines[1] ?? "").trim() || null;
  const st = statusOut.code === 0 ? parseStatusBranch(statusOut.stdout) : null;
  const branch = st && !st.detached ? st.branch : null;
  const detached = st ? st.detached : true;
  const head = st?.oid ? st.oid.slice(0, 7) : null;
  const ahead = st?.ahead ?? null;
  const behind = st?.behind ?? null;

  // Round 2: repo metadata, skipped on a cache hit.
  const key = `${metaKey}|${common ?? top}`;
  let def = null;
  let ref = null;
  let host = null;
  let cached = null;
  if (meta) cached = meta.get(key, now);
  if (!cached) {
    const [refsOut, urlOut] = await Promise.all([
      git([
        "for-each-ref",
        "--format=%(refname)%09%(symref)",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
      ]),
      git(["remote", "get-url", "origin"]),
    ]);
    host = urlOut.code === 0 ? webHost(urlOut.stdout.trim()) : null;
    if (refsOut.code === 0) {
      const lines = refsOut.stdout
        .split("\n")
        .map((line) => {
          const i = line.indexOf("\t");
          return { refname: i === -1 ? line : line.slice(0, i), symref: i === -1 ? "" : line.slice(i + 1) };
        })
        .filter((line) => line.refname);
      const names = new Set(lines.map((line) => line.refname));
      const headLine = lines.find(
        (line) => line.refname === "refs/remotes/origin/HEAD" && line.symref,
      );
      if (headLine) def = headLine.symref.replace(/^refs\/remotes\/origin\//, "");
      if (!def) {
        for (const candidate of ["main", "master"]) {
          if (names.has(`refs/remotes/origin/${candidate}`) || names.has(`refs/heads/${candidate}`)) {
            def = candidate;
            break;
          }
        }
      }
      if (def) {
        if (names.has(`refs/remotes/origin/${def}`)) ref = `origin/${def}`;
        else if (names.has(`refs/heads/${def}`)) ref = def;
        else if (headLine) ref = await defaultRef(git, def);
      }
      if (meta) meta.set(key, { default: def, ref, host }, now);
    }
  } else {
    def = cached.default;
    ref = cached.ref;
    host = cached.host;
  }

  // Round 3: where HEAD diverged from the default branch.
  let base = null;
  let vsDefault = null;
  if (ref) {
    const [baseOut, countOut] = await Promise.all([
      git(["merge-base", "HEAD", ref]),
      git(["rev-list", "--left-right", "--count", `HEAD...${ref}`]),
    ]);
    base = baseOut.code === 0 ? baseOut.stdout.trim() : null;
    const counts = countOut.code === 0 ? parseAheadBehind(countOut.stdout) : null;
    if (counts) vsDefault = { ahead: counts.ahead, behind: counts.behind, ref };
  }

  // Round 4: files changed vs base, plus recent commits.
  let files = [];
  let stat = null;
  let diffOut = null;
  let logOut = null;
  if (details) {
    const logArgs = ["log", "-n", String(commits), `--format=${LOG_FORMAT}`];
    if (base) logArgs.push(`${base}..HEAD`);
    [diffOut, logOut] = await Promise.all([
      base ? git(["diff", "--numstat", "-z", base]) : Promise.resolve(null),
      git(logArgs),
    ]);
  } else if (base) {
    diffOut = await git(["diff", "--numstat", "-z", base]);
  }
  if (base && diffOut.code === 0) {
    files = parseNumstatZ(diffOut.stdout);
    stat = numstatTotals(files);
  }
  const commitsOut = logOut && logOut.code === 0 ? parseLog(logOut.stdout) : [];

  return {
    status: "ok",
    summary: {
      top,
      branch,
      detached,
      head,
      default: def,
      base,
      vsDefault,
      stat,
      ahead,
      behind,
      host,
      common,
      linked: common !== null && common !== `${top}/.git`,
    },
    details: details ? { files, commits: commitsOut } : null,
  };
}

/**
 * Summary of the repo state at the current directory (repoSnapshot without
 * the file/commit details).
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @param {{commits?: number, meta?: object|null, metaKey?: string, now?: number}} [options]
 * @returns {Promise<object|null>} null when not inside a git repo.
 */
export async function repoSummary(git, opts = {}) {
  return (await repoSnapshot(git, { ...opts, details: false })).summary;
}

/**
 * Files changed and recent commits against a base commit. The numstat and
 * log calls run in parallel.
 * @param {(args: string[]) => Promise<{code: number, stdout: string, stderr: string}>} git
 * @param {string|null} base merge-base sha, or null for HEAD-only history
 * @param {{commits?: number}} [options]
 * @returns {Promise<{files: Array, commits: Array}>}
 */
export async function repoDetails(git, base, { commits = 5 } = {}) {
  git = safe(git);
  const logArgs = base
    ? ["log", "-n", String(commits), `--format=${LOG_FORMAT}`, `${base}..HEAD`]
    : ["log", "-n", String(commits), `--format=${LOG_FORMAT}`];
  const [diffOut, logOut] = await Promise.all([
    base ? git(["diff", "--numstat", "-z", base]) : Promise.resolve(null),
    git(logArgs),
  ]);
  return {
    files: base && diffOut.code === 0 ? parseNumstatZ(diffOut.stdout) : [],
    commits: logOut.code === 0 ? parseLog(logOut.stdout) : [],
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
  "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,author,baseRefName,updatedAt,mergeStateStatus,reviewRequests,latestReviews";

/**
 * Where `gh` usually lives. Herdr runs programs with the login shell's PATH,
 * which may lack Homebrew; mods try PATH first, then these.
 */
export const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh", "C:/Program Files/GitHub CLI/gh.exe"];

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
  // Latest review per person (gh's latestReviews): who has approved.
  const approvedBy = [];
  for (const r of json.latestReviews ?? []) {
    const name = r?.author?.login ?? r?.author?.name ?? null;
    if (r?.state === "APPROVED" && name && !approvedBy.includes(name)) approvedBy.push(name);
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
    approvedBy,
  };
}

/**
 * A tiny TTL cache for values that are expensive to compute.
 * Timestamps come from callers, never from Date.now(). `get` deletes an
 * expired entry; `prune` deletes all expired ones; with `max`, `set` evicts
 * the oldest-inserted entries (re-setting a key refreshes its order).
 * @param {number} ttlMs
 * @param {{max?: number}} [options]
 * @returns {{get: (key: string, now: number) => any,
 *            set: (key: string, value: any, now: number) => void,
 *            prune: (now: number) => number,
 *            size: number,
 *            delete: (key: string) => void}}
 */
export function createTtlCache(ttlMs, { max = Infinity } = {}) {
  const entries = new Map();
  return {
    get(key, now) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now - entry.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      entries.delete(key); // refresh insertion order for max eviction
      entries.set(key, { value, at: now });
      while (entries.size > max) {
        entries.delete(entries.keys().next().value);
      }
    },
    prune(now) {
      let removed = 0;
      for (const [key, entry] of entries) {
        if (now - entry.at > ttlMs) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    get size() {
      return entries.size;
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

/**
 * Runs at most `max` functions at once; queued ones start FIFO unless
 * `front: true` puts them at the head of the queue. A rejecting function
 * rejects only its own promise and frees its slot.
 * @param {number} max
 * @returns {{run: (fn: () => Promise<any>, options?: {front?: boolean}) => Promise<any>,
 *            active: number, pending: number}}
 */
export function createLimiter(max) {
  const queue = [];
  let active = 0;
  const next = () => {
    while (active < max && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      active += 1;
      // Promise.resolve().then: a sync throw or plain value still settles. The
      // slot is freed before the caller resumes, then the queue moves on.
      const settle = (done, value) => {
        active -= 1;
        done(value);
        next();
      };
      Promise.resolve().then(fn).then((v) => settle(resolve, v), (e) => settle(reject, e));
    }
  };
  return {
    run(fn, { front = false } = {}) {
      return new Promise((resolve, reject) => {
        const job = { fn, resolve, reject };
        if (front) queue.unshift(job);
        else queue.push(job);
        next();
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}
