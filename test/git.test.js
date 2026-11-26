import test from "node:test";
import assert from "node:assert/strict";
import {
  parseShortstat,
  parseNumstat,
  parseNumstatZ,
  numstatTotals,
  LOG_FORMAT,
  parseLog,
  parseAheadBehind,
  parseStatusBranch,
  webHost,
  links,
  defaultBranch,
  defaultRef,
  repoSnapshot,
  repoSummary,
  repoDetails,
  parsePr,
  runGh,
  createTtlCache,
  createLimiter,
} from "../lib/git.js";

/**
 * Fake git: maps `args.join(" ")` to canned results.
 * @param {Record<string, string|{code:number, stdout:string}>} canned
 */
function fakeGit(canned) {
  return async (args) => {
    const hit = canned[args.join(" ")];
    if (hit === undefined) return { code: 1, stdout: "", stderr: "" };
    if (typeof hit === "string") return { code: 0, stdout: hit, stderr: "" };
    return { code: hit.code, stdout: hit.stdout, stderr: "" };
  };
}

test("parseShortstat", () => {
  assert.deepEqual(
    parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)"),
    { files: 3, add: 10, del: 2 },
  );
  assert.deepEqual(parseShortstat("1 file changed, 1 insertion(+)"), {
    files: 1,
    add: 1,
    del: 0,
  });
  assert.deepEqual(parseShortstat("1 file changed, 4 deletions(-)"), {
    files: 1,
    add: 0,
    del: 4,
  });
  assert.deepEqual(parseShortstat(""), { files: 0, add: 0, del: 0 });
});

test("parseNumstat", () => {
  const text = [
    "10\t2\tsrc/a.js",
    "-\t-\tassets/logo.png",
    "3\t0\told.js => new.js",
    "1\t1\tdir/{old => new}/f.js",
    "",
  ].join("\n");
  assert.deepEqual(parseNumstat(text), [
    { path: "src/a.js", add: 10, del: 2 },
    { path: "assets/logo.png", add: null, del: null },
    { path: "new.js", add: 3, del: 0 },
    { path: "dir/new/f.js", add: 1, del: 1 },
  ]);
  assert.deepEqual(parseNumstat(""), []);
});

test("parseLog", () => {
  const US = "\x1f";
  const RS = "\x1e";
  const text = [
    `abc123${US}abc1234${US}Fix thing${US}Ann${US}1700000000${RS}`,
    `def456${US}def4567${US}Add thing${US}Bob${US}1700000100${RS}`,
    "",
  ].join("\n");
  assert.deepEqual(parseLog(text), [
    {
      sha: "abc123",
      short: "abc1234",
      subject: "Fix thing",
      author: "Ann",
      time: 1_700_000_000_000,
    },
    {
      sha: "def456",
      short: "def4567",
      subject: "Add thing",
      author: "Bob",
      time: 1_700_000_100_000,
    },
  ]);
  assert.deepEqual(parseLog("  \n  "), []);
  assert.match(LOG_FORMAT, /%x1f.*%x1e/);
});

test("parseAheadBehind", () => {
  assert.deepEqual(parseAheadBehind("2\t5\n"), { ahead: 2, behind: 5 });
  assert.deepEqual(parseAheadBehind("0\t0"), { ahead: 0, behind: 0 });
  assert.equal(parseAheadBehind("garbage"), null);
  assert.equal(parseAheadBehind(""), null);
  assert.equal(parseAheadBehind("2\t5\t9"), null);
});

