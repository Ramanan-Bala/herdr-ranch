// Windows-install tests: hooks must call node with forward slashes on win32,
// backups must be nameable, reinstall must not duplicate hooks, uninstall
// must remove legacy backslash hooks. Platform is injected, never read from
// process.platform (docs/fixes/ranch-tasks-windows-install-plan.md §3.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupLabel, cmdShimScript, hookCommand, homeDir, install, launcherScript, repoRoot, statusSummary, uninstall,
} from "../adapters/install.js";
import { rulesFor } from "../adapters/instructions.js";

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

/** console.log lines printed while an (async) install/uninstall runs. */
async function captureOutput(run) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines;
}

const piTheme = (name) => readFileSync(join(repoRoot(), "adapters", "pi", "themes", `${name}.json`));

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
  // macOS/Linux keep the plain sh launcher command. The expected path is
  // built with the same join() the code under test uses, so it holds with
  // native separators on any host (backslashes on a Windows host).
  assert.equal(
    hookCommand("codex", "darwin"),
    `${join(homeDir(), ".herdr", "ranch", "bin", "ranch-tasks")} codex`,
  );
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

  // POSIX sh-launcher command: fine at home, unrunnable on win32. The
  // simulated POSIX home is written with forward slashes even on a Windows
  // host, because a backslash in the command is what "broken" means.
  doc.hooks.PostToolUse = [{ hooks: [{ type: "command", command: `${home.replace(/\\/g, "/")}/.herdr/ranch/bin/ranch-tasks claude` }] }];
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

// ------------------------------------------- Claude task tools env (todo tools)

test("install turns on CLAUDE_CODE_ENABLE_TODO_TOOLS in Claude settings; uninstall takes it out", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const file = join(home, ".claude", "settings.json");
  writeFileSync(file, JSON.stringify({ env: { FOO: "bar" } }, null, 2) + "\n");
  await install({ yes: true, agents: ["claude"], platform: "darwin" });
  let doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.env, { FOO: "bar", CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
  assert.equal(statusSummary().claudeTodoEnv, true);
  await uninstall({ yes: true, agents: ["claude"] });
  doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.env, { FOO: "bar" });
});

test("install leaves a CLAUDE_CODE_ENABLE_TODO_TOOLS value the person set, and uninstall keeps it", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const file = join(home, ".claude", "settings.json");
  writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } }, null, 2) + "\n");
  await install({ yes: true, agents: ["claude"], platform: "darwin" });
  await uninstall({ yes: true, agents: ["claude"] });
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.env, { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" });
});

// ------------------------------------------------------------------- Pi

test("pi install copies the extension and writes the AGENTS.md block; reinstall is unchanged", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["pi"] });
  const extension = join(home, ".pi", "agent", "extensions", "ranch-tasks.js");
  const agents = join(home, ".pi", "agent", "AGENTS.md");
  assert.match(readFileSync(extension, "utf8"), /ranch-tasks plugin/);
  assert.match(readFileSync(agents, "utf8"), /todo_write/);
  assert.equal(statusSummary().agents.pi, "installed");

  const before = readFileSync(agents, "utf8");
  await install({ yes: true, agents: ["pi"] });
  assert.equal(readFileSync(agents, "utf8"), before);
  assert.equal(statusSummary().agents.pi, "installed");
});

test("pi uninstall restores a foreign ranch-tasks.js and removes the AGENTS.md block", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const extension = join(home, ".pi", "agent", "extensions", "ranch-tasks.js");
  const agents = join(home, ".pi", "agent", "AGENTS.md");
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(extension, "// someone else's extension\n");
  writeFileSync(agents, "# my rules\n");

  await install({ yes: true, agents: ["pi"] });
  assert.match(readFileSync(extension, "utf8"), /ranch-tasks plugin/);
  assert.match(readFileSync(agents, "utf8"), /todo_write/);

  await uninstall({ yes: true, agents: ["pi"] });
  assert.equal(readFileSync(extension, "utf8"), "// someone else's extension\n");
  assert.equal(readFileSync(agents, "utf8"), "# my rules\n");
  assert.equal(statusSummary().agents.pi, "missing");
});

