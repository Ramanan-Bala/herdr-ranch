// Pure helpers for the New-space dialog (mods/ranch-newspace): parsing git's
// worktree/branch listings, deciding what the primary action should be, and
// building the checkout path. No herdr imports, so it can be copied into every
// mod and tested in Node.

import { worktreePath } from "./launch.js";

/**
 * Parse `git worktree list --porcelain` output into checkouts:
 *   [{ path, branch, detached, bare, prunable, main }]
 * `branch` is the short branch name, or null for a detached checkout. `main`
 * marks the repository's primary checkout (the first usable entry). Bare and
 * prunable entries are kept with their flags so callers can filter them.
 */
export function parseWorktrees(text) {
  const out = [];
  for (const block of String(text ?? "").split(/\n[ \t]*\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    out.push({
      path,
      branch: lines.find((l) => l.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//, "") ?? null,
      detached: lines.some((l) => l === "detached" || l.startsWith("detached ")),
      bare: lines.some((l) => l === "bare"),
      prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
      main: false,
    });
  }
  const first = out.findIndex((c) => !c.bare && !c.prunable);
  if (first >= 0) out[first].main = true;
  return out;
}

/**
 * Parse `git for-each-ref --format=%(refname)%09%(symref) refs/heads refs/remotes`
 * into `{ local, remote, default }`. Local branches are short names; remote
 * ones keep their remote prefix (`origin/main`). `default` is the branch a
 * `<remote>/HEAD` symbolic ref points at (usually `main`), or null.
 */
export function parseBranches(text) {
  const local = [];
  const remote = [];
  let defaultBranch = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const ref = (tab === -1 ? line : line.slice(0, tab)).trim();
    const symref = tab === -1 ? "" : line.slice(tab + 1).trim();
    if (ref.startsWith("refs/heads/")) {
      local.push(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/remotes/")) {
      const short = ref.slice("refs/remotes/".length);
      if (short.endsWith("/HEAD")) {
        if (symref.startsWith("refs/remotes/")) {
          const target = symref.slice("refs/remotes/".length).split("/").slice(1).join("/");
          if (target) defaultBranch = target;
        }
        continue;
      }
      remote.push(short);
    }
  }
  return { local, remote, default: defaultBranch };
}

/**
 * The repo a folder belongs to, from `rev-parse --show-toplevel` and
 * `rev-parse --path-format=absolute --git-common-dir`: `{ top, main, name }`,
 * or null when either command failed (not a repo). `main` is the primary
 * checkout even when `top` is a linked worktree; `name` is its folder name.
 */
export function repoInfo(topOut, commonOut) {
  const top = String(topOut ?? "").trim();
  let common = String(commonOut ?? "").trim();
  if (!top || !common) return null;
  if (common.endsWith("/.git")) common = common.slice(0, -"/.git".length);
  return { top, main: common, name: common.split("/").filter(Boolean).pop() ?? "" };
}

/** Shorten an absolute path to `~/…` when it is inside `home`. */
export function tilde(path, home) {
  const p = String(path ?? "").replace(/\\/g, "/");
  const h = String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (h && (p === h || p.startsWith(h + "/"))) return `~${p.slice(h.length)}`;
  return path;
}

/**
 * A folder typed with a leading `~` (`~` or `~/x`), resolved against `home`:
 * `home` itself, or `home/x`. Anything else is returned as typed, and without
 * a known home the path stays as typed (never `null/x`).
 */
export function expandHome(path, home) {
  const typed = String(path ?? "").trim();
  const h = String(home ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!h) return typed;
  if (typed === "~" || typed === "~/") return h;
  if (typed.startsWith("~/")) return h + typed.slice(1);
  return typed;
}

/** The first non-empty line of a git error, for the inline error slot. */
export function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0] ?? "";
}

/**
 * The branch to base a new branch on: the remote HEAD when the repo names one,
 * else the checked-out branch, then `main`/`master`, then any local branch.
 */
export function pickDefaultBranch(branches, current) {
  const local = branches?.local ?? [];
  if (branches?.default) return branches.default;
  if (current && local.includes(current)) return current;
  for (const guess of ["main", "master"]) if (local.includes(guess)) return guess;
  return local[0] ?? current ?? null;
}

/**
 * Branch-name autocomplete: local branches plus remote branch names with the
 * remote prefix stripped (`origin/feat` -> `feat`), deduped and prefix-matched
 * against `query` (case-insensitive), most useful first, capped at `limit`.
 */
