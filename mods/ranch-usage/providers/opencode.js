// OpenCode Go: `opencode api GET /api/experimental/usage/limits`
// (helpers/opencode-usage.sh). The CLI asks OpenCode's own local server;
// nothing here sees a token.
import { makeWindow, okReport, errorReport, unavailableReport } from "../usage/report.js";

const SOURCE = "opencode CLI";
const FIVE_H = 5 * 3600; // s
const WEEK = 7 * 24 * 3600;
const MONTH = 30 * 24 * 3600;

// Bar order: the rolling 5-hour window first, then weekly, then monthly.
const METERS = [
  ["rolling", "5h", "5-hour", FIVE_H],
  ["weekly", "wk", "Weekly", WEEK],
  ["monthly", "mo", "Monthly", MONTH],
];

// Limits' resetsAt is epoch ms; makeWindow floors whatever arrives.
const fromMs = (v) => (typeof v === "number" && Number.isFinite(v) ? v / 1000 : null);

function meterWindows(go) {
  const out = [];
  for (const [key, short, long, durationSec] of METERS) {
    const m = go?.[key];
    if (!m || typeof m !== "object") continue;
    // A meter stuck at its limit reads as 100% even without a percent.
    if (m.limited !== true && (typeof m.percent !== "number" || !Number.isFinite(m.percent))) continue;
    out.push(makeWindow({
      id: key,
      short,
      long,
      percent: m.limited === true ? 100 : m.percent,
      resetsAt: fromMs(m.resetsAt),
      durationSec,
    }));
  }
  return out;
}

function budgetWindows(budgets) {
  const out = [];
  for (const b of Array.isArray(budgets) ? budgets : []) {
    if (!b || typeof b !== "object") continue;
    // A budget without a limit cap is not a limit.
    if (typeof b.limit !== "number" || !Number.isFinite(b.limit) || b.limit <= 0) continue;
    const spent = typeof b.spent === "number" && Number.isFinite(b.spent) ? b.spent : 0;
    out.push(makeWindow({
      id: `budget:${b.id}`,
      short: "$",
      long: `Budget $${b.limit}`,
      percent: Math.min(100, (spent / b.limit) * 100),
      resetsAt: fromMs(b.resetsAt),
    }));
  }
  return out;
}

export function parse(text, now) {
  let body;
  try {
    body = JSON.parse(String(text ?? "").trim());
  } catch {
    return errorReport(SOURCE, "No reply from the opencode CLI", now);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorReport(SOURCE, "No reply from the opencode CLI", now);
  }
  // data is null when the CLI is not signed in to OpenCode Console.
  const data = body.data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return unavailableReport(SOURCE, "Not signed in to OpenCode Console", now);
  }
  const ws = [...meterWindows(data.go), ...budgetWindows(data.budgets)];
  if (ws.length === 0) return unavailableReport(SOURCE, "No OpenCode Go plan or budgets", now);
  return okReport(SOURCE, now, ws, data.go ? "Go" : null);
}

export default {
  id: "opencode",
  name: "OpenCode Go",
  icon: "icons/opencode.svg",
  tint: true, // one-colour glyph (fill="currentColor"): draw with svg() in the text colour
  helper: "helpers/opencode-usage.sh",
  parse,
};
