// ranch-tasks CLI (requirements.md §7.4). Subcommands:
//   claude | codex | pi               hook entry points — read stdin JSON,
//                                     update the store, print NOTHING, exit 0
//   antigravity                       Antigravity CLI hook entry point — reads
//                                     stdin JSON, updates store, prints JSON, exits 0
//   install [--yes] [--agents a,b,c]  set the hooks up
//   uninstall [--yes]                 take them back out
//   status [--json]                   what's installed where
//   update [check] [--yes] [--json]   self-update from the repo's main branch
//   gc                                delete store files for dead terminals
//   plan "<status>: <title>" ...      report the whole task list in one go
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hookError, homeDir, recordSharedPr, terminalPath, updateStore } from "./store.js";
import { parsePlanArgs, planSummary } from "./plan.js";
import { agentApp } from "../lib/tasks.js";
import { applyAntigravity } from "./antigravity.js";
import { applyClaude } from "./claude.js";
import { applyCodex } from "./codex.js";
import { applyPi } from "./pi.js";
import { detectCreatedPr, effectiveDir, prCommandOf, prCreateHead, prRepoOf, remoteReposOf } from "../lib/prs.js";
import { gcStores, install, statusSummary, uninstall } from "./install.js";
import { applyUpdate, checkUpdate } from "./update.js";
import { reminderFor } from "./instructions.js";
import { doctor } from "./doctor.js";

const TRANSCRIPT_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
const MAX_TRANSCRIPT = 20 * 1024 * 1024;

/** Transcript JSONL, only when it exists and is under 20 MB. */
function readTranscript(path) {
  if (typeof path !== "string" || !path) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size >= MAX_TRANSCRIPT) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Hook entry point. Everything is wrapped: on any error we log one line to
 * logs/adapter.log and exit 0 with no output. Printing here would inject text into
 * the agent (Claude/Codex read hook stdout as context).
 */
function runHook(agent, apply) {
  try {
    if (!process.env.HC_TERMINAL_ID) return; // not running inside Herdr
    let payload = null;
    try {
      const text = readFileSync(0, "utf8");
      if (text.trim()) payload = JSON.parse(text);
    } catch {
      return; // unparsable stdin: stay silent
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (agent === "claude-code" && TRANSCRIPT_EVENTS.has(payload.hook_event_name)) {
      payload = { ...payload, transcript: readTranscript(payload.transcript_path) };
    }
    const next = updateStore(agent, (store) => {
      const out = apply(store, payload);
      // Reducers surface anomalies (e.g. TaskUpdate for an unknown id, I1)
      // as hook_error: log one line and never persist it.
      if (typeof out?.hook_error === "string") {
        hookError(out.hook_error);
        delete out.hook_error;
      }
      return out;
    });
    // The one deliberate output: a short task-reporting reminder that Claude
    // and Codex add to the model's context (SessionStart, and UserPromptSubmit
    // while there are no open tasks). Everything else stays silent.
    const key = agent === "claude-code" ? "claude" : agent;
    if (process.env.RANCH_REMIND !== "0") {
      const text = reminderFor(key, payload.hook_event_name, next, homeDir());
      if (text) process.stdout.write(text + "\n");
    }
    // Shared PR registry, after the store update: same payload, best effort.
    recordSharedPrFromPayload(payload);
  } catch (err) {
    hookError(err);
  }
}

const PBTXT_ESCAPES = {
  a: 0x07, b: 0x08, f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b, '"': 0x22, "'": 0x27, "\\": 0x5c, "?": 0x3f,
};
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_TASK_MD = 256 * 1024;

function decodePbtxtString(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const rest = raw.slice(i + 1);
      const oct = /^[0-7]{1,3}/.exec(rest);
      if (oct) {
        bytes.push(parseInt(oct[0], 8) & 0xff);
        i += 1 + oct[0].length;
        continue;
      }
      const hex = /^x([0-9a-fA-F]{1,2})/.exec(rest);
      if (hex) {
        bytes.push(parseInt(hex[1], 16));
        i += 1 + hex[0].length;
        continue;
      }
      const u4 = /^u([0-9a-fA-F]{4})/.exec(rest);
      if (u4) {
        for (const b of Buffer.from(String.fromCodePoint(parseInt(u4[1], 16)), "utf8")) bytes.push(b);
        i += 1 + u4[0].length;
        continue;
      }
      const u8 = /^U([0-9a-fA-F]{8})/.exec(rest);
      if (u8) {
        const cp = parseInt(u8[1], 16);
        if (cp <= 0x10ffff) {
          for (const b of Buffer.from(String.fromCodePoint(cp), "utf8")) bytes.push(b);
        }
        i += 1 + u8[0].length;
        continue;
      }
      const esc = raw[i + 1];
      if (Object.prototype.hasOwnProperty.call(PBTXT_ESCAPES, esc)) {
        bytes.push(PBTXT_ESCAPES[esc]);
      } else {
        for (const b of Buffer.from(esc, "utf8")) bytes.push(b);
      }
      i += 2;
      continue;
    }
    const cp = raw.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    i += ch.length;
  }
  return Buffer.from(bytes).toString("utf8");
}

