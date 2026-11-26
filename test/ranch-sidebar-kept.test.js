// Wiring tests for the kept-folder pipeline of mods/ranch-sidebar/main.js:
// a space whose last terminal ends (typing `exit`) must keep its kept entry
// through the degraded renders before Herdr closes the space. main.js is
// loaded under Node with the bare imports "herdr", "gpui-kit" and "gpui-base"
// replaced by in-test stubs (module.registerHooks); the git lookup is fed in
// directly through model.js spaceGitState so the sequence is deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const {
  normalizeKept, spaceGitState, refreshKept, dormantFolders,
} = await import(pathToFileURL(join(root, "mods/ranch-sidebar/model.js")).href);

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
};

// The herdr surface the tests drive: spaces()/panes() change per render.
globalThis.__herdr = {
  spaces: () => [],
  panes: () => [],
  agents: () => [],
  terminals: () => [],
  machines: () => [{ name: null, layout: "ready" }],
  home: () => "/Users/ramanan",
  shared: () => undefined,
  setShared: () => {},
  run: () => {},
  openOverlay: () => {},
  exec: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
  watchFolder: () => new Promise(() => {}),
  readTextFile: () => Promise.resolve(null),
  nextCommand: () => new Promise(() => {}),
  setAgentOrder: () => null,
  window: () => ({ platform: "macos" }),
};

const herdrSource = `
const H = globalThis.__herdr;
export const spaces = () => H.spaces();
export const panes = () => H.panes();
export const agents = () => H.agents();
export const terminals = () => H.terminals();
export const machines = () => H.machines();
export const home = () => H.home();
export const shared = (k) => H.shared(k);
export const setShared = (k, v) => H.setShared(k, v);
export const run = (n, a) => H.run(n, a);
export const openOverlay = (o) => H.openOverlay(o);
export const exec = (...a) => H.exec(...a);
export const watchFolder = (...a) => H.watchFolder(...a);
export const readTextFile = (...a) => H.readTextFile(...a);
export const nextCommand = () => H.nextCommand();
export const setAgentOrder = (o) => H.setAgentOrder(o);
export const window = () => H.window();
export const theme = () => new Proxy({}, { get: () => "#fff" });
`;

const chainSource = `
const chain = () => new Proxy(() => {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => "" : (..._args) => chain()),
  apply: () => chain(),
});
export default chain;
`;

const gpuiKitSource = `
${chainSource}
export class View {}
export const div = () => chain();
export const svg = () => chain();
export const image = () => chain();
`;

const gpuiBaseSource = `
${chainSource}
export const HoverCard = { new: () => chain() };
export const v_flex = () => chain();
export const h_flex = () => chain();
export const InputState = { new: () => chain() };
export const Input = { new: () => chain() };
`;

const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "herdr") return { url: data(herdrSource), shortCircuit: true };
    if (specifier === "gpui-kit") return { url: data(gpuiKitSource), shortCircuit: true };
    if (specifier === "gpui-base") return { url: data(gpuiBaseSource), shortCircuit: true };
    return nextResolve(specifier, _context);
  },
});

const RanchSidebar = (await import(join(root, "mods/ranch-sidebar/main.js"))).default;

// ---- fixtures ------------------------------------------------------------

const HOME = "/Users/ramanan";
const FOO = "/Users/ramanan/Projects/foo";
const DONEGATE = "/Users/ramanan/Projects/donegate";
const RANCH = "/Users/ramanan/Projects/ranch";

const tab = (id) => ({
  id, index: 1, name: id, named: false, active: true, status: null, panes: 1, settled: false,
});
const space = (id, folder, tabs, over = {}) => ({
  id, index: 1, name: over.name ?? folder, named: over.named ?? false, folder,
  machine: over.machine ?? null, branch: null, active: false, status: null, tabs,
});
const pane = (tabId, cwd) => ({ pane: `p-${tabId}`, tab: tabId, cwd, branch: null });
const card = (tabId, cwd, top) => ({ tabId, cwd, top });

/** A fresh view with the kept store the user reported (home, donegate, ranch). */
function freshView(kept) {
  store.clear();
  store.set("keptFolders", JSON.stringify(kept));
  const cx = {
    focus_handle: () => ({}),
    notify() {},
    timer: { every: () => 0, after: () => 0 },
    spawn: (fn) => { void Promise.resolve().then(() => fn(cx)).catch(() => {}); },
    sleep: () => Promise.resolve(),
    write_to_clipboard() {},
  };
  const view = new RanchSidebar();
  view.init({}, cx);
  return view;
}

