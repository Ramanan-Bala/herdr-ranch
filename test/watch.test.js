import test from "node:test";
import assert from "node:assert/strict";
import { createWatchLoops } from "../lib/watch.js";

/**
 * Fake watch: records calls, returns promises resolved manually.
 * @returns {{ watch: (root: string) => Promise<any>,
 *             resolvers: Map<string, Array<(paths: any) => void>>,
 *             calls: Map<string, number>,
 *             resolve: (root: string, paths?: any) => void,
 *             reject: (root: string, err?: Error) => void,
 *             pending: (root: string) => number }}
 */
function fakeWatch() {
  /** @type {Map<string, Array<{promise: Promise<any>, res: (p: any) => void, rej: (e: Error) => void}>>} */
  const pendingByRoot = new Map();
  const calls = new Map();
  return {
    calls,
    watch(root) {
      calls.set(root, (calls.get(root) ?? 0) + 1);
      let res;
      let rej;
      const promise = new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
      });
      if (!pendingByRoot.has(root)) pendingByRoot.set(root, []);
      pendingByRoot.get(root).push({ promise, res, rej });
      return promise;
    },
    resolve(root, paths = []) {
      const entry = pendingByRoot.get(root)?.shift();
      assert.ok(entry, `no pending wait for ${root}`);
      entry.res(paths);
    },
    reject(root, err = new Error("boom")) {
      const entry = pendingByRoot.get(root)?.shift();
      assert.ok(entry, `no pending wait for ${root}`);
      entry.rej(err);
    },
    pending(root) {
      return (pendingByRoot.get(root) ?? []).length;
    },
  };
}

