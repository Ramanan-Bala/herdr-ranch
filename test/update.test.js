// Self-update tests: a throwaway git repo stands in for GitHub, and every
// install target lives under a temp RANCH_HOME/HERDR_APP_HOME. Tests must
// never delete anything outside those temp dirs, so no cleanup is attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyUpdate, checkUpdate, updatePaths } from "../adapters/update.js";

// Temp dirs live in os.tmpdir() and are left for the OS to clean.
function tempHome() {
  return mkdtempSync(join(tmpdir(), "ranch-update-"));
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

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const FILES = {
  "layouts/ranch.json": '{"layout":"ranch"}\n',
  "layouts/ranch.svg": "<svg/>\n",
  "mods/ranch-a/main.js": "// a main\n",
  "mods/ranch-a/lib/x.js": "// a x\n",
  "mods/ranch-b/mod.json": '{"name":"b"}\n',
};

/** A temp git repo to update from, plus temp home dirs for the install. */
function fixture(t) {
  const root = tempHome();
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Ranch Test");
  git(repo, "config", "user.email", "ranch@example.test");
  for (const [rel, text] of Object.entries(FILES)) write(repo, rel, text);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const herdr = join(root, "herdr-app");
  withEnv(t, { RANCH_HOME: home, HERDR_APP_HOME: herdr, RANCH_UPDATE_REPO: repo, RANCH_UPDATE_BRANCH: "main" });
  return { root, repo, home, herdr };
}

test("checkUpdate compares the fixture HEAD with the installed manifest", (t) => {
  const f = fixture(t);
  const result = checkUpdate();
  assert.equal(result.installed, null);
  assert.equal(result.latest, git(f.repo, "rev-parse", "HEAD"));
  assert.equal(result.available, true);
  assert.equal(result.dev, false);
  assert.equal(result.error, undefined);
});

test("applyUpdate without yes writes nothing into the Herdr home", (t) => {
  const f = fixture(t);
  const result = applyUpdate({ yes: false });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.from, null);
  assert.equal(result.to, git(f.repo, "rev-parse", "HEAD"));
  assert.deepEqual(result.plan.copy, [
    "layouts/ranch.json",
    "layouts/ranch.svg",
    "mods/ranch-a/lib/x.js",
    "mods/ranch-a/main.js",
    "mods/ranch-b/mod.json",
  ]);
  assert.equal(existsSync(f.herdr), false);
});

test("first update with yes copies every managed file and records the commit", (t) => {
  const f = fixture(t);
  const head = git(f.repo, "rev-parse", "HEAD");
  const result = applyUpdate({ yes: true });
  assert.equal(result.ok, true);
  assert.equal(result.to, head);
  assert.equal(result.copied, 5);
  assert.equal(result.removed, 0);
  assert.equal(result.tasks, "skipped");
  for (const [rel, text] of Object.entries(FILES)) assert.equal(readFileSync(join(f.herdr, rel), "utf8"), text);
  const manifest = JSON.parse(readFileSync(updatePaths().manifest, "utf8"));
  assert.equal(manifest.commit, head);
  assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(FILES).sort());
  const check = checkUpdate();
  assert.equal(check.installed, head);
  assert.equal(check.available, false);
});

