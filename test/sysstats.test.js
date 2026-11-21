import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePs,
  sessionPids,
  sumUsage,
  parseLsofListen,
  sessionPorts,
  formatMemory,
  parseHcGet,
  attributeTerminals,
  HISTORY_CAPACITY,
  pushHistory,
  readHistory,
  sweepHistory,
  parseMemoryPressure,
  parseMeminfo,
  parseLoadAvg,
  hostMemory,
  sortRows,
  buildResourceGroups,
  herdrUsage,
  ownerSplit,
  isOrphan,
  buildResourceTree,
  historySamples,
  buildTerminalInventory,
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

test("parseHcGet parses valid hc get --json output and optional fields", () => {
  const full = JSON.stringify({
    address: "t9s",
    pid: 1503,
    title: "Orca review",
    cwd: "/x",
    created_ms: 1795226378378,
    foreground: { cwd: "/x", name: "claude", pid: 2141 },
    labels: { "herdr.tab": "tbdc8f", "herdr.space": "sp12c5", where: "ranch / Orca review" },
  });
  assert.deepEqual(parseHcGet(full), {
    address: "t9s",
    pid: 1503,
    tab: "tbdc8f",
    space: "sp12c5",
    title: "Orca review",
    cwd: "/x",
    createdMs: 1795226378378,
    foreground: { name: "claude", pid: 2141 },
  });

  const minimal = JSON.stringify({ address: "t1", pid: 42 });
  assert.deepEqual(parseHcGet(minimal), {
    address: "t1",
    pid: 42,
    tab: null,
    space: null,
    title: null,
    cwd: null,
    createdMs: null,
    foreground: null,
  });

  const nonStringOptionals = JSON.stringify({
    address: "t2",
    pid: 99,
    title: 123,
    cwd: "",
    created_ms: -5,
    foreground: { name: "", pid: 0 },
    labels: { "herdr.tab": 456, "herdr.space": "" },
  });
  assert.deepEqual(parseHcGet(nonStringOptionals), {
    address: "t2",
    pid: 99,
    tab: null,
    space: null,
    title: null,
    cwd: null,
    createdMs: null,
    foreground: { name: null, pid: null },
  });

  const badForeground = JSON.stringify({
    address: "t3",
    pid: 100,
    created_ms: "not-a-number",
    foreground: ["not-an-object"],
  });
  assert.deepEqual(parseHcGet(badForeground), {
    address: "t3",
    pid: 100,
    tab: null,
    space: null,
    title: null,
    cwd: null,
    createdMs: null,
    foreground: null,
  });
});

test("parseHcGet returns null on malformed or incomplete inputs", () => {
  assert.equal(parseHcGet(null), null);
  assert.equal(parseHcGet(undefined), null);
  assert.equal(parseHcGet(123), null);
  assert.equal(parseHcGet(""), null);
  assert.equal(parseHcGet("{bad json"), null);
  assert.equal(parseHcGet("null"), null);
  assert.equal(parseHcGet("[]"), null);
  assert.equal(parseHcGet(JSON.stringify({ pid: 100 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "", pid: 100 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "   ", pid: 100 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "t1" })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "t1", pid: 0 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "t1", pid: -5 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "t1", pid: 1.5 })), null);
  assert.equal(parseHcGet(JSON.stringify({ address: "t1", pid: "100" })), null);
});

test("attributeTerminals attributes nested trees and unclaimed other bucket", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  20    10   2000   1.0 -zsh",
      "  21    20   3000   2.5 node",
      "  22    21   4000   0.5 worker",
      "  30    10   1500   0.2 -zsh",
      "  40    10   5000   3.0 orphan-agent",
      "  41    40   1000   1.0 orphan-child",
      "  90     1  99000  50.0 outside-herdr",
    ].join("\n"),
  );
  const res = attributeTerminals(procs, [
    { address: "t1", pid: 20, tab: "tb1", space: "sp1", title: "One" },
    { address: "t2", pid: 30, tab: "tb2", space: "sp1", title: "Two" },
  ]);
  assert.deepEqual(res, {
    terminals: [
      { address: "t1", tab: "tb1", space: "sp1", title: "One", pid: 20, alive: true, rssKB: 9000, cpu: 4, count: 3 },
      { address: "t2", tab: "tb2", space: "sp1", title: "Two", pid: 30, alive: true, rssKB: 1500, cpu: 0.2, count: 1 },
    ],
    other: { rssKB: 6000, cpu: 4, count: 2 },
  });
});

