// Unit tests for mods/ranch-sidebar/model.js (pure tree builder).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const {
  buildTree, nestWorktrees, BADGE_COLORS, initials, badgeColorIndex, diffSquares, worktreeName, branchLine,
  keptKey, spaceFolder, spaceGitState, normalizeKept, refreshKept, forgetKept, dormantFolders, applyKeptFolders,
} = await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

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

// ---------------------------------------------------------------------------
// nestWorktrees

const repo = (over = {}) => ({ common: over.common ?? "/r/.git", linked: over.linked ?? false });
const entry = (id) => ({ space: id, name: id, cards: [], settled: [] });
const noInfo = () => null;

test("nestWorktrees: no repos keeps order with empty worktrees", () => {
  const input = [entry("s1"), entry("s2")];
  const out = nestWorktrees(input, noInfo);
  assert.deepEqual(out.map((e) => e.space), ["s1", "s2"]);
  assert.deepEqual(out.map((e) => e.worktrees), [[], []]);
  assert.deepEqual(out.map((e) => e.tree), [null, null]);
});

test("nestWorktrees: worktrees nest under the main in order with tree glyphs", () => {
  const input = [entry("main"), entry("wt1"), entry("wt2")];
  const info = (sp) =>
    sp.space === "main" ? repo() : repo({ linked: true });
  const out = nestWorktrees(input, info);
  assert.deepEqual(out.map((e) => e.space), ["main"]);
  assert.deepEqual(
    out[0].worktrees.map((e) => [e.space, e.tree]),
    [["wt1", "├─"], ["wt2", "└─"]]
  );
  assert.deepEqual(out[0].worktrees.map((e) => e.worktrees), [[], []]);
});

test("nestWorktrees: a worktree listed before its main still nests under it", () => {
  const input = [entry("wt"), entry("main")];
  const info = (sp) => (sp.space === "main" ? repo() : repo({ linked: true }));
  const out = nestWorktrees(input, info);
  assert.deepEqual(out.map((e) => e.space), ["main"]);
  assert.deepEqual(out[0].worktrees.map((e) => e.space), ["wt"]);
  assert.equal(out[0].worktrees[0].tree, "└─");
});

test("nestWorktrees: an orphan worktree with no main stays top-level", () => {
  const input = [entry("other"), entry("wt")];
  const info = (sp) => (sp.space === "wt" ? repo({ common: "/elsewhere/.git", linked: true }) : null);
  const out = nestWorktrees(input, info);
  assert.deepEqual(out.map((e) => e.space), ["other", "wt"]);
  assert.equal(out[1].tree, null);
  assert.deepEqual(out[1].worktrees, []);
});

test("nestWorktrees: two mains with the same common nest under the first only", () => {
  const input = [entry("m1"), entry("m2"), entry("wt")];
  const info = (sp) => (sp.space === "wt" ? repo({ linked: true }) : repo());
  const out = nestWorktrees(input, info);
  assert.deepEqual(out.map((e) => e.space), ["m1", "m2"]);
  assert.deepEqual(out[0].worktrees.map((e) => e.space), ["wt"]);
  assert.deepEqual(out[1].worktrees, []);
});

test("nestWorktrees: mixed mains and worktrees keep positions", () => {
  const input = [entry("a"), entry("wtA"), entry("b"), entry("wtB")];
  const info = (sp) =>
    sp.space === "a" ? repo({ common: "/a/.git" })
    : sp.space === "b" ? repo({ common: "/b/.git" })
    : sp.space === "wtA" ? repo({ common: "/a/.git", linked: true })
    : repo({ common: "/b/.git", linked: true });
  const out = nestWorktrees(input, info);
  assert.deepEqual(out.map((e) => e.space), ["a", "b"]);
  assert.deepEqual(out[0].worktrees.map((e) => e.space), ["wtA"]);
  assert.deepEqual(out[1].worktrees.map((e) => e.space), ["wtB"]);
});

test("nestWorktrees: never mutates its inputs", () => {
  const input = [entry("main"), entry("wt")];
  const before = JSON.stringify(input);
  nestWorktrees(input, (sp) => (sp.space === "main" ? repo() : repo({ linked: true })));
  assert.equal(JSON.stringify(input), before);
  assert.equal(input[0].worktrees, undefined);
});

// ---------------------------------------------------------------------------
// worktreeName / branchLine

