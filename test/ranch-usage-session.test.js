// Unit tests for ranch-usage's session-usage support decision (audit finding 17):
// which focused terminals may read session usage without reading another
// machine's process against local files. Pure, inline; no Herdr touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { sessionUsageSupport } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/usage/session-support.js")).href
);

test("local terminal: session usage supported", () => {
  assert.deepEqual(sessionUsageSupport({ remote: false, agent: "claude", platform: "macos" }), { ok: true });
  assert.deepEqual(sessionUsageSupport({ remote: false, agent: "codex", platform: "macos" }), { ok: true });
  assert.deepEqual(sessionUsageSupport({ remote: false, agent: "codex", platform: "linux" }), { ok: true });
  assert.deepEqual(sessionUsageSupport({ remote: false, agent: null, platform: "macos" }), { ok: true });
});

test("remote terminal: never read local files with its PID", () => {
  for (const agent of [null, "claude", "codex"]) {
    for (const platform of ["macos", "windows", "linux"]) {
      const r = sessionUsageSupport({ remote: true, agent, platform });
      assert.equal(r.ok, false, `agent=${agent} platform=${platform}`);
      assert.match(r.reason, /remote/);
    }
  }
});

test("codex on Windows: pgrep/lsof don't exist, so not available", () => {
  const r = sessionUsageSupport({ remote: false, agent: "codex", platform: "windows" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Windows/);
});

test("claude on Windows still works: file reading only", () => {
  assert.deepEqual(sessionUsageSupport({ remote: false, agent: "claude", platform: "windows" }), { ok: true });
});