test("attributeTerminals resolves overlapping terminals in input order", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  20    10   2000   1.0 -zsh",
      "  21    20   3000   2.0 subshell",
      "  22    21   4000   3.0 worker",
    ].join("\n"),
  );
  const firstWins = attributeTerminals(procs, [
    { address: "outer", pid: 20, tab: null, space: null, title: "Outer" },
    { address: "inner", pid: 21, tab: null, space: null, title: "Inner" },
  ]);
  assert.deepEqual(firstWins, {
    terminals: [
      { address: "outer", tab: null, space: null, title: "Outer", pid: 20, alive: true, rssKB: 9000, cpu: 6, count: 3 },
      { address: "inner", tab: null, space: null, title: "Inner", pid: 21, alive: true, rssKB: 0, cpu: 0, count: 0 },
    ],
    other: { rssKB: 0, cpu: 0, count: 0 },
  });

  const innerFirst = attributeTerminals(procs, [
    { address: "inner", pid: 21, tab: null, space: null, title: "Inner" },
    { address: "outer", pid: 20, tab: null, space: null, title: "Outer" },
  ]);
  assert.deepEqual(innerFirst, {
    terminals: [
      { address: "inner", tab: null, space: null, title: "Inner", pid: 21, alive: true, rssKB: 7000, cpu: 5, count: 2 },
      { address: "outer", tab: null, space: null, title: "Outer", pid: 20, alive: true, rssKB: 2000, cpu: 1, count: 1 },
    ],
    other: { rssKB: 0, cpu: 0, count: 0 },
  });
});

test("attributeTerminals handles dead, reused-outside-herdr, invalid pids, cycles, and nested herdr-core", () => {
  const procs = parsePs(
    [
      "  10     1   1000   0.0 /Apps/herdr-core",
      "  20    10   2000   1.0 -zsh",
      "  25    20   1000   0.0 /Apps/herdr-core",
      "  26    25   3000   2.0 nested-shell",
      "  50    10    500   0.5 cyc-a",
      "  51    50    600   0.5 cyc-b",
      "  50    51      0   0.0 cyc-a-edge",
      "  80     1   8000   9.0 reused-pid",
      "  81    80   1000   1.0 reused-child",
    ].join("\n"),
  );
  const res = attributeTerminals(procs, [
    { address: "dead", pid: 999, tab: null, space: null, title: "Dead" },
    { address: "reused", pid: 80, tab: null, space: null, title: "Reused" },
    { address: "badpid", pid: -1, tab: null, space: null, title: "Bad" },
    { address: "nopid", tab: null, space: null, title: "Missing" },
    { address: "outer", pid: 20, tab: null, space: null, title: "Outer" },
    { address: "cyclic", pid: 50, tab: null, space: null, title: "Cyclic" },
  ]);
  assert.deepEqual(res.terminals[0], {
    address: "dead", tab: null, space: null, title: "Dead", pid: 999, alive: false, rssKB: 0, cpu: 0, count: 0,
  });
  assert.deepEqual(res.terminals[1], {
    address: "reused", tab: null, space: null, title: "Reused", pid: 80, alive: false, rssKB: 0, cpu: 0, count: 0,
  });
  assert.deepEqual(res.terminals[2], {
    address: "badpid", tab: null, space: null, title: "Bad", pid: null, alive: false, rssKB: 0, cpu: 0, count: 0,
  });
  assert.deepEqual(res.terminals[3], {
    address: "nopid", tab: null, space: null, title: "Missing", pid: null, alive: false, rssKB: 0, cpu: 0, count: 0,
  });
  // pid 25 is a herdr-core (not in inSession), so outer does not claim 25 or walk into 26
  assert.deepEqual(res.terminals[4], {
    address: "outer", tab: null, space: null, title: "Outer", pid: 20, alive: true, rssKB: 2000, cpu: 1, count: 1,
  });
  assert.equal(res.terminals[5].alive, true);
  assert.equal(res.terminals[5].rssKB, 1100);
  // pid 26 (under nested herdr-core) is inSession and unclaimed -> lands in other
  assert.deepEqual(res.other, { rssKB: 3000, cpu: 2, count: 1 });

  assert.deepEqual(attributeTerminals(null, null), {
    terminals: [],
    other: { rssKB: 0, cpu: 0, count: 0 },
  });
  assert.deepEqual(attributeTerminals([], [null]), {
    terminals: [{ address: null, tab: null, space: null, title: null, pid: null, alive: false, rssKB: 0, cpu: 0, count: 0 }],
    other: { rssKB: 0, cpu: 0, count: 0 },
  });
});

