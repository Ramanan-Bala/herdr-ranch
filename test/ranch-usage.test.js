// Unit tests for the ranch-usage mod's pure helpers: provider parsers and levels.
// Fixtures are inline; no network and no real CLIs are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folders before imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { parse: parseClaude } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/claude.js")).href
);
const { parse: parseCodex } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/codex.js")).href
);
const { parse: parseCopilot } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/copilot.js")).href
);
const { parse: parseOpenCode } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/opencode.js")).href
);
const { parse: parseAntigravity } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/antigravity.js")).href
);
const { PROVIDERS } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/providers/index.js")).href
);
const { level } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/usage/format.js")).href
);
const { effectivePrefs, isShown, toggleProvider, toggleWindow } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/usage/prefs.js")).href
);
const { parseSession, sessionView } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/usage/session.js")).href
);
const { UNREPORTED } = await import(
  pathToFileURL(join(root, "mods/ranch-usage/usage/unreported.js")).href
);

const NOW = Math.floor(Date.parse("2026-11-11T10:00:00Z") / 1000);

// --------------------------------------------------------------------- claude

// The CLI's `get_usage` control response (helpers/claude-usage.mjs prints one line).
const claudeReply = (response) =>
  JSON.stringify({ type: "control_response", response: { subtype: "success", response } }) + "\n";

