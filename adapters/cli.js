// ranch-tasks CLI (requirements.md §7.4). Subcommands:
//   claude | codex                    hook entry points — read stdin JSON,
//                                     update the store, print NOTHING, exit 0
//   install [--yes] [--agents a,b,c]  set the hooks up
//   uninstall [--yes]                 take them back out
//   status [--json]                   what's installed where
//   gc                                delete store files for dead terminals
//   plan "<status>: <title>" ...      report the whole task list in one go
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hookError, homeDir, recordSharedPr, terminalPath, updateStore } from "./store.js";
import { parsePlanArgs, planSummary } from "./plan.js";
import { agentApp } from "../lib/tasks.js";
import { applyClaude } from "./claude.js";
import { applyCodex } from "./codex.js";
import { detectCreatedPr, effectiveDir, prCommandOf, prCreateHead, prRepoOf, remoteReposOf } from "../lib/prs.js";
import { gcStores, install, statusSummary, uninstall } from "./install.js";
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

const REFUSAL = "ranch: this terminal is not running a Codex session; refusing to change its task list";

/**
 * `ranch-tasks plan "<status>: <title>" ...`: the Codex agent reports its
 * whole task list in one shell command. Writes through the normal store
 * writer and reducer only; refuses unless the terminal is live and already
 * running a Codex session (never adopted, no pointer writes, no new locks).
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
  if (agentApp(raw?.agent) !== "codex") {
    console.error(REFUSAL);
    process.exitCode = 1;
    return;
  }
  let wrote = false;
  try {
    updateStore("codex", (store) => {
      // Guard 2, inside the lock: covers a race with another writer that
      // re-pointed the terminal between the check above and this read.
      if (agentApp(store?.agent) !== "codex" || typeof store?.session?.id !== "string" || !store.session.id) return null;
      wrote = true;
      return applyCodex(store, { hook_event_name: "PostToolUse", tool_name: "update_plan", tool_input: { plan: parsed.plan } });
    });
  } catch (err) {
    console.error(`ranch: could not write the task list (${err?.code ?? err?.message}). If Codex runs sandboxed, add ~/.herdr/ranch to sandbox_workspace_write.writable_roots or enable [tools.update_plan] (see RECIPE.md)`);
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

const USAGE =
  'usage: ranch-tasks <claude|codex|plan "<status>: <title>" ...|doctor [--json]|install [--yes] [--no-instructions] [--agents claude,codex,opencode]|uninstall [--yes]|status [--json]|gc>';

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