test("history rings enforce capacity, copy on read, coerce non-finite, and sweep stale keys", () => {
  assert.equal(HISTORY_CAPACITY, 60);
  const store = new Map();

  assert.deepEqual(readHistory(store, "missing"), []);

  pushHistory(store, "a", 10, 1000);
  pushHistory(store, "a", NaN, 2000);
  pushHistory(store, "a", Infinity, 3000);
  pushHistory(store, "a", "bad", 4000);
  pushHistory(store, "a", 25, 5000);
  const snap = readHistory(store, "a");
  assert.deepEqual(snap, [10, 0, 0, 0, 25]);
  snap.push(999);
  assert.deepEqual(readHistory(store, "a"), [10, 0, 0, 0, 25]);

  for (let i = 1; i <= HISTORY_CAPACITY + 5; i++) {
    pushHistory(store, "ring", i, 10000 + i);
  }
  const ring = readHistory(store, "ring");
  assert.equal(ring.length, HISTORY_CAPACITY);
  assert.equal(ring[0], 6);
  assert.equal(ring[ring.length - 1], HISTORY_CAPACITY + 5);

  // Sweep with explicit staleMs: key "a" touchedAt=5000, "ring" touchedAt=10065
  pushHistory(store, "edge", 1, 9000);
  sweepHistory(store, 10000, 1000); // cutoff = 9000; < 9000 deleted, === 9000 kept
  assert.deepEqual(readHistory(store, "a"), []);
  assert.deepEqual(readHistory(store, "edge"), [1]);
  assert.equal(readHistory(store, "ring").length, HISTORY_CAPACITY);

  // Default staleMs = 600000
  sweepHistory(store, 609001); // cutoff = 9001 -> "edge" (9000) removed, "ring" (10065) kept
  assert.deepEqual(readHistory(store, "edge"), []);
  assert.equal(readHistory(store, "ring").length, HISTORY_CAPACITY);

  // Garbage/null tolerance
  assert.doesNotThrow(() => pushHistory(null, "a", 1, 0));
  assert.doesNotThrow(() => pushHistory(store, null, 1, 0));
  assert.deepEqual(readHistory(null, "a"), []);
  assert.deepEqual(readHistory(store, null), []);
  assert.doesNotThrow(() => sweepHistory(null, 1000));
  assert.doesNotThrow(() => sweepHistory(store, NaN));
});

test("parseMemoryPressure parses macOS memory_pressure -Q output and rejects bad inputs", () => {
  const sample = [
    "The system has 34359738368 (8388608 pages with a page size of 4096).",
    "",
    "System-wide memory free percentage: 63%",
  ].join("\n");
  assert.equal(parseMemoryPressure(sample, 1000), 630);
  assert.equal(parseMemoryPressure("System-wide memory free percentage: 0%", 1000), 0);
  assert.equal(parseMemoryPressure("System-wide memory free percentage: 100%", 1000), 1000);
  assert.equal(parseMemoryPressure("System-wide memory free percentage: 33%", 1000), 330);

  assert.equal(parseMemoryPressure("System-wide memory free percentage: 101%", 1000), null);
  assert.equal(parseMemoryPressure("System-wide memory free percentage: -5%", 1000), null);
  assert.equal(parseMemoryPressure("no percentage line here", 1000), null);
  assert.equal(parseMemoryPressure(sample, 0), null);
  assert.equal(parseMemoryPressure(sample, -100), null);
  assert.equal(parseMemoryPressure(sample, NaN), null);
  assert.equal(parseMemoryPressure(null, 1000), null);
  assert.equal(parseMemoryPressure(undefined, 1000), null);
});

test("parseMeminfo parses Linux /proc/meminfo and rejects missing or malformed inputs", () => {
  const sample = [
    "MemTotal:       16384000 kB",
    "MemFree:         2048000 kB",
    "MemAvailable:    8192000 kB",
    "Buffers:          512000 kB",
  ].join("\n");
  assert.deepEqual(parseMeminfo(sample), {
    total: 16384000 * 1024,
    available: 8192000 * 1024,
  });

  assert.equal(parseMeminfo("MemTotal: 16384000 kB\n"), null);
  assert.equal(parseMeminfo("MemAvailable: 8192000 kB\n"), null);
  assert.equal(parseMeminfo("MemTotal: bad kB\nMemAvailable: 100 kB\n"), null);
  assert.equal(parseMeminfo(""), null);
  assert.equal(parseMeminfo(null), null);
  assert.equal(parseMeminfo(undefined), null);
});

test("parseLoadAvg parses macOS sysctl and Linux /proc/loadavg outputs", () => {
  assert.equal(parseLoadAvg("{ 1.23 1.45 1.67 }\n"), 1.23);
  assert.equal(parseLoadAvg("{0.00 0.10 0.20}"), 0);
  assert.equal(parseLoadAvg("0.52 0.58 0.59 1/389 12345\n"), 0.52);
  assert.equal(parseLoadAvg("2 1.5 1.0"), 2);

  assert.equal(parseLoadAvg(""), null);
  assert.equal(parseLoadAvg("   "), null);
  assert.equal(parseLoadAvg("{ }"), null);
  assert.equal(parseLoadAvg("{ 1.23 1.45 }"), null);
  assert.equal(parseLoadAvg("-1.0 0.5 0.5"), null);
  assert.equal(parseLoadAvg("1.23abc 0.5 0.5"), null);
  assert.equal(parseLoadAvg("not loadavg"), null);
  assert.equal(parseLoadAvg(null), null);
  assert.equal(parseLoadAvg(undefined), null);
  assert.equal(parseLoadAvg(42), null);
});

