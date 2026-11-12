// doctor runs synthetic hook events through node, so it must pick the
// installed .js entry, never the sh launcher installed beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath, doctor } from "../adapters/doctor.js";
import { install } from "../adapters/install.js";

test("doctor runs the installed ranch-tasks.js, not the sh launcher", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-"));
  const bin = join(home, ".herdr", "ranch", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ranch-tasks"), "#!/bin/sh\n# launcher\n");
  writeFileSync(join(bin, "ranch-tasks.js"), "// node entry\n");
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  assert.equal(cliPath(), join(bin, "ranch-tasks.js"));
});

// ------------------------------------------------- doctor() in a temp home

// A temp home with Ranch installed for codex only (claude/opencode stay
// "missing" there — the tests below assert on the codex checks alone).
// RANCH_HOME points doctor's homeDir at it for the whole test.
async function codexHome(t) {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-home-"));
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["codex"], noInstructions: true });
  return home;
}

const codexCheck = (report, name) => report.checks.find((c) => c.name === name);

test("doctor runs `ranch-tasks plan` end to end in an installed temp home", async (t) => {
  await codexHome(t);
  const report = await doctor();
  const plan = codexCheck(report, "codex plan command");
  assert.equal(plan.ok, true, plan.detail);
});

test("doctor reports 'needs approval' when only one Ranch hook is trusted", async (t) => {
  const home = await codexHome(t);
  // Codex 0.167 trust format: one nested table for one hook position, so the
  // other eight positions are undecided.
  const hooksPath = join(home, ".codex", "hooks.json");
  writeFileSync(join(home, ".codex", "config.toml"),
    `[hooks.state."${hooksPath}:session_start:0:0"]\ntrusted_hash = "abc123"\n`);
  const report = await doctor();
  const approval = codexCheck(report, "codex hook approval");
  assert.equal(approval.ok, false, approval.detail);
});

test("doctor marks hook approval unknown without config.toml", async (t) => {
  await codexHome(t);
  const report = await doctor();
  const approval = codexCheck(report, "codex hook approval");
  assert.equal(approval.ok, true, approval.detail);
  assert.equal(approval.unknown, true);
});

test("doctor reports update_plan enabled from config.toml", async (t) => {
  const home = await codexHome(t);
  writeFileSync(join(home, ".codex", "config.toml"), "[tools.update_plan]\nenabled = true\n");
  const report = await doctor();
  const tool = codexCheck(report, "codex update_plan tool");
  assert.ok(tool.detail.startsWith("enabled"), tool.detail);
});