test("claude parse: rate_limits.limits shape", () => {
  const r = parseClaude(claudeReply({
    subscription_type: "pro",
    rate_limits: {
      limits: [
        { kind: "session", percent: 21.4, resets_at: "2026-11-11T15:00:00Z" },
        { kind: "weekly_all", percent: 3, resets_at: "2026-11-16T00:00:00Z" },
      ],
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, "pro");
  assert.deepEqual(r.windows.map((w) => w.id), ["session", "weekly_all"]);
  assert.deepEqual(r.windows.map((w) => w.percent), [21, 3]);
  assert.equal(r.windows[0].resetsAt, Date.parse("2026-11-11T15:00:00Z") / 1000);
  assert.equal(r.windows[0].durationSec, 5 * 3600);
});

test("claude parse: legacy five_hour / seven_day shape", () => {
  const r = parseClaude(claudeReply({
    rate_limits: {
      five_hour: { utilization: 40.6, resets_at: "2026-11-11T16:00:00Z" },
      seven_day: { utilization: 10, resets_at: "2026-11-18T00:00:00Z" },
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.windows.map((w) => w.id), ["session", "weekly_all"]);
  assert.deepEqual(r.windows.map((w) => w.percent), [41, 10]);
});

test("claude parse: no control_response line is an error", () => {
  const r = parseClaude('{"type":"system","subtype":"init"}\n', NOW);
  assert.equal(r.status, "error");
  assert.deepEqual(r.windows, []);
});

// ---------------------------------------------------------------------- codex

test("codex parse: account/rateLimits/read reply", () => {
  const r = parseCodex(JSON.stringify({
    id: 2,
    result: {
      rateLimits: {
        limitId: "codex",
        planType: "plus",
        primary: { usedPercent: 12.3, windowDurationMins: 300, resetsAt: "2026-11-11T14:00:00Z" },
        secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: "2026-11-16T00:00:00Z" },
      },
    },
  }) + "\n", NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, "plus");
  assert.deepEqual(r.windows.map((w) => w.id), ["codex:primary", "codex:secondary"]);
  assert.deepEqual(r.windows.map((w) => w.percent), [12, 5]);
  assert.deepEqual(r.windows.map((w) => w.short), ["5h", "wk"]);
  assert.equal(r.windows[0].resetsAt, Date.parse("2026-11-11T14:00:00Z") / 1000);
  assert.equal(r.windows[1].durationSec, 7 * 24 * 3600);
});

test("codex parse: error reply is an error", () => {
  const r = parseCodex(JSON.stringify({ id: 2, error: { message: "not signed in" } }), NOW);
  assert.equal(r.status, "error");
});

// -------------------------------------------------------------------- copilot

// Real response, trimmed: gh api /copilot_internal/user.
const copilotReply = JSON.stringify({
  copilot_plan: "individual",
  access_type_sku: "free_limited_copilot",
  quota_reset_date: "2026-12-01",
  quota_snapshots: {
    chat: { entitlement: 200, remaining: 200, percent_remaining: 100.0, unlimited: false, quota_id: "chat" },
    completions: { entitlement: 2000, remaining: 1998, percent_remaining: 99.9, unlimited: false, quota_id: "completions" },
    premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40.0, unlimited: false, quota_id: "premium_interactions" },
  },
});

test("copilot parse: one window per limited snapshot, in the fixed order", () => {
  const r = parseCopilot(copilotReply, NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, "individual");
  assert.equal(r.windows.length, 3);
  assert.deepEqual(r.windows.map((w) => w.id), ["premium_interactions", "chat", "completions"]);
  assert.deepEqual(r.windows.map((w) => w.short), ["prem", "chat", "comp"]);
  assert.deepEqual(r.windows.map((w) => w.long), ["Premium requests", "Chat", "Completions"]);
  assert.equal(r.windows[0].percent, 60);
  assert.equal(r.windows[1].percent, 0);
  // 100 − 99.9, rounded by makeWindow.
  assert.ok(Math.abs(r.windows[2].percent - 0.1) < 0.5);
  assert.equal(r.windows[0].resetsAt, Date.parse("2026-12-01") / 1000);
  assert.equal(r.windows[0].durationSec, 30 * 24 * 3600);
});

test("copilot parse: unlimited snapshot is skipped, unknown id keeps its key", () => {
  const r = parseCopilot(JSON.stringify({
    copilot_plan: "pro",
    quota_reset_date: "2026-12-01",
    quota_snapshots: {
      chat: { entitlement: 300, remaining: 300, percent_remaining: 100.0, unlimited: true, quota_id: "chat" },
      agent: { entitlement: 100, remaining: 55, percent_remaining: 55.0, unlimited: false, quota_id: "agent" },
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.windows.map((w) => w.id), ["agent"]);
  assert.equal(r.windows[0].short, "agent");
  assert.equal(r.windows[0].percent, 45);
});

test("copilot parse: a quota the plan doesn't have (0 of 0) is skipped, not shown as 100%", () => {
  const r = parseCopilot(JSON.stringify({
    copilot_plan: "individual",
    quota_reset_date: "2026-12-01",
    quota_snapshots: {
      chat: { entitlement: 200, remaining: 150, percent_remaining: 75.0, unlimited: false, has_quota: true, quota_id: "chat" },
      premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0.0, unlimited: false, has_quota: false, quota_id: "premium_interactions" },
    },
  }), NOW);
  assert.deepEqual(r.windows.map((w) => w.id), ["chat"]);
  assert.equal(r.windows[0].percent, 25);
});

test("copilot parse: no usable snapshot is unavailable, garbage is an error", () => {
  const empty = parseCopilot(JSON.stringify({ copilot_plan: "individual", quota_snapshots: {} }), NOW);
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.message, "No Copilot limits");
  const garbage = parseCopilot("gh: not logged in\n", NOW);
  assert.equal(garbage.status, "error");
  assert.deepEqual(garbage.windows, []);
});

// ------------------------------------------------------------------ opencode

// Real reply, trimmed: opencode api GET /api/experimental/usage/limits.
const opencodeReply = JSON.stringify({
  location: { directory: "/Users/x" },
  data: {
    workspace: { id: "wrk_X", name: "Default", usageURL: "https://opencode.ai/console/wrk_X/activity/overview" },
    go: {
      rolling: { percent: 1, limited: false, resetsAt: 1794416002000 },
      weekly: { percent: 32, limited: false, resetsAt: 1794787200000 },
      monthly: { percent: 30, limited: false, resetsAt: 1796628870000 },
    },
    budgets: [],
  },
});

test("opencode parse: one window per data.go meter, resets in seconds", () => {
  const r = parseOpenCode(opencodeReply, NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, "Go");
  assert.equal(r.windows.length, 3);
  assert.deepEqual(r.windows.map((w) => w.id), ["rolling", "weekly", "monthly"]);
  assert.deepEqual(r.windows.map((w) => w.short), ["5h", "wk", "mo"]);
  assert.deepEqual(r.windows.map((w) => w.long), ["5-hour", "Weekly", "Monthly"]);
  assert.deepEqual(r.windows.map((w) => w.percent), [1, 32, 30]);
  assert.deepEqual(r.windows.map((w) => w.resetsAt), [1794416002000 / 1000, 1794787200000 / 1000, 1796628870000 / 1000]);
  assert.deepEqual(r.windows.map((w) => w.durationSec), [5 * 3600, 7 * 24 * 3600, 30 * 24 * 3600]);
});

test("opencode parse: a meter at its limit reads as 100%", () => {
  const r = parseOpenCode(JSON.stringify({
    data: { go: { rolling: { percent: 1, limited: true, resetsAt: 1794416002000 } }, budgets: [] },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.windows[0].percent, 100);
});

test("opencode parse: one window per USD budget, spent as a share of limit", () => {
  const r = parseOpenCode(JSON.stringify({
    data: {
      go: undefined,
      budgets: [{ id: "team", limit: 20, spent: 5, resetsAt: 1796628870000 }],
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.plan, null);
  assert.deepEqual(r.windows.map((w) => w.id), ["budget:team"]);
  assert.deepEqual(r.windows.map((w) => w.short), ["$"]);
  assert.deepEqual(r.windows.map((w) => w.long), ["Budget $20"]);
  assert.deepEqual(r.windows.map((w) => w.percent), [25]);
  assert.equal(r.windows[0].resetsAt, 1796628870000 / 1000);
});

test("opencode parse: data null is not signed in, no go or budgets is unavailable, garbage is an error", () => {
  const signedOut = parseOpenCode(JSON.stringify({ data: null }), NOW);
  assert.equal(signedOut.status, "unavailable");
  assert.equal(signedOut.message, "Not signed in to OpenCode Console");
  const noPlan = parseOpenCode(JSON.stringify({ data: { workspace: { id: "wrk_X" }, budgets: [] } }), NOW);
  assert.equal(noPlan.status, "unavailable");
  assert.equal(noPlan.message, "No OpenCode Go plan or budgets");
  const garbage = parseOpenCode("opencode: not logged in\n", NOW);
  assert.equal(garbage.status, "error");
  assert.equal(garbage.message, "No reply from the opencode CLI");
  assert.deepEqual(garbage.windows, []);
});

// --------------------------------------------------------------- antigravity

// Real reply, trimmed: agy -p /usage --output-format json.
const antigravityReply = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "<tsv text>",
  command: {
    name: "usage",
    data: {
      description: "Usage limits",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: ...",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              description: "...",
              window: "weekly",
              remaining_fraction: 0.9224,
              reset_time: "2026-11-27T03:40:36Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.7287,
              reset_time: "2026-11-20T08:40:36Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-27T03:40:36Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.4,
              reset_time: "2026-11-20T09:00:00Z",
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              name: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remaining_fraction: 1,
            },
          ],
        },
      ],
    },
  },
});

test("antigravity parse: 5 windows in group order with 5h before weekly, correct percents/resets/labels", () => {
  const r = parseAntigravity(antigravityReply, NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.source, "agy CLI");
  assert.equal(r.windows.length, 5);
  assert.deepEqual(
    r.windows.map((w) => w.id),
    ["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly", "gemini-argon-wtu-weekly"],
  );
  assert.deepEqual(r.windows.map((w) => w.percent), [27, 8, 60, 0, 0]);
  assert.deepEqual(r.windows.map((w) => w.short), ["5h", "wk", "C+G 5h", "C+G wk", "Argon wk"]);
  assert.deepEqual(r.windows.map((w) => w.long), [
    "Gemini Models · Five Hour Limit Remaining",
    "Gemini Models · Weekly Limit Remaining",
    "Claude and GPT models · Five Hour Limit Remaining",
    "Claude and GPT models · Weekly Limit Remaining",
    "Gemini 4 Argon · Gemini 4 Argon Weekly Limit",
  ]);
  assert.deepEqual(r.windows.map((w) => w.resetsAt), [
    Date.parse("2026-11-20T08:40:36Z") / 1000,
    Date.parse("2026-11-27T03:40:36Z") / 1000,
    Date.parse("2026-11-20T09:00:00Z") / 1000,
    Date.parse("2026-11-27T03:40:36Z") / 1000,
    null,
  ]);
  assert.deepEqual(r.windows.map((w) => w.durationSec), [18000, 604800, 18000, 604800, 604800]);
});

test("antigravity parse: an unstarted window's 1970 reset_time means no reset, not expired", () => {
  const r = parseAntigravity(JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          { name: "Gemini Models", buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.5, reset_time: "2026-11-20T08:40:36Z" }] },
          {
            name: "Claude and GPT models",
            buckets: [
              { id: "3p-weekly", window: "weekly", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
              { id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "1970-01-01T00:00:00Z" },
            ],
          },
        ],
      },
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.windows.map((w) => [w.id, w.percent, w.resetsAt]), [
    ["gemini-5h", 50, Date.parse("2026-11-20T08:40:36Z") / 1000],
    ["3p-5h", 0, null],
    ["3p-weekly", 0, null],
  ]);
});

test("antigravity parse: disabled bucket and non-numeric remaining_fraction skipped; missing id falls back to index", () => {
  const r = parseAntigravity(JSON.stringify({
    status: "SUCCESS",
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              { id: "disabled-one", window: "5h", disabled: true, remaining_fraction: 0.5 },
              { id: "no-fraction", window: "weekly" },
              { window: "weekly", remaining_fraction: 0.25 },
            ],
          },
        ],
      },
    },
  }), NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].id, "0:2");
  assert.equal(r.windows[0].percent, 75);
  assert.equal(r.windows[0].short, "wk");
  assert.equal(r.windows[0].long, "Gemini Models · Weekly");
});