test("hostMemory clamps available and handles zero or non-finite inputs", () => {
  assert.deepEqual(hostMemory(1000, 400), { total: 1000, available: 400, used: 600, percent: 60 });
  assert.deepEqual(hostMemory(1000, 1500), { total: 1000, available: 1000, used: 0, percent: 0 });
  assert.deepEqual(hostMemory(1000, -50), { total: 1000, available: 0, used: 1000, percent: 100 });
  assert.deepEqual(hostMemory(0, 100), { total: 0, available: 0, used: 0, percent: 0 });
  assert.deepEqual(hostMemory(-100, 50), { total: 0, available: 0, used: 0, percent: 0 });
  assert.deepEqual(hostMemory(NaN, NaN), { total: 0, available: 0, used: 0, percent: 0 });
  assert.deepEqual(hostMemory(1000, Infinity), { total: 1000, available: 0, used: 1000, percent: 100 });
  assert.deepEqual(hostMemory(null, undefined), { total: 0, available: 0, used: 0, percent: 0 });
});

test("sortRows sorts without mutating, breaks ties by name, and tolerates missing fields", () => {
  const rows = [
    { name: "charlie", rssKB: 200, cpu: 10 },
    { name: "alpha", rssKB: 200, cpu: 5 },
    { name: "bravo", rssKB: 500, cpu: 10 },
    { rssKB: 100 }, // missing name and cpu
  ];
  const origOrder = rows.map((r) => r.name);

  const byMem = sortRows(rows, "memory");
  assert.notEqual(byMem, rows);
  assert.deepEqual(rows.map((r) => r.name), origOrder);
  assert.deepEqual(byMem.map((r) => r.name ?? ""), ["bravo", "alpha", "charlie", ""]);

  const byCpu = sortRows(rows, "cpu");
  assert.deepEqual(byCpu.map((r) => r.name ?? ""), ["bravo", "charlie", "alpha", ""]);

  const byName = sortRows(rows, "name");
  assert.deepEqual(byName.map((r) => r.name ?? ""), ["", "alpha", "bravo", "charlie"]);

  const byUnknown = sortRows(rows, "bogus");
  assert.deepEqual(byUnknown.map((r) => r.name ?? ""), ["", "alpha", "bravo", "charlie"]);

  assert.deepEqual(sortRows(null, "memory"), []);
  assert.deepEqual(sortRows([null, { name: "a", rssKB: 10 }], "memory").map((r) => r?.name ?? ""), ["a", ""]);
});

test("buildResourceGroups groups alive rows by space, formats labels, attaches history, and sorts", () => {
  const history = new Map();
  pushHistory(history, "t1", 1024, 1000);
  pushHistory(history, "t1", 2048, 2000);
  pushHistory(history, "t2", 512, 1000);

  const spaces = [
    { id: "sp1", name: "Ranch", tabs: [{ id: "tb1", name: "API" }, { id: "tb2", name: "Web" }] },
    { id: "sp2", name: "Docs", tabs: [{ id: "tb3", name: "Guide" }] },
    { id: "sp_empty", name: "Empty", tabs: [] },
  ];

  const rows = [
    { address: "t1", tab: "tb1", space: "sp1", title: "claude", pid: 10, alive: true, rssKB: 1000, cpu: 2 },
    { address: "t2", tab: "tb2", space: "sp1", title: null, pid: 11, alive: true, rssKB: 3000, cpu: 5 },
    { address: "t3", tab: "tb3", space: "sp2", title: "vite", pid: 12, alive: true, rssKB: 2000, cpu: 10 },
    { address: "t4", tab: null, space: null, title: "orphan", pid: 13, alive: true, rssKB: 500, cpu: 1 },
    { address: "t5", tab: "tb_gone", space: "sp_gone", title: null, pid: 14, alive: true, rssKB: 200, cpu: 0.5 },
    { address: "t_dead", tab: "tb1", space: "sp1", title: "dead", pid: 15, alive: false, rssKB: 9999, cpu: 99 },
  ];

  const byMem = buildResourceGroups({ rows, spaces, history, sort: "memory" });
  assert.deepEqual(byMem, [
    {
      id: "sp1",
      name: "Ranch",
      rssKB: 4000,
      cpu: 7,
      rows: [
        { address: "t2", tab: "tb2", label: "Web", rssKB: 3000, cpu: 5, alive: true, history: [512] },
        { address: "t1", tab: "tb1", label: "API · claude", rssKB: 1000, cpu: 2, alive: true, history: [1024, 2048] },
      ],
    },
    {
      id: "sp2",
      name: "Docs",
      rssKB: 2000,
      cpu: 10,
      rows: [
        { address: "t3", tab: "tb3", label: "Guide · vite", rssKB: 2000, cpu: 10, alive: true, history: [] },
      ],
    },
    {
      id: null,
      name: "Other",
      rssKB: 700,
      cpu: 1.5,
      rows: [
        { address: "t4", tab: null, label: "orphan", rssKB: 500, cpu: 1, alive: true, history: [] },
        { address: "t5", tab: "tb_gone", label: "", rssKB: 200, cpu: 0.5, alive: true, history: [] },
      ],
    },
  ]);

  const byCpu = buildResourceGroups({ rows, spaces, history, sort: "cpu" });
  assert.deepEqual(byCpu.map((g) => g.name), ["Docs", "Ranch", "Other"]);
  assert.deepEqual(byCpu[1].rows.map((r) => r.address), ["t2", "t1"]);

  const byName = buildResourceGroups({ rows, spaces, history, sort: "name" });
  assert.deepEqual(byName.map((g) => g.name), ["Docs", "Other", "Ranch"]);
  assert.deepEqual(byName[2].rows.map((r) => r.label), ["API · claude", "Web"]);

  assert.deepEqual(buildResourceGroups(), []);
  assert.deepEqual(buildResourceGroups({ rows: [rows[5]], spaces, history, sort: "memory" }), []);
});

