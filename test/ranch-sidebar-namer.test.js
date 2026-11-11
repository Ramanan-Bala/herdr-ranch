// Unit tests for mods/ranch-sidebar/namer-model.js (pure helpers only).
// The lib/ copies under mods/ are made by scripts/sync-lib.sh (only into mods
// with a main.js), so this file copies them itself when missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const libDir = join(root, "mods/ranch-sidebar/lib");
if (!existsSync(join(libDir, "naming.js"))) {
  mkdirSync(libDir, { recursive: true });
  for (const f of readdirSync(join(root, "lib"))) {
    if (f.endsWith(".js")) copyFileSync(join(root, "lib", f), join(libDir, f));
  }
}

const { agentShort, collectInputs, buildModelPrompt } = await import("../mods/ranch-sidebar/namer-model.js");

test("agentShort keeps the first word of a program name", () => {
  assert.equal(agentShort("Claude Code"), "Claude");
  assert.equal(agentShort("OpenCode"), "OpenCode");
  assert.equal(agentShort("zsh"), "zsh");
  assert.equal(agentShort(null), null);
  assert.equal(agentShort("   "), null);
});

test("collectInputs ranks agent title over prompt, branch and provisional", () => {
  const base = {
    agentName: "Claude",
    repo: "ranch",
    branch: "feature/fix-login",
    firstPrompt: "fix the login redirect loop on Safari",
  };
  const withTitle = collectInputs({
    ...base,
    agentTitle: "Claude Code — Fix login",
    settings: { naming: { followAgent: true } },
  });
  assert.deepEqual(withTitle, { name: "Fix login", source: "agent_auto" });

  const promptOnly = collectInputs({
    ...base,
    agentTitle: null,
    settings: { naming: { followAgent: true } },
  });
  assert.deepEqual(promptOnly, { name: "Fix login redirect loop on Safari", source: "prompt" });

  const withPrompt = collectInputs({
    ...base,
    settings: { naming: { followAgent: true } },
  });
  assert.equal(withPrompt.source, "prompt");
});

test("collectInputs ignores both agent-provided titles when followAgent is false", () => {
  const inputs = {
    agentTitle: "Refactor db layer",
    agentTitleSource: "agent",
    terminalTitle: "Fix login",
    firstPrompt: "fix the login redirect loop on Safari",
    agentName: "Claude",
    repo: "ranch",
    branch: "feature/fix-login",
    settings: { naming: { followAgent: false } },
  };
  const c = collectInputs(inputs);
  assert.deepEqual(c, { name: "Fix login redirect loop on Safari", source: "prompt" });
});

test("collectInputs treats a missing settings object as followAgent on", () => {
  const c = collectInputs({
    agentTitle: "Refactor db layer",
    agentName: "Claude",
    repo: "ranch",
    settings: null,
  });
  assert.deepEqual(c, { name: "Refactor db layer", source: "agent_auto" });
});

test("collectInputs returns the provisional name when nothing else exists", () => {
  const c = collectInputs({ agentName: "Claude", repo: "ranch", settings: { naming: {} } });
  assert.deepEqual(c, { name: "Claude · ranch", source: "provisional" });
});

test("collectInputs returns null with no inputs at all", () => {
  assert.equal(collectInputs({ settings: { naming: {} } }), null);
});

test("buildModelPrompt caps the prompt at 500 characters", () => {
  const p = buildModelPrompt("x".repeat(600));
  assert.ok(p.startsWith("Reply with only a 3-5 word title for this coding task: "));
  assert.ok(p.length <= 500 + 55);
  assert.equal(p.length, 55 + 500);
});

test("namer.js parses as valid module syntax", () => {
  execFileSync(process.execPath, ["--check", join(root, "mods/ranch-sidebar/namer.js")]);
});
