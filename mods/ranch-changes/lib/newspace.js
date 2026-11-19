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
} = {}) {
  if (probe === "pending") return { action: "wait" };
  if (probe === "error") return { action: "error", error: "Couldn't check the folder for a git repository." };
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