test("herdrUsage separates Herdr app and herdr-core processes from real ps output", () => {
  const procs = parsePs(
    [
      "  54387     1   6864   0.1 /Users/x/.local/bin/herdr-core",
      "  63404 54387   4016   0.0 /Users/x/.local/share/herdr-core/active/Herdr Core.app/Contents/MacOS/herdr-core",
      "  66445     1 115584  10.0 /Applications/Herdr.app/Contents/MacOS/Herdr",
      "  66457 66445    176   0.0 /Users/x/.local/bin/herdr-core",
      "  70000 63404  50000   5.0 -zsh",
      "  70001     1  80000   2.0 /usr/bin/node",
    ].join("\n"),
  );
  const usage = herdrUsage(procs);
  assert.deepEqual(usage.app, { rssKB: 115584, cpu: 10, count: 1 });
  assert.deepEqual(usage.core, { rssKB: 11056, cpu: 0.1, count: 3 });
  assert.equal(usage.rssKB, 126640);
  assert.ok(Math.abs(usage.cpu - 10.1) < 1e-9);
  assert.equal(usage.count, 4);

  const edgeProcs = parsePs(
    [
      "  1 0 1000 1.0 /Applications/Herdr.app/Contents/Frameworks/Helper",
      "  2 0 2000 2.0 /Applications/Herdr.app/Contents/MacOS/herdr-core",
      "  3 0 3000 0.5 /usr/local/bin/herdr-app",
      "  4 0 4000 0.5 Herdr",
      "  5 0 5000 9.0 /usr/local/bin/HerdrHelper",
    ].join("\n"),
  );
  assert.deepEqual(herdrUsage(edgeProcs), {
    app: { rssKB: 8000, cpu: 2, count: 3 },
    core: { rssKB: 2000, cpu: 2, count: 1 },
    rssKB: 10000,
    cpu: 4,
    count: 4,
  });

  const zero = { app: { rssKB: 0, cpu: 0, count: 0 }, core: { rssKB: 0, cpu: 0, count: 0 }, rssKB: 0, cpu: 0, count: 0 };
  assert.deepEqual(herdrUsage(null), zero);
  assert.deepEqual(herdrUsage(undefined), zero);
  assert.deepEqual(herdrUsage([null, {}, { comm: "Herdr", rss: NaN, cpu: Infinity }]), {
    app: { rssKB: 0, cpu: 0, count: 1 },
    core: { rssKB: 0, cpu: 0, count: 0 },
    rssKB: 0,
    cpu: 0,
    count: 1,
  });
});

test("ownerSplit divides RSS across herdr, alive agents, and other alive terminals", () => {
  const herdr = { rssKB: 126640, cpu: 10.1, count: 4 };
  const rows = [
    { address: "t1", alive: true, rssKB: 5000 },
    { address: "t2", alive: true, rssKB: 3000 },
    { address: "t3", alive: true, rssKB: 2000 },
    { address: "t_dead", alive: false, rssKB: 9999 },
    null,
  ];
  assert.deepEqual(ownerSplit({ herdr, rows, agentAddresses: new Set(["t1", "t_dead"]) }), {
    herdr: 126640,
    agents: 5000,
    other: 5000,
  });
  assert.deepEqual(ownerSplit({ herdr, rows, agentAddresses: ["t1", "t3"] }), {
    herdr: 126640,
    agents: 7000,
    other: 3000,
  });
  assert.deepEqual(ownerSplit(), { herdr: 0, agents: 0, other: 0 });
  assert.deepEqual(ownerSplit(null), { herdr: 0, agents: 0, other: 0 });
  assert.deepEqual(ownerSplit({ herdr: { rssKB: NaN }, rows: "bad", agentAddresses: "t1" }), {
    herdr: 0,
    agents: 0,
    other: 0,
  });
});

