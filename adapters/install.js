// ranch-tasks installer: adds passive hooks to Claude Code and Codex configs,
// copies the OpenCode plugin and the runtime into ~/.herdr/ranch/
// (requirements.md §7.1, §7.4). Interactive commands only — never run as a hook.
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { isDeepStrictEqual } from "node:util";
import { STALE } from "../lib/tasks.js";

const AGENTS = ["claude", "codex", "opencode"];
import { rulesFor, blockFor, CLAUDE_IMPORT, withBlock, stripBlock } from "./instructions.js";

const RANCH_MARK = "/.herdr/ranch/bin/ranch-tasks";
const PLUGIN_MARKER = "// ranch-tasks plugin";

const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "SessionEnd", "Stop"];
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "SubagentStart", "SubagentStop", "SessionEnd", "Stop"];
const CLAUDE_MATCHERS = { PostToolUse: "TodoWrite|TaskCreate|TaskUpdate|Bash" };
const CODEX_MATCHERS = { PostToolUse: "update_plan|Bash|shell" };

const here = dirname(fileURLToPath(import.meta.url)); // .../adapters

export function homeDir() {
  return process.env.RANCH_HOME || homedir();
}

export function repoRoot() {
  return dirname(here);
}

/** True when this copy is the repo's, not the installed one. */
function runningFromRepo() {
  return resolve(here) !== resolve(join(homeDir(), ".herdr", "ranch", "adapters"));
}

function installedCliDiffers() {
  try {
    return !readFileSync(join(here, "cli.js")).equals(readFileSync(join(homeDir(), ".herdr", "ranch", "adapters", "cli.js")));
  } catch {
    return true;
  }
}

// Hooks written by a broken Windows install hold backslash paths; normalize
// so they are still recognized as Ranch's (and cleaned up on reinstall).
const normPath = (command) => String(command ?? "").replace(/\\/g, "/");

function isRanchGroup(group) {
  return Array.isArray(group?.hooks) &&
    group.hooks.some((h) => typeof h?.command === "string" && normPath(h.command).includes(RANCH_MARK));
}

/**
 * The hook command line for one agent. Windows can't execute the sh
 * launcher, so it calls node on the .js entry with forward-slash paths
 * (backslashes would never match RANCH_MARK).
 */
export function hookCommand(agent, platform = process.platform) {
  const bin = join(homeDir(), RANCH_MARK.slice(1));
  if (platform === "win32") return `node "${bin.replace(/\\/g, "/")}.js" ${agent}`;
  return `${bin} ${agent}`;
}

/** Backup label from a file path; split on / and \ (Windows drive paths). */
export function backupLabel(file) {
  return file.split(/[\\/]/).slice(-2).join("-");
}

/** True when a Ranch hook exists whose command cannot run on this OS. */
function hasUnrunnableRanchHook(doc, platform) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((g) =>
    Array.isArray(g?.hooks) && g.hooks.some((h) => {
      const command = typeof h?.command === "string" ? h.command : "";
      if (!normPath(command).includes(RANCH_MARK)) return false;
      return command.includes("\\") || (platform === "win32" && !command.startsWith("node "));
    })));
}

function sameFile(src, dest) {
  try {
    return statSync(src).isFile() && statSync(dest).isFile() && readFileSync(src).equals(readFileSync(dest));
  } catch {
    return false;
  }
}

