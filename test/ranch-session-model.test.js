// Unit tests for mods/ranch-session/model.js (pure helpers only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const {
  pickAgent,
  checksSummary,
  checksGlyph,
  reviewPill,
  stateWord,
  subtitle,
  totalsOf,
  unfinishedCount,
  defaultBranchLine,
  taskEmptyState,
  remoteText,
  fileRow,
  subDuration,
  herdrSubStatus,
  activityStatus,
  prStateToken,
  prStateLabel,
  prRepoText,
} = await import(pathToFileURL(join(root, "mods/ranch-session/model.js")).href);
const { ACTIVITY_STALE_MS } = await import(
  pathToFileURL(join(root, "mods/ranch-session/lib/format.js")).href
);

const agent = (address, status) => ({ address, status });

test("pickAgent: empty tab", () => {
  assert.equal(pickAgent([], null), null);
  assert.equal(pickAgent(null, null), null);
});

test("pickAgent: remembered address wins", () => {
  const list = [agent("a", "blocked"), agent("b", "idle")];
  assert.equal(pickAgent(list, "b").address, "b");
  // Unknown remembered address falls back to urgency.
  assert.equal(pickAgent(list, "zz").address, "a");
});

test("pickAgent: most urgent by default, ties keep order", () => {
  assert.equal(pickAgent([agent("a", "idle"), agent("b", "working")], null).address, "b");
  assert.equal(pickAgent([agent("a", "idle"), agent("b", "done")], null).address, "b");
  assert.equal(pickAgent([agent("a", "working"), agent("b", "working")], null).address, "a");
});

test("herdrSubStatus maps raw words", () => {
  assert.equal(herdrSubStatus({ status: "running" }), "working");
  assert.equal(herdrSubStatus({ status: "error" }), "blocked");
  assert.equal(herdrSubStatus({ status: "done" }), "done");
  assert.equal(herdrSubStatus({ status: "working" }), "working");
  assert.equal(herdrSubStatus({ status: "blocked" }), "blocked");
  assert.equal(herdrSubStatus({ status: "idle" }), "idle");
  assert.equal(herdrSubStatus({ status: "weird" }), null);
  assert.equal(herdrSubStatus({}), null);
});

test("totalsOf and unfinishedCount", () => {
  const tasks = (n, status) => Array.from({ length: n }, () => ({ status }));
  assert.deepEqual(totalsOf([tasks(2, "completed"), tasks(4, "pending"), null, "junk"]), { done: 2, total: 6 });
  assert.deepEqual(totalsOf([]), { done: 0, total: 0 });
  assert.equal(unfinishedCount(tasks(2, "completed")), 0);
  assert.equal(unfinishedCount([...tasks(3, "pending"), ...tasks(2, "in_progress"), tasks(1, "completed")[0]]), 5);
  assert.equal(unfinishedCount(null), 0);
});

test("subtitle shows only with tasks (quieter header)", () => {
  assert.equal(subtitle({ done: 2, total: 6 }), "2 of 6 done");
  assert.equal(subtitle({ done: 6, total: 6 }), "6 of 6 done");
  assert.equal(subtitle({ done: 0, total: 0 }), null);
  assert.equal(subtitle(null), null);
});

test("activityStatus maps store activity, stale working reads idle", () => {
  const now = 1_700_000_000_000;
  assert.equal(activityStatus({ state: "working", at: now - 1000 }, now), "working");
  assert.equal(activityStatus({ state: "blocked", at: now - 1000 }, now), "blocked");
  assert.equal(activityStatus({ state: "done", at: now - 1000 }, now), "done");
  assert.equal(activityStatus({ state: "working" }, now), "working");
  assert.equal(activityStatus({ state: "working", at: now - ACTIVITY_STALE_MS - 1 }, now), "idle");
  assert.equal(activityStatus(null, now), null);
  assert.equal(activityStatus({}, now), null);
});

test("stateWord", () => {
  assert.equal(stateWord("working"), "working");
  assert.equal(stateWord("done"), "done");
  assert.equal(stateWord("idle"), "idle");
  assert.equal(stateWord("blocked"), "needs you");
  assert.equal(stateWord(null), null);
});

test("checksSummary skips zero parts, pending reads as running", () => {
  assert.equal(checksSummary({ pass: 12, fail: 3, pending: 2 }), "3 failed · 2 running · 12 passed");
  assert.equal(checksSummary({ pass: 12, fail: 0, pending: 0 }), "12 passed");
  assert.equal(checksSummary({ pass: 0, fail: 0, pending: 2 }), "2 running");
  assert.equal(checksSummary({ pass: 0, fail: 0, pending: 0 }), null);
  assert.equal(checksSummary(null), null);
});

test("checksGlyph picks the leading kind", () => {
  assert.equal(checksGlyph({ pass: 5, fail: 1, pending: 9 }), "fail");
  assert.equal(checksGlyph({ pass: 5, fail: 0, pending: 9 }), "pending");
  assert.equal(checksGlyph({ pass: 5, fail: 0, pending: 0 }), "pass");
  assert.equal(checksGlyph(null), "pass");
});