test("isOrphan distinguishes bound terminals, orphans, live-parent sub-agents, and dead-parent sub-agents", () => {
  const listed = new Set(["t1", "t_sub_live", "t_sub_dead", "t_orphan"]);
  const knownTabs = new Set(["tb1"]);

  // Bound to a known tab -> not orphan
  assert.equal(isOrphan({ address: "t1", labels: { "herdr.tab": "tb1" }, parent: null }, listed, knownTabs), false);
  // Unbound without parent -> orphan
  assert.equal(isOrphan({ address: "t_orphan", labels: {}, parent: null }, listed, knownTabs), true);
  // Stale tab without parent -> orphan
  assert.equal(isOrphan({ address: "t_orphan", labels: { "herdr.tab": "tb_closed" }, parent: null }, listed, knownTabs), true);
  // Sub-agent without tab whose parent is alive/listed -> not orphan
  assert.equal(isOrphan({ address: "t_sub_live", labels: {}, parent: "t1" }, listed, knownTabs), false);
  // Sub-agent without tab whose parent is gone -> orphan
  assert.equal(isOrphan({ address: "t_sub_dead", labels: {}, parent: "t_gone" }, listed, knownTabs), true);

  // Accepts arrays as well as Sets
  assert.equal(isOrphan({ address: "t_sub_live", parent: "t1" }, ["t1", "t_sub_live"], ["tb1"]), false);
  assert.equal(isOrphan({ address: "t_sub_dead", parent: "t_gone" }, ["t_sub_dead"], ["tb1"]), true);

  // Null / garbage tolerance
  assert.equal(isOrphan(null, listed, knownTabs), false);
  assert.equal(isOrphan(undefined, null, null), false);
  assert.equal(isOrphan("bad", null, null), false);
  assert.equal(isOrphan({ address: "t_x" }, null, null), true);
});