function backupFile(file, label, backups) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = /\.[A-Za-z]+$/.exec(file)?.[0] ?? "";
  const dir = join(homeDir(), ".herdr", "ranch", "backups");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${label}.${stamp}${ext}`);
  copyFileSync(file, dest);
  backups.push(dest);
}

function matchingBackup(label, doc) {
  const dir = join(homeDir(), ".herdr", "ranch", "backups");
  try {
    // Newest first: a re-install's backup already holds Ranch's hooks, so an
    // older backup may be the one that matches the pre-Ranch file exactly.
    const names = readdirSync(dir).filter((f) => f.startsWith(`${label}.`)).sort().reverse();
    for (const name of names) {
      const text = readFileSync(join(dir, name), "utf8");
      try {
        if (isDeepStrictEqual(JSON.parse(text), doc)) return text;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function readInstallManifest() {
  try {
    const doc = JSON.parse(readFileSync(join(homeDir(), ".herdr", "ranch", "install.json"), "utf8"));
    return {
      createdFiles: Array.isArray(doc.createdFiles) ? doc.createdFiles : [],
      createdDirs: Array.isArray(doc.createdDirs) ? doc.createdDirs : [],
      opencodeTodo: doc.opencodeTodo && typeof doc.opencodeTodo === "object" ? doc.opencodeTodo : null,
    };
  } catch {
    return { createdFiles: [], createdDirs: [], opencodeTodo: null };
  }
}

function recordInstallCreated(file, directory) {
  const manifest = readInstallManifest();
  if (file && !manifest.createdFiles.includes(file)) manifest.createdFiles.push(file);
  if (directory && !manifest.createdDirs.includes(directory)) manifest.createdDirs.push(directory);
  writeFileSync(join(homeDir(), ".herdr", "ranch", "install.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// ------------------------------------------------------------------ JSONC
// OpenCode's opencode.json / .jsonc may hold comments and trailing commas, so
// it is edited as text: detection runs on a comment-masked copy, the file
// itself is only ever changed by inserting (or removing) one exact string.

/** Skips a JSON string starting at s[i] === '"'; returns the index after it. */
function skipStringAt(s, i) {
  i++;
  while (i < s.length) {
    if (s[i] === "\\") {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i + 1;
    i++;
  }
  return s.length;
}

/** Same length as text with line and block comments blanked (strings kept). */
function maskComments(text) {
  let s = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = skipStringAt(text, i);
      s += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const to = text.indexOf("\n", i);
      const stop = to === -1 ? text.length : to;
      s += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const to = text.indexOf("*/", i + 2);
      const stop = to === -1 ? text.length : to + 2;
      s += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    s += c;
    i++;
  }
  return s;
}

/** Skips a JSON value (string, literal, object or array) starting at s[i]. */
function skipValue(s, i) {
  const c = s[i];
  if (c === '"') return skipStringAt(s, i);
  if (c === "{" || c === "[") {
    let d = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        i = skipStringAt(s, i);
        continue;
      }
      if (ch === "{" || ch === "[") d++;
      else if (ch === "}" || ch === "]") {
        d--;
        if (d === 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  while (i < s.length && s[i] !== "," && s[i] !== "}") i++;
  return i;
}

/** After a value: past whitespace and one separator comma. */
function skipAfterValue(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === ",") i++;
  return i;
}

/**
 * Walks an object's top-level keys. cb(key, valueStart) is called per key;
 * returns the index of the closing brace, or null when unbalanced (not JSON).
 */
function scanObject(s, open, cb) {
  let i = open + 1;
  let d = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "{") {
      d++;
      i++;
      continue;
    }
    if (c === "}") {
      if (d === 0) return i;
      d--;
      i++;
      continue;
    }
    if (c === '"' && d === 0) {
      const keyEnd = skipStringAt(s, i);
      const key = s.slice(i + 1, keyEnd - 1);
      let j = s.indexOf(":", keyEnd);
      if (j === -1) return null;
      j++;
      while (j < s.length && /\s/.test(s[j])) j++;
      cb(key, j);
      i = skipAfterValue(s, skipValue(s, j));
      continue;
    }
    i++;
  }
  return null;
}

function findExperimental(s) {
  const root = s.indexOf("{");
  if (root === -1) return null;
  let expOpen = -1;
  const closed = scanObject(s, root, (key, valueStart) => {
    if (key === "experimental" && s[valueStart] === "{") expOpen = valueStart;
  });
  return closed == null ? null : { root, expOpen };
}

function experimentalTodoState(s, open) {
  let state = "absent";
  scanObject(s, open, (key, valueStart) => {
    if (key === "todo") {
      if (s.startsWith("true", valueStart)) state = "on";
      else if (s.startsWith("false", valueStart)) state = "off";
      else state = "other";
    }
  });
  return state;
}

/**
 * Enables OpenCode's experimental todo tool in a JSONC config, as text:
 * `{"todo": true}` inside the top-level "experimental" object, inserting only
 * an exact string so comments and trailing commas survive. Returns
 * { text, inserted } with the inserted string, or { text, inserted: null }
 * when nothing to do (plus .action "left todo off (set by you)" when the
 * person turned todo off themselves).
 */
export function enableOpencodeTodo(text) {
  const s = maskComments(text);
  const root = findExperimental(s);
  if (!root) return { text, inserted: null };
  if (root.expOpen === -1) {
    const inserted = '\n  "experimental": { "todo": true },';
    return { text: text.slice(0, root.root + 1) + inserted + text.slice(root.root + 1), inserted };
  }
  const state = experimentalTodoState(s, root.expOpen);
  if (state === "on") return { text, inserted: null };
  if (state === "off") return { text, inserted: null, action: "left todo off (set by you)" };
  if (state === "other") return { text, inserted: null };
  const at = root.expOpen + 1;
  const inserted = '"todo": true, ';
  return { text: text.slice(0, at) + inserted + text.slice(at), inserted };
}

/** The OpenCode global config: prefer an existing opencode.jsonc, else .json. */
function opencodeConfigFile() {
  const jsonc = join(homeDir(), ".config", "opencode", "opencode.jsonc");
  return existsSync(jsonc) ? jsonc : join(homeDir(), ".config", "opencode", "opencode.json");
}

/** Whether OpenCode's config has experimental.todo on. */
export function opencodeTodoEnabled() {
  try {
    const s = maskComments(readFileSync(opencodeConfigFile(), "utf8"));
    const root = findExperimental(s);
    if (!root || root.expOpen === -1) return false;
    return experimentalTodoState(s, root.expOpen) === "on";
  } catch {
    return false;
  }
}

function recordOpencodeTodo(entry) {
  const manifest = readInstallManifest();
  manifest.opencodeTodo = entry;
  const file = join(homeDir(), ".herdr", "ranch", "install.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

function readConfig(file) {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.trim() === "") return { text: "", doc: {} };
  try {
    return { text, doc: JSON.parse(text) };
  } catch {
    return { text, doc: null };
  }
}

/**
 * Adds (or refreshes) Ranch's hook groups. Returns the new file text, or null
 * when the existing file is not valid JSON (never clobber it).
 */
function addRanchHooks(doc, events, command, matchers) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const hooks = doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks) ? doc.hooks : {};
  // Also drop ranch groups for events no longer in the list (I14: the old
  // matcher-less Claude PreToolUse hook must go on reinstall).
  const wanted = new Set(events);
  for (const event of Object.keys(hooks)) {
    if (wanted.has(event)) continue;
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isRanchGroup(g));
    if (kept.length !== groups.length) {
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  for (const event of events) {
    const kept = Array.isArray(hooks[event]) ? hooks[event].filter((g) => !isRanchGroup(g)) : [];
    const group = { hooks: [{ type: "command", command, timeout: 5 }] };
    if (matchers[event]) group.matcher = matchers[event];
    hooks[event] = [...kept, group];
  }
  doc.hooks = hooks;
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Removes Ranch's hook groups and empty event keys they leave behind. */
function stripRanchHooks(doc) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return { doc, removed: false };
  let removed = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((g) => !isRanchGroup(g));
    if (kept.length !== groups.length) {
      removed = true;
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
  }
  return { doc, removed };
}

function hasRanchHandlers(doc) {
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some(isRanchGroup));
}

/** POSIX sh launcher for the installed CLI; `node` is looked up at run time. */
export function launcherScript(nodePath) {
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh
# Ranch task reporting launcher (written by ranch-tasks install).
# Hooks and Herdr often run without nvm/volta on PATH, so find node here.
here=$(cd "$(dirname "$0")" && pwd)
latest_nvm=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -t/ -k7 -V 2>/dev/null | tail -n 1)
for n in ${q(nodePath)} "$(command -v node 2>/dev/null)" "$latest_nvm" "$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then exec "$n" --no-warnings "$here/ranch-tasks.js" "$@"; fi
done
# No node: hooks must stay silent and never fail the agent.
case "$1" in claude|codex) cat >/dev/null 2>&1; exit 0 ;; esac
echo "ranch-tasks: node not found" >&2
exit 127
`;
}

