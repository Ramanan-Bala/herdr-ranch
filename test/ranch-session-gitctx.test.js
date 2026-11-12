// Unit tests for mods/ranch-session/gitctx.js (pure module, no imports).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_MAX,
  GIT_INFLIGHT_MAX,
  ageLabel,
  ctxKey,
  remember,
  prNeeded,
  GitContexts,
} from "../mods/ranch-session/gitctx.js";

const HOST = { kind: "github", base: "https://github.com/o/r" };

/** A git summary like the ones the panel's git read produces. */
const summary = (branch, over = {}) => ({ top: `/top/${branch}`, branch, default: "main", host: HOST, ...over });

/** An ok git read result. */
const ok = (s) => ({ status: "ok", summary: s, details: [] });

const failed = () => ({ status: "failed", summary: null, details: null });

test("ctxKey, remember, prNeeded", () => {
  assert.equal(ctxKey(null, "/a"), "|/a");
  assert.equal(ctxKey("box", "/a"), "box|/a");
  assert.equal(ctxKey("box", null), "box|");
  assert.equal(ctxKey(null, null), "|");

  const m = new Map();
  remember(m, "a", 1);
  remember(m, "b", 2);
  remember(m, "a", 3);
  assert.equal(m.get("a"), 3);
  assert.equal([...m.keys()][0], "b"); // a moved to newest
  remember(m, "c", 4, 2);
  assert.equal(m.has("b"), false); // oldest evicted beyond max
  assert.deepEqual([...m.keys()], ["a", "c"]);

  assert.equal(prNeeded({ branch: "f1", host: HOST, default: "main" }), true);
  assert.equal(prNeeded({ branch: "main", host: HOST, default: "main" }), false);
  assert.equal(prNeeded({ branch: "f1", host: null, default: "main" }), false);
  assert.equal(prNeeded({ branch: "f1", default: "main" }), false); // no host
  assert.equal(prNeeded({ branch: null, host: HOST, default: "main" }), false);
  assert.equal(prNeeded(null), false);

  assert.equal(CACHE_MAX, 20);
  assert.equal(GIT_INFLIGHT_MAX, 3);
});

test("cache hit on switch: ready immediately, background refresh scheduled", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  g.select(null, "/b");
  g.finishGit(g.beginGit(), ok(summary("f2")), t);
  assert.equal(g.select(null, "/a"), true);
  assert.equal(g.gitReady(), true);
  assert.equal(g.gitEntry().summary.branch, "f1");
  assert.equal(g.gitDirty, true);
  assert.equal(g.shouldRefreshGit(t, 30000), true);
  assert.equal(g.gitUpdating(), true);
});

test("no cross-folder data on an uncached select", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  g.select(null, "/c");
  assert.equal(g.gitReady(), false);
  assert.equal(g.gitEntry(), null);
  assert.equal(g.prEntry(), null);
});

test("late git result files under its owner, never under the current context", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  const opA = g.beginGit();
  g.select(null, "/b");
  assert.equal(g.finishGit(opA, ok(summary("a2")), t), false);
  assert.equal(g.git.get(ctxKey(null, "/a")).summary.branch, "a2");
  assert.equal(g.gitEntry(), null); // B still uncached
  g.select(null, "/a");
  assert.equal(g.gitEntry().summary.branch, "a2");
});

test("parallel reads: contexts are independent, inflight cap holds", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  const opA = g.beginGit();
  g.select(null, "/b");
  assert.equal(g.shouldRefreshGit(t, 30000), true); // B does not wait for A
  const opB = g.beginGit();
  assert.equal(opB.cwd, "/b");
  g.select(null, "/c");
  assert.equal(g.beginGit().cwd, "/c");
  g.select(null, "/d");
  assert.equal(g.gitBusy.size, 3);
  assert.equal(g.shouldRefreshGit(t, 30000), false); // 3 already running
  assert.equal(g.beginGit(), null);
  assert.ok(opA && opB);
});

