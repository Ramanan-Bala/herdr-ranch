// Unit tests for lib/file-viewer.js (the one-file viewer tab).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { VIEWER_MOD, viewerTab, isViewerTab, baseName, viewerRequest, openViewerCommands, stableLocation } = await import(
  pathToFileURL(join(root, "lib/file-viewer.js")).href
);

const space = { id: "s1", tabs: [{ id: "t1", name: "zsh" }, { id: "t2", name: "main.js" }, { id: "t3", name: "split" }] };
const panes = [
  { pane: "p1", tab: "t1", terminal: "a" },
  { pane: "p2", tab: "t2", terminal: null, mod: VIEWER_MOD },
  // A ranch-files pane split beside a terminal is not the viewer tab.
  { pane: "p3", tab: "t3", terminal: "b" },
  { pane: "p4", tab: "t3", terminal: null, mod: VIEWER_MOD },
];

test("viewerTab: the tab whose only pane is ranch-files", () => {
  assert.equal(viewerTab(space, panes)?.id, "t2");
  assert.equal(viewerTab(space, panes.filter((p) => p.tab !== "t2")), null);
  assert.equal(viewerTab(undefined, panes), null);
});

test("isViewerTab: single ranch-files pane only", () => {
  assert.equal(isViewerTab({ id: "t2" }, panes), true);
  assert.equal(isViewerTab({ id: "t3" }, panes), false);
  assert.equal(isViewerTab({ id: "t1" }, panes), false);
});

test("baseName: both separators and trailing slashes", () => {
  assert.equal(baseName("/a/b/main.js"), "main.js");
  assert.equal(baseName("C:\\x\\y.ts"), "y.ts");
  assert.equal(baseName("/a/b/"), "b");
  assert.equal(baseName(""), "");
});

test("viewerRequest: defaults machine to null", () => {
  assert.deepEqual(viewerRequest("/a.js", undefined, 5), { abs: "/a.js", on: null, nonce: 5 });
});

test("openViewerCommands: reuses the viewer tab, renaming only when the file changed", () => {
  assert.deepEqual(openViewerCommands(space, panes, { abs: "/r/main.js" }), [["tab.select", { id: "t2" }]]);
  assert.deepEqual(openViewerCommands(space, panes, { abs: "/r/other.ts" }), [
    ["tab.select", { id: "t2" }],
    ["tab.rename", { id: "t2", name: "other.ts" }],
  ]);
});

test("openViewerCommands: creates the tab when none exists; nothing without a file or space", () => {
  const noViewer = panes.filter((p) => p.tab !== "t2");
  assert.deepEqual(openViewerCommands(space, noViewer, { abs: "/r/a.md" }), [
    ["tab.new", { space: "s1", name: "a.md", mod: VIEWER_MOD, props: { viewer: true } }],
  ]);
  assert.deepEqual(openViewerCommands(space, panes, {}), []);
  assert.deepEqual(openViewerCommands(null, panes, { abs: "/x" }), []);
});

test("stableLocation: a focused viewer pane keeps the last terminal location of its space", () => {
  const last = new Map();
  const term = { cwd: "/r/sub", on: null, space: "s1" };
  assert.equal(stableLocation(term, { terminal: "a" }, last), term);
  // The viewer has no folder: location() would fall back to the space folder.
  assert.equal(stableLocation({ cwd: "/r", on: null, space: "s1" }, { terminal: null, mod: VIEWER_MOD }, last), term);
  // Another space never borrows s1's folder.
  const other = { cwd: "/x", on: null, space: "s2" };
  assert.equal(stableLocation(other, { terminal: null, mod: VIEWER_MOD }, last), other);
  // No pane (a layout block, nothing focused) is a normal location.
  const plain = { cwd: "/r", on: null, space: "s1" };
  assert.equal(stableLocation(plain, null, last), plain);
  assert.equal(last.get("s1"), plain);
});