test("webHost", () => {
  assert.deepEqual(webHost("git@github.com:o/r.git"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("ssh://git@github.com/o/r.git"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("ssh://git@gitlab.example:2222/o/r"), {
    kind: "gitlab",
    base: "https://gitlab.example/o/r",
  });
  assert.deepEqual(webHost("ssh://git@host.example:2222/o/r"), null);
  assert.deepEqual(webHost("https://github.com/o/r"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("https://github.com/o/r.git"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("https://user@gitlab.com/group/sub/r.git"), {
    kind: "gitlab",
    base: "https://gitlab.com/group/sub/r",
  });
  assert.deepEqual(webHost("git@gitlab.example.com:grp/r.git"), {
    kind: "gitlab",
    base: "https://gitlab.example.com/grp/r",
  });
  assert.equal(webHost("git@example.com:o/r.git"), null);
  assert.equal(webHost(""), null);
});

test("links", () => {
  const gh = links({ kind: "github", base: "https://github.com/o/r" });
  assert.equal(gh.branch("feature/x"), "https://github.com/o/r/tree/feature/x");
  assert.equal(gh.branch("a b"), "https://github.com/o/r/tree/a%20b");
  assert.equal(gh.commit("abc123"), "https://github.com/o/r/commit/abc123");
  assert.equal(
    gh.compare("main", "feature"),
    "https://github.com/o/r/compare/main...feature?expand=1",
  );
  assert.equal(gh.pr(7), "https://github.com/o/r/pull/7");

  const gl = links({ kind: "gitlab", base: "https://gitlab.com/g/r" });
  assert.equal(gl.branch("feature/x"), "https://gitlab.com/g/r/-/tree/feature/x");
  assert.equal(gl.commit("abc123"), "https://gitlab.com/g/r/-/commit/abc123");
  assert.equal(
    gl.compare("main", "feature"),
    "https://gitlab.com/g/r/-/compare/main...feature",
  );
  assert.equal(gl.pr(7), "https://gitlab.com/g/r/-/merge_requests/7");
});

test("defaultBranch", async () => {
  assert.equal(
    await defaultBranch(
      fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n" }),
    ),
    "trunk",
  );
  assert.equal(
    await defaultBranch(fakeGit({ "rev-parse --verify --quiet refs/heads/main": "\n" })),
    "main",
  );
  assert.equal(
    await defaultBranch(
      fakeGit({ "rev-parse --verify --quiet refs/heads/master": "\n" }),
    ),
    "master",
  );
  assert.equal(await defaultBranch(fakeGit({})), null);
});

test("repoSummary", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir":
      "/home/me/ranch\n/home/me/ranch/.git\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head feature/x\n# branch.upstream origin/feature/x\n# branch.ab +2 -5\n1 .M N... 000000 100644 100644 000 a src/a.js\n",
    "for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master":
      "refs/remotes/origin/HEAD\trefs/remotes/origin/main\nrefs/remotes/origin/main\t\n",
    "merge-base HEAD origin/main": "base000\n",
    "rev-list --left-right --count HEAD...origin/main": "12\t3\n",
    "diff --numstat -z base000": "5\t1\ta.js\u00000\t0\tb.js\u0000",
    "remote get-url origin": "git@github.com:o/ranch.git\n",
  });
  assert.deepEqual(await repoSummary(git), {
    top: "/home/me/ranch",
    branch: "feature/x",
    detached: false,
    head: "abc1234",
    default: "main",
    base: "base000",
    vsDefault: { ahead: 12, behind: 3, ref: "origin/main" },
    stat: { files: 2, add: 5, del: 1 },
    ahead: 2,
    behind: 5,
    host: { kind: "github", base: "https://github.com/o/ranch" },
    common: "/home/me/ranch/.git",
    linked: false,
  });
});

test("repoSummary detached, no upstream, no origin", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/repo\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head (detached)\n",
  });
  assert.deepEqual(await repoSummary(git), {
    top: "/repo",
    branch: null,
    detached: true,
    head: "abc1234",
    default: null,
    base: null,
    vsDefault: null,
    stat: null,
    ahead: null,
    behind: null,
    host: null,
    common: null,
    linked: false,
  });
});

test("repoSummary marks a linked worktree", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/r/wt\n/r/main/.git\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head feature/y\n",
  });
  const s = await repoSummary(git);
  assert.equal(s.top, "/r/wt");
  assert.equal(s.common, "/r/main/.git");
  assert.equal(s.linked, true);
});

test("repoSummary keeps linked false when the common-dir command fails", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/repo\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head work\n",
  });
  const s = await repoSummary(git);
  assert.equal(s.common, null);
  assert.equal(s.linked, false);
});

test("repoSummary falls back to the local default branch", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/repo\n/repo/.git\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head work\n",
    "for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master":
      "refs/heads/main\t\n",
    "merge-base HEAD main": "b1\n",
    "rev-list --left-right --count HEAD...main": "4\t0\n",
    "diff --numstat -z b1": "",
  });
  const s = await repoSummary(git);
  assert.equal(s.base, "b1");
  assert.deepEqual(s.vsDefault, { ahead: 4, behind: 0, ref: "main" });
  assert.deepEqual(s.stat, { files: 0, add: 0, del: 0 });
});