test("reviewPill", () => {
  assert.deepEqual(reviewPill("approved"), { text: "Approved", token: "done" });
  assert.deepEqual(reviewPill("review_required"), { text: "Review required", token: "blocked" });
  assert.deepEqual(reviewPill("changes_requested"), { text: "Changes requested", token: "blocked" });
  assert.equal(reviewPill(null), null);
  assert.equal(reviewPill("whatever"), null);
});

test("defaultBranchLine", () => {
  assert.equal(defaultBranchLine(null), null);
  assert.equal(defaultBranchLine({ branch: "feat", default: "main" }).kind, "none");
  assert.deepEqual(defaultBranchLine({ branch: "main", default: "main", vsDefault: { ahead: 3, behind: 0, ref: "origin/main" } }), {
    kind: "on-default",
    ahead: 0,
    behind: 0,
    default: "main",
  });
  assert.deepEqual(defaultBranchLine({ branch: "feat", default: "main", vsDefault: { ahead: 12, behind: 3, ref: "origin/main" } }), {
    kind: "diverged",
    ahead: 12,
    behind: 3,
    default: "main",
  });
  // Detached HEAD diverges from the default branch.
  assert.equal(defaultBranchLine({ branch: null, default: "main", vsDefault: { ahead: 1, behind: 0 } }).kind, "diverged");
});

test("taskEmptyState", () => {
  const ok = (tasks) => ({ ok: true, store: { tasks } });
  assert.equal(taskEmptyState(ok([{ title: "x" }]), "claude-code"), null);
  assert.deepEqual(taskEmptyState(ok([]), "claude-code"), { text: "No plan yet." });
  assert.deepEqual(taskEmptyState(ok([]), "pi"), { text: "This agent doesn't report tasks." });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, "claude"), { text: "No plan yet." });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, "codex"), { text: "No plan yet." });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, "opencode"), { text: "No plan yet." });
  for (const app of ["claude-code", "claude", "codex", "opencode"]) {
    assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, app, "missing"), {
      text: "Task reporting isn't set up", setup: true,
    });
    assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, app, "installed"), { text: "No plan yet." });
  }
  assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, "claude", "outdated"), {
    text: "Task reporting isn't set up", setup: true,
  });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "missing" }, "gemini-cli"), {
    text: "This agent doesn't report tasks.",
  });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "newer" }, "claude-code"), {
    text: "Update Ranch to see tasks.",
  });
  assert.deepEqual(taskEmptyState({ ok: false, reason: "invalid" }, "claude-code"), {
    text: "Task reporting isn't set up",
    setup: true,
  });
  assert.equal(taskEmptyState(null, "claude-code").text, "No plan yet.");
});

test("remoteText", () => {
  assert.equal(remoteText(2, 5), "↑2 ↓5");
  assert.equal(remoteText(2, 0), "↑2");
  assert.equal(remoteText(0, 5), "↓5");
  assert.equal(remoteText(0, 0), null);
  assert.equal(remoteText(null, null), null);
});

test("fileRow", () => {
  assert.deepEqual(fileRow({ path: "src/a.js", add: 3, del: 1 }), { path: "src/a.js", add: "+3", del: "−1" });
  assert.deepEqual(fileRow({ path: "img.png", add: null, del: null }), { path: "img.png", add: "bin", del: null });
  assert.deepEqual(fileRow(null), { path: "", add: "bin", del: null });
});

test("subDuration", () => {
  const now = Date.parse("2026-11-11T10:00:00Z");
  assert.equal(subDuration("2026-11-11T09:59:30Z", null, now), 30000);
  assert.equal(subDuration("2026-11-11T09:59:30Z", "2026-11-11T09:59:45Z", now), 15000);
  assert.equal(subDuration(null, null, now), null);
  assert.equal(subDuration("nope", null, now), null);
});

test("taskEmptyState points at /hooks when Codex hooks need approval", () => {
  const missing = { ok: false, reason: "missing" };
  assert.deepEqual(taskEmptyState(missing, "codex", "needs approval"), { text: "Approve the Ranch hooks with /hooks in Codex." });
  assert.equal(taskEmptyState(missing, "codex", "missing").setup, true);
});

test("prStateToken and prStateLabel map GitHub's states", () => {
  assert.equal(prStateToken("open"), "ansi2");
  assert.equal(prStateToken("draft"), "dim");
  assert.equal(prStateToken("merged"), "ansi5");
  assert.equal(prStateToken("closed"), "blocked");
  assert.equal(prStateToken("weird"), null);
  assert.equal(prStateToken(null), null);
  assert.equal(prStateLabel("open"), "Open");
  assert.equal(prStateLabel("draft"), "Draft");
  assert.equal(prStateLabel("merged"), "Merged");
  assert.equal(prStateLabel("closed"), "Closed");
  assert.equal(prStateLabel("weird"), null);
});

test("prRepoText pulls owner/repo out of a PR URL", () => {
  assert.equal(prRepoText("https://github.com/owner/repo/pull/1285"), "owner/repo");
  assert.equal(prRepoText("https://github.com/owner/repo/pull/1285/"), "owner/repo");
  assert.equal(prRepoText("https://git.sr.ht/~owner/repo/pulls/3"), "~owner/repo");
  assert.equal(prRepoText("https://github.com/only"), null);
  assert.equal(prRepoText("not a url"), null);
  assert.equal(prRepoText(null), null);
});
