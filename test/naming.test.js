import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_RANK,
  cleanTitle,
  summarizePrompt,
  humanizeBranch,
  provisionalName,
  bestCandidate,
  ownership,
  dedupe,
  decide,
  exitAction,
  rememberSession,
  recallSession,
} from "../lib/naming.js";

test("SOURCE_RANK ranks sources, lower wins", () => {
  assert.deepEqual(SOURCE_RANK, {
    user: 1,
    agent_user: 2,
    agent_auto: 3,
    prompt: 4,
    branch: 5,
    provisional: 6,
    default: 7,
  });
});

test("cleanTitle strips glyphs, agent names, paths and user@host", () => {
  assert.equal(cleanTitle("✳ Claude Code — Fix login"), "Fix login");
  assert.equal(cleanTitle("⠋ Fixing tests"), "Fixing tests");
  assert.equal(cleanTitle("✓✔ Fixed the spinner bug"), "Fixed the spinner bug");
  assert.equal(cleanTitle("user@host:~/proj/app build failed"), "build failed");
  assert.equal(cleanTitle("src/lib/naming.js is broken"), "is broken");
  assert.equal(cleanTitle("Fix login..."), "Fix login");
  assert.equal(cleanTitle("Codex — Refactor db"), "Refactor db");
  assert.equal(cleanTitle("Fix login — Claude Code"), "Fix login");
  assert.equal(cleanTitle("(wip) Fix login"), "(wip) Fix login");
});

test("cleanTitle rejects empty and generic titles", () => {
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle(null), null);
  assert.equal(cleanTitle("⠋"), null);
  assert.equal(cleanTitle("zsh"), null);
  assert.equal(cleanTitle("New session"), null);
  assert.equal(cleanTitle("OpenCode"), null);
  assert.equal(cleanTitle("claude"), null);
  assert.equal(cleanTitle("Ranch", { repo: "ranch" }), null);
  assert.equal(cleanTitle("12345"), null);
});

test("summarizePrompt spec example", () => {
  assert.equal(
    summarizePrompt("can you please fix the login redirect loop on Safari?"),
    "Fix login redirect loop on Safari",
  );
});

test("summarizePrompt filler, sentence and issue keys", () => {
  assert.equal(summarizePrompt("hey, can you fix #123 please"), "Fix #123");
  assert.equal(summarizePrompt("Add dark mode. Also fix tests."), "Add dark mode");
  assert.equal(summarizePrompt("i want you to refactor the auth module"), "Refactor auth module");
  assert.equal(summarizePrompt("Fix the thing\nsecond line ignored"), "Fix thing");
  assert.equal(summarizePrompt(""), null);
  assert.equal(summarizePrompt("ok"), null);
  assert.equal(
    summarizePrompt("fix the build for ticket ABC-42 now", { maxWords: 3 }),
    "Fix build for ABC-42",
  );
  assert.equal(summarizePrompt("supercalifragilisticexpialidocious", { maxLen: 10 }), "Supercalif");
});

test("humanizeBranch spec examples", () => {
  assert.equal(humanizeBranch("feature/fix-login-loop", "main"), "Fix login loop");
  assert.equal(humanizeBranch("ramanan/feat/ABC-42-payment-retries", "main"), "ABC-42 payment retries");
});

test("humanizeBranch skips default branches and keeps issue keys", () => {
  assert.equal(humanizeBranch("main", "main"), null);
  assert.equal(humanizeBranch("HEAD"), null);
  assert.equal(humanizeBranch("develop"), null);
  assert.equal(humanizeBranch("", "main"), null);
  assert.equal(humanizeBranch("feature/x", "feature/x"), null);
  assert.equal(humanizeBranch("bugfix/ABC-42", "main"), "ABC-42");
  assert.equal(humanizeBranch("hotfix/add_retry", "develop"), "Add retry");
  const hard = humanizeBranch(`feature/${"x".repeat(40)}`, "main");
  assert.equal(hard, "X" + "x".repeat(31));
});

test("provisionalName combines agent and repo", () => {
  assert.equal(provisionalName("Claude", "ranch"), "Claude · ranch");
  assert.equal(provisionalName("Claude", null), "Claude");
  assert.equal(provisionalName(null, "ranch"), "ranch");
  assert.equal(provisionalName(null, null), null);
});

test("bestCandidate ranks agent titles first", () => {
  assert.deepEqual(
    bestCandidate({ agentTitle: "Claude Code — Fix login", agentTitleSource: "user" }),
    { name: "Fix login", source: "agent_user" },
  );
  assert.deepEqual(
    bestCandidate({
      agentTitle: "Refactor db",
      agentTitleSource: "agent",
      terminalTitle: "Fix login",
      firstPrompt: "fix login",
    }),
    { name: "Refactor db", source: "agent_auto" },
  );
});

