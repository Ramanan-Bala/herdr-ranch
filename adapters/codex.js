// Codex adapter: pure reducer over hook payloads (requirements.md §7.4).
// Codex exposes no session title, so session.title stays null.

import { tasksFingerprint } from "../lib/tasks.js";

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const KNOWN_EVENTS = new Set([
  "SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "SubagentStop", "SessionEnd", "Stop",
]);

function ensureSession(store) {
  const base = store.session && typeof store.session === "object" ? store.session : {};
  const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...base };
  store.session = session;
  return session;
}

/** Activity for a Codex hook event (same meaning as claudeActivity). */
export function codexActivity(payload) {
  switch (payload?.hook_event_name) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SubagentStart":
      return "working";
    case "PermissionRequest":
      return "blocked";
    case "Stop":
      return "done";
    case "SessionStart":
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

export function applyCodex(store, payload) {
  const next = applyCodexCore(store, payload);
  const state = codexActivity(payload);
  if (!state) return next;
  const base = next && typeof next === "object" ? next : store;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

const PR_URL = /https:\/\/github\.com\/[^\s"'<>()]+\/pull\/(\d+)/;

/** Records a PR URL created by `gh pr create` into store.prs (I4). Codex
 * reports the shell tool as "shell" (command array) or "Bash". */
function recordCreatedPr(store, payload) {
  const input = payload.tool_input;
  const command = Array.isArray(input?.command) ? input.command.join(" ") : input?.command;
  if (typeof command !== "string" || !/\bgh\s+pr\s+create\b/.test(command)) return;
  const response = typeof payload.tool_response === "string"
    ? payload.tool_response
    : JSON.stringify(payload.tool_response ?? "");
  const match = PR_URL.exec(response ?? "");
  if (!match) return;
  const url = match[0];
  if (store.prs?.some((p) => p.url === url)) return;
  store.prs = [...(store.prs ?? []), { url, number: Number(match[1]), at: new Date().toISOString() }].slice(-10);
}

function applyCodexCore(store, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return store;
  const event = payload.hook_event_name;
  if (!KNOWN_EVENTS.has(event)) return store;
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };
  const now = new Date().toISOString();

  if (event !== "SessionStart") {
    const sid = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    if (sid && next.session?.id && next.session.id !== sid) {
      // Session reuse without a SessionStart event (I10): start fresh.
      next.session = { id: sid, title: null, title_source: null, first_prompt: null, state: "running" };
      next.tasks = [];
      next.subagents = [];
    } else if (sid && !next.session?.id) {
      // Keep session.id in sync on every event (I12).
      ensureSession(next).id = sid;
    }
  }

  if (event === "SessionStart") {
    const id = typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    const fresh = payload.source === "startup" || payload.source === "clear" ||
      (id && id !== next.session?.id && payload.source !== "compact");
    if (fresh) {
      next.session = { id, title: null, title_source: null, first_prompt: null, state: "running" };
    } else {
      const session = ensureSession(next);
      if (id) session.id = id;
      session.state = "running";
    }
    if (payload.source === "startup" || payload.source === "clear") {
      next.tasks = [];
      next.subagents = [];
    }
    return next;
  }

  if (event === "UserPromptSubmit") {
    const session = ensureSession(next);
    if (!session.first_prompt && typeof payload.prompt === "string" && payload.prompt) {
      session.first_prompt = payload.prompt.slice(0, 500);
    }
    // Turn tracking (fixes §3.7); Stop compares against it.
    session.turn = { tasks: tasksFingerprint(next.tasks), tools: false };
    return next;
  }

  if (event === "PostToolUse") {
    if (payload.tool_name === "Bash" || payload.tool_name === "shell") recordCreatedPr(next, payload);
    const plan = payload.tool_name === "update_plan" ? payload.tool_input?.plan : null;
    if (Array.isArray(plan)) {
      // Replace tasks entirely from the plan's steps.
      next.tasks = plan.flatMap((step, i) => {
        const title = typeof step?.step === "string" ? step.step.trim() : "";
        if (!title) return [];
        return [{
          id: String(i + 1),
          title,
          status: TASK_STATUS.has(step.status) ? step.status : "pending",
          active_form: null,
        }];
      });
    }
    return next;
  }

  if (event === "Stop") {
    // Miss detection (fixes §3.7). Codex exposes no transcript or tool
    // stream, so a turn that left the task list unchanged counts as missed.
    const session = ensureSession(next);
    if (session.turn && tasksFingerprint(next.tasks) === session.turn.tasks) {
      next.missed_turns = (Number.isInteger(store.missed_turns) ? store.missed_turns : 0) + 1;
    }
    return next;
  }

  if (event === "SubagentStart" || event === "SubagentStop") {
    const raw = payload.agent_id;
    if (raw !== undefined && raw !== null && String(raw) !== "") {
      const id = String(raw);
      if (event === "SubagentStart") {
        next.subagents = [
          ...next.subagents.filter((s) => s.id !== id),
          {
            id,
            name: typeof payload.agent_type === "string" && payload.agent_type ? payload.agent_type : id,
            status: "running",
            started_at: now,
            ended_at: null,
          },
        ];
      } else {
        next.subagents = next.subagents.map((s) => (s.id === id ? { ...s, status: "done", ended_at: now } : s));
      }
    }
    return next;
  }

  // SessionEnd
  ensureSession(next).state = "ended";
  return next;
}
