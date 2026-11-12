// Pure argument parsing for `ranch-tasks plan` (no fs, no process access):
// turns "<status>: <title>" shell arguments into an update_plan-shaped list.
// Codex itself never sees this; the CLI feeds the result through the same
// update_plan reducer.

const PREFIXES = {
  todo: "pending",
  pending: "pending",
  doing: "in_progress",
  in_progress: "in_progress",
  done: "completed",
  completed: "completed",
  skip: "cancelled",
  cancelled: "cancelled",
};

const MAX_TASKS = 50;
const MAX_TITLE = 500;

/**
 * Parses `["<prefix>: <title>", ...]` into [{ step, status }] — the same shape
 * Codex's update_plan tool takes. Returns { ok: true, plan } |
 * { ok: false, error }: never throws, so the CLI can print one clean line.
 */
export function parsePlanArgs(args) {
  if (!args.length) return { ok: false, error: 'no tasks given: pass one or more "<status>: <title>" arguments' };
  if (args.length > MAX_TASKS) return { ok: false, error: `too many tasks: ${args.length} given, the limit is ${MAX_TASKS}` };
  const plan = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const n = i + 1;
    if (typeof arg !== "string") return { ok: false, error: `task ${n}: argument must be a string` };
    const sep = arg.indexOf(":");
    if (sep < 0) return { ok: false, error: `task ${n}: missing ":" separator — expected "<status>: <title>"` };
    const prefix = arg.slice(0, sep).trim().toLowerCase();
    const status = PREFIXES[prefix];
    if (!status) {
      return { ok: false, error: `task ${n}: unknown status "${prefix}" — valid prefixes are todo, doing, done, skip` };
    }
    // Titles may contain colons: split on the first one only, and collapse
    // every run of whitespace (including newlines) into one space.
    const step = arg.slice(sep + 1).replace(/\s+/g, " ").trim();
    if (!step) return { ok: false, error: `task ${n}: empty title after "${prefix}:"` };
    if (step.length > MAX_TITLE) return { ok: false, error: `task ${n}: title is longer than ${MAX_TITLE} characters` };
    plan.push({ step, status });
  }
  return { ok: true, plan };
}

/**
 * One stdout line for a successful plan write, e.g.
 * "ranch: 3 tasks (1 doing, 1 done, 1 todo)". Counts are ordered doing,
 * done, todo, skip; zero counts are omitted.
 */
export function planSummary(plan) {
  const labels = { in_progress: "doing", completed: "done", pending: "todo", cancelled: "skip" };
  const counts = {};
  for (const task of plan) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const parts = ["in_progress", "completed", "pending", "cancelled"]
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${labels[status]}`);
  const n = plan.length;
  return `ranch: ${n} task${n === 1 ? "" : "s"} (${parts.join(", ")})`;
}