test("helpers never throw when the runner rejects", async () => {
  const boom = async () => { throw new Error("timeout"); };
  assert.equal(await repoSummary(boom), null);
  assert.equal(await defaultBranch(boom), null);
  assert.deepEqual(await repoDetails(boom, "b"), { files: [], commits: [] });
  assert.equal(await defaultRef(boom, "main"), null);
});

test("repoSummary null outside a repo", async () => {
  assert.equal(await repoSummary(fakeGit({})), null);
});

test("repoDetails with base", async () => {
  const git = fakeGit({
    "diff --numstat -z base000": "3\t1\tsrc/a.js\u0000-\t-\timg.png\u0000",
    "log -n 2 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e":
      "abc\x1fabc1\x1fFix\x1fAnn\x1f1700000000\x1e\n",
  });
  const details = await repoDetails(git, "base000", { commits: 2 });
  assert.deepEqual(details.files, [
    { path: "src/a.js", add: 3, del: 1 },
    { path: "img.png", add: null, del: null },
  ]);
  assert.equal(details.commits.length, 1);
  assert.equal(details.commits[0].subject, "Fix");
});

test("repoDetails without base", async () => {
  const git = fakeGit({
    "log -n 5 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e":
      "abc\x1fabc1\x1fFix\x1fAnn\x1f1700000000\x1e\n",
  });
  const details = await repoDetails(git, null);
  assert.deepEqual(details.files, []);
  assert.equal(details.commits.length, 1);
  assert.equal(details.commits[0].author, "Ann");
});

test("parsePr", () => {
  assert.equal(parsePr(null), null);
  assert.equal(parsePr("nope"), null);
  const pr = parsePr({
      number: 7,
      title: "Fix thing",
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: true,
      reviewDecision: "APPROVED",
      statusCheckRollup: [
        { conclusion: "SUCCESS" },
        { conclusion: "NEUTRAL" },
        { conclusion: "SKIPPED" },
        { conclusion: "FAILURE" },
        { conclusion: "TIMED_OUT" },
        { conclusion: "CANCELLED" },
        { conclusion: "ACTION_REQUIRED" },
        { conclusion: "STARTUP_FAILURE" },
        { conclusion: null, state: "PENDING" },
        { conclusion: null, state: "QUEUED" },
        { conclusion: null, state: "IN_PROGRESS" },
        { conclusion: null, state: "EXPECTED" },
        { conclusion: null, state: "SUCCESS" },
        { conclusion: null, state: "FAILURE" },
        { conclusion: null, state: "ERROR" },
        {},
      ],
    });
  assert.equal(pr.number, 7);
  assert.equal(pr.state, "draft");
  assert.equal(pr.review, "approved");
  assert.deepEqual(pr.checks, { pass: 2, fail: 7, pending: 5, skipped: 2 });
  assert.equal(pr.checkList.length, 16);
  assert.equal(pr.checkList[0].state, "fail");
  assert.equal(pr.checkList.at(-1).state, "skipped");
  assert.equal(parsePr({ state: "MERGED", isDraft: false }).state, "merged");
  assert.equal(parsePr({ state: "CLOSED", isDraft: false }).state, "closed");
  assert.equal(parsePr({ state: "OPEN", isDraft: false }).state, "open");
  assert.equal(parsePr({}).review, null);
  assert.equal(parsePr({}).state, null);
});

test("createTtlCache", () => {
  const cache = createTtlCache(100);
  cache.set("k", "v", 1000);
  assert.equal(cache.get("k", 1050), "v");
  assert.equal(cache.get("k", 1100), "v");
  assert.equal(cache.get("k", 1101), undefined);
  assert.equal(cache.get("missing", 1101), undefined);
  cache.set("k2", "v2", 1000);
  cache.delete("k2");
  assert.equal(cache.get("k2", 1001), undefined);
});

test("parsePr detail fields", () => {
  const pr = parsePr({
    number: 1285, title: "fix", state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED",
    author: { login: "sergei", name: "Sergei T" }, baseRefName: "master",
    updatedAt: "2026-11-11T07:00:00Z", mergeStateStatus: "BEHIND",
    reviewRequests: [{ login: "a" }, { name: "Team B" }, {}],
    statusCheckRollup: [{ name: "Lint", workflowName: "pr-check", conclusion: "SUCCESS", detailsUrl: "u" }],
  });
  assert.equal(pr.author, "Sergei T");
  assert.equal(pr.base, "master");
  assert.equal(pr.updatedAt, Date.parse("2026-11-11T07:00:00Z"));
  assert.equal(pr.behind, true);
  assert.deepEqual(pr.reviewers, ["a", "Team B"]);
  assert.deepEqual(pr.checkList, [{ name: "Lint", workflow: "pr-check", state: "pass", url: "u" }]);
});