function writeLauncher(dest, results) {
  const text = launcherScript(process.execPath);
  mkdirSync(dirname(dest), { recursive: true });
  let same = false;
  try { same = readFileSync(dest, "utf8") === text; } catch {}
  if (!same) {
    writeFileSync(dest, text);
    chmodSync(dest, 0o755);
  }
  results.push({ path: dest, action: same ? "unchanged" : "written (launcher)" });
}

/** Windows cmd shim so a human can type `ranch-tasks` (hooks call node directly). */
function writeCmdShim(dest, results) {
  const text = '@node "%~dp0ranch-tasks.js" %*\n';
  mkdirSync(dirname(dest), { recursive: true });
  let same = false;
  try { same = readFileSync(dest, "utf8") === text; } catch {}
  if (!same) writeFileSync(dest, text);
  results.push({ path: dest, action: same ? "unchanged" : "written (win32 cmd shim)" });
}

function copyRuntime(results, platform = process.platform) {
  const root = repoRoot();
  const ranch = join(homeDir(), ".herdr", "ranch");
  // The node entry is installed as bin/ranch-tasks.js; bin/ranch-tasks becomes a
  // small sh launcher that finds node itself (nvm/volta/Homebrew installs are
  // often missing from the PATH that hooks and Herdr's exec get). When install
  // runs from the installed copy, its entry is already ranch-tasks.js.
  const entry = existsSync(join(root, "bin", "ranch-tasks.js")) ? join(root, "bin", "ranch-tasks.js") : join(root, "bin", "ranch-tasks");
  writeLauncher(join(ranch, "bin", "ranch-tasks"), results);
  if (platform === "win32") writeCmdShim(join(ranch, "bin", "ranch-tasks.cmd"), results);
  // The installed files are ES modules; say so, or node warns on every hook.
  const pkg = join(ranch, "package.json");
  if (!existsSync(pkg)) writeFileSync(pkg, '{ "type": "module", "private": true }\n');
  const files = [
    { src: entry, dest: join(ranch, "bin", "ranch-tasks.js"), mode: 0o755 },
    ...readdirSync(join(root, "adapters"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => ({ src: join(root, "adapters", f), dest: join(ranch, "adapters", f) })),
    { src: join(root, "lib", "tasks.js"), dest: join(ranch, "lib", "tasks.js") },
    { src: join(root, "lib", "prs.js"), dest: join(ranch, "lib", "prs.js") },
    { src: join(root, "lib", "tasks-command.js"), dest: join(ranch, "lib", "tasks-command.js") },
  ];
  for (const { src, dest, mode } of files) {
    mkdirSync(dirname(dest), { recursive: true });
    if (sameFile(src, dest)) {
      results.push({ path: dest, action: "unchanged" });
      continue;
    }
    copyFileSync(src, dest);
    if (mode) chmodSync(dest, mode);
    results.push({ path: dest, action: "copied" });
  }
}

function installClaude(results, backups, platform = process.platform) {
  const file = join(homeDir(), ".claude", "settings.json");
  const command = hookCommand("claude", platform);
  const { text, doc } = readConfig(file);
  const next = addRanchHooks(doc, CLAUDE_EVENTS, command, CLAUDE_MATCHERS);
  if (next == null) {
    results.push({ path: file, action: "skipped (not valid JSON)" });
    return;
  }
  if (next === text) {
    results.push({ path: file, action: "unchanged" });
    return;
  }
  if (text) backupFile(file, "claude-settings", backups);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  results.push({ path: file, action: text ? "merged ranch hooks" : "created" });
}

function installCodex(results, backups, platform = process.platform) {
  const file = join(homeDir(), ".codex", "hooks.json");
  const command = hookCommand("codex", platform);
  const { text, doc } = readConfig(file);
  const next = addRanchHooks(doc, CODEX_EVENTS, command, CODEX_MATCHERS);
  if (next == null) {
    results.push({ path: file, action: "skipped (not valid JSON)" });
    return false;
  }
  if (next === text) {
    results.push({ path: file, action: "unchanged" });
    return false;
  }
  if (text) backupFile(file, "codex-hooks", backups);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  results.push({ path: file, action: text ? "merged ranch hooks" : "created" });
  return true;
}

const FRESH_OPENCODE_CONFIG = '{\n  "experimental": { "todo": true }\n}\n';

function installOpencodeConfig(results, backups) {
  const file = opencodeConfigFile();
  if (!existsSync(file)) {
    // Fresh config: JSONC with the one key install is responsible for.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, FRESH_OPENCODE_CONFIG);
    recordInstallCreated(file, null);
    recordOpencodeTodo({ file, inserted: '\n  "experimental": { "todo": true }' });
    results.push({ path: file, action: "created (experimental todo on)" });
    return;
  }
  const before = readFileSync(file, "utf8");
  const { text, inserted, action } = enableOpencodeTodo(before);
  if (inserted == null) {
    results.push({ path: file, action: action ?? "unchanged" });
    return;
  }
  backupFile(file, "opencode-config", backups);
  writeFileSync(file, text);
  recordOpencodeTodo({ file, inserted });
  results.push({ path: file, action: "enabled experimental todo tool" });
}

function uninstallOpencodeConfig(results) {
  const manifest = readInstallManifest();
  const file = manifest.opencodeTodo?.file ?? opencodeConfigFile();
  if (!existsSync(file)) {
    results.push({ path: file, action: "not present" });
    return;
  }
  const original = readFileSync(file, "utf8");
  // Delete a file Ranch created only while it is still exactly what Ranch
  // wrote; if the person added settings since, just take Ranch's key out.
  if (manifest.createdFiles.includes(file) && original === FRESH_OPENCODE_CONFIG) {
    unlinkSync(file);
    results.push({ path: file, action: "deleted (Ranch created it)" });
    return;
  }
  const inserted = manifest.opencodeTodo?.inserted;
  if (typeof inserted !== "string") {
    results.push({ path: file, action: "unchanged" });
    return;
  }
  // A key the person added after Ranch's block put a comma after it: take
  // that comma too, or the file is left as invalid "{,".
  const target = original.includes(inserted + ",") && !inserted.trimEnd().endsWith(",") ? inserted + "," : inserted;
  const at = original.indexOf(target);
  if (at === -1) {
    results.push({ path: file, action: "changed since install, left as is" });
    return;
  }
  writeFileSync(file, original.slice(0, at) + original.slice(at + target.length));
  results.push({ path: file, action: "disabled experimental todo tool" });
}

function installOpencode(results, backups) {
  const src = join(here, "opencode-plugin.js");
  const dest = join(homeDir(), ".config", "opencode", "plugins", "ranch-tasks.js");
  const existed = existsSync(dest);
  if (existed && sameFile(src, dest)) {
    results.push({ path: dest, action: "unchanged" });
  } else {
    if (existed) backupFile(dest, "opencode-plugin", backups);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    results.push({ path: dest, action: existed ? "replaced" : "copied" });
  }
  installOpencodeConfig(results, backups);
}

function selectAgents(opts) {
  const requested = Array.isArray(opts.agents) && opts.agents.length ? opts.agents : [...AGENTS];
  return AGENTS.filter((a) => requested.includes(a));
}

function plan(agents, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = homeDir();
  const items = [
    { path: join(home, ".herdr", "ranch", "bin", "ranch-tasks"), action: "copy (mode 755)" },
    ...(platform === "win32"
      ? [{ path: join(home, ".herdr", "ranch", "bin", "ranch-tasks.cmd"), action: "write (win32 cmd shim)" }]
      : []),
    { path: join(home, ".herdr", "ranch", "adapters", "*.js"), action: "copy" },
    { path: join(home, ".herdr", "ranch", "lib", "tasks.js"), action: "copy" },
  ];
  if (agents.includes("claude")) items.push({ path: join(home, ".claude", "settings.json"), action: "merge ranch hooks (backed up first)" });
  if (agents.includes("codex")) items.push({ path: join(home, ".codex", "hooks.json"), action: "create or merge hooks (backed up first)" });
  if (agents.includes("opencode")) {
    items.push({ path: join(home, ".config", "opencode", "plugins", "ranch-tasks.js"), action: "copy plugin" });
    items.push({ path: opencodeConfigFile(), action: "enable experimental todo tool" });
  }
  if (!opts.noInstructions) {
    for (const f of instructionFiles(agents)) items.push({ path: f.path, action: f.planAction });
  }
  return items;
}

/**
 * Global instruction files that get Ranch's task-reporting rules (marked
 * blocks; uninstall removes exactly those). Claude keeps the rules in
 * ~/.claude/RANCH.md and imports it from CLAUDE.md with one marked line.
 */
function instructionFiles(agents) {
  const home = homeDir();
  const files = [];
  if (agents.includes("claude")) {
    files.push({ path: join(home, ".claude", "RANCH.md"), whole: rulesFor("claude"), planAction: "write task-reporting rules" });
    files.push({ path: join(home, ".claude", "CLAUDE.md"), block: CLAUDE_IMPORT, planAction: "add one marked @RANCH.md import line" });
  }
  if (agents.includes("codex")) files.push({ path: join(home, ".codex", "AGENTS.md"), block: blockFor("codex", home), planAction: "add marked task-reporting block" });
  if (agents.includes("opencode")) files.push({ path: join(home, ".config", "opencode", "AGENTS.md"), block: blockFor("opencode"), planAction: "add marked task-reporting block" });
  return files;
}

function installInstructions(agents, results, backups) {
  for (const f of instructionFiles(agents)) {
    const existed = existsSync(f.path);
    const before = existed ? readFileSync(f.path, "utf8") : "";
    const after = f.whole ?? withBlock(before, f.block);
    if (after === before) {
      results.push({ path: f.path, action: "unchanged" });
      continue;
    }
    if (existed && !f.whole) backupFile(f.path, `instructions-${backupLabel(f.path)}`, backups);
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, after);
    if (!existed) recordInstallCreated(f.path, null);
    results.push({ path: f.path, action: existed ? "added task-reporting rules" : "created" });
  }
}