test("git cache evicts the oldest beyond max, re-reads move to newest", () => {
  const g = new GitContexts();
  const t = 1000;
  for (let i = 0; i <= 20; i++) {
    g.select(null, `/r${i}`);
    g.finishGit(g.beginGit(), ok(summary(`b${i}`)), t + i);
  }
  assert.equal(g.git.size, CACHE_MAX);
  assert.equal(g.git.has(ctxKey(null, "/r0")), false);
  assert.equal(g.git.has(ctxKey(null, "/r20")), true);
  // Re-reading an evicted-ish old key refreshes its recency.
  g.select(null, "/r1");
  g.finishGit(g.beginGit(), ok(summary("b1x")), t + 100);
  assert.equal(g.git.size, CACHE_MAX);
  assert.equal([...g.git.keys()][0], ctxKey(null, "/r2")); // r2 is now oldest
  g.select(null, "/r1");
  assert.equal(g.gitEntry().summary.branch, "b1x");
});

test("same folder, branch change hides the old branch's PR", () => {
  const g = new GitContexts();
  let t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  const opPr = g.beginPr();
  assert.equal(opPr.branch, "f1");
  g.finishPr(opPr, { parsed: { title: "one" }, failed: false, error: null }, t);
  assert.equal(g.prReady(), true);
  assert.equal(g.prEntry().parsed.title, "one");
  // Branch flips in the same folder.
  t += 100;
  g.finishGit(g.beginGit(), ok(summary("f2")), t);
  assert.equal(g.prEntry(), null); // never f1's PR
  assert.equal(g.prReady(), false);
  const op2 = g.beginPr();
  assert.equal(op2.branch, "f2");
  g.finishPr(op2, { parsed: { title: "two" }, failed: false, error: null }, t);
  assert.equal(g.prEntry().parsed.title, "two");
});

test("late PR result goes to its owner, never shown for the new context", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  const opPr = g.beginPr();
  g.select(null, "/b");
  assert.equal(g.finishPr(opPr, { parsed: { title: "one" }, failed: false, error: null }, t), false);
  assert.equal(g.prEntry(), null); // B uncached
  assert.equal(g.prs.get(`${ctxKey(null, "/a")}|f1`).parsed.title, "one");
});

test("local and remote folders with the same cwd are different contexts", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/w");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  g.select("box", "/w");
  assert.equal(g.gitReady(), false);
  assert.equal(g.gitEntry(), null);
});

test("default branch or no host: synthetic ready PR entry, no refresh", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("main")), t);
  const e = g.prEntry();
  assert.equal(e.parsed, null);
  assert.equal(e.failed, false);
  assert.equal(e.error, null);
  assert.equal(e.at, t);
  assert.equal(g.prReady(), true);
  assert.equal(g.prUpdating(), false);
  assert.equal(g.shouldRefreshPr(t, 30000), false);
  assert.equal(g.beginPr(), null);
  // No host: nothing to ask.
  g.select(null, "/b");
  g.finishGit(g.beginGit(), ok(summary("dev", { host: null })), t);
  assert.equal(g.prReady(), true);
  assert.equal(g.shouldRefreshPr(t, 30000), false);
});

test("failed refresh keeps cached data; failed with no entry records the failure", () => {
  const g = new GitContexts();
  let t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  const before = { ...g.git.get(ctxKey(null, "/a")) };
  t += 100;
  g.finishGit(g.beginGit(), failed(), t);
  const after = g.git.get(ctxKey(null, "/a"));
  assert.deepEqual(after.summary, before.summary);
  assert.equal(after.at, before.at);
  assert.equal(after.checkedAt, t);
  assert.equal(after.failed, false);
  // Failed read with no earlier data: a failed placeholder entry.
  g.select(null, "/z");
  g.finishGit(g.beginGit(), failed(), t);
  const zf = g.git.get(ctxKey(null, "/z"));
  assert.equal(zf.failed, true);
  assert.equal(zf.summary, null);
  assert.equal(zf.at, t);
});