const wt = (over = {}) => ({
  name: over.name ?? "space-name",
  checkout: over.checkout === undefined ? null : over.checkout,
});

test("worktreeName: primary uses the checkout branch", () => {
  assert.equal(worktreeName(wt({ checkout: { branch: "feat/x" } }), true), "feat/x");
});

test("worktreeName: primary detached uses detached @head", () => {
  assert.equal(worktreeName(wt({ checkout: { detached: true, head: "abc123" } }), true), "detached @abc123");
});

test("worktreeName: linked uses the last segment of checkout.top", () => {
  assert.equal(worktreeName(wt({ checkout: { top: "/Users/me/Projects/ranch-wt-sidebar" } }), false), "ranch-wt-sidebar");
  assert.equal(worktreeName(wt({ checkout: { top: "C:\\Users\\me\\ranch" } }), false), "ranch");
});

test("worktreeName: missing checkout falls back to entry.name", () => {
  assert.equal(worktreeName(wt({ name: "solo" }), true), "solo");
  assert.equal(worktreeName(wt({ name: "solo" }), false), "solo");
  assert.equal(worktreeName({ name: "solo", checkout: undefined }, true), "solo");
});

test("branchLine: equal to the name is dropped", () => {
  assert.equal(branchLine("feat", { branch: "feat" }), null);
  assert.equal(branchLine("detached @abc", { detached: true, head: "abc" }), null);
});

test("branchLine: a different branch is the label", () => {
  assert.equal(branchLine("ranch-wt-x", { branch: "feat/x" }), "feat/x");
  assert.equal(branchLine("ranch-wt-x", { detached: true, head: "abc123" }), "detached @abc123");
});

test("branchLine: no checkout or no branch is null", () => {
  assert.equal(branchLine("x", null), null);
  assert.equal(branchLine("x", undefined), null);
  assert.equal(branchLine("x", {}), null);
  assert.equal(branchLine("x", { branch: null }), null);
});

// ---------------------------------------------------------------------------
// Kept (dormant) folders

test("spaceFolder: first tab's live cwd wins, then SpaceInfo.folder", () => {
  const sp = { tabs: [{ id: "t1" }, { id: "t2" }], folder: "/fallback" };
  assert.equal(spaceFolder(sp, [{ tab: "t1", cwd: null }, { tab: "t2", cwd: "/live" }]), "/live");
  assert.equal(spaceFolder(sp, []), "/fallback");
  assert.equal(spaceFolder({ tabs: [], folder: "/only" }, []), "/only");
  assert.equal(spaceFolder(null, []), null);
  // A pane for a tab not in the space is ignored.
  assert.equal(spaceFolder(sp, [{ tab: "other", cwd: "/nope" }]), "/fallback");
});

test("keptKey: machine-local and remote keys differ", () => {
  assert.equal(keptKey(null, "/repo"), "|/repo");
  assert.equal(keptKey("box", "/repo"), "box|/repo");
  assert.notEqual(keptKey(null, "/repo"), keptKey("box", "/repo"));
});

test("normalizeKept: junk is dropped, defaults filled, duplicates deduped", () => {
  const list = normalizeKept([
    null, "x", 42, [],
    { machine: "box", folder: "/repo", name: "Repo", named: true, color: "#fff" },
    { machine: "box", folder: "/repo", name: "dupe" },
    { folder: "/solo" },
    { folder: "" },
    { machine: 7, folder: "/typed" },
  ]);
  assert.deepEqual(list, [
    { machine: "box", folder: "/repo", raw: null, name: "Repo", named: true, color: "#fff" },
    { machine: null, folder: "/solo", raw: null, name: "/solo", named: false, color: null },
    { machine: "7", folder: "/typed", raw: null, name: "/typed", named: false, color: null },
  ]);
  assert.deepEqual(normalizeKept(null), []);
  assert.deepEqual(normalizeKept({}), []);
});

test("refreshKept: new live folders append, existing ones update in place", () => {
  const kept = [{ machine: null, folder: "/a", raw: null, name: "A", named: false, color: null }];
  const { list, changed } = refreshKept(kept, [
    { machine: null, folder: "/a", raw: "/a", name: "A renamed", named: true, color: "ansi2" },
    { machine: null, folder: "/b", raw: "/b", name: "B", named: false, color: null },
  ]);
  assert.equal(changed, true);
  assert.deepEqual(list.map((e) => e.folder), ["/a", "/b"]);
  assert.equal(list[0].name, "A renamed");
  assert.equal(list[0].named, true);
  assert.equal(list[0].color, "ansi2");
});

