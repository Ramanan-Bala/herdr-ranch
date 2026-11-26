import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWorktrees,
  repoInfo,
  tilde,
  expandHome,
  firstLine,
  newSpacePlan,
  planLabel,
  planLines,
  machineChoices,
  folderForMachine,
  recentFolders,
  LIST_DIRS_SCRIPT,
  LIST_LIMIT,
  listDirsArgs,
  windowsDirArgs,
  parseFolderListing,
  filterFolders,
  browseTarget,
  parentFolder,
  childFolder,
  trimFolder,
  classifyFailure,
  classifyExecFailure,
  failureMessage,
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

// ----------------------------------------------------- machineChoices

test("machineChoices puts this computer first, marks unavailable machines offline", () => {
  const list = machineChoices({
    machines: [
      { name: null, layout: "ready" },
      { name: "asus-book", layout: "ready" },
      { name: "work-pc", layout: "unavailable" },
    ],
  });
  assert.deepEqual(list.map((m) => m.name), [null, "asus-book", "work-pc"]);
  assert.equal(list[0].local, true);
  assert.equal(list[0].label, "This computer");
  assert.equal(list[1].label, "asus-book");
  assert.equal(list[1].disabled, false);
  assert.equal(list[1].hint, "");
  assert.equal(list[2].disabled, true);
  assert.equal(list[2].hint, "offline");
});

test("machineChoices always offers this computer and keeps an unknown current machine", () => {
  const list = machineChoices({ machines: [{ name: "asus-book", layout: "loading" }], current: "ghost" });
  assert.deepEqual(list.map((m) => m.name), ["ghost", null, "asus-book"]);
  assert.equal(list[1].local, true);
  assert.equal(list[2].hint, "connecting…");
  assert.equal(list[2].disabled, false);
  // No duplicate when the list and the current machine agree.
  assert.equal(machineChoices({ machines: [{ name: "asus-book", layout: "ready" }], current: "asus-book" }).length, 2);
});

// --------------------------------------------- folderForMachine / recents

const MACHINE_SPACES = [
  { machine: null, folder: "/Users/me/local-a" },
  { machine: "asus-book", folder: "/home/tbala/one" },
  { machine: "asus-book", folder: "/home/tbala/two" },
  { machine: null, folder: "/Users/me/local-b" },
];

test("folderForMachine picks the machine's newest space folder, else its home", () => {
  assert.equal(folderForMachine({ spaces: MACHINE_SPACES, machine: "asus-book", home: "/home/tbala" }), "/home/tbala/two");
  assert.equal(folderForMachine({ spaces: MACHINE_SPACES, machine: null, home: "/Users/me" }), "/Users/me/local-b");
  assert.equal(folderForMachine({ spaces: MACHINE_SPACES, machine: "other", home: "/home/other" }), "/home/other");
  assert.equal(folderForMachine({ spaces: [], machine: "asus-book", home: null }), null);
  // A space with no folder lives at that machine's home.
  assert.equal(folderForMachine({ spaces: [{ machine: "asus-book", folder: "" }], machine: "asus-book", home: "/home/tbala" }), "/home/tbala");
});

test("recentFolders lists a machine's other folders newest first, deduped, capped", () => {
  const recents = recentFolders({ spaces: MACHINE_SPACES, machine: "asus-book", current: "/home/tbala/two" });
  assert.deepEqual(recents, ["/home/tbala/one"]);
  const many = [1, 2, 3, 4, 5].map((n) => ({ machine: null, folder: `/w/${n}` }));
  assert.deepEqual(recentFolders({ spaces: many, machine: null, current: "/w/5" }), ["/w/4", "/w/3", "/w/2", "/w/1"]);
  assert.deepEqual(recentFolders({ spaces: many, machine: null, limit: 2 }), ["/w/5", "/w/4"]);
  assert.deepEqual(recentFolders({ spaces: MACHINE_SPACES, machine: "asus-book", current: "" }), ["/home/tbala/two", "/home/tbala/one"]);
});

// ------------------------------------------------ listing a folder

