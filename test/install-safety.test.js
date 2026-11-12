// Install/uninstall/gc integrity (spec: Ranch owns only the exact bytes it
// wrote, gc never deletes live or live-referenced data, drift compares every
// runtime file). Every test runs in a fresh temp RANCH_HOME + HOME; nothing
// outside those dirs is ever touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gcStores, hookCommand, install, statusSummary, uninstall } from "../adapters/install.js";

function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-safety-"));
}

function withEnv(t, home) {
  const saved = { RANCH_HOME: process.env.RANCH_HOME, HOME: process.env.HOME };
  process.env.RANCH_HOME = home;
  process.env.HOME = home;
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

function backupNames(home, prefix) {
  return readdirSync(join(home, ".herdr", "ranch", "backups")).filter((n) => n.startsWith(prefix));
}

function gcDir(home) {
  const dir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(join(dir, "terminals"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return dir;
}

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const minsAgo = (n) => new Date(Date.now() - n * 60 * 1000);

// ------------------------------------------------------- owned RANCH.md bytes

test("pre-existing custom RANCH.md is backed up and restored byte-identical", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const ranchMd = join(home, ".claude", "RANCH.md");
  const original = "# my own rules\n- keep this\n";
  writeFileSync(ranchMd, original);
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  assert.notEqual(readFileSync(ranchMd, "utf8"), original); // rules were written
  const backups = backupNames(home, "instructions-.claude-RANCH.md.");
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, ".herdr", "ranch", "backups", backups[0]), "utf8"), original);
  await captureOutput(() => uninstall({ yes: true, agents: ["claude"] }));
  assert.equal(readFileSync(ranchMd, "utf8"), original);
});

test("user-edited RANCH.md is left untouched on uninstall, conflict reported", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  const ranchMd = join(home, ".claude", "RANCH.md");
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  const edited = readFileSync(ranchMd, "utf8") + "\nmy own note\n";
  writeFileSync(ranchMd, edited);
  const lines = await captureOutput(() => uninstall({ yes: true, agents: ["claude"] }));
  assert.equal(readFileSync(ranchMd, "utf8"), edited);
  assert.ok(
    lines.some((l) => l.includes(ranchMd) && l.includes("changed since install, left as is")),
    lines.join("\n"),
  );
});

test("repeated install then uninstall restores the custom original, not the rules", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const ranchMd = join(home, ".claude", "RANCH.md");
  const original = "# custom rules, mine\n";
  writeFileSync(ranchMd, original);
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  await captureOutput(() => uninstall({ yes: true, agents: ["claude"] }));
  assert.equal(readFileSync(ranchMd, "utf8"), original);
});

// -------------------------------------------------------- CRLF round-trip

test("CRLF CLAUDE.md with user content round-trips byte-identical", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const claudeMd = join(home, ".claude", "CLAUDE.md");
  const original = "my project rules\r\n- keep crlf\r\n";
  writeFileSync(claudeMd, original);
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  assert.ok(readFileSync(claudeMd, "utf8").includes("@RANCH.md"));
  await captureOutput(() => uninstall({ yes: true, agents: ["claude"] }));
  assert.equal(readFileSync(claudeMd, "utf8"), original);
});

// ------------------------------------------------------------ opencode plugin

test("existing custom opencode plugin is backed up and restored byte-identical", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  mkdirSync(join(home, ".config", "opencode", "plugins"), { recursive: true });
  const plugin = join(home, ".config", "opencode", "plugins", "ranch-tasks.js");
  const custom = "// my own plugin\n";
  writeFileSync(plugin, custom);
  await captureOutput(() => install({ yes: true, agents: ["opencode"], platform: process.platform }));
  const backups = backupNames(home, "opencode-plugin.");
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(home, ".herdr", "ranch", "backups", backups[0]), "utf8"), custom);
  await captureOutput(() => uninstall({ yes: true, agents: ["opencode"] }));
  assert.equal(readFileSync(plugin, "utf8"), custom);
});

test("user-edited ranch plugin is backed up before it is deleted", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  const plugin = join(home, ".config", "opencode", "plugins", "ranch-tasks.js");
  await captureOutput(() => install({ yes: true, agents: ["opencode"], platform: process.platform }));
  const edited = readFileSync(plugin, "utf8") + "\n// my tweak\n";
  writeFileSync(plugin, edited);
  const lines = await captureOutput(() => uninstall({ yes: true, agents: ["opencode"] }));
  assert.equal(existsSync(plugin), false);
  const saved = backupNames(home, "opencode-plugin.");
  assert.ok(saved.some((n) => readFileSync(join(home, ".herdr", "ranch", "backups", n), "utf8") === edited));
  assert.ok(lines.some((l) => l.includes(plugin) && l.includes("deleted (backed up to")), lines.join("\n"));
});

// ------------------------------------------------------------------ hooks