function uninstallInstructions(agents, results) {
  const created = readInstallManifest().createdFiles;
  for (const f of instructionFiles(agents)) {
    if (!existsSync(f.path)) continue;
    const before = readFileSync(f.path, "utf8");
    const stripped = f.whole ? "" : stripBlock(before);
    if (created.includes(f.path) && stripped.trim() === "") {
      unlinkSync(f.path);
      results.push({ path: f.path, action: "deleted (Ranch created it)" });
    } else if (stripped !== before) {
      writeFileSync(f.path, stripped.replace(/\n+$/, "\n"));
      results.push({ path: f.path, action: "removed task-reporting rules" });
    }
  }
}

async function confirm(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printPlan(items) {
  console.log("Ranch task reporting will change:");
  for (const item of items) console.log(`  ${item.path}  (${item.action})`);
}

function printResults(results, backups) {
  console.log("Ranch task reporting:");
  for (const { path, action } of results) console.log(`  ${path}  (${action})`);
  if (backups.length) {
    console.log("Backups:");
    for (const path of backups) console.log(`  ${path}`);
  }
}

/** Installs the runtime copies and per-agent hooks. */
export async function install(opts = {}) {
  const agents = selectAgents(opts);
  const platform = opts.platform ?? process.platform;
  const items = plan(agents, opts);
  if (!opts.yes) {
    printPlan(items);
    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      console.log("Aborted — nothing changed.");
      return;
    }
  }
  const results = [];
  const backups = [];
  copyRuntime(results, platform);
  if (agents.includes("claude")) installClaude(results, backups, platform);
  let codexChanged = false;
  if (agents.includes("codex")) {
    const directory = join(homeDir(), ".codex");
    const file = join(directory, "hooks.json");
    const directoryExisted = existsSync(directory);
    const fileExisted = existsSync(file);
    codexChanged = installCodex(results, backups, platform);
    if (codexChanged && (!directoryExisted || !fileExisted)) {
      recordInstallCreated(fileExisted ? null : file, directoryExisted ? null : directory);
    }
  }
  if (agents.includes("opencode")) installOpencode(results, backups);
  if (agents.includes("codex")) pruneCodexTrust(results, backups);
  if (!opts.noInstructions) installInstructions(agents, results, backups);
  printResults(results, backups);
  if (platform === "win32") {
    // Windows has no shebang support; PATH is the person's to edit.
    console.log(`Windows: add ${join(homeDir(), ".herdr", "ranch", "bin")} to your PATH to run \`ranch-tasks\` from a terminal (Ranch never edits PATH).`);
  }
  if (agents.includes("codex") && codexChanged) {
    console.log("Codex: approve the new hooks once with /hooks in Codex (it asks you to trust new hooks).");
  }
  // Housekeeping (fixes §3.5/F5): prune dead stores right after installing.
  try {
    const removed = gcStores();
    if (removed.length) console.log(`gc: removed ${removed.length} store file${removed.length === 1 ? "" : "s"}`);
  } catch {
    // gc is best effort.
  }
}

