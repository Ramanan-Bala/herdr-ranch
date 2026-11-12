import test from "node:test";
import assert from "node:assert/strict";
import { HOME_RETRY_MS, homeCache, probeHome, windowsHomeFrom } from "../lib/home.js";

const REMOTE = "ssh:box";
const local = () => "/local";

/** A fake exec that answers each command from a handler map. */
function fakeExec(handlers) {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected exec: ${cmd}`);
    return typeof h === "function" ? await h(args, opts) : h;
  };
  fn.calls = calls;
  return fn;
}

test("windowsHomeFrom normalizes backslashes and rejects an unset variable", () => {
  assert.equal(windowsHomeFrom("C:\\Users\\x\r\n"), "C:/Users/x");
  assert.equal(windowsHomeFrom("%USERPROFILE%"), null);
  assert.equal(windowsHomeFrom(""), null);
});

test("probeHome uses sh first and does not fall back when it answers", async () => {
  let cmdCalled = 0;
  const exec = fakeExec({
    sh: () => ({ code: 0, stdout: "/home/me" }),
    "cmd.exe": () => { cmdCalled++; return { code: 0, stdout: "C:\\Users\\x" }; },
  });
  assert.equal(await probeHome(exec, REMOTE), "/home/me");
  assert.equal(cmdCalled, 0);
  assert.deepEqual(exec.calls[0].opts, { on: REMOTE });
});

test("probeHome falls back to cmd.exe when sh fails", async () => {
  const exec = fakeExec({
    sh: () => ({ code: 1, stdout: "" }),
    "cmd.exe": () => ({ code: 0, stdout: "C:\\Users\\x\r\n" }),
  });
  assert.equal(await probeHome(exec, REMOTE), "C:/Users/x");
});

test("probeHome returns null when USERPROFILE is unset", async () => {
  const exec = fakeExec({
    sh: () => ({ code: 1, stdout: "" }),
    "cmd.exe": () => ({ code: 0, stdout: "%USERPROFILE%\r\n" }),
  });
  assert.equal(await probeHome(exec, REMOTE), null);
});

test("homeCache: offline remembers the failure, no exec within the retry window", async () => {
  let now = 1_000;
  const exec = fakeExec({
    sh: () => { throw new Error("offline"); },
    "cmd.exe": () => { throw new Error("offline"); },
  });
  const homeFor = homeCache(exec, local, () => now);
  assert.equal(await homeFor(REMOTE), null);
  assert.equal(exec.calls.length, 2); // sh + cmd.exe
  assert.equal(await homeFor(REMOTE), null);
  assert.equal(await homeFor(REMOTE), null);
  assert.equal(exec.calls.length, 2); // remembered, not retried

  now += HOME_RETRY_MS + 1;
  assert.equal(await homeFor(REMOTE), null); // retries after the window
  assert.equal(exec.calls.length, 4);
});

test("homeCache: concurrent calls share one probe", async () => {
  let calls = 0;
  const exec = () =>
    new Promise((res) => {
      calls++;
      queueMicrotask(() => res({ code: 0, stdout: "/home/me" }));
    });
  const homeFor = homeCache(exec, local, () => 1_000);
  const [a, b] = await Promise.all([homeFor(REMOTE), homeFor(REMOTE)]);
  assert.equal(calls, 1);
  assert.equal(a, "/home/me");
  assert.equal(b, "/home/me");
  assert.equal(await homeFor(REMOTE), "/home/me"); // cached hit, no new probe
  assert.equal(calls, 1);
});

test("homeCache: local machine answers from local(), remote from exec", async () => {
  const exec = fakeExec({ sh: () => ({ code: 0, stdout: "/home/me" }) });
  const homeFor = homeCache(exec, local, () => 1_000);
  assert.equal(await homeFor(null), "/local");
  assert.equal(await homeFor(REMOTE), "/home/me");
  assert.equal(exec.calls.length, 1);
});
