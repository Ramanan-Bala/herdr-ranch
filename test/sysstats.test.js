import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePs,
  sessionPids,
  sumUsage,
  parseLsofListen,
  sessionPorts,
  formatMemory,
} from "../lib/sysstats.js";

test("parsePs reads pid/ppid/rss/cpu and keeps spaces in comm", () => {
  const text = [
    "  63404 54387   4704   0.0 /Users/x/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core",
    "  100     1  12345  12.5 zsh",
    "",
    "not a line",
    "  1 2 3",
    "  101   100   2000   1.5 /Applications/My App Helper",
  ].join("\n");
  assert.deepEqual(parsePs(text), [
    { pid: 63404, ppid: 54387, rss: 4704, cpu: 0, comm: "/Users/x/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core" },
    { pid: 100, ppid: 1, rss: 12345, cpu: 12.5, comm: "zsh" },
    { pid: 101, ppid: 100, rss: 2000, cpu: 1.5, comm: "/Applications/My App Helper" },
  ]);
  assert.deepEqual(parsePs(""), []);
  assert.deepEqual(parsePs(null), []);
});

test("sessionPids finds nested descendants and excludes unrelated procs", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  20    10   2000   0.0 -zsh",
      "  21    20   3000   5.0 node",
      "  22    21   4000   2.0 /usr/bin/foo child",
      "  30     1   9000   0.0 unrelated",
      "  31    30   1000   0.0 child-of-unrelated",
    ].join("\n"),
  );
  assert.deepEqual([...sessionPids(procs)].sort((a, b) => a - b), [20, 21, 22]);
});

test("sessionPids excludes roots and herdr-core descendants but descends through them", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  15    10   1000   0.0 /other/herdr-core",
      "  20    15   2000   0.0 -zsh",
      "  11     1   1000   0.0 herdr-core",
      "  12    11   2000   0.0 node",
    ].join("\n"),
  );
  assert.deepEqual([...sessionPids(procs)].sort((a, b) => a - b), [12, 20]);
});

test("sessionPids does not loop on cycles", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  20    10   1000   0.0 a",
      "  21    20   1000   0.0 b",
      "  20    21   1000   0.0 a",
    ].join("\n"),
  );
  const pids = sessionPids(procs);
  assert.equal(pids.has(20), true);
  assert.equal(pids.has(21), true);
  assert.equal(pids.size, 2);
});

test("sumUsage sums rss/cpu/count over the given pids", () => {
  const procs = parsePs(
    [
      "  20    10   2000   1.5 -zsh",
      "  21    20   3000   2.5 node",
      "  30     1   9000   0.0 unrelated",
    ].join("\n"),
  );
  assert.deepEqual(sumUsage(procs, new Set([20, 21])), { rssKB: 5000, cpu: 4, count: 2 });
  assert.deepEqual(sumUsage(procs, new Set()), { rssKB: 0, cpu: 0, count: 0 });
  assert.deepEqual(sumUsage(procs, new Set([999])), { rssKB: 0, cpu: 0, count: 0 });
});

test("parseLsofListen dedupes IPv4/IPv6 lines of the same pid+port", () => {
  const text = [
    "p300",
    "cnode",
    "f20",
    "n*:8080",
    "f21",
    "n[::1]:8080",
    "f22",
    "n127.0.0.1:5173",
    "p400",
    "cpostgres",
    "f5",
    "n127.0.0.1:5432",
  ].join("\n");
  assert.deepEqual(parseLsofListen(text), [
    { pid: 300, command: "node", port: 8080 },
    { pid: 300, command: "node", port: 5173 },
    { pid: 400, command: "postgres", port: 5432 },
  ]);
  assert.deepEqual(parseLsofListen(""), []);
});

test("sessionPorts filters by pid, dedupes by port and sorts", () => {
  const listens = [
    { pid: 300, command: "node", port: 8080 },
    { pid: 400, command: "postgres", port: 5432 },
    { pid: 300, command: "node", port: 3000 },
    { pid: 300, command: "node", port: 8080 },
  ];
  assert.deepEqual(sessionPorts(listens, new Set([300])), [
    { pid: 300, command: "node", port: 3000 },
    { pid: 300, command: "node", port: 8080 },
  ]);
  assert.deepEqual(sessionPorts(listens, new Set()), []);
});

test("formatMemory", () => {
  assert.equal(formatMemory(0), "0 MB");
  assert.equal(formatMemory(NaN), "0 MB");
  assert.equal(formatMemory(-1), "0 MB");
  assert.equal(formatMemory(undefined), "0 MB");
  assert.equal(formatMemory(900 * 1024), "900 MB");
  assert.equal(formatMemory(1536 * 1024), "1.5 GB");
  assert.equal(formatMemory(2048 * 1024), "2.0 GB");
});