test("runGh falls back through candidate paths", async () => {
  const tried = [];
  const run = async (cmd) => {
    tried.push(cmd);
    if (cmd === "gh") throw new Error("not found");
    if (cmd === "/opt/homebrew/bin/gh") return { code: 0, stdout: "ok", stderr: "" };
    return { code: 127, stdout: "", stderr: "" };
  };
  const r = await runGh(run, ["--version"]);
  assert.equal(r.stdout, "ok");
  assert.equal(r.missing, false);
  assert.deepEqual(tried, ["gh", "/opt/homebrew/bin/gh"]);
  const none = await runGh(async () => { throw new Error("x"); }, []);
  assert.equal(none.missing, true);
});

test("parsePr lists who approved from latestReviews", async () => {
  const { parsePr } = await import("../lib/git.js");
  const pr = parsePr({
    number: 7, state: "OPEN",
    latestReviews: [
      { author: { login: "ana" }, state: "APPROVED" },
      { author: { login: "bo" }, state: "CHANGES_REQUESTED" },
      { author: { login: "ana" }, state: "APPROVED" },
    ],
  });
  assert.deepEqual(pr.approvedBy, ["ana"]);
  assert.deepEqual(parsePr({ number: 8, state: "OPEN" }).approvedBy, []);
});

const NUL = "\0";

test("parseNumstatZ", () => {
  assert.deepEqual(parseNumstatZ(`10\t2\tsrc/a.js${NUL}`), [
    { path: "src/a.js", add: 10, del: 2 },
  ]);
  assert.deepEqual(parseNumstatZ(`3\t0\t${NUL}old.txt${NUL}new.txt${NUL}`), [
    { path: "new.txt", add: 3, del: 0 },
  ]);
  assert.deepEqual(parseNumstatZ(`1\t1\ta weird => name.txt${NUL}`), [
    { path: "a weird => name.txt", add: 1, del: 1 },
  ]);
  assert.deepEqual(parseNumstatZ(`2\t3\tdir/naïve "x"\ty\nz.txt${NUL}`), [
    { path: `dir/naïve "x"\ty\nz.txt`, add: 2, del: 3 },
  ]);
  assert.deepEqual(parseNumstatZ(`4\t0\t${NUL}old => file${NUL}new => file${NUL}`), [
    { path: "new => file", add: 4, del: 0 },
  ]);
  assert.deepEqual(parseNumstatZ(`-\t-\tassets/logo.png${NUL}`), [
    { path: "assets/logo.png", add: null, del: null },
  ]);
  assert.deepEqual(parseNumstatZ(""), []);
  assert.deepEqual(
    parseNumstatZ(`1\t2\ta.js${NUL}4\t0\t${NUL}o${NUL}n${NUL}-\t-\tb.png${NUL}`),
    [
      { path: "a.js", add: 1, del: 2 },
      { path: "n", add: 4, del: 0 },
      { path: "b.png", add: null, del: null },
    ],
  );
});

test("numstatTotals", () => {
  assert.deepEqual(numstatTotals([]), { files: 0, add: 0, del: 0 });
  assert.deepEqual(
    numstatTotals([
      { path: "a", add: 3, del: 1 },
      { path: "b", add: null, del: null },
      { path: "c", add: 2, del: 4 },
    ]),
    { files: 3, add: 5, del: 5 },
  );
  assert.deepEqual(
    numstatTotals(parseNumstatZ(`5\t0\ta.js${NUL}-\t-\tb.png${NUL}`)),
    { files: 2, add: 5, del: 0 },
  );
});