export function branchSuggestions(branches, query, limit = 6) {
  const names = [];
  const seen = new Set();
  const add = (name) => {
    const n = String(name ?? "").trim();
    if (!n || n === "HEAD" || seen.has(n)) return;
    seen.add(n);
    names.push(n);
  };
  for (const name of branches?.local ?? []) add(name);
  for (const ref of branches?.remote ?? []) add(ref.split("/").slice(1).join("/"));
  const q = String(query ?? "").trim().toLowerCase();
  const matched = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
  // Prefix matches before substring matches, then alphabetical.
  matched.sort((a, b) => {
    const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
    return ap - bp || a.localeCompare(b);
  });
  return matched.slice(0, limit);
}

// ------------------------------------------------------ reading a machine

/**
 * The machines a dialog can target, this computer first:
 * `[{ name, label, local, disabled, hint }]`. `name` is null for this computer;
 * `hint` is the connection state to show beside the name ("offline" for a
 * machine that is unavailable, "connecting…" while its layout loads).
 * `current` is kept even when the machine list does not know it (a core that
 * is not connected yet), so the dialog never silently moves the target.
 */
export function machineChoices({ machines: list = [], current = null } = {}) {
  const seen = new Set();
  const out = [];
  const add = (name, layout) => {
    const key = name ?? null;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: key,
      label: key ?? "This computer",
      local: key === null,
      disabled: layout === "unavailable",
      hint: layout === "unavailable" ? "offline" : layout === "loading" ? "connecting…" : "",
    });
  };
  for (const m of list ?? []) add(m?.name ?? null, m?.layout);
  if (!seen.has(null)) out.unshift({ name: null, label: "This computer", local: true, disabled: false, hint: "" });
  if (current && !seen.has(current)) out.unshift({ name: current, label: current, local: false, disabled: false, hint: "" });
  return out;
}

/**
 * The folder a machine should start at: the folder of its most recent space
 * (spaces are in creation order, so the last one on that machine), else the
 * machine's home. A space with no folder of its own lives at the machine's
 * home, so it counts as a home answer too. Null when nothing is known.
 */
export function folderForMachine({ spaces: list = [], machine = null, home = null } = {}) {
  const mine = (list ?? []).filter((s) => (s?.machine ?? null) === (machine ?? null));
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const dir = String(mine[i]?.folder ?? "").trim();
    if (dir) return dir;
  }
  return String(home ?? "").trim() || null;
}

/**
 * The folders of the existing spaces on `machine`, newest first, without
 * `current`, capped at `limit` — one-click reuse under the folder field.
 */