test("bestCandidate falls through the priority chain", () => {
  assert.deepEqual(
    bestCandidate({ terminalTitle: "✳ Claude Code — Fix login", repo: "ranch" }),
    { name: "Fix login", source: "agent_auto" },
  );
  assert.deepEqual(
    bestCandidate({ firstPrompt: "can you please fix the login redirect loop on Safari?" }),
    { name: "Fix login redirect loop on Safari", source: "prompt" },
  );
  assert.deepEqual(
    bestCandidate({ launchTask: "Add dark mode. Also fix tests." }),
    { name: "Add dark mode", source: "prompt" },
  );
  assert.deepEqual(
    bestCandidate({ firstPrompt: "do the dishes", launchTask: "wash dishes" }),
    { name: "Do dishes", source: "prompt" },
  );
  assert.deepEqual(
    bestCandidate({ branch: "feature/fix-login-loop", defaultBranch: "main" }),
    { name: "Fix login loop", source: "branch" },
  );
  assert.deepEqual(
    bestCandidate({ branch: "main", defaultBranch: "main", agentName: "Claude", repo: "ranch" }),
    { name: "Claude · ranch", source: "provisional" },
  );
  assert.deepEqual(bestCandidate({}), null);
});

test("bestCandidate skips agent titles that clean to null", () => {
  assert.deepEqual(
    bestCandidate({ agentTitle: "claude", agentTitleSource: "user", firstPrompt: "Add dark mode" }),
    { name: "Add dark mode", source: "prompt" },
  );
});

test("ownership detects unnamed, auto and locked", () => {
  assert.equal(ownership({ name: "", named: false }, undefined), "unnamed");
  assert.equal(ownership({ name: "Fix login", named: true }, { name: "Fix login", source: "prompt", at: 1 }), "auto");
  assert.equal(ownership({ name: "Fix login", named: true }, undefined), "locked");
  assert.equal(ownership({ name: "My tab", named: true }, { name: "Fix login", source: "prompt", at: 1 }), "locked");
});

test("dedupe appends branch then counters", () => {
  assert.equal(dedupe("Fix login", ["Other"], "auth-v2"), "Fix login");
  assert.equal(dedupe("Fix login", ["fix login"], "auth-v2"), "Fix login · auth-v2");
  assert.equal(dedupe("Fix login", ["fix login"], null), "Fix login 2");
  assert.equal(dedupe("Fix login", ["fix login", "Fix login · auth-v2"], "auth-v2"), "Fix login 2");
  assert.equal(dedupe("Fix login", ["fix login", "Fix login 2"], null), "Fix login 3");
});

test("decide renames an unnamed tab", () => {
  assert.deepEqual(
    decide({
      tab: { name: "", named: false },
      record: undefined,
      candidate: { name: "Fix login", source: "prompt" },
      now: 1000,
    }),
    { action: "rename", name: "Fix login", source: "prompt" },
  );
});

test("decide never touches editing or locked tabs", () => {
  const tab = { name: "My tab", named: true };
  const record = { name: "Fix login", source: "prompt", at: 0 };
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "X", source: "agent_user" }, now: 100000, editing: true }),
    { action: "none", reason: "editing" },
  );
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "X", source: "agent_user" }, now: 100000 }),
    { action: "none", reason: "locked" },
  );
});

test("decide reports no candidate", () => {
  assert.deepEqual(
    decide({ tab: { name: "", named: false }, record: undefined, candidate: null, now: 1000 }),
    { action: "none", reason: "no-candidate" },
  );
});

test("decide never downgrades the name source", () => {
  const tab = { name: "Fix login", named: true };
  const record = { name: "Fix login", source: "prompt", at: 0 };
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "Login loop", source: "branch" }, now: 100000 }),
    { action: "none", reason: "downgrade" },
  );
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "Real fix", source: "agent_auto" }, now: 100000 }),
    { action: "rename", name: "Real fix", source: "agent_auto" },
  );
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "Login loop 2", source: "prompt" }, now: 100000 }),
    { action: "rename", name: "Login loop 2", source: "prompt" },
  );
});

test("decide skips identical names", () => {
  const tab = { name: "Fix login", named: true };
  const record = { name: "Fix login", source: "prompt", at: 0 };
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "Fix login", source: "prompt" }, now: 100000 }),
    { action: "none", reason: "same" },
  );
});