/** Let started loops advance to their next await. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Fake sleep that records delays and resolves immediately. */
function fakeSleep() {
  const delays = [];
  const sleep = (ms) => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

function setup() {
  const fw = fakeWatch();
  const fs = fakeSleep();
  const onChangeCalls = [];
  const loops = createWatchLoops({
    watch: fw.watch,
    onChange: (root, paths) => {
      onChangeCalls.push([root, paths]);
    },
    sleep: fs.sleep,
  });
  return { fw, fs, onChangeCalls, loops };
}

test("add 100 times starts exactly one loop", async () => {
  const { fw, loops } = setup();
  for (let i = 0; i < 100; i++) loops.add("root");
  await tick();
  assert.equal(fw.calls.get("root"), 1);
  assert.equal(fw.pending("root"), 1);
  assert.deepEqual([...loops.live()], ["root"]);
  assert.deepEqual([...loops.wanted()], ["root"]);
});

test("a change wakes the loop and it waits again", async () => {
  const { fw, onChangeCalls, loops } = setup();
  loops.add("root");
  await tick();
  fw.resolve("root", ["a.js"]);
  await tick();
  assert.deepEqual(onChangeCalls, [["root", ["a.js"]]]);
  assert.equal(fw.calls.get("root"), 2);
  assert.equal(fw.pending("root"), 1);
  assert.deepEqual([...loops.live()], ["root"]);
});

test("remove then pending resolve: no onChange, loop exits", async () => {
  const { fw, onChangeCalls, loops } = setup();
  loops.add("root");
  await tick();
  loops.remove("root");
  fw.resolve("root", ["a.js"]);
  await tick();
  assert.deepEqual(onChangeCalls, []);
  assert.equal(fw.calls.get("root"), 1);
  assert.deepEqual([...loops.live()], []);
  assert.deepEqual([...loops.wanted()], []);
});

test("remove then re-add before resolve reuses the pending loop", async () => {
  const { fw, onChangeCalls, loops } = setup();
  loops.add("root");
  await tick();
  loops.remove("root");
  loops.add("root");
  await tick();
  fw.resolve("root", ["a.js"]);
  await tick();
  assert.deepEqual(onChangeCalls, [["root", ["a.js"]]]);
  assert.equal(fw.calls.get("root"), 2);
  assert.equal(fw.pending("root"), 1);
  assert.deepEqual([...loops.live()], ["root"]);
});

// The sidebar's exact sequence (main.js refreshRepo/sweep): a repo is watched,
// sweep drops it (not wanted), a refresh re-adds it while the old loop's
// watchFolder wait is still pending. The pending loop must be reused: one
// onChange call and one new pending wait, never a second loop.
test("sidebar sequence: sweep remove then refresh re-add keeps one loop", async () => {
  const { fw, onChangeCalls, loops } = setup();
  loops.add("top");
  await tick();
  loops.remove("top"); // sweep: no longer wanted
  loops.add("top"); // refreshRepo re-adds while the wait is pending
  await tick();
  fw.resolve("top", ["a.js"]);
  await tick();
  assert.deepEqual(onChangeCalls, [["top", ["a.js"]]]);
  assert.equal(fw.calls.get("top"), 2);
  assert.equal(fw.pending("top"), 1);
  assert.deepEqual([...loops.live()], ["top"]);
});

test("after exit, add starts a fresh loop", async () => {
  const { fw, loops } = setup();
  loops.add("root");
  await tick();
  loops.remove("root");
  fw.resolve("root");
  await tick();
  assert.deepEqual([...loops.live()], []);
  loops.add("root");
  await tick();
  assert.equal(fw.calls.get("root"), 2);
  assert.equal(fw.pending("root"), 1);
  assert.deepEqual([...loops.live()], ["root"]);
});

test("watch failure sleeps then retries while wanted", async () => {
  const { fw, fs, loops } = setup();
  loops.add("root");
  await tick();
  fw.reject("root");
  await tick();
  assert.deepEqual(fs.delays, [5000]);
  await tick();
  assert.equal(fw.calls.get("root"), 2);
  assert.equal(fw.pending("root"), 1);
});

test("removed during error sleep: loop exits without retry", async () => {
  const { fw, loops } = setup();
  let wake;
  const delays = [];
  const loops2 = createWatchLoops({
    watch: fw.watch,
    onChange: () => {},
    sleep: (ms) => {
      delays.push(ms);
      return new Promise((r) => (wake = r));
    },
  });
  loops2.add("root");
  await tick();
  fw.reject("root");
  await tick();
  assert.deepEqual(delays, [5000]);
  loops2.remove("root");
  wake();
  await tick();
  assert.equal(fw.calls.get("root"), 1);
  assert.deepEqual([...loops.live()], []);
  assert.deepEqual([...loops2.live()], []);
});

test("onChange throwing does not kill the loop", async () => {
  const { fw, loops } = setup();
  let fail = true;
  const loops2 = createWatchLoops({
    watch: fw.watch,
    onChange: () => {
      if (fail) throw new Error("cb");
    },
    sleep: () => Promise.resolve(),
  });
  loops2.add("root");
  await tick();
  fw.resolve("root", ["a.js"]);
  await tick();
  fail = false;
  fw.resolve("root", ["b.js"]);
  await tick();
  assert.equal(fw.calls.get("root"), 3);
  assert.equal(fw.pending("root"), 1);
  assert.deepEqual([...loops2.live()], ["root"]);
  assert.deepEqual([...loops2.wanted()], ["root"]);
});

test("setWanted trims roots and never duplicates loops", async () => {
  const { fw, onChangeCalls, loops } = setup();
  loops.setWanted(["a", "b"]);
  await tick();
  assert.equal(fw.calls.get("a"), 1);
  assert.equal(fw.calls.get("b"), 1);
  loops.setWanted(["b"]);
  await tick();
  fw.resolve("a");
  await tick();
  assert.equal(fw.calls.get("a"), 1);
  assert.deepEqual([...loops.wanted()], ["b"]);
  assert.deepEqual([...loops.live()], ["b"]);
  for (let i = 0; i < 100; i++) loops.setWanted(["b"]);
  await tick();
  assert.equal(fw.pending("b"), 1);
  assert.equal(fw.calls.get("b"), 1);
  fw.resolve("b", ["x"]);
  await tick();
  assert.deepEqual(onChangeCalls, [["b", ["x"]]]);
  assert.equal(fw.calls.get("b"), 2);
});

test("falsy roots are ignored", async () => {
  const { fw, loops } = setup();
  loops.add("");
  loops.add(null);
  loops.add(undefined);
  loops.setWanted(["", "real", null]);
  await tick();
  assert.deepEqual([...loops.wanted()], ["real"]);
  assert.equal(fw.calls.get("real"), 1);
  assert.equal(fw.calls.get(""), undefined);
  loops.remove("");
  loops.remove(null);
  assert.deepEqual([...loops.wanted()], ["real"]);
});