/** Removes everything install added, leaving other content identical. */
export async function uninstall(opts = {}) {
  const agents = selectAgents(opts);
  const home = homeDir();
  const items = [];
  if (agents.includes("claude")) items.push({ path: join(home, ".claude", "settings.json"), action: "remove ranch hooks" });
  if (agents.includes("codex")) items.push({ path: join(home, ".codex", "hooks.json"), action: "remove ranch hooks" });
  if (agents.includes("opencode")) {
    items.push({ path: join(home, ".config", "opencode", "plugins", "ranch-tasks.js"), action: "delete plugin" });
    items.push({ path: readInstallManifest().opencodeTodo?.file ?? opencodeConfigFile(), action: "disable experimental todo tool" });
  }
  if (!items.length) return;
  if (!opts.yes) {
    printPlan(items);
    const ok = await confirm("Proceed? [y/N] ");
    if (!ok) {
      console.log("Aborted — nothing changed.");
      return;
    }
  }
  const results = [];
  uninstallInstructions(agents, results);

  if (agents.includes("claude")) {
    const file = join(home, ".claude", "settings.json");
    if (!existsSync(file)) {
      results.push({ path: file, action: "not present" });
    } else {
      const original = readFileSync(file, "utf8");
      const { doc, removed } = stripRanchHooks(readConfig(file).doc);
      if (!removed || doc == null) {
        results.push({ path: file, action: "unchanged" });
      } else {
        const text = matchingBackup("claude-settings", doc) ?? JSON.stringify(doc, null, 2) + "\n";
        if (text !== original) {
          writeFileSync(file, text);
          results.push({ path: file, action: "removed ranch hooks" });
        } else {
          results.push({ path: file, action: "unchanged" });
        }
      }
    }
  }

  if (agents.includes("codex")) {
    const directory = join(home, ".codex");
    const file = join(directory, "hooks.json");
    const createdDirectory = readInstallManifest().createdDirs.includes(directory);
    if (!existsSync(file)) {
      results.push({ path: file, action: "not present" });
    } else {
      const original = readFileSync(file, "utf8");
      const { doc, removed } = stripRanchHooks(readConfig(file).doc);
      const hooks = doc?.hooks;
      const onlyRanch = doc && Object.keys(doc).length === 1 && "hooks" in doc &&
        hooks && typeof hooks === "object" && Object.keys(hooks).length === 0;
      const backup = removed && doc != null ? matchingBackup("codex-hooks", doc) : null;
      if (removed && onlyRanch && backup === null) {
        unlinkSync(file);
        results.push({ path: file, action: "deleted (Ranch created it)" });
      } else if (!removed || doc == null) {
        results.push({ path: file, action: "unchanged" });
      } else {
        const text = backup ?? JSON.stringify(doc, null, 2) + "\n";
        if (text !== original) {
          writeFileSync(file, text);
          results.push({ path: file, action: "removed ranch hooks" });
        } else {
          results.push({ path: file, action: "unchanged" });
        }
      }
    }
    if (createdDirectory) {
      try {
        if (readdirSync(directory).length === 0) {
          rmdirSync(directory);
          results.push({ path: directory, action: "deleted (created by install)" });
        }
      } catch {}
    }
  }

  if (agents.includes("opencode")) {
    const file = join(home, ".config", "opencode", "plugins", "ranch-tasks.js");
    if (!existsSync(file)) {
      results.push({ path: file, action: "not present" });
    } else if (readFileSync(file, "utf8").includes(PLUGIN_MARKER)) {
      unlinkSync(file);
      results.push({ path: file, action: "deleted" });
    } else {
      results.push({ path: file, action: "unchanged (not Ranch's)" });
    }
    uninstallOpencodeConfig(results);
  }

  printResults(results, []);
}

