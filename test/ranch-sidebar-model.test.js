// Unit tests for mods/ranch-sidebar/model.js (pure tree builder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { buildTree, BADGE_COLORS, initials, badgeColorIndex, diffSquares } =
  await import(join(root, "mods/ranch-sidebar/model.js"));

const NOW = Date.parse("2026-11-11T10:00:00Z");
const MIN = 60_000;

const tab = (id, over = {}) => ({
  id,
  name: over.name ?? `Tab ${id}`,
  active: over.active ?? false,
  status: over.status ?? null,
  settled: over.settled ?? false,
  changed_at: over.changed_at ?? null,
  working_since: over.working_since ?? null,
});
const space = (id, over = {}) => ({
  id,
  name: over.name ?? id,
  machine: over.machine ?? null,
  active: over.active ?? false,
  status: null,
  tabs: over.tabs ?? [],
});
const pane = (tabId, over = {}) => ({ tab: tabId, cwd: over.cwd ?? null, branch: over.branch ?? null });
const agent = (address, tabId, over = {}) => ({
  address,
  tab: tabId,
  program: over.program ?? null,
});

test("buildTree: single machine hides machine headers", () => {
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", { tabs: [tab("t1")] })],
    agents: [],
    panes: [],
    filter: null,
    now: NOW,
  });
  assert.equal(tree.showMachines, false);
  assert.equal(tree.groups.length, 1);
  assert.equal(tree.groups[0].machine, null);
  assert.equal(tree.groups[0].label, "This Mac");
  assert.equal(tree.groups[0].state, "ready");
});

test("buildTree: multiple machines show headers, unknown machines are unavailable", () => {
  const tree = buildTree({
    machines: [
      { name: null, layout: "ready" },
      { name: "box", layout: "loading" },
    ],
    spaces: [
      space("s1", { tabs: [tab("t1")] }),
      space("s2", { machine: "ghost", tabs: [tab("t2")] }),
    ],
    agents: [],
    panes: [],
    filter: null,
    now: NOW,
  });
  assert.equal(tree.showMachines, true);
  assert.deepEqual(
    tree.groups.map((g) => [g.machine, g.state]),
    [[null, "ready"], ["box", "loading"], ["ghost", "unavailable"]]
  );
});

test("buildTree: cards take repo/branch/status from the first pane and tab", () => {
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", { active: true, tabs: [tab("t1", { status: "working", working_since: NOW - 4 * MIN })] })],
    agents: [],
    panes: [pane("t1", { cwd: "/Users/me/Projects/ranch", branch: "feat" })],
    filter: null,
    now: NOW,
  });
  const card = tree.groups[0].spaces[0].cards[0];
  assert.equal(card.repo, "ranch");
  assert.equal(card.branch, "feat");
  assert.equal(card.status, "working");
  assert.equal(card.since, 4 * MIN);
  assert.equal(card.spaceActive, true);
  assert.equal(card.active, false); // tab not active
});

test("buildTree: since prefers working_since while working, changed_at otherwise", () => {
  const mk = (over) =>
    buildTree({
      machines: [{ name: null, layout: "ready" }],
      spaces: [space("s1", { tabs: [tab("t1", over)] })],
      agents: [],
      panes: [],
      filter: null,
      now: NOW,
    }).groups[0].spaces[0].cards[0];
  assert.equal(mk({ status: "working", working_since: NOW - MIN, changed_at: NOW - 5 * MIN }).since, MIN);
  assert.equal(mk({ status: "blocked", working_since: NOW - MIN, changed_at: NOW - 5 * MIN }).since, 5 * MIN);
  assert.equal(mk({ status: "idle" }).since, null);
});

test("buildTree: agent icon and primary agent come from the tab's first agent", () => {
  const program = { key: "claude", icon: "/icons/claude.svg", tint: true };
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", { tabs: [tab("t1"), tab("t2")] })],
    agents: [agent("a1", "t1", { program }), agent("a2", "t2")],
    panes: [pane("t1", { program: { key: "terminal", icon: null } }), pane("t2")],
    filter: null,
    now: NOW,
  });
  const [c1, c2] = tree.groups[0].spaces[0].cards;
  assert.equal(c1.agentIcon, program);
  assert.equal(c1.primaryAgent, "a1");
  // No agent program on t2 (agent exists but reports none, pane has none):
  // icon null, but the agent is still primary.
  assert.equal(c2.agentIcon, null);
  assert.equal(c2.primaryAgent, "a2");
});

test("buildTree: settled tabs land in settled, blocked counts both lists", () => {
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", {
      tabs: [
        tab("t1", { status: "blocked" }),
        tab("t2", { status: "working" }),
        tab("t3", { status: "blocked", settled: true }),
      ],
    })],
    agents: [],
    panes: [],
    filter: null,
    now: NOW,
  });
  const sp = tree.groups[0].spaces[0];
  assert.deepEqual(sp.cards.map((c) => c.tabId), ["t1", "t2"]);
  assert.deepEqual(sp.settled.map((c) => c.tabId), ["t3"]);
  assert.equal(sp.blocked, 2);
  assert.equal(tree.groups[0].blocked, 2);
});

