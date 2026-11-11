import test from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_ORDER,
  statusRank,
  mostUrgent,
  STATUS_LABEL,
  formatDuration,
  statusSince,
  truncateMiddle,
  diffSummary,
  relativeTime,
  folderLabel,
  attentionQueue,
} from "../lib/format.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("STATUS_ORDER and STATUS_LABEL constants", () => {
  assert.deepEqual(STATUS_ORDER, ["blocked", "done", "working", "idle"]);
  assert.deepEqual(STATUS_LABEL, {
    blocked: "Needs you",
    done: "Done",
    working: "Working",
    idle: "Idle",
  });
});

test("statusRank", () => {
  assert.equal(statusRank("blocked"), 0);
  assert.equal(statusRank("done"), 1);
  assert.equal(statusRank("working"), 2);
  assert.equal(statusRank("idle"), 3);
  assert.equal(statusRank(null), 4);
  assert.equal(statusRank("bogus"), 4);
});

test("mostUrgent", () => {
  assert.equal(mostUrgent(["working", "blocked", "idle"]), "blocked");
  assert.equal(mostUrgent(["idle", "working"]), "working");
  assert.equal(mostUrgent([null, "idle", undefined]), "idle");
  assert.equal(mostUrgent([]), null);
  assert.equal(mostUrgent([null, undefined]), null);
});

test("formatDuration", () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(-5), null);
  assert.equal(formatDuration(NaN), null);
  assert.equal(formatDuration(0), "<1m");
  assert.equal(formatDuration(59_999), "<1m");
  assert.equal(formatDuration(MIN), "1m");
  assert.equal(formatDuration(4 * MIN + 30_000), "4m");
  assert.equal(formatDuration(HOUR), "1h");
  assert.equal(formatDuration(HOUR + 12 * MIN), "1h 12m");
  assert.equal(formatDuration(23 * HOUR + 59 * MIN), "23h 59m");
  assert.equal(formatDuration(DAY), "1d");
  assert.equal(formatDuration(2 * DAY + HOUR), "2d");
});

test("statusSince", () => {
  const now = 10_000;
  assert.equal(
    statusSince(
      { status: "working", working_since: 8_000, changed_at: 9_000 },
      now,
    ),
    2_000,
  );
  assert.equal(
    statusSince({ status: "blocked", working_since: 8_000, changed_at: 9_000 }, now),
    1_000,
  );
  assert.equal(
    statusSince({ status: "idle", working_since: null, changed_at: null }, now),
    null,
  );
  assert.equal(
    statusSince({ status: "working", working_since: null, changed_at: 9_000 }, now),
    null,
  );
});

test("truncateMiddle", () => {
  assert.equal(truncateMiddle("short", 10), "short");
  assert.equal(truncateMiddle("exactly10!", 10), "exactly10!");
  assert.equal(truncateMiddle("abcdefghij", 5), "ab…ij");
  assert.equal(truncateMiddle("abcdefgh", 6), "ab…fgh");
  assert.equal(truncateMiddle("abcdef", 1), "…");
  assert.equal(truncateMiddle("abcdef", 0), "…");
  assert.equal(truncateMiddle("abcdef", -3), "…");
  assert.equal(truncateMiddle("abcdef", 2), "…f");
});

test("diffSummary", () => {
  assert.equal(diffSummary(null), null);
  assert.equal(diffSummary({ files: 0, add: 0, del: 0 }), null);
  assert.equal(diffSummary({ files: 0, add: undefined, del: 0 }), null);
  assert.equal(diffSummary({ files: 12, add: 340, del: 87 }), "12 files  +340  \u221287");
  assert.equal(diffSummary({ files: 1, add: 1, del: 0 }), "1 file  +1  \u22120");
});

test("relativeTime", () => {
  assert.equal(relativeTime(59_000), "just now");
  assert.equal(relativeTime(5 * MIN), "5m ago");
  assert.equal(relativeTime(3 * HOUR), "3h ago");
  assert.equal(relativeTime(2 * DAY), "2d ago");
  assert.equal(relativeTime(3 * 7 * DAY), "3w ago");
  assert.equal(relativeTime(4 * 30 * DAY), "4mo ago");
  assert.equal(relativeTime(2 * 365 * DAY), "2y ago");
});

test("folderLabel", () => {
  assert.equal(folderLabel(null, "/home/me"), null);
  assert.equal(folderLabel("", "/home/me"), null);
  assert.equal(folderLabel("/home/me", "/home/me"), "~");
  assert.equal(folderLabel("/home/me/projects/ranch", "/home/me"), "ranch");
  assert.equal(folderLabel("/home/me/projects/ranch/", "/home/me"), "ranch");
  assert.equal(folderLabel("C:\\Users\\me\\ranch\\", "C:\\Users\\me"), "ranch");
  assert.equal(folderLabel("ranch", "/home/me"), "ranch");
});

test("attentionQueue", () => {
  const now = 1_000_000;
  const mk = (id, tab) => ({ id, tabs: Array.isArray(tab) ? tab : [tab] });
  // Empty input.
  assert.deepEqual(attentionQueue([], null, now), []);
  assert.deepEqual(attentionQueue([mk("s1", { id: "t1" })], null, now), []);
  // Blocked before done, longest wait (largest since) first.
  const q = attentionQueue(
    [
      mk("s1", [
        { id: "t-working", status: "working", working_since: now - 5 * MIN },
        { id: "t-blocked-old", status: "blocked", changed_at: now - 9 * MIN },
        { id: "t-blocked-new", status: "blocked", changed_at: now - 2 * MIN },
        { id: "t-done", status: "done", changed_at: now - 4 * MIN },
        { id: "t-settled", status: "blocked", changed_at: now, settled: true },
        { id: "t-idle", status: "idle" },
      ]),
      mk("s2", { id: "t-hook", changed_at: null }),
    ],
    { "t-hook": { state: "done", at: now - MIN } },
    now,
  );
  assert.deepEqual(
    q.map(e => e.tabId),
    ["t-blocked-old", "t-blocked-new", "t-done", "t-hook"],
  );
  assert.deepEqual(q[0], { tabId: "t-blocked-old", spaceId: "s1", status: "blocked", since: 9 * MIN });
  assert.equal(q[3].status, "done");
  // Unknown since (no timestamp) sorts last within its status group.
  const q2 = attentionQueue(
    [mk("s1", [{ id: "a", status: "done", changed_at: null }, { id: "b", status: "done", changed_at: now }])],
    null,
    now,
  );
  assert.deepEqual(q2.map(e => e.tabId), ["b", "a"]);
});

test("effectiveStatus prefers Herdr, falls back to hook activity", async () => {
  const { effectiveStatus, ACTIVITY_STALE_MS } = await import("../lib/format.js");
  const now = 1_000_000_000;
  assert.deepEqual(effectiveStatus({ status: "working", working_since: now - 60_000 }, { state: "done", at: now }, now), { status: "working", since: 60_000 });
  assert.deepEqual(effectiveStatus({ status: null }, { state: "blocked", at: now - 5000 }, now), { status: "blocked", since: 5000 });
  assert.deepEqual(effectiveStatus({ status: null }, null, now), { status: null, since: null });
  assert.equal(effectiveStatus({ status: null }, { state: "working", at: now - ACTIVITY_STALE_MS - 1 }, now).status, "idle");
});