function readPbtxtTitle(home, conversationId) {
  try {
    const path = join(home, ".gemini", "antigravity-cli", "annotations", `${conversationId}.pbtxt`);
    const text = readFileSync(path, "utf8");
    const match = /(?:^|\r?\n)\s*title\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/.exec(text);
    if (!match) return null;
    const title = decodePbtxtString(match[1] ?? match[2] ?? "").trim();
    return title || null;
  } catch {
    return null;
  }
}

async function readAntigravitySqlite(home, conversationId) {
  const dbPath = join(home, ".gemini", "antigravity-cli", "conversation_summaries.db");
  if (!existsSync(dbPath)) return null;
  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
    const row = db
      .prepare("SELECT title, parent_conversation_id FROM conversation_summaries WHERE conversation_id = ?")
      .get(conversationId);
    if (!row) return null;
    return {
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : null,
      parent_conversation_id: typeof row.parent_conversation_id === "string" && row.parent_conversation_id
        ? row.parent_conversation_id
        : null,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function readAntigravityTaskMd(artifactDirectoryPath, home) {
  if (typeof artifactDirectoryPath !== "string" || !artifactDirectoryPath) return undefined;
  try {
    const realGemini = realpathSync(resolve(home, ".gemini"));
    const realTask = realpathSync(resolve(artifactDirectoryPath, "task.md"));
    const rel = relative(realGemini, realTask);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    const stat = statSync(realTask);
    if (!stat.isFile() || stat.size >= MAX_TASK_MD) return undefined;
    return readFileSync(realTask, "utf8");
  } catch {
    return undefined;
  }
}

async function enrichAntigravityPayload(payload, home) {
  const out = { ...payload };
  const cid = typeof payload.conversationId === "string" && UUID_RE.test(payload.conversationId)
    ? payload.conversationId
    : null;
  let title = typeof out.session_title === "string" && out.session_title.trim()
    ? out.session_title.trim()
    : null;
  if (cid) {
    if (!title) title = readPbtxtTitle(home, cid);
    const dbInfo = await readAntigravitySqlite(home, cid);
    if (dbInfo) {
      if (!out.parent_conversation_id && dbInfo.parent_conversation_id) {
        out.parent_conversation_id = dbInfo.parent_conversation_id;
      }
      if (!title && dbInfo.title) title = dbInfo.title;
    }
  }
  if (title) out.session_title = title;
  if (out.task_md === undefined) {
    const taskMd = readAntigravityTaskMd(payload.artifactDirectoryPath, home);
    if (taskMd !== undefined) out.task_md = taskMd;
  }
  return out;
}

/**
 * Antigravity CLI (agy) hook entry point. agy requires a valid JSON object on
 * stdout on every invocation, so we always emit one JSON line (`{}` minimum)
 * and exit 0, even when HC_TERMINAL_ID is unset or stdin is malformed.
 * Stale installs may still invoke us on PreToolUse; because agy treats `{}` as
 * a deny, PreToolUse skips the store update and replies `{"decision":"ask"}`
 * (respecting agy's normal permission flow; never "allow" or "deny").
 */
async function runAntigravityHook() {
  let out = {};
  try {
    let text = "";
    try {
      text = readFileSync(0, "utf8");
    } catch {
      return;
    }
    let payload = null;
    try {
      if (text.trim()) payload = JSON.parse(text);
    } catch {
      if (/"hookEventName"\s*:\s*"PreToolUse"/.test(text)) out = { decision: "ask" };
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    if (payload.hookEventName === "PreToolUse") {
      out = { decision: "ask" };
      return;
    }
    if (!process.env.HC_TERMINAL_ID) return;
    const home = homeDir();
    payload = await enrichAntigravityPayload(payload, home);
    const next = updateStore("antigravity", (store) => {
      const updated = applyAntigravity(store, payload);
      if (typeof updated?.hook_error === "string") {
        hookError(updated.hook_error);
        delete updated.hook_error;
      }
      return updated;
    });
    if (process.env.RANCH_REMIND !== "0") {
      const event = payload.hookEventName === "SessionStart"
        ? "SessionStart"
        : payload.hookEventName === "PreInvocation" && payload.invocationNum === 0
          ? "UserPromptSubmit"
          : null;
      if (event) {
        const taskFile = typeof payload.artifactDirectoryPath === "string" && payload.artifactDirectoryPath
          ? join(payload.artifactDirectoryPath, "task.md")
          : undefined;
        const text = reminderFor("antigravity", event, next, home, { taskFile });
        if (text) out = { injectSteps: [{ systemMessage: { systemMessage: text } }] };
      }
    }
  } catch (err) {
    hookError(err);
    out = {};
  } finally {
    process.stdout.write(JSON.stringify(out) + "\n");
  }
}

const PLAN_AGENTS = new Set(["codex", "antigravity"]);
const REFUSAL = "ranch: this terminal is not running a Codex or Antigravity session; refusing to change its task list";

/**
 * `ranch-tasks plan "<status>: <title>" ...`: Codex or Antigravity reports
 * its whole task list in one shell command. Writes through the normal store
 * writer and reducer only; refuses unless the terminal is live and already
 * running a Codex or Antigravity session (never adopted, no pointer writes,
 * no new locks).
 */
function runPlan(args) {
  if (!process.env.HC_TERMINAL_ID) {
    console.error("ranch: not inside Herdr (HC_TERMINAL_ID is not set)");
    process.exitCode = 1;
    return;
  }
  const parsed = parsePlanArgs(args);
  if (!parsed.ok) {
    console.error(`ranch: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  // Fast refusal: read the terminal pointer directly and check its agent.
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(terminalPath(homeDir(), process.env.HC_TERMINAL_ID), "utf8"));
  } catch {
    // missing or unreadable pointer: refused below
  }
  const app = agentApp(raw?.agent);
  if (!PLAN_AGENTS.has(app)) {
    console.error(REFUSAL);
    process.exitCode = 1;
    return;
  }
  let wrote = false;
  try {
    updateStore(app, (store) => {
      // Guard 2, inside the lock: covers a race with another writer that
      // re-pointed the terminal between the check above and this read.
      const storeApp = agentApp(store?.agent);
      if (!PLAN_AGENTS.has(storeApp) || typeof store?.session?.id !== "string" || !store.session.id) return null;
      wrote = true;
      return storeApp === "antigravity"
        ? applyAntigravity(store, { hookEventName: "RanchPlan", plan: parsed.plan })
        : applyCodex(store, { hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: { plan: parsed.plan } });
    });
  } catch (err) {
    const hint = app === "codex"
      ? " If Codex runs sandboxed, add ~/.herdr/ranch to sandbox_workspace_write.writable_roots or enable [tools.update_plan] (see RECIPE.md)"
      : "";
    console.error(`ranch: could not write the task list (${err?.code ?? err?.message}).${hint}`);
    process.exitCode = 1;
    hookError(err);
    return;
  }
  if (!wrote) {
    console.error(REFUSAL);
    process.exitCode = 1;
    return;
  }
  console.log(planSummary(parsed.plan));
}

/**
 * Repo facts of a `gh pr create` run: its top-level dir, current branch
 * (null when HEAD is detached) and the "owner/repo" list of its remotes,
 * resolved in the payload's cwd (else the hook's cwd). execFileSync with a
 * short timeout; stderr ignored, output never printed. Null when the cwd is
 * not a checkout.
 */
function repoFacts(cwd) {
  const dir = typeof cwd === "string" && cwd ? cwd : process.cwd();
  const git = (args) => {
    try {
      return execFileSync("git", args, {
        cwd: dir, timeout: 2000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const top = git(["rev-parse", "--show-toplevel"]);
  if (!top) return null; // not a checkout
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  return { top, branch: branch && branch !== "HEAD" ? branch : null, remotes: remoteReposOf(git(["remote", "-v"])) };
}

/**
 * Shares a created PR in ~/.herdr/ranch/prs.json (keyed repoTop|branch), so
 * every terminal on that checkout lists it — not just this one's store (I4).
 * The record is only shared when the PR's repo can be confirmed to belong to
 * the checkout the command ran in (that checkout's remotes contain it, and
 * the branch comes from --head or the checkout's HEAD); otherwise it is not
 * shared at all (the creator's own store still has it). Best effort: any
 * failure is one hookError line, nothing on stdout.
 */
function recordSharedPrFromPayload(payload) {
  if (payload?.hook_event_name !== "PostToolUse") return;
  const found = detectCreatedPr(payload);
  if (!found) return;
  const repo = prRepoOf(found.url);
  if (!repo) return;
  const cmd = prCommandOf(payload.tool_input);
  const dir = effectiveDir(cmd, payload.cwd, payload.tool_input?.workdir, process.platform);
  if (!dir) return;
  const facts = repoFacts(dir);
  if (!facts || !facts.remotes.includes(repo)) return;
  const branch = prCreateHead(cmd) ?? facts.branch;
  if (!branch) return;
  recordSharedPr(facts.top, branch, { ...found, at: new Date().toISOString() });
}

function parseArgs(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--yes") flags.yes = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--no-instructions") flags.noInstructions = true;
    else if (arg === "--agents") flags.agents = (rest[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return flags;
}

function humanStatus(summary) {
  const lines = [`node  ${summary.node ? "ok" : "missing"}`];
  for (const [agent, state] of Object.entries(summary.agents)) lines.push(`${agent.padEnd(9)} ${state}`);
  return lines.join("\n");
}

function shortCommit(sha) {
  return sha ? String(sha).slice(0, 7) : "unknown";
}

function humanUpdateCheck(result) {
  if (result.error) return `Ranch update check failed: ${result.error}`;
  if (result.available) return `Update available: ${shortCommit(result.installed)} -> ${shortCommit(result.latest)}`;
  return `Ranch is up to date (${shortCommit(result.installed ?? result.latest)})`;
}

function humanUpdate(result) {
  if (!result.ok) return `Ranch update failed: ${result.error}`;
  if (result.dryRun) {
    const { plan } = result;
    const lines = [
      `Update available: ${shortCommit(result.from)} -> ${shortCommit(result.to)} (dry run)`,
      `  ${plan.copy.length} to copy, ${plan.unchanged.length} unchanged, ${plan.backup.length} to back up, ${plan.remove.length} to remove`,
    ];
    if (plan.backup.length) {
      lines.push("Backups:");
      for (const rel of plan.backup) lines.push(`  ${rel}`);
    }
    lines.push("Run with --yes to apply.");
    return lines.join("\n");
  }
  const lines = [
    `Ranch updated: ${shortCommit(result.from)} -> ${shortCommit(result.to)}`,
    result.bridgeOnly
      ? "  task reporting only (the Ranch layout lives in the app on another computer)"
      : `  copied ${result.copied}, removed ${result.removed}`,
  ];
  if (result.backupDir) {
    lines.push(`  backups: ${result.backupDir}`);
    for (const rel of result.backedUp) lines.push(`    ${rel}`);
  }
  lines.push(`  tasks: ${result.tasks}`);
  return lines.join("\n");
}

const USAGE =
  'usage: ranch-tasks <claude|codex|pi|antigravity|plan "<status>: <title>" ...|doctor [--json]|install [--yes] [--no-instructions] [--agents claude,codex,opencode,pi,antigravity]|uninstall [--yes]|status [--json]|update [check] [--yes] [--json]|gc>';

export async function main(argv) {
  const [command = "", ...rest] = argv ?? [];
  if (command === "claude") {
    runHook("claude-code", applyClaude);
    return;
  }
  if (command === "codex") {
    runHook("codex", applyCodex);
    return;
  }
  if (command === "pi") {
    runHook("pi", applyPi);
    return;
  }
  if (command === "antigravity") {
    await runAntigravityHook();
    return;
  }
  if (command === "plan") {
    runPlan(rest);
    return;
  }
  if (command === "install") {
    await install(parseArgs(rest));
    return;
  }
  if (command === "uninstall") {
    await uninstall(parseArgs(rest));
    return;
  }
  if (command === "status") {
    const summary = statusSummary();
    console.log(parseArgs(rest).json ? JSON.stringify(summary, null, 2) : humanStatus(summary));
    return;
  }
  if (command === "update") {
    const flags = parseArgs(rest);
    if (rest[0] === "check") {
      const result = checkUpdate();
      console.log(flags.json ? JSON.stringify(result, null, 2) : humanUpdateCheck(result));
      return;
    }
    const result = applyUpdate({ yes: flags.yes });
    console.log(flags.json ? JSON.stringify(result, null, 2) : humanUpdate(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "gc") {
    const removed = gcStores();
    console.log(`ranch-tasks gc: removed ${removed.length} store file${removed.length === 1 ? "" : "s"}`);
    return;
  }
  if (command === "doctor") {
    const report = await doctor();
    console.log(parseArgs(rest).json ? JSON.stringify(report, null, 2) : humanDoctor(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}

function humanDoctor(report) {
  const lines = [report.ok ? "ranch-tasks doctor: ok" : "ranch-tasks doctor: problems found"];
  for (const check of report.checks) {
    // "??": passes, but could not be verified from here (e.g. Codex hook trust).
    lines.push(`${!check.ok ? "FAIL" : check.unknown ? "??  " : "ok  "}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  return lines.join("\n");
}