test("--agents pi installs only pi", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "ranch-tasks.js")));
  assert.ok(existsSync(join(home, ".pi", "agent", "themes", "opencode.json")));
  assert.ok(existsSync(join(home, ".pi", "agent", "themes", "opencode-light.json")));
  assert.ok(existsSync(join(home, ".pi", "agent", "extensions", "statusline.ts")));
  assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(home, ".codex", "hooks.json")), false);
  assert.equal(existsSync(join(home, ".config", "opencode", "plugins", "ranch-tasks.js")), false);
});

test("pi install copies themes and status line and selects the theme in a new settings.json", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  const agent = join(home, ".pi", "agent");
  assert.deepEqual(readFileSync(join(agent, "themes", "opencode.json")), piTheme("opencode"));
  assert.deepEqual(readFileSync(join(agent, "themes", "opencode-light.json")), piTheme("opencode-light"));
  assert.deepEqual(
    readFileSync(join(agent, "extensions", "statusline.ts")),
    readFileSync(join(repoRoot(), "adapters", "pi", "statusline.ts")),
  );
  assert.equal(
    readFileSync(join(agent, "settings.json"), "utf8"),
    JSON.stringify({ theme: "opencode-light/opencode" }, null, 2) + "\n",
  );

  // drift in a new asset file reports outdated
  writeFileSync(join(agent, "extensions", "statusline.ts"), "// changed\n");
  assert.equal(statusSummary().agents.pi, "outdated");
});

test("pi install leaves an existing chosen theme byte-identical", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const file = join(home, ".pi", "agent", "settings.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  const original = JSON.stringify({ theme: "dark", x: 1 }) + "\n";
  writeFileSync(file, original);
  const lines = await captureOutput(() => install({ yes: true, agents: ["pi"], noInstructions: true }));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.ok(lines.some((l) => l.includes(file) && l.includes("theme left as dark")), lines.join("\n"));
});

test("pi install adds the theme to settings that have none and keeps other keys", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const file = join(home, ".pi", "agent", "settings.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(file, JSON.stringify({ x: 1 }) + "\n");
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc, { x: 1, theme: "opencode-light/opencode" });
});

test("pi reinstall reports the themes and settings unchanged", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  const settings = join(home, ".pi", "agent", "settings.json");
  const before = readFileSync(settings, "utf8");
  const lines = await captureOutput(() => install({ yes: true, agents: ["pi"], noInstructions: true }));
  assert.equal(readFileSync(settings, "utf8"), before);
  for (const file of ["themes/opencode.json", "themes/opencode-light.json", "extensions/statusline.ts"]) {
    const path = join(home, ".pi", "agent", file);
    assert.ok(lines.some((l) => l.includes(path) && l.includes("unchanged")), `${file}: ${lines.join("\n")}`);
  }
});

test("pi install backs up an identical pre-existing status line and uninstall restores it", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const statusline = join(home, ".pi", "agent", "extensions", "statusline.ts");
  const original = readFileSync(join(repoRoot(), "adapters", "pi", "statusline.ts"));
  mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
  writeFileSync(statusline, original);
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  const names = readdirSync(join(home, ".herdr", "ranch", "backups"));
  assert.equal(names.filter((n) => n.startsWith("pi-statusline.")).length, 1);
  await uninstall({ yes: true, agents: ["pi"] });
  assert.ok(existsSync(statusline));
  assert.deepEqual(readFileSync(statusline), original);
});

test("pi uninstall restores a pre-existing different theme file", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const theme = join(home, ".pi", "agent", "themes", "opencode.json");
  mkdirSync(join(home, ".pi", "agent", "themes"), { recursive: true });
  writeFileSync(theme, "// my theme\n");
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  assert.deepEqual(readFileSync(theme), piTheme("opencode"));
  await uninstall({ yes: true, agents: ["pi"] });
  assert.equal(readFileSync(theme, "utf8"), "// my theme\n");
});

test("pi uninstall removes Ranch-installed assets and the theme key it added", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const agent = join(home, ".pi", "agent");
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  await uninstall({ yes: true, agents: ["pi"] });
  for (const file of ["themes/opencode.json", "themes/opencode-light.json", "extensions/statusline.ts"]) {
    assert.equal(existsSync(join(agent, file)), false, file);
  }
  // settings.json was created by install and only held the theme
  assert.equal(existsSync(join(agent, "settings.json")), false);
});

test("pi uninstall removes only the theme key when settings already had content", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const file = join(home, ".pi", "agent", "settings.json");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(file, JSON.stringify({ x: 1 }) + "\n");
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  await uninstall({ yes: true, agents: ["pi"] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { x: 1 });
});