test("antigravity parse: non-SUCCESS is error, missing data/buckets is unavailable, garbage is error", () => {
  const err = parseAntigravity(JSON.stringify({ status: "ERROR", error: "Not signed in to Antigravity" }), NOW);
  assert.equal(err.status, "error");
  assert.equal(err.source, "agy CLI");
  assert.equal(err.message, "Not signed in to Antigravity");
  assert.deepEqual(err.windows, []);

  const missingData = parseAntigravity(JSON.stringify({ status: "SUCCESS", command: { name: "usage" } }), NOW);
  assert.equal(missingData.status, "unavailable");
  assert.equal(missingData.source, "agy CLI");

  const emptyBuckets = parseAntigravity(JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [] } } }), NOW);
  assert.equal(emptyBuckets.status, "unavailable");

  const garbage = parseAntigravity("agy: not logged in\n", NOW);
  assert.equal(garbage.status, "error");
  assert.equal(garbage.source, "agy CLI");
  assert.deepEqual(garbage.windows, []);
});

test("antigravity registration and prefs (hidden provider and hiddenWindows)", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(ids.indexOf("antigravity"), ids.indexOf("opencode") + 1);
  const agy = PROVIDERS.find((p) => p.id === "antigravity");
  assert.equal(agy.icon, "icons/antigravity.svg");
  assert.equal(agy.helper, "helpers/antigravity-usage.mjs");

  let prefs = effectivePrefs(null, {});
  assert.equal(isShown(prefs, "antigravity", "3p-5h"), true);
  prefs = toggleWindow(prefs, "antigravity", "3p-5h");
  assert.equal(isShown(prefs, "antigravity", "3p-5h"), false);
  assert.equal(isShown(prefs, "antigravity", "gemini-5h"), true);
  assert.ok(prefs.hiddenWindows.includes("antigravity:3p-5h"));
  prefs = toggleProvider(prefs, "antigravity");
  assert.equal(isShown(prefs, "antigravity"), false);
  assert.equal(isShown(prefs, "antigravity", "gemini-5h"), false);
});