test("decide throttles renames but agent_user bypasses", () => {
  const tab = { name: "Fix login", named: true };
  const record = { name: "Fix login", source: "prompt", at: 90000 };
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "Login loop", source: "prompt" }, now: 100000 }),
    { action: "none", reason: "throttled" },
  );
  assert.deepEqual(
    decide({ tab, record, candidate: { name: "User title", source: "agent_user" }, now: 100000 }),
    { action: "rename", name: "User title", source: "agent_user" },
  );
});

test("decide dedupes against siblings, excluding the tab's own name", () => {
  assert.deepEqual(
    decide({
      tab: { name: "", named: false },
      record: undefined,
      candidate: { name: "Fix login", source: "prompt" },
      now: 1000,
      siblingNames: ["Fix login"],
      branch: "auth-v2",
    }),
    { action: "rename", name: "Fix login · auth-v2", source: "prompt" },
  );
  assert.deepEqual(
    decide({
      tab: { name: "Fix login", named: true },
      record: { name: "Fix login", source: "prompt", at: 0 },
      candidate: { name: "Real fix", source: "agent_auto" },
      now: 100000,
      siblingNames: ["Fix login", "Real fix"],
    }),
    { action: "rename", name: "Real fix 2", source: "agent_auto" },
  );
});

test("exitAction keeps, reverts or adds a check prefix", () => {
  const auto = { didWork: true, ownershipState: "auto", currentName: "Fix login" };
  assert.deepEqual(exitAction({ ...auto, mode: "keep" }), { action: "none" });
  assert.deepEqual(exitAction({ ...auto, mode: "revert" }), { action: "reset" });
  assert.deepEqual(exitAction({ ...auto, mode: "check" }), { action: "rename", name: "✓ Fix login" });
  assert.deepEqual(
    exitAction({ ...auto, mode: "check", currentName: "✓ Fix login" }),
    { action: "rename", name: "✓ Fix login" },
  );
  assert.deepEqual(
    exitAction({ didWork: false, mode: "check", ownershipState: "auto", currentName: "Fix login" }),
    { action: "reset" },
  );
  assert.deepEqual(
    exitAction({ didWork: false, mode: "revert", ownershipState: "locked", currentName: "My tab" }),
    { action: "none" },
  );
  assert.deepEqual(
    exitAction({ didWork: true, mode: "keep", ownershipState: "unnamed", currentName: "" }),
    { action: "none" },
  );
});

test("rememberSession is an LRU that never mutates its input", () => {
  const original = { a: "A", b: "B" };
  const next = rememberSession(original, "a", "A2", 3);
  assert.deepEqual(original, { a: "A", b: "B" });
  assert.deepEqual(Object.keys(next), ["b", "a"]);
  assert.equal(next.a, "A2");
});

test("rememberSession drops the oldest beyond the cap", () => {
  let m = {};
  for (const [i, id] of ["a", "b", "c"].entries()) m = rememberSession(m, id, `N${i}`, 3);
  m = rememberSession(m, "d", "N3", 3);
  assert.deepEqual(Object.keys(m), ["b", "c", "d"]);
  assert.equal(recallSession(m, "a"), null);
  assert.equal(recallSession(m, "d"), "N3");
});

test("rememberSession caps at 200 by default", () => {
  let m = {};
  for (let i = 0; i < 205; i++) m = rememberSession(m, `s${i}`, `N${i}`);
  assert.equal(Object.keys(m).length, 200);
  assert.equal(recallSession(m, "s4"), null);
  assert.equal(recallSession(m, "s5"), "N5");
  assert.equal(recallSession(m, "s204"), "N204");
});

test("recallSession returns null on misses", () => {
  assert.equal(recallSession({}, "x"), null);
  assert.equal(recallSession(null, "x"), null);
  assert.equal(recallSession({ x: "X" }, "y"), null);
  assert.equal(recallSession({ x: "X" }, "x"), "X");
});

test("agent names are stripped only at the edges", () => {
  assert.equal(cleanTitle("Fix Claude adapter"), "Fix Claude adapter");
  assert.equal(cleanTitle("Claude Code — Fix login"), "Fix login");
  assert.equal(cleanTitle("Fix login · Codex"), "Fix login");
});

test("summarizePrompt never overruns maxLen by a long word", () => {
  const out = summarizePrompt("refactor the authentication middleware internationalization handlers");
  assert.ok(out.length <= 32 + 8, out);
});

test("cleanTitle ignores bare Herdr terminal addresses", () => {
  assert.equal(cleanTitle("t11"), null);
  assert.equal(cleanTitle("t1b"), null);
  assert.equal(cleanTitle("mac-mini/t7"), null);
  assert.equal(cleanTitle("test"), "test");
  assert.equal(cleanTitle("t11 fix login"), "t11 fix login");
});