/** { node, version, agents: { claude, codex, opencode } } per §7 status. */
export function statusSummary(platform = process.platform) {
  const home = homeDir();
  const binExists = existsSync(join(home, ".herdr", "ranch", "bin", "ranch-tasks"));
  const outdated = runningFromRepo() && installedCliDiffers();
  const hookStatus = (file) => {
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return "missing";
    }
    if (!hasRanchHandlers(doc)) return "missing";
    if (!binExists) return "missing";
    if (hasUnrunnableRanchHook(doc, platform)) return "broken";
    return outdated ? "outdated" : "installed";
  };
  const plugin = join(home, ".config", "opencode", "plugins", "ranch-tasks.js");
  const opencode = (() => {
    try {
      if (!readFileSync(plugin, "utf8").includes(PLUGIN_MARKER)) return "missing";
    } catch {
      return "missing";
    }
    return outdated ? "outdated" : "installed";
  })();
  const codexBase = hookStatus(join(home, ".codex", "hooks.json"));
  let codexConfigText = "";
  try {
    codexConfigText = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  } catch {}
  const codex = codexBase === "installed" || codexBase === "outdated"
    ? (codexTrustState(readConfig(join(home, ".codex", "hooks.json")).doc, codexConfigText, join(home, ".codex", "hooks.json")) === "needs approval"
      ? "needs approval"
      : codexBase)
    : codexBase;
  return {
    node: true,
    version: 2,
    agents: {
      claude: hookStatus(join(home, ".claude", "settings.json")),
      codex,
      opencode,
    },
    opencodeTodo: opencodeTodoEnabled(),
  };
}

// ---- Codex hook trust (I11) -------------------------------------------------
// Codex asks you to trust each hook position once; the decisions live as
// `<event>:<group>:<hook>` keys under [hooks.state] in ~/.codex/config.toml
// (legacy format) or as nested `<hooks.json path>:<event>:<group>:<hook>`
// entries (Codex 0.167 format, see codexNestedTrust).
// Positions that no longer exist (hooks reordered or removed) are stale and
// get pruned on install.

/** The [hooks.state] entries of a config.toml text: key -> raw value, or
 * null when the file has no such section. */
export function codexTrustEntries(configText) {
  const entries = new Map();
  let inSection = false;
  let found = false;
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("[")) {
      inSection = t === "[hooks.state]";
      if (inSection) found = true;
      continue;
    }
    if (!inSection) continue;
    const m = /^(?:"([^"]+)"|'([^']+)'|([^=\s#]+))\s*=/.exec(t);
    if (m) entries.set(m[1] ?? m[2] ?? m[3], t.slice(t.indexOf("=") + 1).trim());
  }
  return found ? entries : null;
}

/** TOML dotted key path (header content or key prefix) split into parts:
 * bare keys, "basic" strings (escapes decoded) and 'literal' strings.
 * Returns null for malformed input. */
function tomlKeyParts(text) {
  const t = String(text ?? "");
  const parts = [];
  let i = 0;
  while (i < t.length) {
    if (t[i] === "." || /\s/.test(t[i])) { i++; continue; }
    if (t[i] === '"') {
      let s = "";
      i++;
      let closed = false;
      while (i < t.length) {
        const c = t[i];
        if (c === "\\") {
          const n = t[i + 1];
          if (n === "\\") { s += "\\"; i += 2; }
          else if (n === '"') { s += '"'; i += 2; }
          else if (n === "n") { s += "\n"; i += 2; }
          else if (n === "t") { s += "\t"; i += 2; }
          else if (n === "u" && /^[0-9a-fA-F]{4}/.test(t.slice(i + 2, i + 6))) {
            s += String.fromCharCode(parseInt(t.slice(i + 2, i + 6), 16));
            i += 6;
          } else i++;
        } else if (c === '"') { closed = true; i++; break; }
        else { s += c; i++; }
      }
      if (!closed) return null;
      parts.push(s);
    } else if (t[i] === "'") {
      const j = t.indexOf("'", i + 1);
      if (j === -1) return null;
      parts.push(t.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < t.length && t[j] !== "." && !/\s/.test(t[j])) j++;
      parts.push(t.slice(i, j));
      i = j;
    }
  }
  return parts;
}

/** Splits "key = value" at the first = outside quotes, or null when there is
 * none (unterminated quote). */
function splitTomlKeyValue(line) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "=") return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

/** Value text without a trailing # comment (outside quotes). */
function stripTomlComment(value) {
  let quote = null;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") return value.slice(0, i);
  }
  return value;
}

/** Fills one field (trusted_hash / enabled) of a nested trust entry. */
function applyNestedField(entry, field, value) {
  if (field === "trusted_hash") {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (m) entry.trustedHash = m[1];
  } else if (field === "enabled") {
    if (value === "true" || value === "false") entry.enabled = value === "true";
  }
}

/**
 * Nested hook-trust entries of a config.toml text, in the format current
 * Codex (0.167.x) writes: keys are `<hooks.json path>:<event>:<group>:<hook>`
 * and values carry `enabled` and `trusted_hash`. Accepts header tables
 * ([hooks.state."<key>"]), inline tables and dotted keys under [hooks.state].
 * Skips anything it cannot parse instead of throwing. Pure.
 */