// ------------------------------------------------------------------ unreported

test("UNREPORTED is empty now that Antigravity has a provider", () => {
  assert.deepEqual(UNREPORTED, []);
});

// -------------------------------------------------------------------- levels

test("level thresholds: 70/90", () => {
  assert.equal(level(69), "ok");
  assert.equal(level(70), "warn");
  assert.equal(level(89), "warn");
  assert.equal(level(90), "hot");
  assert.equal(level(100), "hot");
});

// ------------------------------------------------- ported helpers (fixes doc F11)

// The helpers/*.mjs run as plain `node helper.mjs` processes and talk to the
// CLIs themselves. The fake CLIs here are sh scripts wired in through the
// HERDR_USAGE_*_BIN overrides the helpers accept, so no real CLI is touched.
const helpersDir = join(root, "mods/ranch-usage/helpers");
const runHelper = (name, vars, args = []) =>
  spawnSync("node", [join(helpersDir, name), ...args], { encoding: "utf8", env: { ...process.env, ...vars } });

const fakes = mkdtempSync(join(tmpdir(), "ranch-usage-helpers-"));
const fake = (name, body) => {
  const p = join(fakes, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

test("copilot-usage.mjs prints the gh reply; 1 on failure, 127 without gh", () => {
  const ok = runHelper("copilot-usage.mjs", {
    HERDR_USAGE_GH_BIN: fake("gh-ok", `printf '%s\\n' '{"copilot_plan":"individual"}'`),
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '{"copilot_plan":"individual"}\n');

  const failed = runHelper("copilot-usage.mjs", { HERDR_USAGE_GH_BIN: fake("gh-fail", "exit 1") });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");

  const missing = runHelper("copilot-usage.mjs", { HERDR_USAGE_GH_BIN: join(fakes, "no-such-gh") });
  assert.equal(missing.status, 127);
});

test("claude-usage.mjs prints only the control_response line; 1 without one, 127 without claude", () => {
  const reply = fake(
    "claude-reply",
    `read line
printf '%s\\n' '{"type":"system","subtype":"init"}'
printf '%s\\n' '{"type":"control_response","response":{"subtype":"success"}}'`
  );
  const ok = runHelper("claude-usage.mjs", { HERDR_USAGE_CLAUDE_BIN: reply });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '{"type":"control_response","response":{"subtype":"success"}}\n');

  const silent = runHelper("claude-usage.mjs", { HERDR_USAGE_CLAUDE_BIN: fake("claude-silent", "exit 0") });
  assert.equal(silent.status, 1);
  assert.equal(silent.stdout, "");

  const missing = runHelper("claude-usage.mjs", { HERDR_USAGE_CLAUDE_BIN: join(fakes, "no-such-claude") });
  assert.equal(missing.status, 127);
});

test("opencode-usage.mjs prints the reply with \"data\"; 1 without one, 127 without the CLI", () => {
  const ok = runHelper("opencode-usage.mjs", {
    HERDR_USAGE_OPENCODE_BIN: fake("oc-ok", `printf '%s\\n' '{"data":{"go":{}}}'`),
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '{"data":{"go":{}}}\n');

  const silent = runHelper("opencode-usage.mjs", {
    HERDR_USAGE_OPENCODE_BIN: fake("oc-bad", `printf '%s\\n' 'nope'`),
  });
  assert.equal(silent.status, 1);
  assert.equal(silent.stdout, "");

  // HOME and USERPROFILE are overridden too: without them the helper's
  // ~/.opencode/bin fallback would find a really installed opencode instead
  // of exiting 127. USERPROFILE because Windows homedir() ignores HOME.
  const missing = runHelper("opencode-usage.mjs", {
    HERDR_USAGE_OPENCODE_BIN: join(fakes, "no-such-oc"),
    HOME: fakes,
    USERPROFILE: fakes,
  });
  assert.equal(missing.status, 127);
});

test("codex-limits.mjs prints the id:2 reply, else the newest session snapshot", () => {
  const ok = runHelper("codex-limits.mjs", {
    HERDR_USAGE_CODEX_BIN: fake(
      "codex-reply",
      `printf '%s\\n' '{"id":2,"result":{"rateLimits":{"limitId":"codex"}}}'`
    ),
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '{"id":2,"result":{"rateLimits":{"limitId":"codex"}}}\n');

  // No app-server reply: the newest rate_limits line of the last 14 days of
  // session logs, wrapped as {"snapshot": <line>}.
  const codexHome = join(fakes, "codex-home");
  const rollout = join(codexHome, "sessions", "2026", "11", "rollout-1.jsonl");
  mkdirSync(join(rollout, ".."), { recursive: true });
  const snapshotLine = '{"timestamp":"2026-11-11T00:00:00Z","payload":{"rate_limits":{"limit_id":"codex"}}}';
  writeFileSync(rollout, snapshotLine + "\n");
  const snap = runHelper("codex-limits.mjs", {
    HERDR_USAGE_CODEX_BIN: fake("codex-silent", "exit 0"),
    CODEX_HOME: codexHome,
  });
  assert.equal(snap.status, 0);
  assert.equal(snap.stdout, `{"snapshot":${snapshotLine}}\n`);

  // Nothing anywhere: exit 1 (codex found but no reply and no snapshot).
  const none = runHelper("codex-limits.mjs", {
    HERDR_USAGE_CODEX_BIN: fake("codex-silent", "exit 0"),
    CODEX_HOME: join(fakes, "empty-codex-home"),
  });
  assert.equal(none.status, 1);

  const missing = runHelper("codex-limits.mjs", { HERDR_USAGE_CODEX_BIN: join(fakes, "no-such-codex") });
  assert.equal(missing.status, 127);
});

test("session.mjs claude: same numbers as the sh+awk helper", () => {
  const conf = join(fakes, "claude-conf");
  mkdirSync(join(conf, "sessions"), { recursive: true });
  mkdirSync(join(conf, "projects", "p1"), { recursive: true });
  writeFileSync(join(conf, "sessions", "4242.json"), '{"sessionId":"abc-123"}');
  writeFileSync(
    join(conf, "projects", "p1", "abc-123.jsonl"),
    [
      '{"type":"user","isSidechain":false,"message":"hi"}',
      '{"type":"user","isSidechain":false,"isMeta":true}',
      '{"content":"says \\"type\\":\\"user\\" and \\"isSidechain\\":false in text"}',
      '{"subtype":"compact_boundary","preTokens":100,"postTokens":50,"trigger":"auto"}',
      '{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}}',
      // With server tools the last {"input_tokens": of the iterations is the context.
      '{"type":"assistant","isSidechain":false,"message":{"usage":{"iterations":[{"input_tokens":5},{"input_tokens":9}],"input_tokens":7}}}',
    ].join("\n") + "\n"
  );
  const r = runHelper("session.mjs", { CLAUDE_CONFIG_DIR: conf }, ["claude", "4242"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "tokens=9 calls=1 compactions=1 lastTrigger=auto lastPre=100 lastPost=50\n");
});

test("session.mjs: no session file exits 1; missing pid exits 1; codex (via sh) exits 1 for an unknown pid", () => {
  const conf = join(fakes, "claude-empty");
  mkdirSync(conf, { recursive: true });
  assert.equal(runHelper("session.mjs", { CLAUDE_CONFIG_DIR: conf }, ["claude", "4242"]).status, 1);
  assert.equal(runHelper("session.mjs", { CLAUDE_CONFIG_DIR: conf }, []).status, 1);
  assert.equal(runHelper("session.mjs", { CLAUDE_CONFIG_DIR: conf }, ["codex", "999999"]).status, 1);
});

test("antigravity-usage.mjs prints JSON with status; 1 on failure, 127 without agy", () => {
  const ok = runHelper("antigravity-usage.mjs", {
    HERDR_USAGE_AGY_BIN: fake("agy-ok", `printf '%s\\n' '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}'`),
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}}\n');

  const nonSuccess = runHelper("antigravity-usage.mjs", {
    HERDR_USAGE_AGY_BIN: fake("agy-err", `printf '%s\\n' '{"status":"ERROR","error":"Not signed in"}'; exit 1`),
  });
  assert.equal(nonSuccess.status, 0);
  assert.equal(nonSuccess.stdout, '{"status":"ERROR","error":"Not signed in"}\n');

  const bad = runHelper("antigravity-usage.mjs", {
    HERDR_USAGE_AGY_BIN: fake("agy-bad", `printf '%s\\n' 'nope'`),
  });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");

  const missing = runHelper("antigravity-usage.mjs", {
    HERDR_USAGE_AGY_BIN: join(fakes, "no-such-agy"),
  });
  assert.equal(missing.status, 127);
});

test("session.mjs antigravity: reads latest PLANNER_RESPONSE tokens and call count from transcript", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-usage-agy-"));
  const convId = "123e4567-e89b-12d3-a456-426614174000";
  const tasksDir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(join(tasksDir, "terminals"), { recursive: true });
  mkdirSync(join(tasksDir, "sessions"), { recursive: true });
  writeFileSync(join(tasksDir, "terminals", "t6.json"), JSON.stringify({
    version: 2,
    terminal: "t6",
    agent: { app: "antigravity", session: convId, pid: 100 },
    session: convId,
  }));
  writeFileSync(join(tasksDir, "sessions", `${convId}.json`), JSON.stringify({
    version: 2,
    terminal: "t6",
    agent: { app: "antigravity", session: convId, pid: 100 },
    session: { id: convId, state: "running" },
  }));

  const logsDir = join(home, ".gemini", "antigravity-cli", "brain", convId, ".system_generated", "logs");
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, "transcript.jsonl"),
    [
      '{"step_index":0,"type":"USER_INPUT","content":"hello"}',
      '{"step_index":1,"type":"PLANNER_RESPONSE","model":"gemini-4-neon-high","input_tokens":1000,"cache_read_tokens":500,"output_tokens":200}',
      '{"step_index":2,"type":"GENERIC","content":"mentions \\"PLANNER_RESPONSE\\" in text"}',
      '{"step_index":3,"type":"PLANNER_RESPONSE","model":"gemini-4-neon-high","input_tokens":12000,"cache_read_tokens":3400,"output_tokens":450}',
    ].join("\n") + "\n",
  );

  const r = runHelper("session.mjs", { RANCH_HOME: home }, ["antigravity", "t6"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "tokens=15400 calls=2\n");

  const parsed = parseSession(r.stdout, "antigravity");
  assert.deepEqual(parsed, {
    app: "antigravity",
    tokens: 15400,
    window: null,
    calls: 2,
    compactions: null,
    last: null,
  });
  const view = sessionView(parsed, "ranch");
  assert.equal(view.context.text, "15k");
  assert.equal(view.context.fill, null);
  assert.equal(view.calls, "2 calls");
});

test("session.mjs antigravity: validates UUID, blocks path escape / symlinks, and caps reads at ~2 MB", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-usage-agy-sec-"));
  const tasksDir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(join(tasksDir, "terminals"), { recursive: true });
  mkdirSync(join(tasksDir, "sessions"), { recursive: true });

  // 1. Non-UUID / traversal conversationId is rejected before path construction.
  for (const badId of ["not-a-uuid", "../escape", "123e4567-e89b-12d3-a456-426614174000/../../etc"]) {
    writeFileSync(join(tasksDir, "terminals", "tbad.json"), JSON.stringify({
      version: 2,
      terminal: "tbad",
      agent: { app: "antigravity", session: badId, pid: 1 },
      session: { id: badId, state: "running" },
    }));
    const r = runHelper("session.mjs", { RANCH_HOME: home }, ["antigravity", "tbad"]);
    assert.equal(r.status, 1, `should reject conversationId=${badId}`);
  }

  // 2. Symlink escaping ~/.gemini/antigravity-cli is rejected.
  const outside = join(home, "outside.jsonl");
  writeFileSync(outside, '{"type":"PLANNER_RESPONSE","input_tokens":500,"cache_read_tokens":0}\n');
  const symId = "223e4567-e89b-12d3-a456-426614174000";
  writeFileSync(join(tasksDir, "terminals", "tsym.json"), JSON.stringify({
    version: 2,
    terminal: "tsym",
    agent: { app: "antigravity", session: symId, pid: 1 },
    session: { id: symId, state: "running" },
  }));
  const symLogs = join(home, ".gemini", "antigravity-cli", "brain", symId, ".system_generated", "logs");
  mkdirSync(symLogs, { recursive: true });
  symlinkSync(outside, join(symLogs, "transcript.jsonl"));
  assert.equal(runHelper("session.mjs", { RANCH_HOME: home }, ["antigravity", "tsym"]).status, 1);

  // 3. Large (>2 MB) transcript reads only the tail and still finds the latest PLANNER_RESPONSE.
  const bigId = "323e4567-e89b-12d3-a456-426614174000";
  writeFileSync(join(tasksDir, "terminals", "tbig.json"), JSON.stringify({
    version: 2,
    terminal: "tbig",
    agent: { app: "antigravity", session: bigId, pid: 1 },
    session: { id: bigId, state: "running" },
  }));
  const bigLogs = join(home, ".gemini", "antigravity-cli", "brain", bigId, ".system_generated", "logs");
  mkdirSync(bigLogs, { recursive: true });
  const padLine = JSON.stringify({ type: "GENERIC", content: "x".repeat(10000) }) + "\n";
  const bigContent =
    '{"type":"PLANNER_RESPONSE","input_tokens":111,"cache_read_tokens":0}\n'
    + padLine.repeat(240) // ~2.4 MB of padding pushes the first step outside the 2 MB tail
    + '{"type":"PLANNER_RESPONSE","input_tokens":42000,"cache_read_tokens":8000}\n';
  writeFileSync(join(bigLogs, "transcript.jsonl"), bigContent);
  const big = runHelper("session.mjs", { RANCH_HOME: home }, ["antigravity", "tbig"]);
  assert.equal(big.status, 0);
  assert.equal(big.stdout, "tokens=50000 calls=1\n");
});
