import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWinProcs,
  applyWinCpu,
  parseNetstatListen,
  sessionPids,
  herdrUsage,
} from "../lib/sysstats.js";

const PS = [
  "4 0 140 0 System",
  "100 4 51200 2000000 herdr-core.exe",
  "200 100 20480 1000000 pwsh.exe",
  "300 200 102400 5000000 node.exe",
  "400 4 307200 9000000 Herdr.exe",
  "500 4 1024 10 Code Helper.exe",
  "garbage line",
  "",
].join("\r\n");

test("parseWinProcs reads pid, ppid, rss, ticks and names with spaces", () => {
  const procs = parseWinProcs(PS);
  assert.equal(procs.length, 6);
  assert.deepEqual(procs[5], { pid: 500, ppid: 4, rss: 1024, ticks: 10, comm: "Code Helper.exe" });
});

test("herdr-core.exe roots the session tree on Windows", () => {
  const procs = parseWinProcs(PS);
  assert.deepEqual([...sessionPids(procs)].sort(), [200, 300]);
  const h = herdrUsage(procs);
  assert.equal(h.core.count, 1);
  assert.equal(h.app.count, 1);
  assert.equal(h.app.rssKB, 307200);
});

test("applyWinCpu derives percent of one core from tick deltas", () => {
  const prev = new Map();
  const first = applyWinCpu(parseWinProcs(PS), prev, 1000);
  assert.ok(first.every((p) => p.cpu === 0));
  const later = parseWinProcs(PS.replace("300 200 102400 5000000", "300 200 102400 15000000"));
  applyWinCpu(later, prev, 2000); // 1 s wall = 10,000,000 ticks
  assert.equal(later.find((p) => p.pid === 300).cpu, 100);
  assert.equal(later.find((p) => p.pid === 200).cpu, 0);
});

test("applyWinCpu ignores a reused pid and forgets exited ones", () => {
  const prev = new Map();
  applyWinCpu([{ pid: 9, ppid: 1, rss: 1, ticks: 100, comm: "a.exe" }], prev, 0);
  const next = [{ pid: 9, ppid: 1, rss: 1, ticks: 99999999, comm: "b.exe" }];
  applyWinCpu(next, prev, 1000);
  assert.equal(next[0].cpu, 0);
  applyWinCpu([], prev, 2000);
  assert.equal(prev.size, 0);
});

test("parseNetstatListen keeps listening TCP rows regardless of locale", () => {
  const text = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       300",
    "  TCP    127.0.0.1:3000         127.0.0.1:51000        ESTABLISHED     300",
    "  TCP    [::]:3000              [::]:0                 ABHÖREN         300",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       4",
    "  UDP    0.0.0.0:5353           *:*                                    300",
  ].join("\r\n");
  const out = parseNetstatListen(text, parseWinProcs(PS));
  assert.deepEqual(out, [
    { pid: 300, command: "node", port: 3000 },
    { pid: 4, command: "System", port: 135 },
  ]);
});