test("an existing edited file with no manifest is backed up and replaced", (t) => {
  const f = fixture(t);
  write(f.herdr, "mods/ranch-a/main.js", "// mine\n");
  const result = applyUpdate({ yes: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.backedUp, ["mods/ranch-a/main.js"]);
  assert.ok(result.backupDir);
  assert.ok(result.backupDir.startsWith(join(updatePaths().backups, "update-")), result.backupDir);
  assert.equal(readFileSync(join(result.backupDir, "mods/ranch-a/main.js"), "utf8"), "// mine\n");
  assert.equal(readFileSync(join(f.herdr, "mods/ranch-a/main.js"), "utf8"), FILES["mods/ranch-a/main.js"]);
});

test("a later commit replaces untouched files, removes dropped ones and backs up local edits", (t) => {
  const f = fixture(t);
  assert.equal(applyUpdate({ yes: true }).ok, true);

  write(f.repo, "mods/ranch-a/main.js", "// a main v2\n");
  unlinkSync(join(f.repo, "mods/ranch-b/mod.json"));
  git(f.repo, "add", "-A");
  git(f.repo, "commit", "-m", "update");
  const head = git(f.repo, "rev-parse", "HEAD");

  write(f.herdr, "mods/ranch-a/lib/x.js", "// my edit\n");
  const result = applyUpdate({ yes: true });
  assert.equal(result.ok, true);
  assert.equal(result.to, head);
  assert.equal(readFileSync(join(f.herdr, "mods/ranch-a/main.js"), "utf8"), "// a main v2\n");
  assert.equal(existsSync(join(f.herdr, "mods/ranch-b", "mod.json")), false);
  assert.equal(existsSync(join(f.herdr, "mods/ranch-b")), false);
  assert.ok(result.backedUp.includes("mods/ranch-a/lib/x.js"));
  assert.equal(readFileSync(join(result.backupDir, "mods/ranch-a/lib/x.js"), "utf8"), "// my edit\n");
  assert.equal(readFileSync(join(f.herdr, "mods/ranch-a/lib/x.js"), "utf8"), FILES["mods/ranch-a/lib/x.js"]);
});

test("a symlinked mod is a dev install: apply refuses and check reports dev", (t) => {
  const f = fixture(t);
  const target = join(f.root, "dev-mod");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "main.js"), "// dev\n");
  mkdirSync(join(f.herdr, "mods"), { recursive: true });
  symlinkSync(target, join(f.herdr, "mods", "ranch-a"), "dir");

  const result = applyUpdate({ yes: true });
  assert.equal(result.ok, false);
  assert.equal(result.dev, true);
  assert.match(result.error, /dev install/);
  assert.equal(readFileSync(join(f.herdr, "mods", "ranch-a", "main.js"), "utf8"), "// dev\n");
  assert.equal(existsSync(updatePaths().manifest), false);
  assert.equal(existsSync(updatePaths().src), false);
  assert.equal(checkUpdate().dev, true);
});

test("checkUpdate never throws when git ls-remote fails", (t) => {
  const f = fixture(t);
  withEnv(t, { RANCH_UPDATE_REPO: join(f.root, "does-not-exist") });
  const result = checkUpdate();
  assert.ok(result.error);
  assert.equal(result.latest, null);
  assert.equal(result.available, false);
});

test("a bridge-only machine (manifest says so) updates task reporting, never the Herdr home", (t) => {
  const f = fixture(t);
  // The source has a runnable bin/ranch-tasks so the reinstall step succeeds.
  write(f.repo, "bin/ranch-tasks", "process.exit(0);\n");
  git(f.repo, "add", "-A");
  git(f.repo, "commit", "-m", "bin");
  const head = git(f.repo, "rev-parse", "HEAD");
  write(f.home, ".herdr/ranch/update.json", JSON.stringify({ version: 1, commit: null, bridgeOnly: true, files: {} }));
  const check = checkUpdate();
  assert.equal(check.bridgeOnly, true);
  assert.equal(check.available, true);
  const result = applyUpdate({ yes: true });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.bridgeOnly, true);
  assert.equal(result.to, head);
  assert.equal(result.tasks, "reinstalled");
  assert.equal(existsSync(f.herdr), false);
  const manifest = JSON.parse(readFileSync(updatePaths().manifest, "utf8"));
  assert.equal(manifest.commit, head);
  assert.equal(manifest.bridgeOnly, true);
  assert.equal(checkUpdate().available, false);
});

test("no manifest: bridge-only only when task reporting is installed and there is no Herdr app home", (t) => {
  const f = fixture(t);
  assert.equal(checkUpdate().bridgeOnly, false);
  write(f.home, ".herdr/ranch/install.json", "{}\n");
  assert.equal(checkUpdate().bridgeOnly, true);
  mkdirSync(f.herdr, { recursive: true });
  assert.equal(checkUpdate().bridgeOnly, false);
});
