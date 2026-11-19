import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktrees,
  parseBranches,
  repoInfo,
  tilde,
  expandHome,
  firstLine,
  pickDefaultBranch,
  branchSuggestions,
  newSpacePlan,
  planLabel,
  planLines,
} from "../lib/newspace.js";

// ------------------------------------------------------- parseWorktrees

const PORCELAIN = `worktree /Users/me/repo
HEAD abc123
branch refs/heads/main

worktree /Users/me/.herdr/worktrees/repo/feat-x
HEAD def456
branch refs/heads/feat/x

worktree /Users/me/.herdr/worktrees/repo/detached
HEAD 999999
detached

worktree /tmp/prunable
HEAD aaa
prunable gitdir file points to non-existent location
`;

test("parseWorktrees reads paths, branches, flags and marks the main checkout", () => {
  const list = parseWorktrees(PORCELAIN);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { path: "/Users/me/repo", branch: "main", detached: false, bare: false, prunable: false, main: true });
  assert.deepEqual(list[1], { path: "/Users/me/.herdr/worktrees/repo/feat-x", branch: "feat/x", detached: false, bare: false, prunable: false, main: false });
  assert.equal(list[2].branch, null);
  assert.equal(list[2].detached, true);
  assert.equal(list[2].main, false);
  assert.equal(list[3].prunable, true);
  assert.equal(list[3].main, false);
});

test("parseWorktrees marks the first usable entry as main past a bare first entry", () => {
  const list = parseWorktrees("worktree /srv/repo.git\nbare\n\nworktree /Users/me/repo\nbranch refs/heads/main\n");
  assert.equal(list[0].bare, true);
  assert.equal(list[0].main, false);
  assert.equal(list[1].main, true);
});

test("parseWorktrees tolerates empty and junk input", () => {
  assert.deepEqual(parseWorktrees(""), []);
  assert.deepEqual(parseWorktrees(undefined), []);
  assert.deepEqual(parseWorktrees("\n\n"), []);
});

// ------------------------------------------------------ parseBranches

const REFS = [
  "refs/heads/main\t",
  "refs/heads/feat/x\t",
  "refs/remotes/origin/HEAD\trefs/remotes/origin/main",
  "refs/remotes/origin/main\t",
  "refs/remotes/origin/feat/x\t",
  "refs/remotes/upstream/only-here\t",
].join("\n");

test("parseBranches splits local/remote and derives the default from symref HEAD", () => {
  const b = parseBranches(REFS);
  assert.deepEqual(b.local, ["main", "feat/x"]);
  assert.deepEqual(b.remote, ["origin/main", "origin/feat/x", "upstream/only-here"]);
  assert.equal(b.default, "main");
});

test("parseBranches without a remote HEAD has no default", () => {
  assert.deepEqual(parseBranches("refs/heads/main\t\nrefs/remotes/origin/main\t"), {
    local: ["main"],
    remote: ["origin/main"],
    default: null,
  });
  assert.deepEqual(parseBranches(""), { local: [], remote: [], default: null });
});

// ---------------------------------------------------------- repoInfo

test("repoInfo strips /.git from the common dir and names the repo", () => {
  assert.deepEqual(repoInfo("/Users/me/ws/feat\n", "/Users/me/repo/.git\n"), {
    top: "/Users/me/ws/feat",
    main: "/Users/me/repo",
    name: "repo",
  });
  // A bare common dir is used as-is.
  assert.deepEqual(repoInfo("/srv/work", "/srv/repo.git"), { top: "/srv/work", main: "/srv/repo.git", name: "repo.git" });
});

test("repoInfo is null when either command failed", () => {
  assert.equal(repoInfo("", "/x/.git"), null);
  assert.equal(repoInfo("/x", ""), null);
  assert.equal(repoInfo(undefined, undefined), null);
});

// ------------------------------------------------------------- helpers

test("tilde shortens paths inside home, on either slash", () => {
  assert.equal(tilde("/Users/me/repo/x", "/Users/me"), "~/repo/x");
  assert.equal(tilde("/Users/me", "/Users/me"), "~");
  assert.equal(tilde("/Users/me", "/Users/me/"), "~");
  assert.equal(tilde("C:\\Users\\me\\repo", "C:\\Users\\me"), "~/repo");
  assert.equal(tilde("/other/x", "/Users/me"), "/other/x");
});

test("expandHome resolves a typed ~ against the machine's home", () => {
  assert.equal(expandHome("~", "/Users/me"), "/Users/me");
  assert.equal(expandHome("~/", "/Users/me"), "/Users/me");
  assert.equal(expandHome("~/code/repo", "/Users/me"), "/Users/me/code/repo");
  assert.equal(expandHome("  ~/code  ", "/Users/me/"), "/Users/me/code");
  assert.equal(expandHome("/abs/path", "/Users/me"), "/abs/path");
  assert.equal(expandHome("~someone/x", "/Users/me"), "~someone/x");
  // No home known: keep what was typed rather than make it relative to nothing.
  assert.equal(expandHome("~/code", null), "~/code");
  assert.equal(expandHome(undefined, "/Users/me"), "");
});

test("firstLine returns the first non-empty line", () => {
  assert.equal(firstLine("\n fatal: bad\nmore"), "fatal: bad");
  assert.equal(firstLine(""), "");
  assert.equal(firstLine(undefined), "");
});