test("refreshKept: no change means changed stays false", () => {
  const kept = [{ machine: null, folder: "/a", raw: "/a", name: "A", named: false, color: null }];
  const live = [{ machine: null, folder: "/a", raw: "/a", name: "A", named: false, color: null }];
  assert.equal(refreshKept(kept, live).changed, false);
});

test("refreshKept: a later git top upgrades the raw entry instead of duplicating", () => {
  const kept = [{ machine: null, folder: "/repo/sub", raw: "/repo/sub", name: "sub", named: false, color: null }];
  const { list, changed } = refreshKept(kept, [
    { machine: null, folder: "/repo", raw: "/repo/sub", name: "repo", named: false, color: null },
  ]);
  assert.equal(changed, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].folder, "/repo");
  assert.equal(list[0].raw, "/repo/sub");
});

test("refreshKept: two spaces in one repo collapse to one entry", () => {
  const { list } = refreshKept([], [
    { machine: null, folder: "/repo", raw: "/repo/sub", name: "repo", named: false, color: null },
    { machine: null, folder: "/repo", raw: "/repo/other", name: "repo", named: false, color: null },
  ]);
  assert.equal(list.length, 1);
});

test("refreshKept: a resolved live space folds a stale unresolved duplicate", () => {
  const kept = [
    { machine: null, folder: "/repo", raw: "/repo/other", name: "repo", named: false, color: null },
    { machine: null, folder: "/repo/sub2", raw: "/repo/sub2", name: "sub2", named: false, color: null },
  ];
  const { list, changed } = refreshKept(kept, [
    { machine: null, folder: "/repo", raw: "/repo/sub2", name: "repo", named: false, color: null },
  ]);
  assert.equal(changed, true);
  assert.equal(list.length, 1);
  assert.equal(list[0].folder, "/repo");
  assert.equal(list[0].raw, "/repo/sub2");
});

test("refreshKept: a second pass over an upgraded entry adds nothing", () => {
  const first = refreshKept([], [{ machine: null, folder: "/repo", raw: "/repo/sub", name: "repo", named: false, color: null }]);
  const second = refreshKept(first.list, [{ machine: null, folder: "/repo", raw: "/repo/sub", name: "repo", named: false, color: null }]);
  assert.equal(second.changed, false);
  assert.equal(second.list.length, 1);
});

test("forgetKept: removes only the matching machine+folder", () => {
  const kept = normalizeKept([
    { machine: null, folder: "/a" },
    { machine: "box", folder: "/a" },
    { machine: null, folder: "/b" },
  ]);
  const after = forgetKept(kept, null, "/a");
  assert.deepEqual(after.map((e) => keptKey(e.machine, e.folder)), ["box|/a", "|/b"]);
});

test("applyKeptFolders: dormant entries append to their machine group", () => {
  const tree = {
    showMachines: false,
    groups: [{ machine: null, label: "This Mac", state: "ready", blocked: 0, spaces: [{ space: "s1" }] }],
  };
  const out = applyKeptFolders(tree, [{ machine: null, folder: "/a", name: "A" }]);
  assert.equal(out.groups.length, 1);
  assert.deepEqual(out.groups[0].kept.map((e) => e.folder), ["/a"]);
  assert.equal(out.showMachines, false);
  // Input untouched (no kept key on the original group).
  assert.equal(tree.groups[0].kept, undefined);
});

test("applyKeptFolders: a machine with only dormant folders gets its own group", () => {
  const tree = { showMachines: false, groups: [{ machine: null, label: "This Mac", state: "ready", blocked: 0, spaces: [] }] };
  const out = applyKeptFolders(tree, [{ machine: "box", folder: "/a", name: "A" }]);
  assert.equal(out.groups.length, 2);
  assert.equal(out.showMachines, true);
  assert.deepEqual(out.groups.map((g) => g.machine), [null, "box"]);
  assert.equal(out.groups[1].state, "unavailable");
  assert.deepEqual(out.groups[1].kept.map((e) => e.folder), ["/a"]);
});