test("not-repo caches a clean non-failed entry", () => {
  const g = new GitContexts();
  const t = 1000;
  g.select(null, "/plain");
  g.finishGit(g.beginGit(), { status: "not-repo", summary: null, details: null }, t);
  const e = g.git.get(ctxKey(null, "/plain"));
  assert.equal(e.failed, false);
  assert.equal(e.summary, null);
  assert.equal(e.top, null);
});

test("push: one at a time, cross-context view is blocked, stale ids ignored", () => {
  const g = new GitContexts();
  let t = 1000;
  g.select(null, "/a");
  g.finishGit(g.beginGit(), ok(summary("f1")), t);
  const p1 = g.beginPush();
  assert.ok(p1);
  assert.equal(Object.isFrozen(p1), true);
  assert.equal(p1.branch, "f1");
  assert.equal(g.beginPush(), null); // one push at a time
  g.select(null, "/b");
  assert.deepEqual(g.pushView(), { busy: false, err: null, at: 0, blocked: true });
  g.finishGit(g.beginGit(), ok(summary("f2")), t);
  assert.equal(g.beginPush(), null); // still A's push in flight
  assert.equal(g.finishPush(p1, { ok: true, err: null }, t), true);
  g.select(null, "/a");
  assert.equal(g.pushView().at, t);
  assert.equal(g.pushView().blocked, false);
  // A stale op (wrong id) never changes the newer push's state.
  const stale = { ...p1, id: p1.id + 9 };
  const snapshot = { ...g.push };
  assert.equal(g.finishPush(stale, { ok: true, err: null }, t + 1), false);
  assert.deepEqual(g.push, snapshot);
  // A failed push shows its error only on its own context.
  const p2 = g.beginPush();
  assert.equal(g.finishPush(p2, { ok: false, err: "boom" }, t + 2), true);
  assert.equal(g.pushView().err, "boom");
  assert.equal(g.pushView().busy, false);
  g.select(null, "/b");
  assert.deepEqual(g.pushView(), { busy: false, err: null, at: 0, blocked: false });
  g.select(null, "/a");
  // A successful push on the current context marks git dirty.
  const p3 = g.beginPush();
  g.finishPush(p3, { ok: true, err: null }, t + 3);
  assert.equal(g.gitDirty, true);
  assert.equal(g.prDirty, true);
});

test("ageLabel buckets the age for the as-of badge", () => {
  assert.equal(ageLabel(0), "as of 0s");
  assert.equal(ageLabel(59999), "as of 59s");
  assert.equal(ageLabel(60000), "as of 1m");
  assert.equal(ageLabel(3599999), "as of 59m");
  assert.equal(ageLabel(3600000), "as of 1h");
  assert.equal(ageLabel(null), null);
  assert.equal(ageLabel(-1), null);
});

test("select semantics, gen bumps, ops frozen", () => {
  const g = new GitContexts();
  assert.equal(g.select(null, "/a"), true);
  const gen1 = g.current.gen;
  assert.equal(g.select(null, "/a"), false); // same key: no-op
  assert.equal(g.current.gen, gen1);
  assert.equal(g.select("m", "/a"), true);
  assert.equal(g.current.gen, gen1 + 1);
  assert.equal(g.current.machine, "m");
  assert.equal(g.current.cwd, "/a");
  const op = g.beginGit();
  assert.ok(op);
  assert.equal(Object.isFrozen(op), true);
  assert.equal(op.gen, g.current.gen);
  g.select(null, "/b");
  g.finishGit(g.beginGit(), ok(summary("f1")), 1000);
  const pr = g.beginPr();
  assert.ok(pr);
  assert.equal(Object.isFrozen(pr), true);
});
