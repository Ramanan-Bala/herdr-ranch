// doctor runs synthetic hook events through node, so it must pick the
// installed .js entry, never the sh launcher installed beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

test("doctor runs the pi synthetic session end to end when Pi is installed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-pi-"));
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["pi"], noInstructions: true });

  const report = await doctor();
  const hooks = codexCheck(report, "pi hooks");
  assert.equal(hooks.ok, true, hooks.detail);
  const synthetic = codexCheck(report, "pi synthetic event");
  assert.equal(synthetic.ok, true, synthetic.detail);
});

test("doctor skips (does not fail) antigravity checks when antigravity is missing", async (t) => {
  const home = await codexHome(t);
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; });
  const report = await doctor();
  const agyChecks = report.checks.filter((c) => c.name.startsWith("antigravity"));
  assert.deepEqual(agyChecks, []);
});

test("doctor checks antigravity plugin files presence and ownership", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-agy-files-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["antigravity"] });

  let report = await doctor();
  assert.equal(codexCheck(report, "antigravity hooks")?.ok, true);
  assert.equal(codexCheck(report, "antigravity plugin files")?.ok, true);

  // Tamper with hooks.json (while keeping Ranch's hook) -> plugin ownership check fails.
  const hooksJson = join(home, ".gemini", "config", "plugins", "ranch-tasks", "hooks.json");
  writeFileSync(hooksJson, readFileSync(hooksJson, "utf8") + "\n");
  report = await doctor();
  assert.equal(codexCheck(report, "antigravity plugin files")?.ok, false);
});

test("doctor checks antigravity synthetic hook JSON stdout and store write", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-agy-stub-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["antigravity"] });

  const stubBin = join(home, ".herdr", "ranch", "bin", "ranch-tasks.js");
  const writeStub = (mode) => writeFileSync(stubBin, `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv[2] !== "antigravity") process.exit(0);
const payload = JSON.parse(readFileSync(0, "utf8"));
if (payload.hookEventName !== "SessionStart" || typeof payload.conversationId !== "string") process.exit(2);
const base = join(process.env.RANCH_HOME, ".herdr", "ranch", "tasks");
if (${JSON.stringify(mode)} !== "no-store") {
  mkdirSync(join(base, "terminals"), { recursive: true });
  mkdirSync(join(base, "sessions"), { recursive: true });
  writeFileSync(join(base, "terminals", process.env.HC_TERMINAL_ID + ".json"), JSON.stringify({ session: payload.conversationId }));
  writeFileSync(join(base, "sessions", payload.conversationId + ".json"), JSON.stringify({
    version: 1, terminal: process.env.HC_TERMINAL_ID, agent: "antigravity", updated_at: new Date().toISOString(),
    session: { id: payload.conversationId, state: "running", activity: { state: "idle", at: new Date().toISOString() } },
    tasks: [], subagents: [],
  }));
}
process.stdout.write(${JSON.stringify(mode)} === "bad-json" ? "not json\\n" : "{}\\n");
`);

  writeStub("ok");
  let report = await doctor();
  assert.equal(codexCheck(report, "antigravity synthetic event")?.ok, true, codexCheck(report, "antigravity synthetic event")?.detail);

  writeStub("bad-json");
  report = await doctor();
  assert.equal(codexCheck(report, "antigravity synthetic event")?.ok, false);

  writeStub("no-store");
  report = await doctor();
  assert.equal(codexCheck(report, "antigravity synthetic event")?.ok, false);
});

test("doctor runs the antigravity synthetic session end to end when Antigravity is installed", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-agy-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["antigravity"] });

  const report = await doctor();
  const hooks = codexCheck(report, "antigravity hooks");
  assert.equal(hooks.ok, true, hooks.detail);
  const plugin = codexCheck(report, "antigravity plugin files");
  assert.equal(plugin.ok, true, plugin.detail);
  const preToolUse = codexCheck(report, "antigravity PreToolUse hook");
  assert.equal(preToolUse.ok, true, preToolUse.detail);
  const synthetic = codexCheck(report, "antigravity synthetic event");
  assert.equal(synthetic.ok, true, synthetic.detail);
});

test("doctor fails when antigravity hooks.json contains PreToolUse", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-agy-pretool-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  await install({ yes: true, agents: ["antigravity"], noInstructions: true });

  const hooksFile = join(home, ".gemini", "config", "plugins", "ranch-tasks", "hooks.json");
  const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
  doc["ranch-tasks"].PreToolUse = [{ matcher: "*", hooks: [doc["ranch-tasks"].SessionStart[0]] }];
  writeFileSync(hooksFile, JSON.stringify(doc, null, 2) + "\n");

  const report = await doctor();
  assert.equal(report.ok, false);
  const preToolUse = codexCheck(report, "antigravity PreToolUse hook");
  assert.ok(preToolUse, "antigravity PreToolUse hook check must exist");
  assert.equal(preToolUse.ok, false);
  assert.equal(preToolUse.detail, "PreToolUse hook denies every agy tool call; run ranch-tasks install");
});
