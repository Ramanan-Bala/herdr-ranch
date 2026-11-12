// ranch-tasks doctor (fixes §3.8): checks the runtime, the per-agent hook
// setup and the OpenCode todo flag, then fires one synthetic event through
// each installed adapter into an isolated store and confirms the store file
// appears. Read-only for the real store; the synthetic events run in a temp
// RANCH_HOME that is deleted afterwards.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStore } from "../lib/tasks.js";
import { homeDir } from "./store.js";
import { claudeTodoEnvEnabled, codexTrustState, codexUpdatePlanEnabled, opencodeTodoEnabled, statusSummary } from "./install.js";

const TODO_PAYLOAD = {
  hook_event_name: "PostToolUse",
  tool_name: "TodoWrite",
  session_id: "ses-ranch-doctor",
  cwd: "/tmp",
  tool_input: { todos: [{ content: "doctor check", status: "in_progress", activeForm: "running doctor" }] },
};

const PLAN_PAYLOAD = {
  hook_event_name: "PostToolUse",
  tool_name: "update_plan",
  session_id: "ses-ranch-doctor",
  cwd: "/tmp",
  tool_input: { plan: [{ step: "doctor check", status: "in_progress" }] },
};

/**
 * The node entry this doctor was installed with (repo run falls back to
 * ../bin). The installed bin/ranch-tasks is a sh launcher, so run the .js.
 */
export function cliPath() {
  const installed = join(homeDir(), ".herdr", "ranch", "bin", "ranch-tasks.js");
  if (existsSync(installed)) return installed;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ranch-tasks");
}

/** Store text of the temp home after a synthetic write: the session file the
 * terminal pointer names, or the terminal file itself while no session id is
 * known (fixes §3.3). Shared by the hook, plugin and plan checks. */
function readSyntheticStore(home) {
  const pointer = readFileSync(join(home, ".herdr", "ranch", "tasks", "terminals", "doctor.json"), "utf8");
  const raw = JSON.parse(pointer);
  const path = typeof raw.session === "string"
    ? join(home, ".herdr", "ranch", "tasks", "sessions", `${raw.session}.json`)
    : pointer;
  return { store: readFileSync(path, "utf8"), pointer };
}

/** Runs one hook adapter against an isolated store; returns the store text. */
function syntheticHook(agent, payload, home) {
  const env = { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: "doctor" };
  const run = spawnSync(process.execPath, [cliPath(), agent], {
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 10000,
  });
  if (run.status !== 0) return { error: run.stderr?.trim() || `exit ${run.status}` };
  try {
    return readSyntheticStore(home);
  } catch (err) {
    return { error: `no store appeared (${err?.code ?? err?.message ?? err})` };
  }
}

