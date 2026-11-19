// ranch-tasks update: shallow-clones the Ranch repo from GitHub main into
// ~/.herdr/ranch/src, copies layouts/ranch.* and mods/ranch-* into the Herdr
// app home, backs up files the person edited, and records the commit plus a
// sha256 per installed file in ~/.herdr/ranch/update.json. Interactive only.
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { homeDir } from "./install.js";

const DEFAULT_REPO = "https://github.com/Ramanan-Bala/herdr-ranch.git";
const DEFAULT_BRANCH = "main";
const GIT_TIMEOUT = 120000;
const LS_REMOTE_TIMEOUT = 15000;

/** Source, install and backup paths; env overrides exist for tests. */
export function updatePaths() {
  const repo = process.env.RANCH_UPDATE_REPO || DEFAULT_REPO;
  const branch = process.env.RANCH_UPDATE_BRANCH || DEFAULT_BRANCH;
  const ranch = join(homeDir(), ".herdr", "ranch");
  return {
    repo,
    branch,
    src: join(ranch, "src"),
    manifest: join(ranch, "update.json"),
    herdrHome: process.env.HERDR_APP_HOME || join(homeDir(), ".config", "herdr-app"),
    backups: join(ranch, "backups"),
  };
}

function isSymlink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when the layout or any mod in the Herdr home is a symlink (dev install). */
export function isDevInstall(herdrHome) {
  if (isSymlink(join(herdrHome, "layouts", "ranch.json"))) return true;
  let entries = [];
  try {
    entries = readdirSync(join(herdrHome, "mods"), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.name.startsWith("ranch-") && isSymlink(join(herdrHome, "mods", entry.name)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function shortError(err) {
  const text = String(err?.shortMessage ?? err?.message ?? err);
  return text.split("\n")[0].slice(0, 200);
}

function readManifest(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function git(args, cwd, timeout = GIT_TIMEOUT) {
  return execFileSync("git", args, {
    cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * True on a machine that only carries the task-reporting bridge (a remote
 * Herdr machine: agents run there, the Ranch layout and mods live in the app
 * on another computer). There an update refreshes ~/.herdr/ranch only.
 */
export function isBridgeOnly(paths, manifest) {
  if (manifest) return manifest.bridgeOnly === true;
  // Never updated: task reporting installed, but no Herdr app home at all.
  return existsSync(join(dirname(paths.manifest), "install.json")) && !existsSync(paths.herdrHome);
}

/** { installed, latest, available, dev, bridgeOnly, error? }; never throws. */
export function checkUpdate() {
  const paths = updatePaths();
  const manifest = readManifest(paths.manifest);
  const installed = manifest?.commit ?? null;
  let latest = null;
  let error;
  try {
    const out = git(["ls-remote", paths.repo, `refs/heads/${paths.branch}`], undefined, LS_REMOTE_TIMEOUT);
    const line = out.split("\n")[0]?.trim() ?? "";
    latest = line ? line.split(/\s+/)[0] : null;
  } catch (err) {
    error = shortError(err);
  }
  return {
    installed,
    latest,
    available: !!latest && latest !== installed,
    dev: isDevInstall(paths.herdrHome),
    bridgeOnly: isBridgeOnly(paths, manifest),
    ...(error ? { error } : {}),
  };
}

/** Sorted forward-slash relative paths Ranch owns under a source checkout. */
export function managedFiles(srcRoot) {
  const rels = [];
  for (const rel of ["layouts/ranch.json", "layouts/ranch.svg"]) {
    try {
      if (statSync(join(srcRoot, rel)).isFile()) rels.push(rel);
    } catch {}
  }
  let entries = [];
  try {
    entries = readdirSync(join(srcRoot, "mods"), { withFileTypes: true });
  } catch {}
  const walk = (abs, rel) => {
    const list = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of list) {
      const childAbs = join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) rels.push(childRel);
    }
  };
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith("ranch-") && entry.isDirectory()) walk(join(srcRoot, "mods", entry.name), `mods/${entry.name}`);
  }
  return rels.sort();
}

/**
 * What an update would do, from reads only: copy (writes), unchanged,
 * backup (edited by the person, or no manifest yet) and remove (dropped
 * upstream and written by Ranch, per the manifest).
 */
export function planUpdate({ srcRoot, herdrHome, manifest }) {
  const copy = [];
  const unchanged = [];
  const backup = [];
  const remove = [];
  const rels = managedFiles(srcRoot);
  for (const rel of rels) {
    const dest = join(herdrHome, rel);
    let destBytes = null;
    try {
      destBytes = readFileSync(dest);
    } catch {}
    const srcBytes = readFileSync(join(srcRoot, rel));
    if (destBytes === null) {
      copy.push(rel);
    } else if (destBytes.equals(srcBytes)) {
      unchanged.push(rel);
    } else if (manifest?.files?.[rel] === sha256(destBytes)) {
      copy.push(rel);
    } else {
      backup.push(rel);
      copy.push(rel);
    }
  }
  if (manifest?.files) {
    const managed = new Set(rels);
    for (const rel of Object.keys(manifest.files).sort()) {
      if (managed.has(rel)) continue;
      const dest = join(herdrHome, rel);
      if (!existsSync(dest)) continue;
      remove.push(rel);
      let destBytes = null;
      try {
        destBytes = readFileSync(dest);
      } catch {}
      if (destBytes !== null && sha256(destBytes) !== manifest.files[rel]) backup.push(rel);
    }
  }
  return { copy, unchanged, backup, remove };
}

/** Fetches the branch into src, resetting a matching checkout or cloning fresh. */
function fetchSource(paths) {
  const origin = (() => {
    try {
      return git(["remote", "get-url", "origin"], paths.src);
    } catch {
      return null;
    }
  })();
  if (existsSync(join(paths.src, ".git")) && origin === paths.repo) {
    git(["fetch", "--depth", "1", "origin", paths.branch], paths.src);
    git(["reset", "--hard", "FETCH_HEAD"], paths.src);
  } else {
    rmSync(paths.src, { recursive: true, force: true });
    mkdirSync(dirname(paths.src), { recursive: true });
    git(["clone", "--depth", "1", "--branch", paths.branch, paths.repo, paths.src]);
  }
  return git(["rev-parse", "HEAD"], paths.src);
}

/** Removes a dropped file, then empty mod folders up to (not including) mods/. */
function removeFile(herdrHome, rel) {
  unlinkSync(join(herdrHome, rel));
  const modsRoot = join(herdrHome, "mods");
  let dir = dirname(join(herdrHome, rel));
  while (dir.startsWith(modsRoot + "/") || dir.startsWith(modsRoot + "\\")) {
    try {
      if (readdirSync(dir).length) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

/** Bridge-only update: fetch, reinstall task reporting from it, record the commit. */
function updateBridge({ paths, from, yes, now }) {
  try {
    const commit = fetchSource(paths);
    const plan = { copy: [], unchanged: [], backup: [], remove: [] };
    if (!yes) return { ok: true, dryRun: true, bridgeOnly: true, from, to: commit, plan };
    let tasks = "reinstalled";
    try {
      execFileSync(process.execPath, [join(paths.src, "bin", "ranch-tasks"), "install", "--yes"], {
        env: process.env, timeout: GIT_TIMEOUT, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      tasks = "failed";
    }
    if (tasks === "failed") return { ok: false, bridgeOnly: true, from, error: "task reporting reinstall failed" };
    mkdirSync(dirname(paths.manifest), { recursive: true });
    writeFileSync(paths.manifest, JSON.stringify({
      version: 1, repo: paths.repo, branch: paths.branch, commit, updatedAt: now.toISOString(), bridgeOnly: true, files: {},
    }, null, 2) + "\n");
    return { ok: true, bridgeOnly: true, from, to: commit, copied: 0, removed: 0, backedUp: [], backupDir: null, tasks };
  } catch (err) {
    return { ok: false, bridgeOnly: true, error: shortError(err) };
  }
}

/**
 * Applies (or, without yes, describes) an update from the configured repo.
 * Never throws: failures come back as { ok: false, error }.
 */
export function applyUpdate({ yes = false, now = new Date() } = {}) {
  const paths = updatePaths();
  if (isDevInstall(paths.herdrHome)) {
    return { ok: false, dev: true, error: "dev install (symlinked into Herdr); run git pull in the repo instead" };
  }
  const manifest = readManifest(paths.manifest);
  const from = manifest?.commit ?? null;
  if (isBridgeOnly(paths, manifest)) return updateBridge({ paths, from, yes, now });
  try {
    const commit = fetchSource(paths);
    const plan = planUpdate({ srcRoot: paths.src, herdrHome: paths.herdrHome, manifest });
    if (!yes) {
      return { ok: true, dryRun: true, from, to: commit, plan };
    }
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const backupDir = plan.backup.length ? join(paths.backups, `update-${stamp}`) : null;
    for (const rel of plan.backup) {
      const target = join(backupDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(paths.herdrHome, rel), target);
    }
    for (const rel of plan.copy) {
      const dest = join(paths.herdrHome, rel);
      const tmp = dest + ".ranch-tmp";
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(paths.src, rel), tmp);
      renameSync(tmp, dest);
    }
    for (const rel of plan.remove) removeFile(paths.herdrHome, rel);
    const files = {};
    for (const rel of managedFiles(paths.src)) files[rel] = sha256(readFileSync(join(paths.herdrHome, rel)));
    mkdirSync(dirname(paths.manifest), { recursive: true });
    writeFileSync(paths.manifest, JSON.stringify({
      version: 1, repo: paths.repo, branch: paths.branch, commit, updatedAt: now.toISOString(), files,
    }, null, 2) + "\n");
    let tasks = "skipped";
    if (existsSync(join(dirname(paths.manifest), "install.json"))) {
      try {
        execFileSync(process.execPath, [join(paths.src, "bin", "ranch-tasks"), "install", "--yes"], {
          env: process.env, timeout: GIT_TIMEOUT,
        });
        tasks = "reinstalled";
      } catch {
        tasks = "failed";
      }
    }
    return {
      ok: true, from, to: commit, copied: plan.copy.length, removed: plan.remove.length,
      backedUp: plan.backup, backupDir, tasks,
    };
  } catch (err) {
    return { ok: false, error: shortError(err) };
  }
}
