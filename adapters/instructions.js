// Ranch task-reporting instructions for each agent's global instruction file,
// plus the short reminder hooks inject into context. Installed and removed by
// adapters/install.js; every block is wrapped in markers so uninstall can take
// back exactly what install added.

import { looksWindows, tasksCommand } from "../lib/tasks-command.js";

export const BEGIN = "<!-- ranch-tasks:begin -->";
export const END = "<!-- ranch-tasks:end -->";

const TOOL = {
  claude: "your task tool (TaskCreate to add tasks, TaskUpdate to change status; TodoWrite if that is what you have)",
  opencode: "the todowrite tool",
};

const PLAN_EXAMPLE = `"doing: <first task>" "todo: <next task>"`;
const PLAN_NOTE = "(one quoted argument per task, prefixes todo/doing/done/skip; each run replaces the whole list, so always pass every task)";

/** Shell-ready absolute `ranch-tasks plan` command for a home dir ("ranch-tasks plan" without one). */
export function planCommandLine(home) {
  if (!home) return "ranch-tasks plan";
  const win = looksWindows(home);
  const [cmd, args] = tasksCommand(win ? String(home).replace(/\\/g, "/") : home, ["plan"], win);
  if (win) return `node "${args[0]}" ${args.slice(1).join(" ")}`;
  return `${cmd.includes(" ") ? `"${cmd}"` : cmd} ${args.join(" ")}`;
}

/** The rules, worded for one agent ("claude" | "codex" | "opencode"). */
export function rulesFor(agent, home) {
  const tool =
    agent === "codex"
      ? `the update_plan tool if you have it; otherwise run \`${planCommandLine(home)} ${PLAN_EXAMPLE}\` ${PLAN_NOTE}`
      : (TOOL[agent] ?? "your task/todo tool");
  return `# Task reporting (Ranch) - mandatory for every message

The person watches your progress in Herdr's Ranch panel, which shows your task
list live. This rule is non-negotiable and applies to EVERY message the person
sends, with no exceptions (questions and one-line answers included):

1. Before doing anything else in your reply, record the work as tasks with
   ${tool}: at least one task per message, one task per concrete step when
   there are several.
2. Mark a task in_progress when you start it and completed the moment it is
   done. Exactly one task is in_progress while you are working.
3. Before you end your reply, every task for that message is completed (or
   explicitly left pending with the reason stated). Never leave finished work
   marked pending or in_progress.
4. When the plan changes, update the list (add, reword or remove tasks) before
   continuing.
`;
}

/** The marked block for an AGENTS.md / CLAUDE.md style file. */
export function blockFor(agent, home) {
  return `${BEGIN}\n${rulesFor(agent, home)}${END}\n`;
}

/** The line Claude's CLAUDE.md gets: an import of ~/.claude/RANCH.md. */
export const CLAUDE_IMPORT = `${BEGIN}\n@RANCH.md\n${END}\n`;

/** Removes every marked Ranch block (and the blank line before it) from text,
 * keeping the file's own line endings (CRLF files stay CRLF). */
export function stripBlock(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const re = new RegExp(`(?:\\r?\\n)?${escape(BEGIN)}[\\s\\S]*?${escape(END)}(?:\\r?\\n)?`, "g");
  return text.replace(re, eol).replace(/\n{3,}$/, "\n\n");
}

/** Text with the block appended once (replacing an older Ranch block), in the
 * file's line endings so uninstall restores it byte-for-byte. */
export function withBlock(text, block) {
  const crlf = (text ?? "").includes("\r\n");
  const base = stripBlock(text ?? "").replace(/\s*$/, "");
  const body = crlf ? block.replace(/\r?\n/g, "\r\n") : block;
  const sep = crlf ? "\r\n\r\n" : "\n\n";
  return base ? `${base}${sep}${body}` : body;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hook reminder injected into the agent's context (Claude and Codex add a
 * SessionStart / UserPromptSubmit hook's stdout as context). Conditional
 * (fixes §3.7): nudged on session start and on prompts until a list exists;
 * once there is one, only when the previous turn did not update it
 * (missed_turns > 0).
 */
export function reminderFor(agent, event, store, home) {
  const tool =
    agent === "codex"
      ? `update_plan (or, without it: ${planCommandLine(home)} "doing: ..." "todo: ...")`
      : agent === "opencode"
        ? "todowrite"
        : "TaskCreate/TaskUpdate";
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return null;
  const hasList = Array.isArray(store?.tasks) && store.tasks.length > 0;
  const missed = Number.isInteger(store?.missed_turns) && store.missed_turns > 0;
  if (hasList && !missed) return null;
  if (event === "SessionStart") {
    return `Ranch task reporting is mandatory: for EVERY user message, first record the work as tasks with ${tool}, mark each in_progress then completed, and finish all of them before ending your reply.`;
  }
  return `Ranch (mandatory): before anything else, add task(s) for this message with ${tool}; mark in_progress, then completed before you finish.`;
}
