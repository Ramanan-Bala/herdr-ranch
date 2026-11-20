// Antigravity: `agy -p /usage --output-format json`
// (helpers/antigravity-usage.mjs). The CLI authenticates itself and starts no
// turn; nothing here sees a token.
import { makeWindow, okReport, errorReport, unavailableReport, toEpoch } from "../usage/report.js";

const SOURCE = "agy CLI";
const FIVE_H = 5 * 3600; // s (18000)
const WEEK = 7 * 24 * 3600; // s (604800)

/** @type {Record<string, number>} */
const DURATION = { "5h": FIVE_H, weekly: WEEK };
/** @type {Record<string, string>} */
const SHORT = { "5h": "5h", weekly: "wk" };
/** @type {Record<string, string>} */
const LONG = { "5h": "5-hour", weekly: "Weekly" };
/** @type {Record<string, number>} */
const ORDER = { "5h": 0, weekly: 1 };

// Compact bar prefix for non-primary groups:
// "Claude and GPT models" -> "C+G", "Gemini 4 Argon" -> "Argon".
function groupPrefix(name, groupIndex) {
  const cleaned = String(name ?? "").trim().replace(/\s+models?$/i, "").trim();
  if (!cleaned) return `G${groupIndex + 1}`;
  if (/\s+(?:and|&)\s+/i.test(cleaned)) {
    const initials = cleaned
      .split(/\s+(?:and|&)\s+/i)
      .map((part) => part.trim().charAt(0).toUpperCase())
      .filter(Boolean);
    if (initials.length >= 2) return initials.join("+");
  }
  const words = cleaned.split(/\s+/).filter((w) => w && !/^\d+(?:\.\d+)*$/.test(w));
  const pick = words.at(-1) ?? cleaned;
  return pick.length > 10 ? pick.slice(0, 10) : pick;
}

function windowRank(win) {
  return Object.prototype.hasOwnProperty.call(ORDER, win) ? ORDER[win] : 2;
}

function bucketWindows(groups) {
  const out = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    if (!group || typeof group !== "object") continue;
    const rawBuckets = Array.isArray(group.buckets) ? group.buckets : [];
    const indexed = rawBuckets.map((bucket, bi) => ({ bucket, bi }));
    indexed.sort((a, b) => windowRank(a.bucket?.window) - windowRank(b.bucket?.window) || a.bi - b.bi);

    const groupName = typeof group.name === "string" && group.name.trim() ? group.name.trim() : null;
    const prefix = gi === 0 ? null : groupPrefix(groupName, gi);

    for (const { bucket: b, bi } of indexed) {
      if (!b || typeof b !== "object" || b.disabled === true) continue;
      if (typeof b.remaining_fraction !== "number" || !Number.isFinite(b.remaining_fraction)) continue;
      const id = typeof b.id === "string" && b.id.trim() ? b.id.trim() : `${gi}:${bi}`;
      const win = typeof b.window === "string" ? b.window.trim() : "";
      const winShort = SHORT[win] ?? (win || id);
      const bucketName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : (LONG[win] ?? (win || id));
      const percent = Math.min(100, Math.max(0, (1 - b.remaining_fraction) * 100));
      out.push(makeWindow({
        id,
        short: prefix ? `${prefix} ${winShort}` : winShort,
        long: groupName ? `${groupName} · ${bucketName}` : bucketName,
        percent,
        resetsAt: toEpoch(b.reset_time),
        durationSec: DURATION[win] ?? null,
      }));
    }
  }
  return out;
}

function errorMessage(body) {
  const raw = typeof body.error === "string"
    ? body.error
    : typeof body.error?.message === "string"
      ? body.error.message
      : typeof body.response === "string"
        ? body.response
        : "";
  const line = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
  if (!line) return "agy CLI could not read usage";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

export function parse(text, now) {
  let body;
  try {
    body = JSON.parse(String(text ?? "").trim());
  } catch {
    return errorReport(SOURCE, "No reply from the agy CLI", now);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorReport(SOURCE, "No reply from the agy CLI", now);
  }
  if (body.status !== "SUCCESS") {
    return errorReport(SOURCE, errorMessage(body), now);
  }
  const data = body.command?.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.groups)) {
    return unavailableReport(SOURCE, "No Antigravity usage data", now);
  }
  const ws = bucketWindows(data.groups);
  if (ws.length === 0) return unavailableReport(SOURCE, "No Antigravity limits", now);
  return okReport(SOURCE, now, ws);
}

export default {
  id: "antigravity",
  name: "Antigravity",
  icon: "icons/antigravity.svg",
  helper: "helpers/antigravity-usage.mjs",
  parse,
};