export function recentFolders({ spaces: list = [], machine = null, current = "", limit = 4 } = {}) {
  const skip = String(current ?? "").trim();
  const seen = new Set();
  const out = [];
  const mine = (list ?? []).filter((s) => (s?.machine ?? null) === (machine ?? null));
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const dir = String(mine[i]?.folder ?? "").trim();
    if (!dir || dir === skip || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------- reading a folder

/** How many folders one listing reports before it says there are more. */
export const LIST_LIMIT = 500;

/**
 * The POSIX listing script, run as `sh -c LIST_DIRS_SCRIPT sh <folder> <limit>`:
 * the folder is a positional argument ($1), never part of the script text, so
 * a path with spaces, quotes or `;` cannot become shell code. Output is one
 * line per folder — `1<TAB>name` for a git repo, `0<TAB>name` otherwise — and
 * a final `!<TAB>` line when the folder holds more than `limit`. Hidden
 * folders are skipped (the glob only matches visible ones), and a folder that
 * cannot be read reports why on stderr (the `ls` line carries the system's
 * own reason).
 */
export const LIST_DIRS_SCRIPT = `p=$1
limit=$2
if [ ! -d "$p" ]; then
  printf '%s: no such folder\\n' "$p" >&2
  exit 2
fi
if ! ls -a "$p" >/dev/null 2>&1; then
  ls -a "$p" >/dev/null
  exit 3
fi
cd "$p" || exit 4
n=0
for d in */; do
  [ -d "$d" ] || continue
  d=\${d%/}
  if [ -e "$d/.git" ]; then
    printf '1\\t%s\\n' "$d"
  else
    printf '0\\t%s\\n' "$d"
  fi
  n=$((n + 1))
  if [ "$n" -ge "$limit" ]; then
    printf '!\\t\\n'
    break
  fi
done
exit 0`;

/** The `sh` argv that lists `folder` on any machine (see LIST_DIRS_SCRIPT). */
export function listDirsArgs(folder, limit = LIST_LIMIT) {
  return ["-c", LIST_DIRS_SCRIPT, "sh", String(folder ?? ""), String(limit)];
}

/**
 * The `cmd.exe` argv that lists `folder` with `dir /b /ad` — the fallback for
 * a Windows machine without `sh`. Null when the path holds a character cmd
 * would read as syntax (`& | < > ^ " %`): cmd re-parses its command line, so
 * such a path is reported as unreadable rather than risked.
 */
export function windowsDirArgs(folder) {
  const p = String(folder ?? "").trim();
  if (!p || /[&|<>^"%]/.test(p)) return null;
  return ["/c", "dir", "/b", "/ad", p];
}

/**
 * Parse a folder listing — LIST_DIRS_SCRIPT's output, or plain names from
 * `dir /b /ad` — into `{ dirs: [{ name, git }], truncated }`, sorted by name.
 * Hidden names are dropped, `!<TAB>` marks a capped listing, and a line with
 * no tab is a plain folder (the Windows form). Each name is the last path
 * segment only, so a caller joins it onto the folder it listed.
 */
export function parseFolderListing(text) {
  const dirs = [];
  let truncated = false;
  const seen = new Set();
  for (const raw of String(text ?? "").split("\n")) {
    // Only the line end is trimmed: a tab is data here (`!<TAB>` has no name).
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const flag = tab === -1 ? "0" : line.slice(0, tab);
    const name = tab === -1 ? line : line.slice(tab + 1);
    if (flag === "!") {
      truncated = true;
      continue;
    }
    if (!name || name === "." || name === ".." || name.startsWith(".")) continue;
    // A Windows `dir` can name the folder itself; only keep bare names.
    if (/[\\/]/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    dirs.push({ name, git: flag === "1" });
  }
  // Case-insensitive, so `alpha` and `Zeta` interleave the way a file list should.
  dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.name.localeCompare(b.name));
  return { dirs, truncated };
}

/** Keep the folders whose name contains `query` (case-insensitive). */
export function filterFolders(dirs, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return dirs ?? [];
  return (dirs ?? []).filter((d) => String(d?.name ?? "").toLowerCase().includes(q));
}

/**
 * What a typed folder field asks the browser to show: a folder to list and a
 * name filter. A trailing `/` means "show what is inside" (`~/code/`), so the
 * folder itself is listed; anything else lists its parent and filters by the
 * last segment, which is what makes typing narrow the list as you go. A
 * relative fragment keeps listing `current`. `home` resolves a leading `~`.
 */
export function browseTarget(value, home = null, current = null) {
  const typed = String(value ?? "").trim();
  if (!typed) return { path: String(current ?? expandHome("~", home) ?? ""), filter: "" };
  const expanded = expandHome(typed, home);
  const slashed = expanded.replace(/\\/g, "/");
  if (/\/$/.test(slashed)) return { path: slashed.replace(/\/+$/, "") || "/", filter: "" };
  const cut = slashed.lastIndexOf("/");
  if (cut === -1) return { path: String(current ?? ""), filter: slashed };
  const parent = slashed.slice(0, cut) || "/";
  return { path: parent, filter: slashed.slice(cut + 1) };
}

/** The folder above `path`; `/` and a drive root stay put. */
export function parentFolder(path) {
  const p = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!p || p === "/") return "/";
  if (/^[A-Za-z]:$/.test(p)) return `${p}/`;
  const cut = p.lastIndexOf("/");
  if (cut === 0) return "/";
  if (cut === -1) return p;
  const parent = p.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/** `folder` and `name` joined with one `/` (a drive root keeps its slash). */
export function childFolder(path, name) {
  const p = String(path ?? "").replace(/\\/g, "/");
  const n = String(name ?? "").trim();
  if (!n || n === "." || n === ".." || /[\\/]/.test(n)) return p;
  if (!p) return n;
  if (p === "/") return `/${n}`;
  return p.endsWith("/") ? p + n : `${p}/${n}`;
}

/** A folder without its trailing slash, but never "" — `/` and `C:/` stay. */
export function trimFolder(path) {
  const p = String(path ?? "").trim();
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  if (!trimmed) return "/";
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : trimmed;
}

/**
 * Why a shell command failed, from its stderr and exit code:
 * "missing" (no such folder), "denied" (not readable), "norepo" (git's own
 * answer) or "other". "unreachable" is not here: an `exec` rejection means
 * the machine or its shell could not be started at all, and the caller says so.
 */
export function classifyFailure({ stage = "list", stderr = "", code = 0 } = {}) {
  const s = String(stderr ?? "");
  if (/permission denied|not permitted|access is denied|not authorized/i.test(s)) return "denied";
  if (/not a git repository/i.test(s)) return "norepo";
  if (/no such file|does not exist|cannot access|not found|cannot find|can't cd|no such folder/i.test(s)) return "missing";
  if (code === 2) return "missing";
  return stage === "repo" && code === 128 ? "norepo" : "other";
}

/**
 * Why an `exec` call could not start at all (its rejection, not an exit code):
 * a folder that vanished under it, a permission, or a machine/shell that is
 * not there. Read from the rejection's text.
 */
export function classifyExecFailure(text) {
  const s = String(text ?? "");
  if (/permission denied|not permitted|access is denied|not authorized/i.test(s)) return "denied";
  if (/no such file|does not exist|cannot start folder|not found/i.test(s)) return "missing";
  return "unreachable";
}

/**
 * A sentence for a failed folder read, naming the machine and the system's
 * own reason: `Can't read /root on asus-book: Permission denied`. `machine`
 * null reads as this computer.
 */
export function failureMessage(kind, { path = "", machine = null, reason = "" } = {}) {
  const where = machine || "this computer";
  // The shell and git both lead with their own name for the folder we already
  // printed; keep the system's reason and drop the echo.
  const line = firstLine(reason)
    .replace(/^fatal:\s*/i, "")
    .replace(/^cannot start [^:]+:\s*/i, "")
    .replace(/^cannot change to '[^']*':\s*/, "")
    .replace(/\.$/, "");
  switch (kind) {
    case "missing": return `Folder ${path} doesn't exist on ${where}.`;
    case "denied": return `Can't read ${path} on ${where}: ${line || "permission denied"}.`;
    case "unreachable": return machine ? `Can't reach ${machine}.` : "Couldn't run a shell on this computer.";
    case "norepo": return "Not a git repository.";
    default:
      return line
        ? `Can't read ${path} on ${where}: ${line}.`
        : `Can't read ${path} on ${where}.`;
  }
}

/**
 * What pressing Enter should do, from the dialog's inputs:
 *  - "wait"            the repo probe is still running
 *  - "error"           the inputs cannot make a space (message in `error`)
 *  - "space"           open a space at `folder` (not a git repo, or none picked)
 *  - "open"            open the space already at the chosen checkout
 *  - "select"          the typed branch is checked out elsewhere: open that
 *  - "create-worktree" run `git worktree add` with `args`, then open `path`
 * `probe` is "pending" | "repo" | "none" | "error"; `worktree` is "new" or an
 * existing checkout path; `repoTop` is the primary checkout (for the path).
 * `folder` is already expanded (see `expandHome`): a `~` is not a folder.
 */
export function newSpacePlan({
  probe,
  folder,
  repoTop,
  worktree,
  checkouts = [],
  branch = "",
  localBranches = [],
  defaultBranch = null,
  home = "~",
  error = "",
} = {}) {
  if (probe === "pending") return { action: "wait" };
  if (probe === "error") {
    return { action: "error", error: String(error ?? "").trim() || "Couldn't check the folder for a git repository." };
  }
  if (probe !== "repo" || !repoTop) {
    const dir = String(folder ?? "").trim();
    return dir
      ? { action: "space", folder: dir }
      : { action: "error", error: "Type a folder." };
  }
  if (worktree && worktree !== "new") return { action: "open", folder: worktree };

  const wanted = String(branch ?? "").trim();
  if (!wanted) return { action: "error", error: "Type a branch name." };
  const elsewhere = checkouts.find((c) => c.branch === wanted);
  if (elsewhere) return { action: "select", folder: elsewhere.path, branch: wanted };

  const path = worktreePath(home, repoTop, wanted);
  if (localBranches.includes(wanted)) {
    return { action: "create-worktree", path, branch: wanted, createsBranch: false, args: ["worktree", "add", path, wanted] };
  }
  const base = defaultBranch || "HEAD";
  return {
    action: "create-worktree",
    path,
    branch: wanted,
    base,
    createsBranch: true,
    args: ["worktree", "add", "-b", wanted, path, base],
  };
}

/** The primary button's label for a plan. */
export function planLabel(plan) {
  switch (plan?.action) {
    case "wait": return "Checking…";
    case "select": return "Open that worktree";
    case "create-worktree": return "Create worktree & open";
    default: return "Open space";
  }
}

/**
 * The confirmation lines shown above the primary button for a plan, as plain
 * text (the view shortens paths with `tilde`).
 */
export function planLines(plan, home = "~") {
  switch (plan?.action) {
    case "create-worktree": {
      const lines = [`Create worktree at ${tilde(plan.path, home)}`];
      if (plan.createsBranch) lines.push(`Create branch ${plan.branch} from ${plan.base}`);
      else lines.push(`Check out existing branch ${plan.branch}`);
      return lines;
    }
    case "select": return [`Branch ${plan.branch} is already checked out in ${tilde(plan.folder, home)}`];
    default: return [];
  }
}
