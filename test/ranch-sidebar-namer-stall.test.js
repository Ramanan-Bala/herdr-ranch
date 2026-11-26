// The tab namer's pass must not freeze for good when a Herdr read never
// settles (seen across a mod reload): after PASS_STALL_MS the next tick starts
// a new pass, and the stalled one's late result is dropped. namer.js is
// loaded under Node with "herdr" stubbed (module.registerHooks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Copy lib/ only when missing: re-syncing here races other test files that
// import the copies while they are rewritten (npm test syncs first anyway).
const libDir = join(root, "mods/ranch-sidebar/lib");
for (const f of readdirSync(join(root, "lib"))) {
  if (!f.endsWith(".js") || existsSync(join(libDir, f))) continue;
  mkdirSync(libDir, { recursive: true });
  copyFileSync(join(root, "lib", f), join(libDir, f));
}

globalThis.__namer = { shared: { layout: "ranch" }, sets: [], reads: 0, hang: true };
const herdrSource = `
const H = globalThis.__namer;
export const spaces = () => [{ id: "s1", name: "proj", machine: null, tabs: [{ id: "tb1", name: "1" }] }];
export const agents = () => [{ address: "t1", tab: "tb1", pane: "p1", app: "pi", program: { name: "Pi" } }];
export const panes = () => [{ pane: "p1", tab: "tb1", terminal: "t1", cwd: "/home/u/proj" }];
export const terminals = () => [{ address: "t1", state: "live" }];
export const shared = (k) => H.shared[k];
export const setShared = (k, v) => { H.shared[k] = v; H.sets.push(k); };
export const run = () => {};
export const exec = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
export const readTextFile = () => { H.reads++; return H.hang ? new Promise(() => {}) : Promise.resolve(null); };
export const home = () => "/home/u";
export const watchFolder = (...a) => (globalThis.__namerWatch ? globalThis.__namerWatch(...a) : new Promise(() => {}));
`;
const data = (s) => `data:text/javascript,${encodeURIComponent(s)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "herdr") return { url: data(herdrSource), shortCircuit: true };
    return next(specifier, context);
  },
});

const { TabNamer, PASS_STALL_MS } = await import(join(root, "mods/ranch-sidebar/namer.js"));

const flush = () => new Promise((r) => setImmediate(r));
const cx = { spawn: (fn) => { fn(cx); }, timer: { every() {} }, notify() {} };

test("a stalled pass is replaced after PASS_STALL_MS, not waited on forever", async () => {
  const H = globalThis.__namer;
  const namer = new TabNamer();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    namer.tick(cx);
    await flush();
    assert.equal(H.reads, 1, "first pass reads the store and hangs");
    namer.tick(cx);
    await flush();
    assert.equal(H.reads, 1, "a tick inside the stall window does not overlap");
    now += PASS_STALL_MS + 1;
    H.hang = false;
    namer.tick(cx);
    for (let i = 0; i < 10; i++) await flush();
    assert.ok(H.reads >= 2, "the next tick after the stall starts a new pass");
    assert.equal(namer.running, false, "the new pass finishes");
  } finally {
    Date.now = realNow;
  }
});

test("store cache: local stores live until the tasks-folder watch fires; remote ones 5 s", () => {
  const namer = new TabNamer();
  const at = 1_000_000;
  // No watch (yet, or it failed): re-read every tick (2 s).
  assert.equal(namer.storeFresh({ at, gen: 0 }, null, at + 1999), true);
  assert.equal(namer.storeFresh({ at, gen: 0 }, null, at + 2001), false);
  // Watched and unchanged: kept for up to 30 s.
  namer.localWatched = true;
  assert.equal(namer.storeFresh({ at, gen: 0 }, null, at + 20_000), true);
  assert.equal(namer.storeFresh({ at, gen: 0 }, null, at + 30_001), false);
  // A change bumps the generation: the cached store is stale at once.
  namer.localGen = 1;
  assert.equal(namer.storeFresh({ at, gen: 0 }, null, at + 1), false);
  // Another machine: 5 s, whatever the local watch says.
  assert.equal(namer.storeFresh({ at, gen: 1 }, "box", at + 4_999), true);
  assert.equal(namer.storeFresh({ at, gen: 1 }, "box", at + 5_001), false);
});

test("watchLocalTasks bumps the generation on every change and marks a failed watch", async () => {
  const namer = new TabNamer();
  const events = [];
  let fire;
  globalThis.__namerWatch = () => new Promise((resolve, reject) => { fire = { resolve, reject }; });
  const cxw = { spawn: (fn) => { fn({ sleep: () => new Promise(() => {}) }); } };
  namer.watchLocalTasks(cxw);
  await flush();
  assert.equal(namer.localWatched, true);
  fire.resolve([]);
  await flush();
  events.push(namer.localGen);
  fire.reject(new Error("gone"));
  await flush();
  assert.equal(namer.localWatched, false);
  assert.equal(events[0], 1);
  assert.equal(namer.localGen, 2);
});