/** Fires the plugin's own recorder in-process against an isolated store. */
async function syntheticOpencode(home) {
  const plugin = join(homeDir(), ".config", "opencode", "plugins", "ranch-tasks.js");
  const mod = await import(pathToFileURL(plugin).href);
  const hooks = await (mod.RanchTasks ?? mod.default?.server)();
  const env = { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: "doctor" };
  const saved = { RANCH_HOME: process.env.RANCH_HOME, HC_TERMINAL_ID: process.env.HC_TERMINAL_ID };
  Object.assign(process.env, env);
  try {
    await hooks.event({ event: { type: "todo.updated", properties: { sessionID: "ses-ranch-doctor", todos: [{ id: "1", content: "doctor check", status: "in_progress" }] } } });
  } finally {
    if (saved.RANCH_HOME === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved.RANCH_HOME;
    if (saved.HC_TERMINAL_ID === undefined) delete process.env.HC_TERMINAL_ID; else process.env.HC_TERMINAL_ID = saved.HC_TERMINAL_ID;
  }
  return readSyntheticStore(home);
}

function check(name, ok, detail = "") {
  return { name, ok: !!ok, detail };
}

function storeCheck(name, result) {
  if (result.error) return check(name, false, result.error);
  const parsed = parseStore(result.store);
  if (!parsed.ok) return check(name, false, `store did not parse (${parsed.reason})`);
  const ok = parsed.store.tasks.length === 1 && parsed.store.tasks[0].title === "doctor check";
  return check(name, ok, ok ? "store appeared with the task" : "store missing the task");
}

/**
 * `ranch-tasks plan` end to end in the same temp home: the codex synthetic
 * event left a live Codex session in the terminal, so the command must write
 * the task through the normal store path.
 */
function planCheck(name, run, home) {
  if (run.status !== 0) return check(name, false, run.stderr?.trim() || `exit ${run.status}`);
  let result;
  try {
    result = readSyntheticStore(home);
  } catch (err) {
    return check(name, false, `no store appeared (${err?.code ?? err?.message ?? err})`);
  }
  const parsed = parseStore(result.store);
  if (!parsed.ok) return check(name, false, `store did not parse (${parsed.reason})`);
  const task = parsed.store.tasks.length === 1 ? parsed.store.tasks[0] : null;
  const ok = task?.title === "doctor plan check" && task.status === "in_progress";
  return check(name, ok, ok ? "plan wrote the task" : "store missing the planned task");
}

/** The codex hook-approval check from codexTrustState, plus the
 * informational update_plan check; both only when codex is installed. */
function codexChecks(checks, agents, home) {
  if (!agents?.codex || agents.codex === "missing") return;
  const hooksFile = join(home, ".codex", "hooks.json");
  let doc = null;
  let configText = "";
  try {
    doc = JSON.parse(readFileSync(hooksFile, "utf8"));
  } catch {}
  try {
    configText = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  } catch {}
  const trust = codexTrustState(doc, configText, hooksFile);
  if (trust === "trusted") {
    checks.push(check("codex hook approval", true, "approved in ~/.codex/config.toml (Ranch cannot re-check Codex's hash: if Codex says hooks were modified, re-approve with /hooks)"));
  } else if (trust === "needs approval") {
    checks.push(check("codex hook approval", false, "approve the Ranch hooks once with /hooks in Codex"));
  } else {
    checks.push({ ...check("codex hook approval", true, "not verified: no trust entries for the Ranch hooks found; confirm with /hooks in Codex"), unknown: true });
  }
  checks.push(check("codex update_plan tool", true, codexUpdatePlanEnabled(configText)
    ? "enabled ([tools.update_plan])"
    : "off: Codex reports tasks with `ranch-tasks plan` (enable [tools.update_plan] in ~/.codex/config.toml to use the native tool; see RECIPE.md)"));
}

/** Full doctor report: { ok, checks: [{ name, ok, detail }] }. */
export async function doctor() {
  const checks = [];
  const home = homeDir();
  const bin = join(home, ".herdr", "ranch", "bin", "ranch-tasks");
  checks.push(check("runtime installed", existsSync(bin), bin));

  let executable = false;
  try {
    accessSync(bin, constants.X_OK);
    executable = true;
  } catch {}
  checks.push(check("hook executable on this OS", executable, bin));

  let agents = null;
  try {
    agents = statusSummary().agents;
  } catch {}
  for (const [agent, state] of Object.entries(agents ?? {})) {
    checks.push(check(`${agent} hooks`, state === "installed", state));
  }
  codexChecks(checks, agents, home);
  checks.push(check("opencode experimental.todo", opencodeTodoEnabled(), "opencode config"));
  // Claude Code's task tools: settings env, or the shell exporting it.
  const claudeTodo = claudeTodoEnvEnabled(join(home, ".claude", "settings.json")) || process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS === "1";
  checks.push(check("claude CLAUDE_CODE_ENABLE_TODO_TOOLS", claudeTodo, "~/.claude/settings.json env"));

  // Synthetic events in an isolated store.
  const temp = mkdtempSync(join(tmpdir(), "ranch-doctor-"));
  try {
    checks.push(storeCheck("claude synthetic event", syntheticHook("claude", TODO_PAYLOAD, temp)));
    checks.push(storeCheck("codex synthetic event", syntheticHook("codex", PLAN_PAYLOAD, temp)));
    // `ranch-tasks plan` in the same temp home: the codex event above left a
    // live Codex session in this terminal, so the command may write through.
    const planRun = spawnSync(process.execPath, [cliPath(), "plan", "doing: doctor plan check"], {
      env: { ...process.env, RANCH_HOME: temp, HC_TERMINAL_ID: "doctor" },
      encoding: "utf8",
      timeout: 10000,
    });
    checks.push(planCheck("codex plan command", planRun, temp));
    let opencode = null;
    try {
      opencode = await syntheticOpencode(temp);
    } catch (err) {
      opencode = { error: err?.message ?? String(err) };
    }
    checks.push(storeCheck("opencode synthetic event", opencode, temp));
  } finally {
    try {
      rmSync(temp, { recursive: true, force: true });
    } catch {
      // leave the temp dir; it is in the OS temp folder anyway
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}
