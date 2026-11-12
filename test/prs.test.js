import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRS_FILE,
  PR_URL,
  prKey,
  parsePrRegistry,
  addPr,
  prsFor,
  detectCreatedPr,
  prRepoOf,
  repoOfWebBase,
  remoteReposOf,
  prCommandOf,
  prCreateHead,
  effectiveDir,
  registryPrBelongs,
  samePr,
} from "../lib/prs.js";

const REC = (url, number = 1, at = "2026-01-01T00:00:00.000Z") => ({ url, number, at });

test("prs constants", () => {
  assert.equal(PRS_FILE, ".herdr/ranch/prs.json");
  const m = PR_URL.exec("see https://github.com/o/r/pull/42 done");
  assert.equal(m[0], "https://github.com/o/r/pull/42");
  assert.equal(m[1], "42");
});

test("prKey needs both top and branch", () => {
  assert.equal(prKey("/repo", "fix/x"), "/repo|fix/x");
  assert.equal(prKey("/repo", ""), null);
  assert.equal(prKey(null, "fix/x"), null);
  assert.equal(prKey("  ", "fix/x"), null);
});

test("parsePrRegistry tolerates bad and missing files", () => {
  for (const bad of [null, undefined, "", "{nope", "[1,2]", "{}", JSON.stringify({ entries: "nope" })]) {
    assert.deepEqual(parsePrRegistry(bad), { version: 1, entries: {} });
  }
});

test("parsePrRegistry drops malformed entries, keeps valid ones", () => {
  const r = parsePrRegistry(JSON.stringify({
    version: 1,
    entries: {
      "/repo|main": [
        REC("https://github.com/o/r/pull/1", 1),
        { nope: true },
        { url: "" },
        REC("https://github.com/o/r/pull/2", "not-a-number", null),
      ],
      broken: "nope",
      "": [REC("https://github.com/o/r/pull/3", 3)],
    },
  }));
  assert.deepEqual(r.entries, {
    "/repo|main": [
      REC("https://github.com/o/r/pull/1", 1),
      { url: "https://github.com/o/r/pull/2", number: null, at: null },
    ],
  });
});

test("addPr appends newest last and dedupes by url", () => {
  let r = parsePrRegistry(null);
  r = addPr(r, "/repo", "main", REC("https://github.com/o/r/pull/1", 1, "t1"));
  r = addPr(r, "/repo", "main", REC("https://github.com/o/r/pull/2", 2, "t2"));
  r = addPr(r, "/repo", "main", REC("https://github.com/o/r/pull/1", 1, "t3"));
  assert.deepEqual(prsFor(r, "/repo", "main"), [
    REC("https://github.com/o/r/pull/2", 2, "t2"),
    REC("https://github.com/o/r/pull/1", 1, "t3"),
  ]);
  // other keys untouched, input never mutated
  assert.deepEqual(r.entries, { "/repo|main": prsFor(r, "/repo", "main") });
});

