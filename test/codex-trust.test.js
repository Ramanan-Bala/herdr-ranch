// Nested codex hook trust (current Codex 0.167.x format): trust entries live
// under [hooks.state] as `<hooks.json path>:<event>:<group>:<hook>` keys, in
// header-table, inline-table or dotted spellings, and update_plan detection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTrustState, codexUpdatePlanEnabled, install, pruneCodexTrustText } from "../adapters/install.js";

const HOOKS_PATH = "/Users/a/.codex/hooks.json";
const MARK = "/x/.herdr/ranch/bin/ranch-tasks codex";

const HOOKS_DOC = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: MARK, timeout: 5 }] }],
    PostToolUse: [{ matcher: "update_plan", hooks: [{ type: "command", command: MARK, timeout: 5 }] }],
  },
};

// ------------------------------------------------- nested trust: header tables

test("nested header tables: all ranch positions trusted", () => {
  const text = `[model]
gpt = "5"

[hooks.state."${HOOKS_PATH}:session_start:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."${HOOKS_PATH}:post_tool_use:0:0"]
trusted_hash = "sha256:def"
enabled = true
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, HOOKS_PATH), "trusted");
});

test("nested header tables: one position missing -> needs approval", () => {
  const text = `[hooks.state."${HOOKS_PATH}:session_start:0:0"]
trusted_hash = "sha256:abc"
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, HOOKS_PATH), "needs approval");
});

test("nested header tables: enabled = false -> needs approval", () => {
  const text = `[hooks.state."${HOOKS_PATH}:session_start:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."${HOOKS_PATH}:post_tool_use:0:0"]
trusted_hash = "sha256:def"
enabled = false
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, HOOKS_PATH), "needs approval");
});

test("nested header tables: no trusted_hash (only enabled) -> needs approval", () => {
  const text = `[hooks.state."${HOOKS_PATH}:session_start:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."${HOOKS_PATH}:post_tool_use:0:0"]
enabled = true
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, HOOKS_PATH), "needs approval");
});

// ------------------------------------------------------------------- windows

