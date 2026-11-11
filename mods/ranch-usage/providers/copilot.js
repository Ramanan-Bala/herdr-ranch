// GitHub Copilot: `gh api /copilot_internal/user` (helpers/copilot-usage.sh).
// gh authenticates itself; nothing here sees a token.
import { makeWindow, okReport, errorReport, unavailableReport, toEpoch } from "../usage/report.js";

const SOURCE = "gh CLI";
const MONTH = 30 * 24 * 3600; // s; the reset date is a bare day, so pace the month as 30 days

// Bar order: premium requests first, then chat and completions, the rest after.
const ORDER = ["premium_interactions", "chat", "completions"];
const LABEL = {
  premium_interactions: { short: "prem", long: "Premium requests" },
  chat: { short: "chat", long: "Chat" },
  completions: { short: "comp", long: "Completions" },
};

function windows(snapshots, resetsAt) {
  const ids = Object.keys(snapshots ?? {}).sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
  });
  const out = [];
  for (const id of ids) {
    const s = snapshots[id];
    if (!s || s.unlimited === true) continue;
    // A plan without this quota (free plans' premium requests) reports 0 of 0: not a limit.
    if (s.has_quota === false || s.entitlement === 0) continue;
    if (typeof s.percent_remaining !== "number" || !Number.isFinite(s.percent_remaining)) continue;
    const label = LABEL[id] ?? { short: id, long: id };
    out.push(makeWindow({
      id,
      short: label.short,
      long: label.long,
      percent: 100 - s.percent_remaining,
      resetsAt,
      durationSec: MONTH,
    }));
  }
  return out;
}

export function parse(text, now) {
  let body;
  try {
    body = JSON.parse(String(text ?? "").trim());
  } catch {
    return errorReport(SOURCE, "No reply from the gh CLI", now);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorReport(SOURCE, "No reply from the gh CLI", now);
  }
  const plan = typeof body.copilot_plan === "string" ? body.copilot_plan : null;
  // quota_reset_date_utc (ISO) when present, else the bare day in quota_reset_date.
  const resetsAt = toEpoch(body.quota_reset_date_utc ?? body.quota_reset_date);
  const ws = windows(body.quota_snapshots, resetsAt);
  if (ws.length === 0) return unavailableReport(SOURCE, "No Copilot limits", now);
  return okReport(SOURCE, now, ws, plan);
}

export default {
  id: "copilot",
  name: "Copilot",
  icon: "icons/copilot.svg",
  helper: "helpers/copilot-usage.sh",
  parse,
};
