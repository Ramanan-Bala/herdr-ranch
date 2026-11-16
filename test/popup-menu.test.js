import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const {
  ROW,
  SEPARATOR,
  PAD,
  MENU_WIDTH,
  normalizeItems,
  menuSize,
  nextIndex,
  openMenu,
  runAction,
  menuKey,
} = await import(pathToFileURL(join(root, "lib/popup-menu.js")).href);

const sep = { separator: true };
const a = { label: "a", action: { type: "copy", text: "a" } };
const b = { label: "b", disabled: true, action: { type: "copy", text: "b" } };
const c = { label: "c", action: { type: "copy", text: "c" } };

test("normalizeItems: drops empty entries, leading/trailing and repeated separators", () => {
  assert.deepEqual(normalizeItems([null, sep, a, sep, sep, b, sep, undefined, false, c, sep]), [a, sep, b, sep, c]);
  assert.deepEqual(normalizeItems([sep]), []);
  assert.deepEqual(normalizeItems(undefined), []);
  assert.deepEqual(normalizeItems([a, c]), [a, c]);
});

test("menuSize: rows, separators, padding and border", () => {
  assert.deepEqual(menuSize([a, sep, c]), { width: MENU_WIDTH, height: 2 * ROW + SEPARATOR + 2 * PAD + 2 });
  assert.deepEqual(menuSize([sep, a, sep]), { width: MENU_WIDTH, height: ROW + 2 * PAD + 2 });
  assert.deepEqual(menuSize([a, b]), { width: MENU_WIDTH, height: 2 * ROW + 2 * PAD + 2 });
});

test("nextIndex: skips separators and disabled, wraps, -1 when none", () => {
  const items = [a, sep, b, c];
  assert.equal(nextIndex(items, -1, 1), 0);
  assert.equal(nextIndex(items, -1, -1), 3);
  assert.equal(nextIndex(items, 0, 1), 3);
  assert.equal(nextIndex(items, 3, 1), 0);
  assert.equal(nextIndex(items, 0, -1), 3);
  assert.equal(nextIndex(items, 3, -1), 0);
  assert.equal(nextIndex([sep, b, sep], -1, 1), -1);
  assert.equal(nextIndex([], -1, 1), -1);
});

test("openMenu: opens a pointer popup with normalized menu and extra props", () => {
  const calls = [];
  const openOverlay = (spec) => {
    calls.push(spec);
    return "ov-1";
  };
  const items = [sep, a, sep, sep, c, sep];
  assert.equal(openMenu({ openOverlay, mod: "ranch-x", items, extra: { target: { id: "t1" } } }), "ov-1");
  assert.deepEqual(calls, [
    {
      mod: "ranch-x",
      kind: "popup",
      frame: "none",
      at: "pointer",
      width: MENU_WIDTH,
      height: 2 * ROW + SEPARATOR + 2 * PAD + 2,
      props: { menu: [a, sep, c], target: { id: "t1" } },
    },
  ]);
});

test("openMenu: nothing selectable opens nothing", () => {
  let called = false;
  const openOverlay = () => {
    called = true;
    return "ov";
  };
  assert.equal(openMenu({ openOverlay, mod: "ranch-x", items: [sep, b, sep] }), null);
  assert.equal(openMenu({ openOverlay, mod: "ranch-x", items: [] }), null);
  assert.equal(called, false);
});

function deps(over = {}) {
  const got = [];
  return {
    got,
    run: (name, args) => got.push(["run", name, args]),
    setShared: (key, value) => got.push(["setShared", key, value]),
    exec: async (cmd, args, options) => {
      got.push(["exec", cmd, args, options]);
      return { code: 0, stdout: "", stderr: "" };
    },
    copy: (text) => got.push(["copy", text]),
    ...over,
  };
}

test("runAction: copy, run, exec and many", async () => {
  const d = deps();
  await runAction({ type: "copy", text: "hello" }, d);
  await runAction({ type: "run", name: "tab.new" }, d);
  await runAction({ type: "run", name: "space.new", args: { folder: "/tmp/x" } }, d);
  await runAction({ type: "exec", cmd: "git", args: ["status"], cwd: "/tmp", on: "m1" }, d);
  await runAction(
    {
      type: "many",
      actions: [
        { type: "copy", text: "one" },
        { type: "run", name: "a" },
        { type: "copy", text: "two" },
      ],
    },
    d,
  );
  assert.deepEqual(d.got, [
    ["copy", "hello"],
    ["run", "tab.new", {}],
    ["run", "space.new", { folder: "/tmp/x" }],
    ["exec", "git", ["status"], { cwd: "/tmp", on: "m1" }],
    ["copy", "one"],
    ["run", "a", {}],
    ["copy", "two"],
  ]);
});

test("runAction: request adds a nonce that increases between calls", async () => {
  const d = deps();
  await runAction({ type: "request", key: "ranch.tab", value: { id: "t1" } }, d);
  await runAction({ type: "request", key: "ranch.tab", value: { id: "t2" } }, d);
  assert.equal(d.got.length, 2);
  assert.equal(d.got[0][0], "setShared");
  assert.equal(d.got[0][1], "ranch.tab");
  assert.deepEqual({ ...d.got[0][2], nonce: 0 }, { id: "t1", nonce: 0 });
  assert.deepEqual({ ...d.got[1][2], nonce: 0 }, { id: "t2", nonce: 0 });
  assert.equal(typeof d.got[0][2].nonce, "number");
  assert.ok(d.got[1][2].nonce > d.got[0][2].nonce);
});

test("runAction: exec failure throws with stderr; unknown type throws", async () => {
  const failing = deps({
    exec: async () => ({ code: 2, stdout: "", stderr: "fatal: not a repo\n" }),
  });
  await assert.rejects(runAction({ type: "exec", cmd: "git", args: [] }, failing), /fatal: not a repo/);
  await assert.rejects(runAction({ type: "nope" }, deps()), /Unknown action/);
});

test("menuKey: arrows move, enter picks a selectable row, escape closes", () => {
  const items = [a, sep, b, c];
  assert.deepEqual(menuKey("down", items, -1), { active: 0 });
  assert.deepEqual(menuKey("down", items, 0), { active: 3 });
  assert.deepEqual(menuKey("up", items, 0), { active: 3 });
  assert.deepEqual(menuKey("arrowdown", items, 3), { active: 0 });
  assert.deepEqual(menuKey("arrowup", items, 3), { active: 0 });
  assert.deepEqual(menuKey("down", [sep, b], -1), {});
  assert.deepEqual(menuKey("enter", items, 3), { pick: 3 });
  assert.deepEqual(menuKey("enter", items, 0), { pick: 0 });
  assert.deepEqual(menuKey("enter", items, 1), {});
  assert.deepEqual(menuKey("enter", items, 2), {});
  assert.deepEqual(menuKey("enter", items, -1), {});
  assert.deepEqual(menuKey("escape", items, 0), { close: true });
  assert.deepEqual(menuKey("a", items, 0), {});
});
