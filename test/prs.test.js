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

test("detectCreatedPr parses the Codex exec_command payload fixture", () => {
  // Codex runs shell commands through exec_command but reports them to hooks
  // as tool_name "Bash" with the command as ONE string (rust-v0.167.1).
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/codex-exec-command.json", import.meta.url), "utf8"));
  assert.deepEqual(detectCreatedPr(fixture), { url: "https://github.com/o/r/pull/12", number: 12 });
});