test("pickDefaultBranch prefers the remote HEAD, then current, then main/master", () => {
  assert.equal(pickDefaultBranch({ default: "develop", local: ["main"] }, "main"), "develop");
  assert.equal(pickDefaultBranch({ default: null, local: ["main", "topic"] }, "topic"), "topic");
  assert.equal(pickDefaultBranch({ default: null, local: ["master"] }, "topic"), "master");
  assert.equal(pickDefaultBranch({ default: null, local: ["dev"] }, null), "dev");
  assert.equal(pickDefaultBranch({ default: null, local: [] }, "topic"), "topic");
  assert.equal(pickDefaultBranch(null, null), null);
});

test("branchSuggestions merges local + remote (prefix stripped), dedupes and filters", () => {
  const branches = parseBranches(REFS);
  assert.deepEqual(branchSuggestions(branches, ""), ["feat/x", "main", "only-here"]);
  assert.deepEqual(branchSuggestions(branches, "feat"), ["feat/x"]);
  assert.deepEqual(branchSuggestions(branches, "o"), ["only-here"]);
  assert.deepEqual(branchSuggestions(branches, "zzz"), []);
});

test("branchSuggestions ranks prefix matches before substring matches", () => {
  const branches = { local: ["feature", "my-feature"], remote: [] };
  assert.deepEqual(branchSuggestions(branches, "feat"), ["feature", "my-feature"]);
  assert.deepEqual(branchSuggestions(branches, "e"), ["feature", "my-feature"]);
});

// -------------------------------------------------------- newSpacePlan

const CHECKOUTS = parseWorktrees(PORCELAIN).filter((c) => !c.bare && !c.prunable);
const BASE = { probe: "repo", folder: "/Users/me/repo", repoTop: "/Users/me/repo", home: "/Users/me" };

test("newSpacePlan: pending and failed probes", () => {
  assert.equal(newSpacePlan({ probe: "pending" }).action, "wait");
  assert.equal(newSpacePlan({ probe: "error" }).action, "error");
});

test("newSpacePlan: a non-repo opens a plain space at the folder", () => {
  assert.deepEqual(newSpacePlan({ probe: "none", folder: "/tmp/notes" }), { action: "space", folder: "/tmp/notes" });
  assert.equal(newSpacePlan({ probe: "none", folder: "  " }).action, "error");
});

test("newSpacePlan: an existing checkout is opened as-is", () => {
  assert.deepEqual(newSpacePlan({ ...BASE, worktree: "/Users/me/repo", branch: "main" }), { action: "open", folder: "/Users/me/repo" });
});

test("newSpacePlan: a new worktree on a brand-new branch creates it from the base", () => {
  const plan = newSpacePlan({
    ...BASE,
    worktree: "new",
    branch: "feat/new",
    localBranches: ["main"],
    defaultBranch: "main",
    checkouts: CHECKOUTS,
  });
  assert.deepEqual(plan, {
    action: "create-worktree",
    path: "/Users/me/.herdr/worktrees/repo/feat-new",
    branch: "feat/new",
    base: "main",
    createsBranch: true,
    args: ["worktree", "add", "-b", "feat/new", "/Users/me/.herdr/worktrees/repo/feat-new", "main"],
  });
});

test("newSpacePlan: a new worktree on an existing local branch checks it out", () => {
  const plan = newSpacePlan({
    ...BASE,
    worktree: "new",
    branch: "topic",
    localBranches: ["main", "topic"],
    defaultBranch: "main",
    checkouts: CHECKOUTS,
  });
  assert.equal(plan.action, "create-worktree");
  assert.equal(plan.createsBranch, false);
  assert.deepEqual(plan.args, ["worktree", "add", "/Users/me/.herdr/worktrees/repo/topic", "topic"]);
});

test("newSpacePlan: a branch checked out elsewhere selects that checkout", () => {
  const plan = newSpacePlan({ ...BASE, worktree: "new", branch: "feat/x", localBranches: ["main", "feat/x"], checkouts: CHECKOUTS });
  assert.deepEqual(plan, { action: "select", folder: "/Users/me/.herdr/worktrees/repo/feat-x", branch: "feat/x" });
});

test("newSpacePlan: an empty branch asks for one, and HEAD is the no-default base", () => {
  assert.match(newSpacePlan({ ...BASE, worktree: "new", branch: "  " }).error, /branch name/);
  const plan = newSpacePlan({ ...BASE, worktree: "new", branch: "wip", defaultBranch: null });
  assert.equal(plan.base, "HEAD");
  assert.deepEqual(plan.args, ["worktree", "add", "-b", "wip", "/Users/me/.herdr/worktrees/repo/wip", "HEAD"]);
});

// ------------------------------------------------------- plan label/notes

test("planLabel names the primary action", () => {
  assert.equal(planLabel({ action: "space" }), "Open space");
  assert.equal(planLabel({ action: "open" }), "Open space");
  assert.equal(planLabel({ action: "select" }), "Open that worktree");
  assert.equal(planLabel({ action: "create-worktree" }), "Create worktree & open");
  assert.equal(planLabel({ action: "wait" }), "Checking…");
});

test("planLines confirms what will be created", () => {
  const create = planLines({ action: "create-worktree", path: "/Users/me/.herdr/worktrees/repo/feat", branch: "feat", base: "main", createsBranch: true }, "/Users/me");
  assert.deepEqual(create, ["Create worktree at ~/.herdr/worktrees/repo/feat", "Create branch feat from main"]);
  const existing = planLines({ action: "create-worktree", path: "/Users/me/.herdr/worktrees/repo/feat", branch: "feat", createsBranch: false }, "/Users/me");
  assert.deepEqual(existing, ["Create worktree at ~/.herdr/worktrees/repo/feat", "Check out existing branch feat"]);
  assert.match(planLines({ action: "select", branch: "feat/x", folder: "/Users/me/ws" }, "/Users/me")[0], /already checked out/);
  assert.deepEqual(planLines({ action: "space" }), []);
});
