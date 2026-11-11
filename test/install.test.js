// Windows-install tests: hooks must call node with forward slashes on win32,
// backups must be nameable, reinstall must not duplicate hooks, uninstall
// must remove legacy backslash hooks. Platform is injected, never read from
// process.platform (docs/fixes/ranch-tasks-windows-install-plan.md §3.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupLabel, hookCommand, homeDir, install, statusSummary, uninstall } from "../adapters/install.js";

const RANCH_MARK = "/.herdr/ranch/bin/ranch-tasks";

// Temp dirs live in os.tmpdir() and are left for the OS to clean; tests must
// never delete anything outside them, so no cleanup is attempted here.
function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-install-"));
}

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Ranch hook groups in a config doc, recognized on either path separator. */
function ranchGroups(doc) {
  return Object.values(doc.hooks ?? {}).flatMap((groups) =>
    Array.isArray(groups) ? groups.filter((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command ?? "").replace(/\\/g, "/").includes(RANCH_MARK))) : []);
}

// ------------------------------------------------------------- hookCommand

test("hookCommand calls node on the .js entry with forward slashes on win32", () => {
  const command = hookCommand("claude", "win32");
  assert.ok(command.startsWith('node "'), command);
  assert.ok(command.endsWith("/.herdr/ranch/bin/ranch-tasks.js\" claude"), command);
  assert.ok(!command.includes("\\"), command);
  // macOS/Linux keep the plain sh launcher command.
  assert.equal(hookCommand("codex", "darwin"), `${homeDir()}/.herdr/ranch/bin/ranch-tasks codex`);
});

// ------------------------------------------------------------ backupLabel

test("backupLabel splits on / and \\ so Windows drive paths stay nameable", () => {
  assert.equal(backupLabel("C:\\Users\\x\\.codex\\AGENTS.md"), ".codex-AGENTS.md");
  assert.equal(backupLabel("/Users/x/.codex/AGENTS.md"), ".codex-AGENTS.md");
});

// ----------------------------------------------------------------- install

test("win32 install writes node hooks, reinstall migrates legacy ones without duplicates", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  // Legacy broken hook (backslash command) from a failed install, plus a
  // foreign hook that must survive.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [
        { hooks: [{ type: "command", command: "C:\\Users\\x\\.herdr\\ranch\\bin\\ranch-tasks claude", timeout: 5 }] },
        { hooks: [{ type: "command", command: "echo foreign" }] },
      ],
    },
  }, null, 2) + "\n");
  await install({ yes: true, agents: ["claude"], platform: "win32" });
  await install({ yes: true, agents: ["claude"], platform: "win32" });
  const doc = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  for (const [event, groups] of Object.entries(doc.hooks)) {
    assert.equal(ranchGroups({ hooks: { [event]: groups } }).length, 1, event);
  }
  for (const hook of ranchGroups(doc).flatMap((g) => g.hooks)) {
    assert.ok(hook.command.startsWith('node "'), hook.command);
    assert.ok(!hook.command.includes("\\"), hook.command);
  }
  const foreign = doc.hooks.PostToolUse.flatMap((g) => g.hooks).filter((h) => h.command === "echo foreign");
  assert.equal(foreign.length, 1);
});

test("win32 install backup names contain no : or \\", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "AGENTS.md"), "# user rules\n");
  await install({ yes: true, agents: ["codex"], platform: "win32" });
  const names = readdirSync(join(home, ".herdr", "ranch", "backups"));
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(!name.includes(":") && !name.includes("\\"), name);
});

// ------------------------------------------------------------------ status

test("statusSummary reports broken for hooks that cannot run on this OS", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["claude"], platform: "win32" });
  assert.equal(statusSummary("win32").agents.claude, "installed");

  // Legacy backslash command: cannot run on any OS.
  const file = join(home, ".claude", "settings.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.hooks.PostToolUse = [{ hooks: [{ type: "command", command: "C:\\Users\\x\\.herdr\\ranch\\bin\\ranch-tasks claude" }] }];
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  assert.equal(statusSummary("win32").agents.claude, "broken");
  assert.equal(statusSummary("darwin").agents.claude, "broken");

  // POSIX sh-launcher command: fine at home, unrunnable on win32.
  doc.hooks.PostToolUse = [{ hooks: [{ type: "command", command: `${home}/.herdr/ranch/bin/ranch-tasks claude` }] }];
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  assert.equal(statusSummary("win32").agents.claude, "broken");
  assert.notEqual(statusSummary("darwin").agents.claude, "broken");
});

// --------------------------------------------------------------- uninstall

test("uninstall removes legacy backslash ranch hooks and keeps foreign ones", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [
        { hooks: [{ type: "command", command: "C:\\Users\\x\\.herdr\\ranch\\bin\\ranch-tasks claude" }] },
        { hooks: [{ type: "command", command: "echo foreign" }] },
      ],
    },
  }, null, 2) + "\n");
  await uninstall({ yes: true, agents: ["claude"] });
  const doc = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(ranchGroups(doc), []);
  const kept = doc.hooks.PostToolUse.flatMap((g) => g.hooks).filter((h) => h.command === "echo foreign");
  assert.equal(kept.length, 1);
});
