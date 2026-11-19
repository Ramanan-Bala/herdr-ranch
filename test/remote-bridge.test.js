// tests lib/remote-bridge.js: copying the task-reporting bridge to a machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGE_FILES, PUSH_SCRIPT, REMOTE_SCRIPT, bridgeMissing, cleanCommit, commitFromManifest,
  pushBlocker, pushBridge, pushBridgeArgs, pushResultText,
} from "../lib/remote-bridge.js";

test("pushBridgeArgs keeps the machine and commit out of the script text", () => {
  const [cmd, args] = pushBridgeArgs("box; rm -rf /", "abc1234");
  assert.equal(cmd, "sh");
  assert.deepEqual(args, ["-c", PUSH_SCRIPT, "ranch-push", "box; rm -rf /", "abc1234", REMOTE_SCRIPT]);
  assert.equal(pushBridgeArgs("m", "$(evil)")[1][4], "");
});

test("cleanCommit and commitFromManifest accept only hex commits", () => {
  assert.equal(cleanCommit("7e5fe24"), "7e5fe24");
  assert.equal(cleanCommit("main"), "");
  assert.equal(commitFromManifest('{"commit":"7e5fe24aa"}'), "7e5fe24aa");
  assert.equal(commitFromManifest("nope"), "");
  assert.equal(commitFromManifest(null), "");
});

test("pushBlocker explains what stops a push", () => {
  assert.match(pushBlocker({ machine: null }), /this computer/);
  assert.match(pushBlocker({ machine: "b", localWindows: true, remoteHome: "/home/x" }), /sh and tar/);
  assert.equal(pushBlocker({ machine: "b", remoteHome: null }), "Can't reach b.");
  assert.match(pushBlocker({ machine: "b", remoteHome: "C:/Users/x" }), /Windows/);
  assert.equal(pushBlocker({ machine: "b", remoteHome: "/home/x" }), null);
});

test("bridgeMissing reads a missing launcher, not an ordinary failure", () => {
  assert.equal(bridgeMissing(null), true);
  assert.equal(bridgeMissing({ code: 127, stdout: "", stderr: "" }), true);
  assert.equal(bridgeMissing({ code: 1, stdout: "", stderr: "sh: /x/ranch-tasks: No such file or directory" }), true);
  assert.equal(bridgeMissing({ code: 1, stdout: "", stderr: "boom" }), false);
  assert.equal(bridgeMissing({ code: 0, stdout: "{}", stderr: "" }), false);
});

test("pushResultText names the machine on failure", () => {
  assert.equal(pushResultText("b", { code: 0, stdout: "", stderr: "" }), "Task reporting set up on b.");
  assert.match(pushResultText("b", { code: 3, stdout: "", stderr: "" }), /set it up here first/);
  assert.match(pushResultText("b", { code: 1, stdout: "", stderr: "tar: bad" }), /^b: tar: bad/);
  assert.match(pushResultText("b", null), /Couldn't copy/);
});

test("pushBridge passes the local commit and never rejects", async () => {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push([cmd, args, opts]);
    return { code: 0, stdout: "node  ok", stderr: "" };
  };
  const r = await pushBridge({
    exec, machine: "box", localHome: "/Users/me", remoteHome: "/home/me",
    readLocal: async (p) => (p === "/Users/me/.herdr/ranch/update.json" ? '{"commit":"abcdef1"}' : null),
  });
  assert.deepEqual(r, { ok: true, text: "node  ok" });
  assert.equal(calls[0][1][3], "box");
  assert.equal(calls[0][1][4], "abcdef1");
  assert.equal(calls[0][2].on, undefined);
  const bad = await pushBridge({ exec: async () => { throw new Error("gone"); }, machine: "box", localHome: "/h", remoteHome: "/r", readLocal: async () => null });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /gone/);
});

test("the push script copies the bridge files and runs install there", () => {
  // A fake `hc` that runs the remote script locally under another HOME.
  const root = mkdtempSync(join(tmpdir(), "ranch-push-"));
  const local = join(root, "local"), remote = join(root, "remote"), bin = join(root, "bin");
  for (const d of ["bin", "adapters", "lib", "tasks"]) mkdirSync(join(local, ".herdr/ranch", d), { recursive: true });
  writeFileSync(join(local, ".herdr/ranch/bin/ranch-tasks"), '#!/bin/sh\necho "ran $*" > "$(dirname "$0")/../ran.txt"\n');
  writeFileSync(join(local, ".herdr/ranch/bin/ranch-tasks.js"), "// js\n");
  writeFileSync(join(local, ".herdr/ranch/adapters/a.js"), "// a\n");
  writeFileSync(join(local, ".herdr/ranch/lib/tasks.js"), "// t\n");
  writeFileSync(join(local, ".herdr/ranch/package.json"), "{}\n");
  writeFileSync(join(local, ".herdr/ranch/tasks/t1.json"), "{}\n");
  mkdirSync(remote);
  mkdirSync(bin);
  // hc exec -i --on <m> sh -c <script> <name> <args...>
  writeFileSync(join(bin, "hc"), `#!/bin/sh\nshift 4\nHOME="${remote}" exec "$@"\n`, { mode: 0o755 });
  const [cmd, args] = pushBridgeArgs("box", "abcdef1");
  execFileSync(cmd, args, { env: { ...process.env, HOME: local, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
  const d = join(remote, ".herdr/ranch");
  for (const rel of ["bin/ranch-tasks.js", "adapters/a.js", "lib/tasks.js", "package.json"]) assert.ok(existsSync(join(d, rel)), rel);
  assert.equal(existsSync(join(d, "tasks/t1.json")), false);
  assert.equal(readFileSync(join(d, "ran.txt"), "utf8"), "ran install --yes\n");
  assert.deepEqual(JSON.parse(readFileSync(join(d, "update.json"), "utf8")), { version: 1, commit: "abcdef1", bridgeOnly: true, files: {} });
  assert.ok(BRIDGE_FILES.includes("adapters"));
});
