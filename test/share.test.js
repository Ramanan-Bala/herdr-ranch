import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withGitSummary, sharedGitSummary, withPr, sharedPr, prBranchKey, prUrlKey, SHARE_MAX_AGE_MS, SHARE_MAX_ENTRIES,
} from "../lib/share.js";

const sum = (top, branch = "f1") => ({ top, branch, base: "b" });

test("a shared summary is found by its top or by a folder mapped to it", () => {
  let v = withGitSummary(undefined, null, "/repo/sub", sum("/repo"), 1000);
  assert.equal(sharedGitSummary(v, null, "/repo", 0).summary.top, "/repo");
  assert.equal(sharedGitSummary(v, null, "/repo/sub", 0).summary.top, "/repo");
  assert.equal(sharedGitSummary(v, null, "/other", 0), null);
  assert.equal(sharedGitSummary(v, "box", "/repo", 0), null, "machines are kept apart");
  v = withGitSummary(v, "box", "/repo", sum("/repo", "remote"), 1000);
  assert.equal(sharedGitSummary(v, "box", "/repo", 0).summary.branch, "remote");
});

test("sharedGitSummary only returns reads started after newerThan", () => {
  const v = withGitSummary({}, null, "/r", sum("/r"), 1000);
  assert.equal(sharedGitSummary(v, null, "/r", 999).at, 1000);
  assert.equal(sharedGitSummary(v, null, "/r", 1000), null);
});

test("an older read never replaces a newer one", () => {
  let v = withGitSummary({}, null, "/r", sum("/r", "new"), 2000);
  v = withGitSummary(v, null, "/r", sum("/r", "old"), 1000, 2500);
  assert.equal(sharedGitSummary(v, null, "/r", 0).summary.branch, "new");
});

test("old entries are pruned and the maps are capped", () => {
  let v = withGitSummary({}, null, "/old", sum("/old"), 0);
  v = withGitSummary(v, null, "/new", sum("/new"), SHARE_MAX_AGE_MS + 1);
  assert.equal(sharedGitSummary(v, null, "/old", -1), null);
  for (let i = 0; i < SHARE_MAX_ENTRIES + 10; i++) v = withGitSummary(v, null, `/r${i}`, sum(`/r${i}`), 1000 + i);
  assert.equal(Object.keys(v.repos).length, SHARE_MAX_ENTRIES);
  assert.ok(sharedGitSummary(v, null, `/r${SHARE_MAX_ENTRIES + 9}`, 0), "newest kept");
});

test("withGitSummary ignores a summary without a top", () => {
  assert.deepEqual(withGitSummary({ repos: {} }, null, "/x", null, 1), { repos: {} });
});

test("PR shares: branch and URL keys, newerThan, and null as a definite 'no PR'", () => {
  const bk = prBranchKey(null, "/r", "f1");
  assert.equal(bk, "|/r|f1");
  let v = withPr(undefined, bk, { number: 7 }, 1000);
  v = withPr(v, prUrlKey("https://x/pull/1"), null, 1000);
  assert.deepEqual(sharedPr(v, bk, 0), { parsed: { number: 7 }, at: 1000 });
  assert.deepEqual(sharedPr(v, prUrlKey("https://x/pull/1"), 0), { parsed: null, at: 1000 });
  assert.equal(sharedPr(v, bk, 1000), undefined);
  assert.equal(sharedPr(v, "missing", 0), undefined);
});