test("pi uninstall leaves a theme the person changed after install", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home });
  const file = join(home, ".pi", "agent", "settings.json");
  await install({ yes: true, agents: ["pi"], noInstructions: true });
  writeFileSync(file, JSON.stringify({ theme: "light" }, null, 2) + "\n");
  await uninstall({ yes: true, agents: ["pi"] });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "light");
});

// --------------------------------------------------------------- Antigravity

test("antigravity install writes plugin.json, hooks.json (5 events, no PreToolUse) and rules/AGENTS.md", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"] });

  const pluginDir = join(home, ".gemini", "config", "plugins", "ranch-tasks");
  const pluginJson = JSON.parse(readFileSync(join(pluginDir, "plugin.json"), "utf8"));
  assert.deepEqual(pluginJson, { name: "ranch-tasks" });

  const hooksJson = JSON.parse(readFileSync(join(pluginDir, "hooks.json"), "utf8"));
  const expectedCmd = hookCommand("antigravity", process.platform);
  const expectedHandler = { type: "command", command: expectedCmd, timeout: 10 };
  assert.deepEqual(hooksJson, {
    "ranch-tasks": {
      SessionStart: [expectedHandler],
      PreInvocation: [expectedHandler],
      PostInvocation: [expectedHandler],
      Stop: [expectedHandler],
      PostToolUse: [{ matcher: "*", hooks: [expectedHandler] }],
    },
  });
  assert.equal("PreToolUse" in hooksJson["ranch-tasks"], false);

  const rules = readFileSync(join(pluginDir, "rules", "AGENTS.md"), "utf8");
  assert.equal(rules, rulesFor("antigravity", home));
  assert.equal(statusSummary().agents.antigravity, "installed");
});

test("statusSummary reports antigravity outdated when hooks.json still contains PreToolUse", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"], noInstructions: true });
  const hooksFile = join(home, ".gemini", "config", "plugins", "ranch-tasks", "hooks.json");
  const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
  const expectedHandler = { type: "command", command: hookCommand("antigravity", process.platform), timeout: 10 };
  doc["ranch-tasks"].PreToolUse = [{ matcher: "*", hooks: [expectedHandler] }];
  writeFileSync(hooksFile, JSON.stringify(doc, null, 2) + "\n");

  assert.equal(statusSummary().agents.antigravity, "outdated");

  // Reinstalling drops PreToolUse and restores "installed".
  await install({ yes: true, agents: ["antigravity"], noInstructions: true });
  const updated = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal("PreToolUse" in updated["ranch-tasks"], false);
  assert.equal(statusSummary().agents.antigravity, "installed");
});

test("antigravity install on win32 uses node command with forward slashes and detects broken hooks", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"], platform: "win32", noInstructions: true });
  const hooksFile = join(home, ".gemini", "config", "plugins", "ranch-tasks", "hooks.json");
  const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
  const cmd = doc["ranch-tasks"].SessionStart[0].command;
  assert.ok(cmd.startsWith('node "'), cmd);
  assert.ok(cmd.endsWith('/.herdr/ranch/bin/ranch-tasks.js" antigravity'), cmd);
  assert.ok(!cmd.includes("\\"), cmd);
  assert.equal(statusSummary("win32").agents.antigravity, "installed");

  // POSIX launcher command is unrunnable on win32 -> broken
  doc["ranch-tasks"].SessionStart[0].command = `${home.replace(/\\/g, "/")}/.herdr/ranch/bin/ranch-tasks antigravity`;
  writeFileSync(hooksFile, JSON.stringify(doc, null, 2) + "\n");
  assert.equal(statusSummary("win32").agents.antigravity, "broken");
});

test("antigravity install with --no-instructions omits rules/AGENTS.md", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"], noInstructions: true });

  const pluginDir = join(home, ".gemini", "config", "plugins", "ranch-tasks");
  assert.ok(existsSync(join(pluginDir, "plugin.json")));
  assert.ok(existsSync(join(pluginDir, "hooks.json")));
  assert.equal(existsSync(join(pluginDir, "rules", "AGENTS.md")), false);
  assert.equal(existsSync(join(pluginDir, "rules")), false);
  assert.equal(statusSummary().agents.antigravity, "installed");
});