test("buildTree: space status is the most urgent across cards and settled", () => {
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", {
      tabs: [tab("t1", { status: "working" }), tab("t2", { status: "done", settled: true })],
    })],
    agents: [],
    panes: [],
    filter: null,
    now: NOW,
  });
  assert.equal(tree.groups[0].spaces[0].status, "done");
});

test("buildTree: filter keeps matching cards and hides empty spaces and machines", () => {
  const tree = buildTree({
    machines: [
      { name: null, layout: "ready" },
      { name: "box", layout: "ready" },
    ],
    spaces: [
      space("s1", { tabs: [tab("t1", { status: "working" })] }),
      space("s2", { tabs: [tab("t2", { status: "idle" })] }),
      space("s3", { machine: "box", tabs: [tab("t3", { status: "working" })] }),
    ],
    agents: [],
    panes: [],
    filter: "working",
    now: NOW,
  });
  assert.equal(tree.showMachines, true); // both machines still have a working space
  assert.deepEqual(tree.groups.map((g) => g.machine), [null, "box"]);
  const ids = tree.groups.flatMap((g) => g.spaces.flatMap((sp) => sp.cards.map((c) => c.tabId)));
  assert.deepEqual(ids, ["t1", "t3"]);
});

test("buildTree: null filter keeps everything, missing panes and agents tolerated", () => {
  const tree = buildTree({
    machines: [{ name: null, layout: "ready" }],
    spaces: [space("s1", { tabs: [tab("t1", { status: "done" })] })],
    agents: [agent("a1", "gone")],
    panes: [pane("gone")],
    filter: null,
    now: NOW,
  });
  const card = tree.groups[0].spaces[0].cards[0];
  assert.equal(card.repo, null);
  assert.equal(card.branch, null);
  assert.equal(card.agentIcon, null);
  assert.equal(card.primaryAgent, null);
});

test("buildTree: machines() order wins, duplicates deduped", () => {
  const tree = buildTree({
    machines: [
      { name: "box", layout: "ready" },
      { name: null, layout: "ready" },
      { name: "box", layout: "ready" },
    ],
    spaces: [
      space("s1", { tabs: [tab("t1")] }),
      space("s2", { machine: "box", tabs: [tab("t2")] }),
    ],
    agents: [],
    panes: [],
    filter: null,
    now: NOW,
  });
  assert.deepEqual(tree.groups.map((g) => g.machine), ["box", null]);
});

// ---------------------------------------------------------------------------
// Sidebar badge/summary helpers

test("initials: picks first letters across separators, caps single word", () => {
  assert.equal(initials("Jae Kim"), "JK");
  assert.equal(initials("wip-branch_bot x"), "WB");
  assert.equal(initials("raven"), "RA");
  assert.equal(initials("  "), "");
  assert.equal(initials(null), "");
  assert.equal(initials("a"), "A");
});

test("badgeColorIndex: deterministic and in range", () => {
  assert.equal(badgeColorIndex("agent-a1"), badgeColorIndex("agent-a1"));
  for (const id of ["", "a", "agent-a1", "long-address-000-xyz", null, undefined]) {
    const idx = badgeColorIndex(id);
    assert.ok(Number.isInteger(idx) && idx >= 0 && idx < BADGE_COLORS.length, `${id} -> ${idx}`);
  }
  // Sanity: ids spread across the palette, not all the same bucket.
  const buckets = new Set(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map(badgeColorIndex)
  );
  assert.ok(buckets.size > 1);
});

test("diffSquares: zero diff is all none", () => {
  assert.deepEqual(diffSquares(), ["none", "none", "none", "none", "none"]);
  assert.deepEqual(diffSquares(0, 0), ["none", "none", "none", "none", "none"]);
});

test("diffSquares: proportional fills, five squares always", () => {
  assert.deepEqual(diffSquares(10, 0), ["add", "add", "add", "add", "add"]);
  assert.deepEqual(diffSquares(0, 10), ["del", "del", "del", "del", "del"]);
  // 2/2 ties at 3/3 after rounding, capped to 2/3.
  assert.deepEqual(diffSquares(2, 2), ["add", "add", "del", "del", "del"]);
  // Nonzero counts get at least one square.
  assert.deepEqual(diffSquares(1, 99), ["add", "del", "del", "del", "del"]);
  assert.deepEqual(diffSquares(1, 0), ["add", "add", "add", "add", "add"]);
});

test("a card at this computer's home reads ~, not the user's folder name", () => {
  const tree = buildTree({
    home: "/Users/someone",
    machines: [{ name: null, layout: "ready" }],
    spaces: [{ id: "s1", name: "~", machine: null, active: true, tabs: [{ id: "t1", name: "1", active: true }] }],
    agents: [],
    panes: [{ tab: "t1", pane: "p1", terminal: "t9", cwd: "/Users/someone" }],
    filter: null,
    now: 0,
  });
  assert.equal(tree.groups[0].spaces[0].cards[0].repo, "~");
});
