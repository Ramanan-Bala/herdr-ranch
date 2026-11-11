// Unit tests for the ranch-usage mod's pure helpers: provider parsers and levels.
// Fixtures are inline; no network and no real CLIs are touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folders before imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

const { parse: parseClaude } = await import(join(root, "mods/ranch-usage/providers/claude.js"));
const { parse: parseCodex } = await import(join(root, "mods/ranch-usage/providers/codex.js"));
const { parse: parseCopilot } = await import(join(root, "mods/ranch-usage/providers/copilot.js"));
const { parse: parseOpenCode } = await import(join(root, "mods/ranch-usage/providers/opencode.js"));
const { level } = await import(join(root, "mods/ranch-usage/usage/format.js"));

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

  // HOME is overridden too: without it the helper's ~/.opencode/bin fallback
  // would find a really installed opencode instead of exiting 127.
  const missing = runHelper("opencode-usage.mjs", {
    HERDR_USAGE_OPENCODE_BIN: join(fakes, "no-such-oc"),
    HOME: fakes,
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