test("antigravity reinstall is idempotent", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"] });
  const pluginDir = join(home, ".gemini", "config", "plugins", "ranch-tasks");
  const files = [
    join(pluginDir, "plugin.json"),
    join(pluginDir, "hooks.json"),
    join(pluginDir, "rules", "AGENTS.md"),
  ];
  const before = files.map((f) => readFileSync(f, "utf8"));

  const lines = await captureOutput(() => install({ yes: true, agents: ["antigravity"] }));
  assert.deepEqual(files.map((f) => readFileSync(f, "utf8")), before);
  for (const f of files) {
    assert.ok(lines.some((l) => l.includes(f) && l.includes("unchanged")), lines.join("\n"));
  }
  assert.equal(existsSync(join(home, ".herdr", "ranch", "backups")), false);
  assert.equal(statusSummary().agents.antigravity, "installed");
});

test("antigravity install detects agy on PATH without ~/.gemini/antigravity-cli", async (t) => {
  const home = tempHome();
  const binDir = join(home, "fake-bin");
  mkdirSync(binDir, { recursive: true });
  const agyBin = join(binDir, "agy");
  writeFileSync(agyBin, "#!/bin/sh\nexit 99\n");
  chmodSync(agyBin, 0o755);
  withEnv(t, { RANCH_HOME: home, PATH: binDir });

  await install({ yes: true, agents: ["antigravity"] });
  const pluginDir = join(home, ".gemini", "config", "plugins", "ranch-tasks");
  assert.ok(existsSync(join(pluginDir, "plugin.json")));
  assert.ok(existsSync(join(pluginDir, "hooks.json")));
  assert.ok(existsSync(join(pluginDir, "rules", "AGENTS.md")));
  assert.equal(statusSummary().agents.antigravity, "installed");

  await uninstall({ yes: true, agents: ["antigravity"] });
  assert.equal(existsSync(join(home, ".gemini")), false);
  assert.equal(statusSummary().agents.antigravity, "missing");
});

test("antigravity install is skipped when agy is missing", async (t) => {
  const home = tempHome();
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  const lines = await captureOutput(() => install({ yes: true, agents: ["antigravity"] }));
  assert.ok(lines.some((l) => l.includes("skipped")), lines.join("\n"));
  assert.equal(existsSync(join(home, ".gemini")), false);
  assert.equal(statusSummary().agents.antigravity, "missing");
});

test("antigravity uninstall removes owned files and directories created by install", async (t) => {
  const home = tempHome();
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  withEnv(t, { RANCH_HOME: home, PATH: "" });

  await install({ yes: true, agents: ["antigravity"] });
  await uninstall({ yes: true, agents: ["antigravity"] });

  assert.equal(existsSync(join(home, ".gemini", "config")), false);
  assert.ok(existsSync(join(home, ".gemini", "antigravity-cli")));
  assert.equal(statusSummary().agents.antigravity, "missing");
});

test("launcherScript no-node fallback prints {} and exits 0 for antigravity", () => {
  const script = launcherScript("/nonexistent/node");
  assert.match(script, /antigravity\)/);
  assert.match(cmdShimScript(), /"%~1"=="antigravity"/);

  if (process.platform === "win32") return;

  // Strip hardcoded host node locations so the no-node fallback always runs.
  const isolated = script
    .replace("/opt/homebrew/bin/node", "/nonexistent/a")
    .replace("/usr/local/bin/node", "/nonexistent/b")
    .replace("/usr/bin/node", "/nonexistent/c");
  const dir = tempHome();
  const launcher = join(dir, "ranch-tasks");
  writeFileSync(launcher, isolated);
  chmodSync(launcher, 0o755);

  const minBin = join(dir, "bin");
  mkdirSync(minBin, { recursive: true });
  for (const tool of ["cat", "dirname", "ls", "sort", "tail"]) {
    const src = existsSync(`/bin/${tool}`) ? `/bin/${tool}` : `/usr/bin/${tool}`;
    if (existsSync(src)) symlinkSync(src, join(minBin, tool));
  }

  const agy = spawnSync("/bin/sh", [launcher, "antigravity"], {
    env: { HOME: dir, PATH: minBin },
    input: JSON.stringify({ hookEventName: "SessionStart" }),
    encoding: "utf8",
  });
  assert.equal(agy.status, 0, agy.stderr);
  assert.deepEqual(JSON.parse(agy.stdout), {});
  assert.equal(agy.stderr, "");

  const claude = spawnSync("/bin/sh", [launcher, "claude"], {
    env: { HOME: dir, PATH: minBin },
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    encoding: "utf8",
  });
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.stdout, "");
});