export function codexNestedTrust(configText) {
  const entries = new Map();
  const entry = (key) => {
    let e = entries.get(key);
    if (!e) entries.set(key, (e = { enabled: null, trustedHash: null }));
    return e;
  };
  let section = null; // header key path, parts joined with \0
  let headerKey = null; // nested key of the [hooks.state."<key>"] table in effect
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("[")) {
      const parts = tomlKeyParts(t.slice(1, t.lastIndexOf("]")));
      section = parts?.join("\0") ?? null;
      headerKey = null;
      if (section?.startsWith("hooks\0state\0") && parts.length > 2) headerKey = parts.slice(2).join("");
      continue;
    }
    const kv = splitTomlKeyValue(t);
    if (!kv) continue;
    const parts = tomlKeyParts(kv[0]);
    if (!parts?.length) continue;
    const value = stripTomlComment(kv[1]).trim();
    if (headerKey) {
      if (parts.length === 1) applyNestedField(entry(headerKey), parts[0], value);
      continue;
    }
    if (section !== "hooks\0state") continue;
    if (parts.length === 1) {
      // Inline table spelling: "<key>" = { trusted_hash = "...", enabled = false }
      if (value.startsWith("{") && completeTomlValue(value)) {
        const e = entry(parts[0]);
        const hash = /(?:^|[,{]\s*)trusted_hash\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(value);
        if (hash) e.trustedHash = hash[1];
        const enabled = /(?:^|[,{]\s*)enabled\s*=\s*(true|false)(?![\w-])/.exec(value);
        if (enabled) e.enabled = enabled[1] === "true";
      }
      // Single-part keys are otherwise legacy flat entries: not nested.
      continue;
    }
    applyNestedField(entry(parts.slice(0, -1).join("")), parts[parts.length - 1], value);
  }
  return entries;
}

/** Path normalised for trust-key matching: slashes unified, duplicates
 * collapsed, lower-cased for Windows-looking paths (drive letter or UNC). */
function normaliseHooksPath(path) {
  const raw = String(path ?? "");
  const win = /^[a-z]:/i.test(raw) || raw.startsWith("//") || raw.startsWith("\\\\");
  const s = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return win ? s.toLowerCase() : s;
}

/** <path> and "<event>:<group>:<hook>" of a nested trust key, or null. */
function nestedKeyParts(key) {
  const i1 = key.lastIndexOf(":");
  const i2 = i1 > 0 ? key.lastIndexOf(":", i1 - 1) : -1;
  const i3 = i2 > 0 ? key.lastIndexOf(":", i2 - 1) : -1;
  if (i3 < 0) return null;
  return { path: key.slice(0, i3), pos: key.slice(i3 + 1) };
}

/** The nested trust entry for a hooks.json path + position, or undefined. */
function nestedTrustMatch(nested, home, pos) {
  for (const [key, e] of nested) {
    const parts = nestedKeyParts(key);
    if (parts && parts.pos === pos && normaliseHooksPath(parts.path) === home) return e;
  }
  return undefined;
}

/** TOML event key for a hook event name ("SessionStart" -> "session_start"). */
function snakeEvent(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** "event:group:hook" for every hook registered in a hooks.json doc. */
function codexPositions(doc) {
  const positions = new Set();
  const hooks = doc?.hooks;
  if (!hooks || typeof hooks !== "object") return positions;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let gi = 0; gi < groups.length; gi++) {
      const list = Array.isArray(groups[gi]?.hooks) ? groups[gi].hooks : [];
      for (let hi = 0; hi < list.length; hi++) positions.add(`${snakeEvent(event)}:${gi}:${hi}`);
    }
  }
  return positions;
}

/**
 * null when codex has no ranch hooks or nothing is decided yet (no
 * [hooks.state] section and no nested trust entry for hooksPath);
 * "trusted" when every ranch hook position is trusted; else
 * "needs approval" (shown by `ranch-tasks status`). hooksPath is the
 * absolute path of the hooks.json the doc came from; nested entries
 * (Codex 0.167 format) are only matched when it is given.
 */
export function codexTrustState(hooksDoc, configText, hooksPath) {
  if (!hasRanchHandlers(hooksDoc)) return null;
  const entries = codexTrustEntries(configText);
  const nested = codexNestedTrust(configText);
  const home = hooksPath == null ? null : normaliseHooksPath(hooksPath);
  // null = nothing decided: no legacy [hooks.state] section and no nested
  // trust entries at all (matching today's "cannot tell" meaning).
  if (entries === null && (home === null || nested.size === 0)) return null;
  const hooks = hooksDoc?.hooks;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (let gi = 0; gi < groups.length; gi++) {
      if (!isRanchGroup(groups[gi])) continue;
      const list = Array.isArray(groups[gi]?.hooks) ? groups[gi].hooks : [];
      for (let hi = 0; hi < list.length; hi++) {
        const pos = `${snakeEvent(event)}:${gi}:${hi}`;
        const nestedEntry = home === null ? undefined : nestedTrustMatch(nested, home, pos);
        if (nestedEntry) {
          // Ranch cannot recompute Codex's trusted_hash; a present hash means
          // "trusted, not re-verified".
          if (nestedEntry.enabled === false || !nestedEntry.trustedHash) return "needs approval";
          continue;
        }
        const value = entries?.get(pos);
        if (value === undefined || value === "false") return "needs approval";
      }
    }
  }
  return "trusted";
}

function completeTomlValue(value) {
  let quote = null;
  let escaped = false;
  let content = false;
  const brackets = [];
  for (const c of value) {
    if (quote) {
      content = true;
      if (escaped) escaped = false;
      else if (c === "\\" && quote === '"') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "#") break;
    if (!/\s/.test(c)) content = true;
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") brackets.push(c);
    else if (c === "]" || c === "}") {
      if (brackets.pop() !== (c === "]" ? "[" : "{")) return false;
    }
  }
  return content && !quote && brackets.length === 0;
}

/** config.toml text with [hooks.state] entries whose position no longer
 * exists in the given hooks doc, or null when nothing changed. Nested trust
 * entries (keys that are not the legacy `event:g:h` shape) are never touched.
 * Pure. */