test("applyKeptFolders: no dormant entries keeps groups with empty kept arrays", () => {
  const tree = { showMachines: false, groups: [{ machine: null, label: "This Mac", state: "ready", blocked: 0, spaces: [] }] };
  const out = applyKeptFolders(tree, []);
  assert.deepEqual(out.groups[0].kept, []);
  assert.equal(out.showMachines, false);
});

// ---------------------------------------------------------------------------
// Kept folders: git resolution, linked-worktree pruning and dormant matching

const keptEntry = (folder, over = {}) => ({
  machine: over.machine ?? null, folder, raw: over.raw ?? folder,
  name: over.name ?? folder, named: over.named ?? false, color: over.color ?? null,
});
const liveEntry = (folder, over = {}) => ({
  machine: over.machine ?? null, folder, raw: over.raw ?? folder,
  name: over.name ?? folder, named: over.named ?? false, color: over.color ?? null,
});

const gitSpace = (id, cards, checkout = null) => ({ space: id, cards, settled: [], checkout });
const gitCard = (cwd, top) => ({ tabId: `${cwd}/${top}`, cwd, top });

/** A tree whose spaces carry `cwd`/`top` cards and a `checkout` summary. */
const decorated = (spaces) => ({ groups: [{ machine: null, spaces }] });

test("spaceGitState: unknown, non-repo and repo cards resolve differently", () => {
  const git = spaceGitState(decorated([
    gitSpace("repo", [gitCard("/repo", "/repo")], { top: "/repo", linked: false }),
    gitSpace("pending", [gitCard("/repo", undefined)]),
    gitSpace("plain", [gitCard("/plain", null)]),
    gitSpace("linked", [gitCard("/wt", "/wt")], { top: "/wt", linked: true }),
  ]));
  assert.deepEqual(git.get("repo"), { resolved: true, linked: false, top: "/repo" });
  assert.deepEqual(git.get("pending"), { resolved: false, linked: false, top: null });
  assert.deepEqual(git.get("plain"), { resolved: true, linked: false, top: null });
  assert.deepEqual(git.get("linked"), { resolved: true, linked: true, top: "/wt" });
});

test("spaceGitState: every folder card must be answered, settled ones included", () => {
  const git = spaceGitState(decorated([
    gitSpace("mixed", [gitCard("/repo", "/repo"), gitCard("/repo/sub", undefined)]),
    { space: "settled", cards: [], settled: [gitCard("/repo", undefined)] },
    { space: "settled-ok", cards: [gitCard("/repo", "/repo")], settled: [gitCard("/repo/sub", "/repo")] },
    // No folder card (e.g. a viewer-only space): nothing to resolve it with.
    gitSpace("empty", []),
    gitSpace("no-cwd", [{ tabId: "t", cwd: null, top: undefined }]),
  ]));
  assert.equal(git.get("mixed").resolved, false);
  assert.equal(git.get("settled").resolved, false);
  assert.equal(git.get("settled-ok").resolved, true);
  assert.equal(git.get("empty").resolved, false);
  assert.equal(git.get("no-cwd").resolved, false);
});

test("spaceGitState: junk trees answer with no spaces", () => {
  assert.equal(spaceGitState(null).size, 0);
  assert.equal(spaceGitState({}).size, 0);
  assert.equal(spaceGitState({ groups: [{}, { spaces: [{}] }] }).size, 1);
});

test("refreshKept: a live linked worktree prunes its stale entry", () => {
  const kept = [keptEntry("/repo"), keptEntry("/wt")];
  const { list, changed } = refreshKept(kept, [], [{ machine: null, folder: "/wt", raw: "/wt" }]);
  assert.equal(changed, true);
  assert.deepEqual(list.map((e) => e.folder), ["/repo"]);
});

test("refreshKept: exclude matches the raw too, and only on its own machine", () => {
  const kept = [
    keptEntry("/repo", { raw: "/repo/worktree" }),
    keptEntry("/wt", { machine: "box" }),
  ];
  const { list, changed } = refreshKept(kept, [], [
    { machine: null, folder: "/elsewhere", raw: "/repo/worktree" },
    { machine: null, folder: "/wt", raw: "/wt" },
  ]);
  assert.equal(changed, true);
  assert.deepEqual(list.map((e) => `${e.machine}|${e.folder}`), ["box|/wt"]);
});

test("refreshKept: no exclude leaves the list alone", () => {
  const kept = [keptEntry("/repo")];
  const { list, changed } = refreshKept(kept, []);
  assert.equal(changed, false);
  assert.deepEqual(list, [keptEntry("/repo")]);
});