test("listDirsArgs passes the folder as a positional argument, never in the script", () => {
  const args = listDirsArgs("/home/tbala/a b; rm -rf ~");
  assert.equal(args[0], "-c");
  assert.equal(args[1], LIST_DIRS_SCRIPT);
  assert.equal(args[2], "sh");
  assert.equal(args[3], "/home/tbala/a b; rm -rf ~");
  assert.equal(args[4], String(LIST_LIMIT));
  assert.ok(!LIST_DIRS_SCRIPT.includes("/home/tbala"));
  // The script reads its folder from $1 and quotes it everywhere it is used.
  assert.ok(LIST_DIRS_SCRIPT.includes('p=$1'));
  assert.ok(LIST_DIRS_SCRIPT.includes('[ ! -d "$p" ]'));
});

test("parseFolderListing reads git markers, sorts, drops hidden names and notes a cap", () => {
  const text = ["0\tZeta", "1\talpha", "0\t.hidden", "0\t..", "", "0\tmid", "!\t"].join("\n");
  const out = parseFolderListing(text);
  assert.deepEqual(out.dirs, [
    { name: "alpha", git: true },
    { name: "mid", git: false },
    { name: "Zeta", git: false },
  ]);
  assert.equal(out.truncated, true);
});

test("parseFolderListing accepts plain names (cmd dir) and tolerates junk", () => {
  assert.deepEqual(parseFolderListing("Beta\r\nAlpha\r\n").dirs, [{ name: "Alpha", git: false }, { name: "Beta", git: false }]);
  assert.deepEqual(parseFolderListing("").dirs, []);
  assert.deepEqual(parseFolderListing(undefined), { dirs: [], truncated: false });
  // A path from a recursive listing is not a child name.
  assert.deepEqual(parseFolderListing("0\tC:\\Temp\\x").dirs, []);
});

test("windowsDirArgs quotes nothing it cannot make safe", () => {
  assert.deepEqual(windowsDirArgs("C:\\Users\\me"), ["/c", "dir", "/b", "/ad", "C:\\Users\\me"]);
  assert.equal(windowsDirArgs("C:\\a & del x"), null);
  assert.equal(windowsDirArgs("C:\\a|b"), null);
  assert.equal(windowsDirArgs(""), null);
});

test("filterFolders matches names case-insensitively", () => {
  const dirs = [{ name: "Projects", git: false }, { name: "notes", git: true }];
  assert.deepEqual(filterFolders(dirs, "pro").map((d) => d.name), ["Projects"]);
  assert.deepEqual(filterFolders(dirs, "  ").length, 2);
  assert.deepEqual(filterFolders(dirs, "zzz"), []);
});

// ------------------------------------------------- browsing paths

test("browseTarget lists a slashed path and otherwise filters by the last segment", () => {
  assert.deepEqual(browseTarget("/home/tbala/Projects/", "/home/tbala"), { path: "/home/tbala/Projects", filter: "" });
  assert.deepEqual(browseTarget("/home/tbala/Pro", "/home/tbala"), { path: "/home/tbala", filter: "Pro" });
  assert.deepEqual(browseTarget("~/code/", "/Users/me"), { path: "/Users/me/code", filter: "" });
  assert.deepEqual(browseTarget("~/code", "/Users/me"), { path: "/Users/me", filter: "code" });
  assert.deepEqual(browseTarget("/", "/Users/me"), { path: "/", filter: "" });
  // Nothing typed: the folder being browsed stays.
  assert.deepEqual(browseTarget("", "/home/tbala", "/home/tbala/Projects"), { path: "/home/tbala/Projects", filter: "" });
  assert.deepEqual(browseTarget("", "/home/tbala"), { path: "/home/tbala", filter: "" });
  // A bare fragment keeps the current folder and filters it.
  assert.deepEqual(browseTarget("Pro", "/home/tbala", "/home/tbala"), { path: "/home/tbala", filter: "Pro" });
});

