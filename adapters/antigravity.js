// Antigravity CLI (agy) adapter: pure reducer over hook payloads (no fs/process).
// Event mapping:
//   SessionStart (new conversations only)        -> activity "idle", sets session.id
//   PreInvocation { invocationNum: 0 }           -> turn start (first_prompt, turn tracking), activity "working"
//   PreInvocation (invocationNum > 0),
//   PostToolUse, PostInvocation                  -> marks turn tools (PostToolUse; PreToolUse also accepted), activity "working"
//   Stop                                         -> activity "done", judges missed_turns
//   RanchPlan (synthetic, from ranch-tasks plan) -> replaces tasks, clears missed_turns on change
// CLI-enriched fields on payload: session_title, task_md, parent_conversation_id.

import { createHash } from "node:crypto";
import { tasksFingerprint } from "../lib/tasks.js";

const TASK_STATUS = new Set(["pending", "in_progress", "completed", "cancelled"]);
const KNOWN_EVENTS = new Set([
  "SessionStart",
  "PreInvocation",
  "PreToolUse",
  "PostToolUse",
  "PostInvocation",
  "Stop",
  "RanchPlan",
]);

const CHECKLIST_STATUS = {
  " ": "pending",
  "/": "in_progress",
  x: "completed",
  X: "completed",
  "-": "cancelled",
  "~": "cancelled",
};

const MAX_TASKS = 50;
const MAX_TITLE = 500;

function ensureSession(store) {
  const base = store.session && typeof store.session === "object" ? store.session : {};
  const session = { id: null, title: null, title_source: null, first_prompt: null, state: "running", ...base };
  store.session = session;
  return session;
}

function shortHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Parses markdown checklist items from task.md into Ranch task records. */
function parseTaskMd(text) {
  const tasks = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*[-*+]\s+\[([ /xX\-~])\]\s+(.*)$/.exec(line);
    if (!match) continue;
    const title = match[2].trim().slice(0, MAX_TITLE);
    if (!title) continue;
    tasks.push({
      id: String(tasks.length + 1),
      title,
      status: CHECKLIST_STATUS[match[1]] ?? "pending",
      active_form: null,
    });
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks;
}

function isSubagentEvent(store, payload) {
  const parentId = typeof payload?.parent_conversation_id === "string" && payload.parent_conversation_id
    ? payload.parent_conversation_id
    : null;
  const mainId = typeof store?.session?.id === "string" && store.session.id ? store.session.id : null;
  return Boolean(parentId && mainId && parentId === mainId);
}

/** Activity for an Antigravity hook event (same meaning as claudeActivity). */
export function antigravityActivity(payload) {
  switch (payload?.hookEventName) {
    case "SessionStart":
      return "idle";
    case "PreInvocation":
    case "PreToolUse":
    case "PostToolUse":
    case "PostInvocation":
      return "working";
    case "Stop":
      return "done";
    default:
      return null;
  }
}

export function applyAntigravity(store, payload) {
  const next = applyAntigravityCore(store, payload);
  if (isSubagentEvent(store, payload)) return next;
  const state = antigravityActivity(payload);
  if (!state) return next;
  const base = next && typeof next === "object" ? next : store;
  const session = base.session && typeof base.session === "object"
    ? base.session
    : { id: null, title: null, title_source: null, first_prompt: null, state: "running" };
  return { ...base, session: { ...session, activity: { state, at: Date.now() } } };
}

function applyAntigravityCore(store, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return store;
  const event = payload.hookEventName;
  if (!KNOWN_EVENTS.has(event)) return store;
  const next = { ...store, tasks: [...(store.tasks ?? [])], subagents: [...(store.subagents ?? [])] };
  const now = new Date().toISOString();

  if (isSubagentEvent(next, payload)) {
    const subId = typeof payload.conversationId === "string" && payload.conversationId ? payload.conversationId : null;
    if (!subId || subId === next.session.id) return next;
    const existing = next.subagents.find((s) => s.id === subId);
    const title = typeof payload.session_title === "string" && payload.session_title.trim()
      ? payload.session_title.trim()
      : null;
    const name = title ?? existing?.name ?? subId;
    const entry = event === "Stop"
      ? { id: subId, name, status: "done", started_at: existing?.started_at ?? now, ended_at: now }
      : { id: subId, name, status: "running", started_at: existing?.started_at ?? now, ended_at: null };
    next.subagents = existing
      ? next.subagents.map((s) => (s.id === subId ? entry : s))
      : [...next.subagents, entry];
    return next;
  }

  if (event === "RanchPlan") {
    const before = tasksFingerprint(next.tasks);
    if (Array.isArray(payload.plan)) {
      next.tasks = payload.plan.flatMap((step, i) => {
        const title = typeof step?.step === "string" ? step.step.trim().slice(0, MAX_TITLE) : "";
        if (!title) return [];
        return [{
          id: String(i + 1),
          title,
          status: TASK_STATUS.has(step.status) ? step.status : "pending",
          active_form: null,
        }];
      });
    }
    if (tasksFingerprint(next.tasks) !== before) next.missed_turns = 0;
    return next;
  }

  const sid = typeof payload.conversationId === "string" && payload.conversationId ? payload.conversationId : null;
  if (sid && next.session?.id && next.session.id !== sid) {
    // Conversation changed (new session or /resume in the same terminal): start fresh.
    next.session = { id: sid, title: null, title_source: null, first_prompt: null, state: "running" };
    next.tasks = [];
    next.subagents = [];
    next.missed_turns = 0;
    delete next.antigravity_task_md;
  } else if (sid && !next.session?.id) {
    ensureSession(next).id = sid;
  }

  if (event === "SessionStart") {
    ensureSession(next).state = "running";
  }

  if (typeof payload.session_title === "string") {
    const title = payload.session_title.trim();
    if (title) {
      const session = ensureSession(next);
      if (session.title_source !== "user") {
        session.title = title;
        session.title_source = "agent";
      }
    }
  }

  if (typeof payload.task_md === "string") {
    const hash = shortHash(payload.task_md);
    if (hash !== next.antigravity_task_md) {
      const before = tasksFingerprint(next.tasks);
      next.tasks = parseTaskMd(payload.task_md);
      next.antigravity_task_md = hash;
      if (tasksFingerprint(next.tasks) !== before) next.missed_turns = 0;
    }
  }

  if (event === "PreInvocation" && payload.invocationNum === 0) {
    const session = ensureSession(next);
    if (!session.first_prompt && typeof payload.lastUserInput === "string" && payload.lastUserInput) {
      session.first_prompt = payload.lastUserInput.slice(0, MAX_TITLE);
    }
    session.turn = { tasks: tasksFingerprint(next.tasks), tools: false };
    return next;
  }

  if (event === "PreToolUse" || event === "PostToolUse") {
    const turn = next.session?.turn;
    if (turn && !turn.tools) {
      next.session = { ...next.session, turn: { ...turn, tools: true } };
    }
    return next;
  }

  if (event === "Stop") {
    const session = ensureSession(next);
    if (session.turn) {
      if (session.turn.tools && tasksFingerprint(next.tasks) === session.turn.tasks) {
        next.missed_turns = (Number.isInteger(next.missed_turns) ? next.missed_turns : 0) + 1;
      }
      delete session.turn;
    }
    return next;
  }

  return next;
}