const REPORTED = [
  { machine: null, folder: HOME, raw: HOME, name: "Root", named: true, color: null },
  { machine: null, folder: DONEGATE, raw: DONEGATE, name: "donegate", named: false, color: null },
  { machine: null, folder: RANCH, raw: RANCH, name: "ranch", named: false, color: "ansi3" },
];

/** One render's kept block exactly as main.js render() does it. */
function step(view, { spaces = [], panes = [], cards = [] }) {
  globalThis.__herdr.spaces = () => spaces;
  globalThis.__herdr.panes = () => panes;
  const tree = {
    groups: [{ machine: null, spaces: cards.map((c) => ({
      space: c.space, cards: c.cards, settled: [], checkout: c.checkout ?? null,
    })) }],
  };
  const live = view.liveKept(spaces, panes, spaceGitState(tree));
  const refreshed = refreshKept(view.kept,
    live.filter((l) => l.resolved && !l.linked && !l.degraded),
    live.filter((l) => l.linked));
  view.kept = refreshed.list;
  const dormant = dormantFolders(view.kept, live.filter((l) => !l.linked), { home: HOME });
  return { live, dormant, kept: view.kept };
}

const folders = (list) => list.map((e) => e.folder);
const fooSpace = (folder = HOME) => space("spFoo", folder, [tab("tFoo")], { name: "foo" });
const fooCards = (cwd, top) => [{ space: "spFoo", cards: [card("tFoo", cwd, top)] }];

// ---- the sequence -------------------------------------------------------

test("kept pipeline: a shell exit keeps the folder through every degraded render", () => {
  const view = freshView(REPORTED);

  // (a) The space is live in foo (its creation folder is elsewhere, as Herdr
  // keeps SpaceInfo.folder; the pane's cwd is where the space is now).
  let r = step(view, {
    spaces: [fooSpace()],
    panes: [pane("tFoo", FOO)],
    cards: fooCards(FOO, null),
  });
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]);
  assert.equal(r.dormant.some((e) => e.folder === FOO), false);

  // (b1) `exit`: the terminal is gone, the tab has no panes, the space still
  // lists itself with no folder ("" = that machine's home).
  r = step(view, {
    spaces: [fooSpace("")],
    panes: [],
    cards: fooCards(null, undefined),
  });
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]); // nothing dropped
  // Its own row is suppressed while the space is still there, not duplicated.
  assert.deepEqual(folders(r.dormant), [HOME, DONEGATE, RANCH]);

  // (b2) the same render with SpaceInfo.folder falling back to the home folder.
  r = step(view, {
    spaces: [fooSpace(HOME)],
    panes: [],
    cards: fooCards(null, undefined),
  });
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]);
  // The home entry stays visible: home is not the missing space.
  assert.deepEqual(folders(r.dormant), [HOME, DONEGATE, RANCH]);

  // (b3) the transient reports cwd = home (the dying terminal's fallback).
  r = step(view, {
    spaces: [fooSpace(HOME)],
    panes: [pane("tFoo", HOME)],
    cards: fooCards(HOME, null),
  });
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]);
  // The home entry was not re-keyed or renamed into foo's space.
  assert.deepEqual(r.kept.slice(0, 3), REPORTED);
  assert.deepEqual(folders(r.dormant), [HOME, DONEGATE, RANCH]);

  // (c) Herdr closes the space: both the folder and home draw as dormant.
  r = step(view, {});
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]);
  assert.deepEqual(folders(r.dormant), [HOME, DONEGATE, RANCH, FOO]);
  assert.equal(r.kept[3].name, "foo");
});

test("kept pipeline: a space made in another kept folder does not fold that entry", () => {
  const view = freshView(REPORTED);
  // The space was made in donegate (a kept entry!) and works in foo.
  const sp = space("spR", DONEGATE, [tab("tR")], { name: "ranch" });
  step(view, {
    spaces: [sp], panes: [pane("tR", FOO)],
    cards: [{ space: "spR", cards: [card("tR", FOO, null)] }],
  });
  // Degraded: no pane; the creation folder is another kept entry. It must not
  // be re-keyed or folded away, and only the space's own folder is suppressed.
  const r = step(view, {
    spaces: [sp],
    panes: [],
    cards: [{ space: "spR", cards: [card("tR", null, undefined)] }],
  });
  assert.deepEqual(folders(r.kept), [HOME, DONEGATE, RANCH, FOO]);
  assert.deepEqual(folders(r.dormant), [HOME, DONEGATE, RANCH]);
});