export function pruneCodexTrustText(configText, hooksDoc) {
  const live = codexPositions(hooksDoc);
  const lines = String(configText ?? "").split(/\r?\n/);
  let inSection = false;
  let changed = false;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("[")) {
      inSection = t === "[hooks.state]";
      out.push(line);
      continue;
    }
    if (inSection && t && !t.startsWith("#")) {
      const kv = splitTomlKeyValue(t);
      if (!kv || !completeTomlValue(kv[1])) return null;
      const parts = tomlKeyParts(kv[0]);
      const key = parts?.length === 1 ? parts[0] : kv[0];
      if (/^[a-z_]+:\d+:\d+$/.test(key) && !live.has(key)) {
        changed = true;
        continue;
      }
    }
    out.push(line);
  }
  return changed ? out.join("\n") : null;
}

/** True only when config.toml enables codex's update_plan tool (off by
 * default): [tools.update_plan] + enabled = true, or the equivalent inline /
 * dotted spellings under [tools] or at the root. [profiles.*] ignored. */
export function codexUpdatePlanEnabled(configText) {
  let table = []; // current header key path parts
  for (const line of String(configText ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (t.startsWith("[")) {
      table = tomlKeyParts(t.slice(1, t.lastIndexOf("]"))) ?? ["?"];
      continue;
    }
    const kv = splitTomlKeyValue(t);
    if (!kv) continue;
    const parts = tomlKeyParts(kv[0]);
    if (!parts?.length) continue;
    const value = stripTomlComment(kv[1]).trim();
    const truthy = (v) => v === "true";
    if (parts.length === 1 && parts[0] === "enabled" && table.length === 2 && table[0] === "tools" && table[1] === "update_plan") {
      if (truthy(value)) return true;
    } else if (parts[0] === "update_plan" && table.length === 1 && table[0] === "tools") {
      if (parts.length === 1 && /(?:^|[,{]\s*)enabled\s*=\s*true(?![\w-])/.test(value)) return true;
      if (parts.length === 2 && parts[1] === "enabled" && truthy(value)) return true;
    } else if (parts.length === 3 && table.length === 0
      && parts[0] === "tools" && parts[1] === "update_plan" && parts[2] === "enabled") {
      if (truthy(value)) return true;
    }
  }
  return false;
}

/** Applies pruneCodexTrustText to ~/.codex/config.toml (install, I11). */
function pruneCodexTrust(results, backups) {
  const hooksFile = join(homeDir(), ".codex", "hooks.json");
  const tomlFile = join(homeDir(), ".codex", "config.toml");
  try {
    const doc = JSON.parse(readFileSync(hooksFile, "utf8"));
    const text = readFileSync(tomlFile, "utf8");
    const next = pruneCodexTrustText(text, doc);
    if (next !== null) {
      backupFile(tomlFile, "codex-config", backups);
      writeFileSync(tomlFile, next);
      results.push({ path: tomlFile, action: "removed stale hook trust entries" });
    }
  } catch {
    // no parsable hooks.json or no config.toml: nothing to prune
  }
}

/**
 * Deletes store files for terminals that no longer exist (via `hc ls --json
 * --all`, 5 s timeout): a gone terminal is cleaned after 2 minutes, a finished
 * one once its store has been idle that long; session files untouched for
 * 14 days are pruned (fixes §3.5). Without a working `hc`, only the 14-day
 * rule applies. Reads both the session-keyed layout (terminals/, sessions/)
 * and legacy flat stores, and removes `*.json.tmp-*` leftovers older than a
 * minute in each (I8). Returns the removed file paths.
 */
export function gcStores() {
  const dir = join(homeDir(), ".herdr", "ranch", "tasks");
  const pruneCutoff = Date.now() - STALE.PRUNE_MS;
  const goneCutoff = Date.now() - STALE.GONE_MS;
  let states = null; // terminal address -> state, when hc works
  try {
    const out = execFileSync("hc", ["ls", "--json", "--all"], { timeout: 5000, encoding: "utf8" });
    const data = JSON.parse(out);
    const terminals = Array.isArray(data?.terminals) ? data.terminals : [];
    states = new Map(terminals.filter((t) => t?.address).map((t) => [t.address, t.state]));
  } catch {
    states = null;
  }
  const removed = [];
  const sweep = (subdir, kind) => {
    let names = [];
    const sub = join(dir, subdir);
    try {
      names = readdirSync(sub);
    } catch {
      return;
    }
    for (const name of names) {
      // Leftover temp files from a crashed write (I8): drop after a minute.
      if (/\.json\.tmp-/.test(name)) {
        try {
          if (statSync(join(sub, name)).mtimeMs < Date.now() - 60 * 1000) {
            unlinkSync(join(sub, name));
            removed.push(subdir ? `${subdir}/${name}` : name);
          }
        } catch {}
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const path = join(sub, name);
      let old = false;
      try {
        old = statSync(path).mtimeMs < pruneCutoff;
      } catch {
        continue;
      }
      let dead = false;
      if (kind === "session") {
        dead = old; // 14-day prune
      } else {
        const address = name.slice(0, -".json".length);
        const state = states?.get(address);
        if (states !== null && state === undefined) dead = statMtime(path) < goneCutoff; // terminal gone
        else if (state === "finished") dead = statMtime(path) < goneCutoff; // finished for over 2 min
        else if (kind === "legacy") dead = old || existsSync(join(dir, "terminals", name)); // migrated or stale
        else dead = old;
      }
      if (dead) {
        try {
          unlinkSync(path);
          removed.push(subdir ? `${subdir}/${name}` : name);
        } catch {
          // leave it; the next gc can try again
        }
      }
    }
  };
  sweep("terminals", "terminal");
  sweep("sessions", "session");
  sweep("", "legacy");
  return removed;
}

function statMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
