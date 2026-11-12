// Unit tests for mods/ranch-changes/model.js (pure helpers only).
// Regression tests for the audit fix: a context switch while a git read is in
// flight must never show the old workspace's files/diff/root/message, and the
// newer context's read must start as soon as the older one settles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { requestGate, headerLabel } = await import(
  pathToFileURL(join(root, "mods/ranch-changes/model.js")).href
);

test("requestGate: starts the first request with token 1", () => {
  const gate = requestGate();
  assert.deepEqual(gate.plan("A"), { action: "start", token: 1, context: "A" });
});

test("requestGate: refresh while the same context is loading waits, no new token", () => {
  const gate = requestGate();
  gate.plan("A");
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
});

test("hold A open, switch to B: B is queued, A's result is rejected, B starts immediately", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  assert.equal(a.action, "start");
  // Context switches to B while A's read is in flight.
  assert.deepEqual(gate.plan("B"), { action: "queue", token: 1, context: "B" });
  // A's read finishes but the focused context is now B: nothing applies.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
  // The pending read starts right away (not on the 10s timer).
  assert.deepEqual(gate.plan("B"), { action: "start", token: 2, context: "B" });
  assert.deepEqual(gate.settle(2, "B"), { apply: true, restart: false });
});

test("an old completion must not clear a newer request's loading state", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  gate.plan("B"); // queued
  gate.settle(a.token, "B"); // A settles, B restarts
  const b = gate.plan("B");
  assert.equal(b.token, 2);
  // A duplicate/late completion for token 1 arrives after token 2 started.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: false });
  assert.deepEqual(gate.settle(b.token, "B"), { apply: true, restart: false });
});

test("rapid A->B->A: only the final A request's result is applied", () => {
  const gate = requestGate();
  const a = gate.plan("A");
  assert.equal(gate.plan("B").action, "queue");
  // Back to A while A is still in flight: the queued B is dropped.
  assert.deepEqual(gate.plan("A"), { action: "wait", token: 1, context: "A" });
  assert.deepEqual(gate.settle(a.token, "A"), { apply: true, restart: false });
});

test("a duplicate stale completion after a newer request started is a no-op", () => {
  const gate = requestGate();
  const a = gate.plan("A"); // token 1, in flight
  gate.plan("B"); // queued
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
  const b = gate.plan("B"); // token 2 starts immediately
  assert.equal(b.action, "start");
  // A late duplicate completion for token 1 must not apply or restart anything.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: false });
});

test("commit in progress: the new context is queued and starts when the commit settles", () => {
  const gate = requestGate();
  assert.deepEqual(gate.plan("A", true), { action: "queue", token: null, context: "A" });
  assert.deepEqual(gate.plan("B", true), { action: "queue", token: null, context: "B" });
  // Commit finishes; the next refresh starts the queued context immediately.
  assert.deepEqual(gate.plan("B", false), { action: "start", token: 1, context: "B" });
});

test("commit settling lets the very next refresh start a read", () => {
  const gate = requestGate();
  gate.plan("A", true); // busy: queued
  gate.plan("A", false); // busy over: starts now, does not stay queued
  assert.deepEqual(gate.settle(1, "A"), { apply: true, restart: false });
});

test("headerLabel: folder name, machine only when remote", () => {
  assert.equal(headerLabel("/home/me/projects/ranch", null, "/home/me"), "ranch");
  assert.equal(headerLabel("/home/me/projects/ranch", "box1", "/home/me"), "ranch · box1");
  assert.equal(headerLabel(null, "box1", "/home/me"), null);
  assert.equal(headerLabel("/Volumes/disk/", null, "/home/me"), "disk");
});

test("a stale completion restarts even when no refresh queued the new context", async () => {
  const { requestGate } = await import(pathToFileURL(join(root, "mods/ranch-changes/model.js")).href);
  const gate = requestGate();
  const a = gate.plan("A");
  // Focus moved to B but no render called plan("B") yet.
  assert.deepEqual(gate.settle(a.token, "B"), { apply: false, restart: true });
});
