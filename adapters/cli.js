// ranch-tasks CLI (requirements.md §7.4). Subcommands:
//   claude | codex                    hook entry points — read stdin JSON,
//                                     update the store, print NOTHING, exit 0
//   install [--yes] [--agents a,b,c]  set the hooks up
//   uninstall [--yes]                 take them back out
//   status [--json]                   what's installed where
//   gc                                delete store files for dead terminals
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeDir, updateStore } from "./store.js";
import { applyClaude } from "./claude.js";
import { applyCodex } from "./codex.js";
import { gcStores, install, statusSummary, uninstall } from "./install.js";
import { reminderFor } from "./instructions.js";

const TRANSCRIPT_EVENTS = new Set(["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]);
const MAX_TRANSCRIPT = 20 * 1024 * 1024;

/**
 * One line per error to ~/.herdr/ranch/logs/errors.log — never to stdout,
 * which the agent would read as context.
 */
function hookError(err) {
  try {
    const dir = join(homeDir(), ".herdr", "ranch", "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "errors.log"), `${new Date().toISOString()} ${err?.stack ?? String(err)}\n`);
  } catch {
    // out of options; stay silent
  }
}

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
 * errors.log and exit 0 with no output. Printing here would inject text into
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
    const next = updateStore(agent, (store) => apply(store, payload));
    // The one deliberate output: a short task-reporting reminder that Claude
    // and Codex add to the model's context (SessionStart, and UserPromptSubmit
    // while there are no open tasks). Everything else stays silent.
    const key = agent === "claude-code" ? "claude" : agent;
    if (process.env.RANCH_REMIND !== "0") {
      const text = reminderFor(key, payload.hook_event_name, next);
      if (text) process.stdout.write(text + "\n");
    }
  } catch (err) {
    hookError(err);
  }
}

function parseArgs(rest) {
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--yes") flags.yes = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--agents") flags.agents = (rest[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return flags;
}

function humanStatus(summary) {
  const lines = [`node  ${summary.node ? "ok" : "missing"}`];
  for (const [agent, state] of Object.entries(summary.agents)) lines.push(`${agent.padEnd(9)} ${state}`);
  return lines.join("\n");
}

const USAGE =
  "usage: ranch-tasks <claude|codex|install [--yes] [--agents claude,codex,opencode]|uninstall [--yes]|status [--json]|gc>";

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
  if (command === "gc") {
    const removed = gcStores();
    console.log(`ranch-tasks gc: removed ${removed.length} store file${removed.length === 1 ? "" : "s"}`);
    return;
  }
  console.error(USAGE);
  process.exitCode = 1;
}