test("addPr caps at 10 per key and ignores unusable input", () => {
  let r = parsePrRegistry(null);
  for (let i = 1; i <= 12; i++) {
    r = addPr(r, "/repo", "main", REC(`https://github.com/o/r/pull/${i}`, i, `t${i}`));
  }
  assert.deepEqual(prsFor(r, "/repo", "main").map((p) => p.number), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(addPr(r, "/repo", "main", { nope: true }), r);
  assert.deepEqual(addPr(null, "/repo", "main", REC("https://github.com/o/r/pull/1", 1)).entries["/repo|main"], [
    REC("https://github.com/o/r/pull/1", 1),
  ]);
  assert.equal(addPr(r, null, "main", REC("https://github.com/o/r/pull/1", 1)), r);
});

test("prsFor returns [] for unknown or unusable keys", () => {
  const r = parsePrRegistry(JSON.stringify({ version: 1, entries: { "/repo|main": [REC("https://github.com/o/r/pull/1", 1)] } }));
  assert.deepEqual(prsFor(r, "/repo", "main"), [REC("https://github.com/o/r/pull/1", 1)]);
  assert.deepEqual(prsFor(r, "/repo", "other"), []);
  assert.deepEqual(prsFor(null, "/repo", "main"), []);
});

test("detectCreatedPr matches the reducers' gh pr create detection", () => {
  const payload = {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" },
    tool_response: "https://github.com/o/r/pull/7\n",
  };
  assert.deepEqual(detectCreatedPr(payload), { url: "https://github.com/o/r/pull/7", number: 7 });
  // command array (Codex shell), object response
  assert.deepEqual(detectCreatedPr({
    tool_input: { command: ["gh", "pr", "create"] },
    tool_response: { stdout: "created: https://github.com/o/r/pull/8" },
  }), { url: "https://github.com/o/r/pull/8", number: 8 });
  assert.equal(detectCreatedPr({ tool_input: { command: "git status" }, tool_response: "" }), null);
  assert.equal(detectCreatedPr({ tool_input: { command: "gh pr create" }, tool_response: "no url" }), null);
  assert.equal(detectCreatedPr({}), null);
  assert.equal(detectCreatedPr(null), null);
});

test("detectCreatedPr only counts gh pr create run as a command", () => {
  const url = "https://github.com/o/r/pull/9";
  const ran = (command, out = `${url}\n`) => detectCreatedPr({ tool_input: { command }, tool_response: out });
  // Real invocations: after cd &&, ;, a pipe, $( and with env assignments.
  assert.equal(ran("cd repo && gh pr create --fill")?.number, 9);
  assert.equal(ran("git push -q ; gh pr create --base main")?.number, 9);
  assert.equal(ran('echo x | GH_TOKEN=x gh pr create --fill')?.number, 9);
  assert.equal(ran('url=$(gh pr create --fill)')?.number, 9);
  // Mentions are not invocations: comments, strings, heredoc bodies.
  assert.equal(ran("python3 - <<'EOF'\n  /** recorded `gh pr create` here */\nEOF"), null);
  assert.equal(ran('echo "run gh pr create later"'), null);
  assert.equal(ran("grep -n 'gh pr create' lib/prs.js"), null);
  // The URL gh prints last wins over earlier URLs in the output.
  assert.equal(ran("gh pr create --fill", "see https://github.com/a/b/pull/1\nhttps://github.com/o/r/pull/9\n")?.number, 9);
});

// ------------------------------------------------------- shared-PR helpers

test("prRepoOf parses the owner/repo out of a github.com PR URL", () => {
  assert.equal(prRepoOf("https://github.com/Owner/Repo/pull/7"), "owner/repo");
  assert.equal(prRepoOf("see https://github.com/o/r/pull/42 done"), "o/r");
  assert.equal(prRepoOf("https://gitlab.com/o/r/-/merge_requests/1"), null);
  assert.equal(prRepoOf("not a url"), null);
  assert.equal(prRepoOf(null), null);
});

test("repoOfWebBase parses a web host base", () => {
  assert.equal(repoOfWebBase("https://github.com/Owner/Repo"), "owner/repo");
  assert.equal(repoOfWebBase("https://github.com/o/r/"), "o/r");
  assert.equal(repoOfWebBase("https://github.com/o/r.git"), "o/r");
  assert.equal(repoOfWebBase("https://gitlab.com/o/r"), null);
  assert.equal(repoOfWebBase("https://github.com/o"), null);
  assert.equal(repoOfWebBase(null), null);
});

test("remoteReposOf parses git remote -v output", () => {
  const text = [
    "origin\thttps://github.com/O/render.git (fetch)",
    "origin\thttps://github.com/O/render.git (push)",
    "upstream\thttps://me@github.com/O/render (fetch)",
    "fork\tssh://git@github.com/me/profile-api.git (fetch)",
    "work\tgit@github.com:Me/Deploy.git (push)",
    "other\thttps://gitlab.com/o/r.git (fetch)",
  ].join("\n");
  assert.deepEqual(remoteReposOf(text), ["o/render", "me/profile-api", "me/deploy"]);
  assert.deepEqual(remoteReposOf(""), []);
  assert.deepEqual(remoteReposOf(null), []);
});

test("prCommandOf reads command or cmd, string or argv", () => {
  assert.equal(prCommandOf({ command: "gh pr create" }), "gh pr create");
  assert.equal(prCommandOf({ cmd: "gh pr create" }), "gh pr create");
  assert.equal(prCommandOf({ command: ["bash", "-lc", "gh pr create"] }), "bash -lc gh pr create");
  assert.equal(prCommandOf({ cmd: ["gh", "pr", "create"] }), "gh pr create");
  assert.equal(prCommandOf({}), "");
  assert.equal(prCommandOf(null), "");
});

test("prCreateHead reads --head / -H from the gh pr create segment only", () => {
  assert.equal(prCreateHead("gh pr create --head fix/x --fill"), "fix/x");
  assert.equal(prCreateHead('gh pr create --head="fix x"'), "fix x");
  assert.equal(prCreateHead("gh pr create -H fix/x"), "fix/x");
  assert.equal(prCreateHead("gh pr create --head=me:feat"), "feat");
  assert.equal(prCreateHead("cd repo && gh pr create --head feat"), "feat");
  // head flags outside the gh segment are ignored
  assert.equal(prCreateHead("git push --head nope && gh pr create"), null);
  assert.equal(prCreateHead("gh pr create --fill"), null);
  assert.equal(prCreateHead("git status"), null);
});

test("effectiveDir resolves cd, workdir and Git Bash paths", () => {
  assert.equal(effectiveDir("cd /b && gh pr create", "/a", null, "darwin"), "/b");
  assert.equal(effectiveDir('cd "dir with space" && gh pr create', "/a", null, "darwin"), "/a/dir with space");
  assert.equal(effectiveDir("cd sub && gh pr create", "/a", null, "darwin"), "/a/sub");
  assert.equal(effectiveDir("gh pr create", "/a", "/b", "darwin"), "/b");
  assert.equal(effectiveDir("cd inner && gh pr create", "/a", "/b", "darwin"), "/b/inner");
  // Git Bash paths become Windows paths only on win32
  assert.equal(effectiveDir("cd /c/Raptor/x && gh pr create", null, null, "win32"), "C:/Raptor/x");
  assert.equal(effectiveDir("cd /c/Raptor/x && gh pr create", null, null, "darwin"), "/c/Raptor/x");
  // cd after the gh segment does not apply
  assert.equal(effectiveDir("gh pr create && cd /b", "/a", null, "darwin"), "/a");
  // the last cd before gh wins
  assert.equal(effectiveDir("cd /x && cd /y && gh pr create", "/a", null, "darwin"), "/y");
  assert.equal(effectiveDir("gh pr create", null, null, "darwin"), null);
  // leading whitespace before the first cd
  assert.equal(effectiveDir("  cd /b && gh pr create", "/a", null, "darwin"), "/b");
});

test("prCreateHead ignores head-like flags after the gh segment", () => {
  assert.equal(prCreateHead('gh pr create --fill && curl -H "Accept: x" https://e'), null);
  assert.equal(prCreateHead("gh pr create --fill; git push -H nope"), null);
  assert.equal(prCreateHead("gh pr create --head a | tee log"), "a");
});

test("registryPrBelongs accepts same repo, same name and unknown checkout", () => {
  const url = "https://github.com/o/render/pull/3";
  assert.equal(registryPrBelongs(url, "o/render"), true);
  assert.equal(registryPrBelongs(url, "O/Render"), true);
  assert.equal(registryPrBelongs(url, "other/api"), false);
  // fork: same repo name, different owner
  assert.equal(registryPrBelongs(url, "me/render"), true);
  // unknown checkout or non-PR url: cannot disprove, keep
  assert.equal(registryPrBelongs(url, null), true);
  assert.equal(registryPrBelongs("https://gitlab.com/o/r/-/merge_requests/1", "o/other"), true);
});

test("samePr compares urls case-insensitively, else positive numbers", () => {
  assert.equal(samePr({ url: "https://github.com/o/r/pull/3", number: 3 }, { url: "https://GitHub.com/O/R/pull/3" }), true);
  // same number in two different repos is NOT the same PR
  assert.equal(samePr({ url: "https://github.com/o/a/pull/3", number: 3 }, { url: "https://github.com/o/b/pull/3", number: 3 }), false);
  assert.equal(samePr({ number: 3 }, { number: 3 }), true);
  assert.equal(samePr({ number: 3 }, { number: 4 }), false);
  assert.equal(samePr({ number: 3 }, { number: 0 }), false);
  assert.equal(samePr(null, { number: 3 }), false);
  assert.equal(samePr({}, {}), false);
});

test("detectCreatedPr detects gh -R / --repo and tool_input.cmd", () => {
  const ran = (tool_input, tool_response = "https://github.com/o/r/pull/9\n") =>
    detectCreatedPr({ tool_input, tool_response });
  assert.equal(ran({ command: "gh -R o/r pr create --fill" })?.number, 9);
  assert.equal(ran({ command: "gh --repo o/r pr create --fill" })?.number, 9);
  assert.equal(ran({ command: "gh --repo=o/r pr create --fill" })?.number, 9);
  assert.equal(ran({ cmd: "gh pr create --fill" })?.number, 9);
  assert.equal(ran({ cmd: ["bash", "-lc", "gh pr create --fill"] })?.number, 9);
  // still not a command mention
  assert.equal(ran({ command: 'echo "gh -R o/r pr create later"' }), null);
});

test("detectCreatedPr reads object responses: exit code and stdout only", () => {
  const input = { command: "gh pr create --fill" };
  assert.deepEqual(
    detectCreatedPr({ tool_input: input, tool_response: { stdout: "https://github.com/o/r/pull/9\n" } }),
    { url: "https://github.com/o/r/pull/9", number: 9 },
  );
  // gh's "already exists" error goes to stderr: no PR created
  assert.equal(detectCreatedPr({
    tool_input: input,
    tool_response: { stdout: "", stderr: 'a pull request for branch "dev" into branch "main" already exists:\nhttps://github.com/o/render/pull/3' },
  }), null);
  // non-zero exit: no PR created, even with a URL in the output
  assert.equal(detectCreatedPr({
    tool_input: input,
    tool_response: { stdout: "https://github.com/o/r/pull/9", exit_code: 1 },
  }), null);
  assert.equal(detectCreatedPr({
    tool_input: input,
    tool_response: { stdout: "https://github.com/o/r/pull/9", exitCode: 1 },
  }), null);
  // string responses: "already exists" anywhere means no new PR
  assert.equal(detectCreatedPr({
    tool_input: input,
    tool_response: 'a pull request for branch "dev" already exists: https://github.com/o/r/pull/3',
  }), null);
  // exit 0 is fine
  assert.equal(detectCreatedPr({
    tool_input: input,
    tool_response: { stdout: "https://github.com/o/r/pull/9", exit_code: 0 },
  })?.number, 9);
});

test("detectCreatedPr parses the Codex exec_command payload fixture", () => {
  // Codex runs shell commands through exec_command but reports them to hooks
  // as tool_name "Bash" with the command as ONE string (rust-v0.167.1).
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-exec-command.json", import.meta.url), "utf8"));
  assert.deepEqual(detectCreatedPr(fixture), { url: "https://github.com/o/r/pull/12", number: 12 });
});