test("windows: literal-quoted key with backslashes and case-insensitive path", () => {
  const text = `["hooks"."state".'C:\\Users\\A\\.codex\\hooks.json:session_start:0:0']
trusted_hash = "sha256:abc"

["hooks"."state".'C:\\Users\\a\\.codex\\hooks.json:post_tool_use:0:0']
trusted_hash = "sha256:def"
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, "C:\\Users\\a\\.codex\\hooks.json"), "trusted");
});

// --------------------------------------------- nested trust: [hooks.state] forms

test("inline tables and dotted keys under [hooks.state] work", () => {
  const inline = `[hooks.state]
"${HOOKS_PATH}:session_start:0:0" = { trusted_hash = "sha256:abc" }
"${HOOKS_PATH}:post_tool_use:0:0" = { trusted_hash = "sha256:def", enabled = false }
`;
  assert.equal(codexTrustState(HOOKS_DOC, inline, HOOKS_PATH), "needs approval");
  assert.equal(
    codexTrustState(
      HOOKS_DOC,
      `[hooks.state]\n"${HOOKS_PATH}:session_start:0:0" = { trusted_hash = "sha256:abc" }\n"${HOOKS_PATH}:post_tool_use:0:0" = { trusted_hash = "sha256:def" }\n`,
      HOOKS_PATH,
    ),
    "trusted",
  );
});

test("dotted keys under [hooks.state] work", () => {
  const dotted = `[hooks.state]
"${HOOKS_PATH}:session_start:0:0".trusted_hash = "sha256:abc"
"${HOOKS_PATH}:post_tool_use:0:0".trusted_hash = "sha256:def"
`;
  assert.equal(codexTrustState(HOOKS_DOC, dotted, HOOKS_PATH), "trusted");
});

// ------------------------------------------------------- other paths / legacy

test("an entry for a different hooks.json path does not count", () => {
  const text = `[hooks.state."/repo/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."/repo/.codex/hooks.json:post_tool_use:0:0"]
trusted_hash = "sha256:def"
`;
  assert.equal(codexTrustState(HOOKS_DOC, text, HOOKS_PATH), "needs approval");
});

test("legacy-only text still works through the new signature", () => {
  const trusted = `[hooks.state]
"session_start:0:0" = true
"post_tool_use:0:0" = true
`;
  assert.equal(codexTrustState(HOOKS_DOC, trusted, HOOKS_PATH), "trusted");
  assert.equal(codexTrustState(HOOKS_DOC, trusted), "trusted");
  assert.equal(
    codexTrustState(HOOKS_DOC, `[hooks.state]\n"session_start:0:0" = true\n`, HOOKS_PATH),
    "needs approval",
  );
});

test("no trust info at all -> null", () => {
  assert.equal(codexTrustState(HOOKS_DOC, "[model]\nx = 1\n", HOOKS_PATH), null);
  assert.equal(codexTrustState(HOOKS_DOC, "", HOOKS_PATH), null);
});

// ------------------------------------------------------------------- pruning

test("prune: file with only nested entries returns null", () => {
  const text = `[hooks.state."${HOOKS_PATH}:session_start:0:0"]
trusted_hash = "sha256:abc"

[hooks.state."${HOOKS_PATH}:post_tool_use:0:0"]
trusted_hash = "sha256:def"
`;
  assert.equal(pruneCodexTrustText(text, HOOKS_DOC), null);
});

test("prune: mixed file prunes only stale legacy keys, nested survive", () => {
  const text = `"$schema" = "x"

[hooks.state]
"session_start:0:0" = true
"gone:2:1" = true
"${HOOKS_PATH}:post_tool_use:0:0" = { trusted_hash = "sha256:def" }
"post_tool_use:0:0" = true

[other]
key = "value"
`;
  const pruned = pruneCodexTrustText(text, HOOKS_DOC);
  assert.ok(pruned.includes('"session_start:0:0" = true'));
  assert.ok(pruned.includes('"post_tool_use:0:0" = true'));
  assert.ok(pruned.includes('{ trusted_hash = "sha256:def" }'));
  assert.ok(!pruned.includes('"gone:2:1"'));
  assert.ok(pruned.includes("[other]"));
});

test("prune: inline nested entry under [hooks.state] survives", () => {
  const text = `[hooks.state]
"gone:2:1" = true
"${HOOKS_PATH}:session_start:0:0" = { trusted_hash = "sha256:abc", enabled = false }
`;
  const pruned = pruneCodexTrustText(text, HOOKS_DOC);
  assert.ok(pruned.includes('{ trusted_hash = "sha256:abc", enabled = false }'));
  assert.ok(!pruned.includes('"gone:2:1"'));
});

// ------------------------------------------------------------- update_plan tool

test("codexUpdatePlanEnabled: [tools.update_plan] + enabled = true", () => {
  assert.equal(codexUpdatePlanEnabled(`[tools.update_plan]\nenabled = true\n`), true);
  assert.equal(codexUpdatePlanEnabled(`[tools.update_plan]\nenabled = false\n`), false);
});

test("codexUpdatePlanEnabled: [tools] inline and dotted spellings", () => {
  assert.equal(codexUpdatePlanEnabled(`[tools]\nupdate_plan = { enabled = true }\n`), true);
  assert.equal(codexUpdatePlanEnabled(`[tools]\nupdate_plan.enabled = true\n`), true);
});

test("codexUpdatePlanEnabled: root dotted spelling", () => {
  assert.equal(codexUpdatePlanEnabled(`tools.update_plan.enabled = true\n`), true);
});

test("codexUpdatePlanEnabled: profile-only enable -> false; empty -> false", () => {
  assert.equal(codexUpdatePlanEnabled(`[profiles.work]\ntools.update_plan.enabled = true\n`), false);
  assert.equal(codexUpdatePlanEnabled(""), false);
  assert.equal(codexUpdatePlanEnabled(undefined), false);
});

// ------------------------------------------------------------------- install

test("install copies lib/tasks-command.js into ~/.herdr/ranch/lib", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-codex-"));
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.RANCH_HOME;
    else process.env.RANCH_HOME = saved;
  });
  await install({ yes: true, agents: ["codex"] });
  assert.ok(existsSync(join(home, ".herdr", "ranch", "lib", "tasks-command.js")));
});