test("kept pipeline: an unresolved worktree is not recorded, then its stale entry is pruned", () => {
  const stale = [keptEntry("/wt")];
  const run = (tree, kept) => {
    const git = spaceGitState(tree);
    const live = ["wt"].map((id) => {
      const state = git.get(id);
      return { machine: null, folder: state.top || "/wt", raw: "/wt", resolved: state.resolved, linked: state.linked };
    });
    const { list, changed } = refreshKept(kept,
      live.filter((l) => l.resolved && !l.linked), live.filter((l) => l.linked));
    return { list, changed, dormant: dormantFolders(list, live.filter((l) => !l.linked)) };
  };
  // First renders: the git lookup has not answered. The stale entry is live
  // (same raw folder) and nothing new is recorded under the raw path.
  const pending = run(decorated([gitSpace("wt", [gitCard("/wt", undefined)])]), stale);
  assert.deepEqual(pending.list, stale);
  assert.equal(pending.changed, false);
  assert.deepEqual(pending.dormant, []);
  // Once the link is known, the worktree is skipped and its entry pruned.
  const known = run(decorated([gitSpace("wt", [gitCard("/wt", "/wt")], { top: "/wt", linked: true })]), stale);
  assert.deepEqual(known.list, []);
  assert.equal(known.changed, true);
  assert.deepEqual(known.dormant, []);
});

test("refreshKept: a folded-away entry's keys do not capture a later live space", () => {
  // The second entry recorded /repo/sub before resolving to /repo/sub2; one
  // live space folds it into /repo, the next one must still get its own entry.
  const kept = [keptEntry("/repo", { raw: "/repo/sub" }), keptEntry("/repo/sub2", { raw: "/repo/sub" })];
  const { list } = refreshKept(kept, [
    liveEntry("/repo", { raw: "/repo/sub" }),
    liveEntry("/repo/sub2", { raw: "/repo/sub2" }),
  ]);
  assert.deepEqual(list.map((e) => e.folder), ["/repo", "/repo/sub2"]);
});

test("dormantFolders: live folder or raw matches keep the entry quiet", () => {
  const kept = [keptEntry("/repo", { raw: "/repo/sub" })];
  assert.deepEqual(dormantFolders(kept, [liveEntry("/repo", { raw: "/repo/sub" })]), []);
  // The live space is unresolved: its folder is still the raw path.
  assert.deepEqual(dormantFolders(kept, [liveEntry("/repo/sub")]), []);
  // A live space resolved to the old raw folder is the same space too.
  assert.deepEqual(dormantFolders(kept, [liveEntry("/repo/sub", { raw: "/other" })]), []);
});

test("dormantFolders: a live raw folder inside the kept folder counts as live", () => {
  const kept = [keptEntry("/repo")];
  assert.deepEqual(dormantFolders(kept, [liveEntry("/repo/sub/deep")]), []);
  assert.deepEqual(dormantFolders(kept, [liveEntry("C:\\repo\\sub")]), [kept[0]]);
  assert.deepEqual(dormantFolders([keptEntry("C:\\repo")], [liveEntry("C:\\repo\\sub")]), []);
});

test("dormantFolders: matching wants a path separator, not a name prefix", () => {
  const kept = [keptEntry("/repo")];
  assert.equal(dormantFolders(kept, [liveEntry("/repository")]).length, 1);
  // Trailing separators do not change the folder.
  assert.deepEqual(dormantFolders([keptEntry("/repo/")], [liveEntry("/repo/sub")]), []);
});

test("dormantFolders: entries only match live spaces on their own machine", () => {
  const kept = [keptEntry("/repo", { machine: null }), keptEntry("/repo", { machine: "box" })];
  const dormant = dormantFolders(kept, [liveEntry("/repo", { machine: "box" })]);
  assert.deepEqual(dormant.map((e) => e.machine), [null]);
});

test("dormantFolders: unrelated and junk entries", () => {
  const kept = [keptEntry("/a"), keptEntry("/b"), null, { folder: "" }, { folder: "/c" }];
  const dormant = dormantFolders(kept, [liveEntry("/a")]);
  assert.deepEqual(dormant.map((e) => e.folder), ["/b", "/c"]);
  assert.deepEqual(dormantFolders([], [liveEntry("/a")]), []);
  assert.deepEqual(dormantFolders(null, null), []);
});
