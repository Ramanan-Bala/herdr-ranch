// Ranch task-reporting instructions for each agent's global instruction file,
// plus the short reminder hooks inject into context. Installed and removed by
// adapters/install.js; every block is wrapped in markers so uninstall can take
// back exactly what install added.

export const BEGIN = "<!-- ranch-tasks:begin -->";
export const END = "<!-- ranch-tasks:end -->";

const TOOL = {
  claude: "your task tool (TaskCreate to add tasks, TaskUpdate to change status; TodoWrite if that is what you have)",
  codex: "the update_plan tool",
  opencode: "the todowrite tool",
};

/** The rules, worded for one agent ("claude" | "codex" | "opencode"). */
export function rulesFor(agent) {
  const tool = TOOL[agent] ?? "your task/todo tool";
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
export function blockFor(agent) {
  return `${BEGIN}\n${rulesFor(agent)}${END}\n`;
}

/** The line Claude's CLAUDE.md gets: an import of ~/.claude/RANCH.md. */
export const CLAUDE_IMPORT = `${BEGIN}\n@RANCH.md\n${END}\n`;

/** Removes every marked Ranch block (and the blank line before it) from text. */
export function stripBlock(text) {
  const re = new RegExp(`\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`, "g");
  return text.replace(re, "\n").replace(/\n{3,}$/, "\n\n");
}

/** Text with the block appended once (replacing an older Ranch block). */
export function withBlock(text, block) {
  const base = stripBlock(text ?? "").replace(/\s*$/, "");
  return base ? `${base}\n\n${block}` : block;
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hook reminder injected into the agent's context (Claude and Codex add a
 * SessionStart / UserPromptSubmit hook's stdout as context). Sent on every
 * prompt: task reporting is mandatory for every user message.
 */
export function reminderFor(agent, event, store) {
  const tool = agent === "codex" ? "update_plan" : agent === "opencode" ? "todowrite" : "TaskCreate/TaskUpdate";
  if (event === "SessionStart") {
    return `Ranch task reporting is mandatory: for EVERY user message, first record the work as tasks with ${tool}, mark each in_progress then completed, and finish all of them before ending your reply.`;
  }
  if (event === "UserPromptSubmit") {
    return `Ranch (mandatory): before anything else, add task(s) for this message with ${tool}; mark in_progress, then completed before you finish.`;
  }
  return null;
}
