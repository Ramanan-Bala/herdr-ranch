import test from "node:test";
import assert from "node:assert/strict";
import {
  parseShortstat,
  parseNumstat,
  LOG_FORMAT,
  parseLog,
  parseAheadBehind,
  webHost,
  links,
  defaultBranch,
  defaultRef,
  repoSummary,
  repoDetails,
  parsePr,
  runGh,
  createTtlCache,
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
    "rev-parse --show-toplevel": "/home/me/ranch\n",
    "branch --show-current": "feature/x\n",
    "rev-parse --short HEAD": "abc1234\n",
    "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main\n",
    "rev-parse --verify --quiet refs/remotes/origin/main": "\n",
    "merge-base HEAD origin/main": "base000\n",
    "rev-list --left-right --count HEAD...origin/main": "12\t3\n",
    "diff --shortstat base000": " 2 files changed, 5 insertions(+), 1 deletion(-)\n",
    "rev-list --left-right --count HEAD...@{u}": "2\t5\n",
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
  });
});

test("repoSummary detached, no upstream, no origin", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel": "/repo\n",
    "branch --show-current": "",
    "rev-parse --short HEAD": "abc1234\n",
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
  });
});

test("repoSummary falls back to the local default branch", async () => {
  const git = fakeGit({
    "rev-parse --show-toplevel": "/repo\n",
    "branch --show-current": "work\n",
    "rev-parse --short HEAD": "abc1234\n",
    "rev-parse --verify --quiet refs/heads/main": "\n",
    "merge-base HEAD main": "b1\n",
    "rev-list --left-right --count HEAD...main": "4\t0\n",
    "diff --shortstat b1": "",
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
    "diff --numstat base000": "3\t1\tsrc/a.js\n-\t-\timg.png\n",
    "log -n 2 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e base000..HEAD":
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