test("mixed hook group keeps the user hook on install and uninstall", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  const userHook = { type: "command", command: "echo user" };
  writeFileSync(settings, JSON.stringify({
    hooks: {
      PostToolUse: [{ hooks: [userHook, { type: "command", command: hookCommand("claude", process.platform), timeout: 5 }] }],
    },
  }, null, 2) + "\n");
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  const ranchHooks = (doc) => Object.values(doc.hooks)
    .flatMap((groups) => groups.flatMap((g) => g?.hooks ?? []))
    .filter((h) => String(h?.command ?? "").replace(/\\/g, "/").includes("/.herdr/ranch/bin/ranch-tasks"));
  let doc = JSON.parse(readFileSync(settings, "utf8"));
  assert.ok(doc.hooks.PostToolUse.some((g) => g.hooks.some((h) => h.command === "echo user")));
  // One Ranch hook per Claude event, none duplicated.
  assert.equal(ranchHooks(doc).length, 9);
  await captureOutput(() => uninstall({ yes: true, agents: ["claude"] }));
  doc = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(ranchHooks(doc).length, 0);
  const group = doc.hooks.PostToolUse.find((g) => g.hooks.some((h) => h.command === "echo user"));
  assert.ok(group, "user hook kept in its original group");
  assert.equal(group.hooks.length, 1);
});

// --------------------------------------------------------------------- gc

test("gc keeps a live terminal's pointer and its referenced session however old", (t) => {
  const home = tempHome();
  withEnv(t, home);
  const dir = gcDir(home);
  const pointer = join(dir, "terminals", "t-live.json");
  writeFileSync(pointer, JSON.stringify({ session: "s-live" }));
  const session = join(dir, "sessions", "s-live.json");
  writeFileSync(session, "{}");
  utimesSync(pointer, daysAgo(15), daysAgo(15));
  utimesSync(session, daysAgo(15), daysAgo(15));
  const removed = gcStores(() => new Map([["t-live", "live"]]));
  assert.ok(existsSync(pointer));
  assert.ok(existsSync(session));
  assert.ok(!removed.includes("terminals/t-live.json"), removed.join(","));
  assert.ok(!removed.includes("sessions/s-live.json"), removed.join(","));
});

test("gc removes a gone terminal's pointer and its now-unreferenced old session", (t) => {
  const home = tempHome();
  withEnv(t, home);
  const dir = gcDir(home);
  const pointer = join(dir, "terminals", "t-gone.json");
  writeFileSync(pointer, JSON.stringify({ session: "s-gone" }));
  utimesSync(pointer, minsAgo(5), minsAgo(5)); // gone for over 2 minutes
  const session = join(dir, "sessions", "s-gone.json");
  writeFileSync(session, "{}");
  utimesSync(session, daysAgo(15), daysAgo(15));
  const removed = gcStores(() => new Map()); // hc works, terminal absent
  assert.ok(removed.includes("terminals/t-gone.json"), removed.join(","));
  assert.ok(removed.includes("sessions/s-gone.json"), removed.join(","));
});

test("gc with hc unavailable keeps pointers, prunes only unreferenced old sessions", (t) => {
  const home = tempHome();
  withEnv(t, home);
  const dir = gcDir(home);
  const pointer = join(dir, "terminals", "t-live.json");
  writeFileSync(pointer, JSON.stringify({ session: "s-kept" }));
  utimesSync(pointer, daysAgo(15), daysAgo(15));
  const kept = join(dir, "sessions", "s-kept.json");
  writeFileSync(kept, "{}");
  utimesSync(kept, daysAgo(15), daysAgo(15));
  const orphan = join(dir, "sessions", "s-orphan.json");
  writeFileSync(orphan, "{}");
  utimesSync(orphan, daysAgo(15), daysAgo(15));
  const removed = gcStores(() => null);
  assert.ok(existsSync(pointer));
  assert.ok(existsSync(kept));
  assert.ok(removed.includes("sessions/s-orphan.json"), removed.join(","));
});

// ------------------------------------------------------------------ drift

test("drift flags a modified non-cli runtime file as outdated", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  assert.equal(statusSummary(process.platform).agents.claude, "installed");
  const installedTasks = join(home, ".herdr", "ranch", "lib", "tasks.js");
  writeFileSync(installedTasks, readFileSync(installedTasks, "utf8") + "\n// drifted\n");
  assert.equal(statusSummary(process.platform).agents.claude, "outdated");
});

test("a person's own (non-Ranch) file at the plugin path is not drift", async (t) => {
  const home = tempHome();
  withEnv(t, home);
  await captureOutput(() => install({ yes: true, agents: ["claude"], platform: process.platform }));
  const plugin = join(home, ".config", "opencode", "plugins", "ranch-tasks.js");
  mkdirSync(join(home, ".config", "opencode", "plugins"), { recursive: true });
  writeFileSync(plugin, "// my own plugin\nexport default {};\n");
  assert.equal(statusSummary(process.platform).agents.claude, "installed");
});