test("buildResourceTree builds space/tab/terminal tree with totals, history, Background, orphans, and sorting", () => {
  const history = new Map();
  pushHistory(history, "t1", 1000 * 1024, 1000);
  pushHistory(history, "t2", 3000 * 1024, 1000);
  pushHistory(history, "t_sub", 4000 * 1024, 1000);
  pushHistory(history, "t_orph", 500 * 1024, 1000);
  pushHistory(history, "tab:tb1", 4000 * 1024, 1000);
  pushHistory(history, "space:sp1", 4500 * 1024, 1000);
  pushHistory(history, "tab:background", 4000 * 1024, 1000);
  pushHistory(history, "space:background", 4000 * 1024, 1000);

  const spaces = [
    { id: "sp1", name: "Ranch", tabs: [{ id: "tb1", name: "API" }, { id: "tb2", name: "Web" }] },
    { id: "sp2", name: "Docs", tabs: [{ id: "tb3", name: "Guide" }] },
    { id: "sp_empty", name: "Empty", tabs: [] },
  ];

  const rows = [
    { address: "t1", tab: "tb1", space: "sp1", title: "claude", pid: 10, alive: true, rssKB: 1000, cpu: 2 },
    { address: "t2", tab: "tb1", space: "sp1", title: null, pid: 11, alive: true, rssKB: 3000, cpu: 5 },
    { address: "t3", tab: "tb2", space: "sp1", title: "vite", pid: 12, alive: true, rssKB: 500, cpu: 1 },
    { address: "t4", tab: "tb3", space: "sp2", title: "docs", pid: 13, alive: true, rssKB: 2000, cpu: 10 },
    { address: "t_sub", tab: null, space: null, title: "sub-agent", pid: 14, alive: true, rssKB: 4000, cpu: 4 },
    { address: "t_orph", tab: "tb_gone", space: "sp_gone", title: null, pid: 15, alive: true, rssKB: 500, cpu: 0.5 },
    { address: "t_orph2", tab: null, space: null, title: "stray", pid: 16, alive: true, rssKB: 800, cpu: 0.2 },
    { address: "t_dead", tab: "tb1", space: "sp1", title: "dead", pid: 17, alive: false, rssKB: 9999, cpu: 99 },
  ];

  const byMem = buildResourceTree({
    rows,
    spaces,
    history,
    sort: "memory",
    agentAddresses: new Set(["t1", "t_sub"]),
    orphanAddresses: new Set(["t_orph", "t_orph2"]),
  });

  assert.deepEqual(byMem, {
    spaces: [
      {
        id: "sp1",
        name: "Ranch",
        rssKB: 4500,
        cpu: 8,
        history: [4500 * 1024],
        tabs: [
          {
            id: "tb1",
            name: "API",
            rssKB: 4000,
            cpu: 7,
            history: [4000 * 1024],
            terminals: [
              { address: "t2", tab: "tb1", space: "sp1", label: "t2", rssKB: 3000, cpu: 5, history: [3000 * 1024], bound: true, agent: false },
              { address: "t1", tab: "tb1", space: "sp1", label: "claude", rssKB: 1000, cpu: 2, history: [1000 * 1024], bound: true, agent: true },
            ],
          },
          {
            id: "tb2",
            name: "Web",
            rssKB: 500,
            cpu: 1,
            history: [],
            terminals: [
              { address: "t3", tab: "tb2", space: "sp1", label: "vite", rssKB: 500, cpu: 1, history: [], bound: true, agent: false },
            ],
          },
        ],
      },
      {
        id: null,
        name: "Background",
        rssKB: 4000,
        cpu: 4,
        history: [4000 * 1024],
        tabs: [
          {
            id: null,
            name: "Background",
            rssKB: 4000,
            cpu: 4,
            history: [4000 * 1024],
            terminals: [
              { address: "t_sub", tab: null, space: null, label: "sub-agent", rssKB: 4000, cpu: 4, history: [4000 * 1024], bound: false, agent: true },
            ],
          },
        ],
      },
      {
        id: "sp2",
        name: "Docs",
        rssKB: 2000,
        cpu: 10,
        history: [],
        tabs: [
          {
            id: "tb3",
            name: "Guide",
            rssKB: 2000,
            cpu: 10,
            history: [],
            terminals: [
              { address: "t4", tab: "tb3", space: "sp2", label: "docs", rssKB: 2000, cpu: 10, history: [], bound: true, agent: false },
            ],
          },
        ],
      },
    ],
    orphans: [
      { address: "t_orph2", tab: null, space: null, label: "stray", rssKB: 800, cpu: 0.2, history: [], bound: false, agent: false },
      { address: "t_orph", tab: "tb_gone", space: "sp_gone", label: "t_orph", rssKB: 500, cpu: 0.5, history: [500 * 1024], bound: false, agent: false },
    ],
  });

  const byCpu = buildResourceTree({
    rows,
    spaces,
    history,
    sort: "cpu",
    agentAddresses: ["t1", "t_sub"],
    orphanAddresses: ["t_orph", "t_orph2"],
  });
  assert.deepEqual(byCpu.spaces.map((s) => s.name), ["Docs", "Ranch", "Background"]);
  assert.deepEqual(byCpu.orphans.map((o) => o.address), ["t_orph", "t_orph2"]);

  const byName = buildResourceTree({
    rows,
    spaces,
    history,
    sort: "name",
    agentAddresses: ["t1", "t_sub"],
    orphanAddresses: ["t_orph", "t_orph2"],
  });
  assert.deepEqual(byName.spaces.map((s) => s.name), ["Background", "Docs", "Ranch"]);
  assert.deepEqual(byName.spaces[2].tabs[0].terminals.map((t) => t.label), ["claude", "t2"]);
  assert.deepEqual(byName.orphans.map((o) => o.label), ["stray", "t_orph"]);

  assert.deepEqual(buildResourceTree(), { spaces: [], orphans: [] });
  assert.deepEqual(buildResourceTree(null), { spaces: [], orphans: [] });
  assert.deepEqual(buildResourceTree({ rows: [rows[7], null], spaces }), { spaces: [], orphans: [] });
});

test("historySamples emits [key, bytes] for spaces, tabs, terminals, Background, and orphans", () => {
  const spaces = [{ id: "sp1", name: "Ranch", tabs: [{ id: "tb1", name: "API" }] }];
  const rows = [
    { address: "t1", tab: "tb1", space: "sp1", title: "claude", alive: true, rssKB: 1000, cpu: 2 },
    { address: "t_sub", tab: null, space: null, title: "sub", alive: true, rssKB: 2500, cpu: 1 },
    { address: "t_orph", tab: null, space: null, title: "orph", alive: true, rssKB: 500, cpu: 0 },
  ];
  const tree = buildResourceTree({ rows, spaces, sort: "memory", orphanAddresses: ["t_orph"] });
  const samples = historySamples(tree);
  assert.deepEqual(samples, [
    ["space:background", 2500 * 1024],
    ["tab:background", 2500 * 1024],
    ["t_sub", 2500 * 1024],
    ["space:sp1", 1000 * 1024],
    ["tab:tb1", 1000 * 1024],
    ["t1", 1000 * 1024],
    ["t_orph", 500 * 1024],
  ]);

  // Round-trip: pushing samples back into store populates every node's history
  const store = new Map();
  for (const [key, bytes] of samples) pushHistory(store, key, bytes, 1000);
  const next = buildResourceTree({ rows, spaces, history: store, sort: "memory", orphanAddresses: ["t_orph"] });
  assert.deepEqual(next.spaces[0].history, [2500 * 1024]);
  assert.deepEqual(next.spaces[0].tabs[0].history, [2500 * 1024]);
  assert.deepEqual(next.spaces[0].tabs[0].terminals[0].history, [2500 * 1024]);
  assert.deepEqual(next.spaces[1].history, [1000 * 1024]);
  assert.deepEqual(next.spaces[1].tabs[0].history, [1000 * 1024]);
  assert.deepEqual(next.spaces[1].tabs[0].terminals[0].history, [1000 * 1024]);
  assert.deepEqual(next.orphans[0].history, [500 * 1024]);

  assert.deepEqual(historySamples(null), []);
  assert.deepEqual(historySamples({}), []);
  assert.deepEqual(historySamples({ spaces: [null], orphans: [null] }), []);
});