test("parentFolder and childFolder walk a path on either slash", () => {
  assert.equal(parentFolder("/home/tbala/Projects"), "/home/tbala");
  assert.equal(parentFolder("/home"), "/");
  assert.equal(parentFolder("/"), "/");
  assert.equal(parentFolder(""), "/");
  assert.equal(parentFolder("/home/tbala/"), "/home");
  assert.equal(parentFolder("C:\\Users\\me"), "C:/Users");
  assert.equal(parentFolder("C:/"), "C:/");
  assert.equal(childFolder("/home/tbala", "Projects"), "/home/tbala/Projects");
  assert.equal(childFolder("/home/tbala/", "Projects"), "/home/tbala/Projects");
  assert.equal(childFolder("/", "home"), "/home");
  assert.equal(childFolder("C:/", "Users"), "C:/Users");
  assert.equal(childFolder("/home", ".."), "/home");
  assert.equal(childFolder("/home", "a/b"), "/home");
});

test("trimFolder drops a trailing slash but keeps a root meaningful", () => {
  assert.equal(trimFolder("/home/tbala/Projects/"), "/home/tbala/Projects");
  assert.equal(trimFolder("/"), "/");
  assert.equal(trimFolder("C:/"), "C:/");
  assert.equal(trimFolder(""), "");
});

// --------------------------------------------- failure classification

test("classifyFailure reads the shell's own reason", () => {
  assert.equal(classifyFailure({ stderr: "ls: cannot open directory '/root': Permission denied", code: 3 }), "denied");
  assert.equal(classifyFailure({ stderr: "Access is denied.", code: 1 }), "denied");
  assert.equal(classifyFailure({ stderr: "/x: no such folder", code: 2 }), "missing");
  assert.equal(classifyFailure({ stderr: "fatal: not a git repository (or any of the parent directories): .git", code: 128 }), "norepo");
  assert.equal(classifyFailure({ stage: "repo", code: 128 }), "norepo");
  assert.equal(classifyFailure({ stderr: "weird", code: 1 }), "other");
});

test("classifyExecFailure reads a rejection: vanished folder, permission, no shell", () => {
  assert.equal(classifyExecFailure("cannot start folder /Users/ramanan: No such file or directory (os error 2)"), "missing");
  assert.equal(classifyExecFailure("Permission denied (publickey)"), "denied");
  assert.equal(classifyExecFailure("machine asus-book is unreachable"), "unreachable");
  assert.equal(classifyExecFailure(""), "unreachable");
});

test("failureMessage names the machine, the folder and the reason", () => {
  assert.equal(
    failureMessage("denied", { path: "/root", machine: "asus-book", reason: "ls: cannot open directory '/root': Permission denied\nmore" }),
    "Can't read /root on asus-book: ls: cannot open directory '/root': Permission denied.",
  );
  assert.equal(failureMessage("missing", { path: "/x", machine: "asus-book" }), "Folder /x doesn't exist on asus-book.");
  assert.equal(failureMessage("missing", { path: "/x", machine: null }), "Folder /x doesn't exist on this computer.");
  assert.equal(failureMessage("unreachable", { machine: "asus-book" }), "Can't reach asus-book.");
  assert.equal(failureMessage("unreachable", { machine: null }), "Couldn't run a shell on this computer.");
  assert.equal(failureMessage("norepo", { path: "/x" }), "Not a git repository.");
  assert.equal(failureMessage("other", { path: "/x", machine: "m" }), "Can't read /x on m.");
  assert.equal(failureMessage("other", { path: "/x", machine: "m", reason: "boom" }), "Can't read /x on m: boom.");
  // git and the shell name the folder we already printed; the reason is kept.
  assert.equal(
    failureMessage("denied", { path: "/root", machine: "asus-book", reason: "fatal: cannot change to '/root': Permission denied" }),
    "Can't read /root on asus-book: Permission denied.",
  );
  assert.equal(
    failureMessage("denied", { path: "/root", machine: "asus-book", reason: "cannot start git: Permission denied (os error 13)" }),
    "Can't read /root on asus-book: Permission denied (os error 13).",
  );
});

test("newSpacePlan carries a specific probe error through", () => {
  assert.deepEqual(newSpacePlan({ probe: "error", error: "Can't reach asus-book." }), { action: "error", error: "Can't reach asus-book." });
  assert.match(newSpacePlan({ probe: "error" }).error, /git repository/);
});
