import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blockShown, PanelVisibility } from "../lib/panels.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ranch = () => JSON.parse(readFileSync(join(root, "layouts/ranch.json"), "utf8"));
const find = (node, id) => node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null;
const PANELS = [["session", "ranch-session"], ["files", "ranch-files"], ["changes", "ranch-changes"], ["settings", "ranch-settings"]];

test("blockShown: the shipped layout hides every panel until the panel column opens", () => {
  const l = ranch();
  for (const [id, mod] of PANELS) assert.equal(blockShown(l, { id, mod }), false, id);
  assert.equal(blockShown(l, { id: "tree", mod: "ranch-sidebar" }), true);
});

test("blockShown: an open panel column shows only the stack's active child", () => {
  const l = ranch();
  find(l, "panel").hidden = false;
  find(l, "panel-body").active = "changes";
  const shown = Object.fromEntries(PANELS.map(([id, mod]) => [id, blockShown(l, { id, mod })]));
  assert.deepEqual(shown, { session: false, files: false, changes: true, settings: false });
});

test("blockShown: a stack without active shows its first child", () => {
  const l = ranch();
  find(l, "panel").hidden = false;
  delete find(l, "panel-body").active;
  assert.equal(blockShown(l, { id: "session", mod: "ranch-session" }), true);
  assert.equal(blockShown(l, { id: "files", mod: "ranch-files" }), false);
});

test("blockShown: matches by id when layout nodes carry no content", () => {
  const l = { id: "root", type: "column", children: [
    { id: "panel", type: "column", hidden: true, children: [{ id: "files", type: "block" }] },
  ] };
  assert.equal(blockShown(l, { id: "files", mod: "ranch-files" }), false);
  l.children[0].hidden = false;
  assert.equal(blockShown(l, { id: "files", mod: "ranch-files" }), true);
});

test("blockShown: unknown layout or no matching block never skips work", () => {
  assert.equal(blockShown(null, { id: "files", mod: "ranch-files" }), true);
  assert.equal(blockShown({ id: "root", type: "row", children: [] }, { id: "files", mod: "ranch-files" }), true);
});

test("PanelVisibility: justShown on the first visible check after hidden; missed hands back once", () => {
  let visible = false;
  const v = new PanelVisibility(() => visible);
  assert.equal(v.check(), false);
  v.skip();
  assert.equal(v.check(), false);
  visible = true;
  assert.equal(v.check(), true);
  assert.equal(v.justShown, true);
  assert.equal(v.check(), true);
  assert.equal(v.justShown, false);
  assert.equal(v.takeMissed(), true);
  assert.equal(v.takeMissed(), false);
});

test("PanelVisibility: a probe that throws counts as shown", () => {
  const v = new PanelVisibility(() => { throw new Error("no layout"); });
  assert.equal(v.check(), true);
});