test("buildTerminalInventory combines terminals, details, rows, spaces, and withoutTab count", () => {
  const spaces = [
    { id: "sp1", name: "Ranch", tabs: [{ id: "tb1", name: "API" }] },
  ];
  const terminals = [
    {
      address: "t1",
      title: "Claude",
      agent: "claude-code",
      cwd: "/live/ranch",
      status: "running",
      parent: null,
      labels: { "herdr.tab": "tb1", "herdr.space": "sp1" },
    },
    {
      address: "t_sub",
      title: "Worker",
      agent: "codex",
      cwd: "",
      status: "idle",
      parent: "t1",
      labels: {},
    },
    {
      address: "t_orph",
      title: null,
      cwd: null,
      status: null,
      parent: null,
      labels: { "herdr.tab": "tb_closed" },
    },
  ];
  const details = new Map([
    [
      "t1",
      {
        address: "t1",
        pid: 1503,
        tab: "tb1",
        space: "sp1",
        title: "Old title",
        cwd: "/stale/ranch",
        createdMs: 1795226378378,
        foreground: { name: "claude", pid: 2141 },
      },
    ],
    [
      "t_sub",
      {
        address: "t_sub",
        pid: 1600,
        tab: null,
        space: null,
        title: "Worker",
        cwd: "/from/detail",
        createdMs: 1795226390000,
        foreground: { name: "node", pid: 1650 },
      },
    ],
  ]);
  const rows = [
    { address: "t1", alive: true, rssKB: 8000, cpu: 12.5, pid: 1503 },
    { address: "t_sub", alive: true, rssKB: 2000, cpu: 1.5, pid: 1600 },
  ];

  const inv = buildTerminalInventory({
    terminals,
    details,
    rows,
    spaces,
    orphanAddresses: new Set(["t_orph"]),
  });

  assert.deepEqual(inv, {
    count: 3,
    withoutTab: 2,
    items: [
      {
        address: "t1",
        title: "Claude",
        pid: 1503,
        cwd: "/live/ranch",
        tabId: "tb1",
        tabName: "API",
        spaceName: "Ranch",
        agent: "claude-code",
        status: "running",
        foreground: "claude",
        foregroundPid: 2141,
        createdMs: 1795226378378,
        bound: true,
        orphan: false,
        alive: true,
        rssKB: 8000,
        cpu: 12.5,
        parent: null,
      },
      {
        address: "t_sub",
        title: "Worker",
        pid: 1600,
        cwd: "/from/detail",
        tabId: null,
        tabName: null,
        spaceName: null,
        agent: "codex",
        status: "idle",
        foreground: "node",
        foregroundPid: 1650,
        createdMs: 1795226390000,
        bound: false,
        orphan: false,
        alive: true,
        rssKB: 2000,
        cpu: 1.5,
        parent: "t1",
      },
      {
        address: "t_orph",
        title: null,
        pid: null,
        cwd: null,
        tabId: "tb_closed",
        tabName: null,
        spaceName: null,
        agent: null,
        status: null,
        foreground: null,
        foregroundPid: null,
        createdMs: null,
        bound: false,
        orphan: true,
        alive: false,
        rssKB: 0,
        cpu: 0,
        parent: null,
      },
    ],
  });

  assert.deepEqual(buildTerminalInventory(), { count: 0, withoutTab: 0, items: [] });
  assert.deepEqual(buildTerminalInventory(null), { count: 0, withoutTab: 0, items: [] });
  assert.deepEqual(
    buildTerminalInventory({ terminals: [null, undefined], details: "bad", rows: "bad", spaces: "bad", orphanAddresses: "bad" }),
    { count: 0, withoutTab: 0, items: [] },
  );
});