test("webHost classifies the exact hostname", () => {
  assert.equal(webHost("https://github.com.example.test/o/r"), null);
  assert.equal(webHost("git@github.com.evil.test:o/r.git"), null);
  assert.equal(webHost("https://evilgithub.com/o/r"), null);
  assert.equal(webHost("https://github.com:443.evil.test/o/r"), null);
  assert.deepEqual(webHost("git@ssh.github.com:o/r.git"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("https://GitHub.com/o/r"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  assert.deepEqual(webHost("ssh://git@www.github.com/o/r"), {
    kind: "github",
    base: "https://github.com/o/r",
  });
  // gitlab self-hosted cases still classify
  assert.deepEqual(webHost("git@gitlab.example.com:grp/r.git"), {
    kind: "gitlab",
    base: "https://gitlab.example.com/grp/r",
  });
  assert.deepEqual(webHost("https://user@gitlab.com/group/sub/r.git"), {
    kind: "gitlab",
    base: "https://gitlab.com/group/sub/r",
  });
});

test("links encodes compare refs", () => {
  const gh = links({ kind: "github", base: "https://github.com/o/r" });
  assert.equal(
    gh.compare("a#b", "c d"),
    "https://github.com/o/r/compare/a%23b...c%20d?expand=1",
  );
  assert.equal(
    gh.compare("x?y", "z%w"),
    "https://github.com/o/r/compare/x%3Fy...z%25w?expand=1",
  );
  assert.equal(
    gh.compare("a+b", "c/d"),
    "https://github.com/o/r/compare/a%2Bb...c/d?expand=1",
  );
  const gl = links({ kind: "gitlab", base: "https://gitlab.com/g/r" });
  assert.equal(
    gl.compare("a#b", "c d"),
    "https://gitlab.com/g/r/-/compare/a%23b...c%20d",
  );
  assert.equal(
    gl.compare("x?y", "z%w"),
    "https://gitlab.com/g/r/-/compare/x%3Fy...z%25w",
  );
});

test("defaultBranch prefers the remote ref", async () => {
  assert.equal(
    await defaultBranch(
      fakeGit({ "rev-parse --verify --quiet refs/remotes/origin/master": "\n" }),
    ),
    "master",
  );
  assert.equal(
    await defaultRef(
      fakeGit({ "rev-parse --verify --quiet refs/remotes/origin/master": "\n" }),
      "master",
    ),
    "origin/master",
  );
  assert.equal(
    await defaultBranch(
      fakeGit({ "rev-parse --verify --quiet refs/heads/main": "\n" }),
    ),
    "main",
  );
  assert.equal(
    await defaultBranch(
      fakeGit({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/trunk\n" }),
    ),
    "trunk",
  );
  assert.equal(await defaultBranch(fakeGit({})), null);
});

test("parseStatusBranch", () => {
  const normal = [
    "# branch.oid 0123456789abcdef",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -5",
    "1 .M N... 000000 100644 100644 000 abc src/a.js",
    "2 .R N... old\tnew.txt",
  ].join("\n");
  assert.deepEqual(parseStatusBranch(normal), {
    oid: "0123456789abcdef",
    branch: "feature/x",
    detached: false,
    upstream: "origin/feature/x",
    ahead: 2,
    behind: 5,
  });
  assert.deepEqual(parseStatusBranch("# branch.oid abcdef0123456\n# branch.head (detached)\n"), {
    oid: "abcdef0123456",
    branch: null,
    detached: true,
    upstream: null,
    ahead: null,
    behind: null,
  });
  assert.deepEqual(parseStatusBranch("# branch.oid (initial)\n# branch.head new-branch\n"), {
    oid: null,
    branch: "new-branch",
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
  });
  assert.deepEqual(
    parseStatusBranch("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n"),
    {
      oid: "abc",
      branch: "main",
      detached: false,
      upstream: "origin/main",
      ahead: null,
      behind: null,
    },
  );
  assert.deepEqual(parseStatusBranch(""), {
    oid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
  });
});

/** fakeGit with a 5ms timer, a call log and a concurrency counter. */
function timedGit(canned) {
  const calls = [];
  const stats = { active: 0, max: 0 };
  const git = async (args) => {
    calls.push(args.join(" "));
    stats.active += 1;
    stats.max = Math.max(stats.max, stats.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    stats.active -= 1;
    const hit = canned[args.join(" ")];
    if (hit === undefined) return { code: 1, stdout: "", stderr: "" };
    if (typeof hit === "string") return { code: 0, stdout: hit, stderr: "" };
    return { code: hit.code, stdout: hit.stdout ?? "", stderr: "" };
  };
  git.calls = calls;
  git.stats = stats;
  return git;
}

const SNAP = {
  "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/t\n/t/.git\n",
  "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
    "# branch.oid abc1234abcdef\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n",
  "for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master":
    "refs/remotes/origin/HEAD\trefs/remotes/origin/main\nrefs/remotes/origin/main\t\n",
  "remote get-url origin": "git@github.com:o/r.git\n",
  "merge-base HEAD origin/main": "b0\n",
  "rev-list --left-right --count HEAD...origin/main": "1\t2\n",
  "diff --numstat -z b0": "3\t1\ta.js\0-\t-\tb.png\0",
  "log -n 5 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e":
    "abc\x1fabc1\x1fFix\x1fAnn\x1f1700000000\x1e\n",
};

test("repoSnapshot call counts and concurrency", async () => {
  const git = timedGit(SNAP);
  const meta = createTtlCache(10_000);
  const cold = await repoSnapshot(git, { meta, metaKey: "k", now: 100 });
  assert.equal(cold.status, "ok");
  assert.equal(git.calls.length, 8);
  assert.ok(git.stats.max <= 4, `cold max concurrency ${git.stats.max}`);
  assert.deepEqual(cold.summary, {
    top: "/t",
    branch: "main",
    detached: false,
    head: "abc1234",
    default: "main",
    base: "b0",
    vsDefault: { ahead: 1, behind: 2, ref: "origin/main" },
    stat: { files: 2, add: 3, del: 1 },
    ahead: 1,
    behind: 2,
    host: { kind: "github", base: "https://github.com/o/r" },
    common: "/t/.git",
    linked: false,
  });
  assert.deepEqual(cold.details, {
    files: [
      { path: "a.js", add: 3, del: 1 },
      { path: "b.png", add: null, del: null },
    ],
    commits: [{ sha: "abc", short: "abc1", subject: "Fix", author: "Ann", time: 1_700_000_000_000 }],
  });
  // stat equals the totals of the numstat rows
  assert.deepEqual(
    cold.details.files,
    parseNumstatZ(SNAP["diff --numstat -z b0"]),
  );
  assert.deepEqual(cold.summary.stat, numstatTotals(cold.details.files));

  const warm = await repoSnapshot(git, { meta, metaKey: "k", now: 200 });
  assert.equal(warm.status, "ok");
  assert.equal(git.calls.length, 14);
  assert.ok(git.stats.max <= 4, `warm max concurrency ${git.stats.max}`);
  // warm read skips the for-each-ref and remote calls (cache hit)
  assert.equal(
    git.calls.slice(8).filter((c) => c.startsWith("for-each-ref") || c.startsWith("remote get-url")).length,
    0,
  );
  assert.deepEqual(warm.summary, cold.summary);
  assert.deepEqual(warm.details, cold.details);
});

test("repoSnapshot not-repo", async () => {
  const git = timedGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": {
      code: 128,
      stdout: "fatal: not a git repository\n",
    },
  });
  assert.deepEqual(await repoSnapshot(git), { status: "not-repo", summary: null, details: null });
  assert.equal(git.calls.length, 2);
});

test("repoSnapshot failed when the runner rejects", async () => {
  const boom = async () => { throw new Error("timeout"); };
  assert.deepEqual(await repoSnapshot(boom), { status: "failed", summary: null, details: null });
});

test("repoSnapshot detached", async () => {
  const git = timedGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/t\n/t/.git\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid abc1234abcdef\n# branch.head (detached)\n",
    "log -n 5 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e": "",
  });
  const r = await repoSnapshot(git);
  assert.equal(r.status, "ok");
  assert.equal(r.summary.branch, null);
  assert.equal(r.summary.detached, true);
  assert.equal(r.summary.head, "abc1234");
  assert.equal(r.summary.ahead, null);
  assert.equal(r.summary.behind, null);
  assert.equal(r.summary.default, null);
  assert.equal(r.summary.base, null);
  assert.deepEqual(r.details, { files: [], commits: [] });
});

test("repoSnapshot unborn repo with no commits", async () => {
  const git = timedGit({
    "rev-parse --show-toplevel --path-format=absolute --git-common-dir": "/u\n/u/.git\n",
    "--no-optional-locks status --porcelain=v2 --branch --untracked-files=no":
      "# branch.oid (initial)\n# branch.head main\n",
    "for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master":
      "refs/heads/main\t\n",
    "merge-base HEAD main": "",
    "log -n 5 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e": "",
  });
  const r = await repoSnapshot(git);
  assert.equal(r.status, "ok");
  assert.equal(r.summary.head, null);
  assert.equal(r.summary.branch, "main");
  assert.equal(r.summary.ahead, null);
  assert.equal(r.summary.behind, null);
  assert.deepEqual(r.summary.stat, null);
  assert.deepEqual(r.details, { files: [], commits: [] });
});

test("repoSnapshot details false skips the log", async () => {
  const git = timedGit(SNAP);
  const r = await repoSnapshot(git, { details: false });
  assert.equal(r.status, "ok");
  assert.equal(r.details, null);
  assert.equal(r.summary.branch, "main");
  assert.equal(
    git.calls.some((c) => c.startsWith("log ")),
    false,
  );
});

test("repoSnapshot does not cache a failed for-each-ref", async () => {
  const canned = { ...SNAP };
  delete canned["for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master"];
  const git = timedGit(canned);
  const meta = createTtlCache(10_000);
  const first = await repoSnapshot(git, { meta, metaKey: "k", now: 100 });
  const second = await repoSnapshot(git, { meta, metaKey: "k", now: 200 });
  assert.equal(first.summary.default, null);
  assert.equal(second.summary.default, null);
  assert.equal(
    git.calls.filter((c) => c.startsWith("for-each-ref")).length,
    2,
  );
});

test("createTtlCache prunes expired entries", () => {
  const cache = createTtlCache(100);
  cache.set("a", 1, 1000);
  assert.equal(cache.get("a", 1101), undefined);
  assert.equal(cache.size, 0);

  const big = createTtlCache(100);
  for (let i = 0; i < 1000; i++) big.set(`k${i}`, i, 1000);
  assert.equal(big.size, 1000);
  assert.equal(big.prune(1101), 1000);
  assert.equal(big.size, 0);
});

test("createTtlCache max evicts the oldest entry", () => {
  const cache = createTtlCache(1000, { max: 3 });
  cache.set("a", 1, 1000);
  cache.set("b", 2, 1000);
  cache.set("c", 3, 1000);
  assert.equal(cache.size, 3);
  cache.set("d", 4, 1000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a", 1001), undefined);
  assert.equal(cache.get("d", 1001), 4);
  // setting an existing key refreshes its order
  cache.set("b", 5, 1000);
  cache.set("e", 6, 1000);
  assert.equal(cache.size, 3);
  assert.equal(cache.get("c", 1001), undefined);
  assert.equal(cache.get("b", 1001), 5);
  assert.equal(cache.get("e", 1001), 6);
});

test("createLimiter limits concurrency", async () => {
  const limiter = createLimiter(2);
  let running = 0;
  let maxRunning = 0;
  const job = async (n) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return n;
  };
  const results = await Promise.all([
    limiter.run(() => job(1)),
    limiter.run(() => job(2)),
    limiter.run(() => job(3)),
    limiter.run(() => job(4)),
  ]);
  assert.deepEqual(results, [1, 2, 3, 4]);
  assert.ok(maxRunning <= 2, `max running ${maxRunning}`);
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});

test("createLimiter runs FIFO and front jumps the queue", async () => {
  const limiter = createLimiter(1);
  const order = [];
  const p1 = limiter.run(async () => { await new Promise((r) => setTimeout(r, 5)); order.push("1"); });
  const p2 = limiter.run(async () => { order.push("2"); });
  const p3 = limiter.run(async () => { order.push("3"); });
  const pFront = limiter.run(async () => { order.push("front"); }, { front: true });
  await Promise.all([p1, p2, p3, pFront]);
  assert.deepEqual(order, ["1", "front", "2", "3"]);
});

test("createLimiter rejection frees the slot", async () => {
  const limiter = createLimiter(1);
  await assert.rejects(
    limiter.run(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
  assert.equal(await limiter.run(async () => "after"), "after");
});


test("createLimiter: a synchronous throw or plain value never leaks the slot", async () => {
  const limiter = createLimiter(1);
  await assert.rejects(limiter.run(() => { throw new Error("sync"); }), /sync/);
  assert.equal(limiter.active, 0);
  assert.equal(await limiter.run(() => 42), 42);
  assert.equal(limiter.active, 0);
  assert.equal(await limiter.run(async () => "after"), "after");
});
