// Regression tests for the task-integrity fixes (docs/fixes/
// ranch-task-reporter-integrity.md): I1 task ids, I4 recorded PRs,
// I8/I9 store write/lock, I10 identity, I11 codex trust, I12 session ids,
// I13 opencode hash ids, I14 matcher-less PreToolUse hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { emptyStore, normalizePrRecord, parseStore } from "../lib/tasks.js";
import { links } from "../lib/git.js";
import { applyClaude } from "../adapters/claude.js";
import { applyCodex } from "../adapters/codex.js";
import { readStore, updateStore } from "../adapters/store.js";
import { codexTrustState, gcStores, install, pruneCodexTrustText, statusSummary } from "../adapters/install.js";

// Schema-2 layout: terminals/<t>.json is the store, or a pointer to
// sessions/<sid>.json once the agent reported a session id.
function terminalStoreText(home, terminal) {
  const dir = join(home, ".herdr", "ranch", "tasks");
  const text = readFileSync(join(dir, "terminals", `${terminal}.json`), "utf8");
  const sid = JSON.parse(text).session;
  return typeof sid === "string" && sid ? readFileSync(join(dir, "sessions", `${sid}.json`), "utf8") : text;
}
import { RanchTasks, reduceOpencode } from "../adapters/opencode-plugin.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- I1: task ids

test("I1: TaskCreate reads the structured {task:{id}} golden payload", () => {
  const base = emptyStore("t1", "claude-code");
  const store = applyClaude(base, {
    hook_event_name: "PostToolUse",
    tool_name: "TaskCreate",
    tool_input: { subject: "Push branch and open PR (no ticket)", description: "gh pr create" },
    tool_response: { task: { id: "9", subject: "Push branch and open PR (no ticket)", description: "gh pr create" } },
  });
  assert.deepEqual(store.tasks.at(-1), {
    id: "9",
    title: "Push branch and open PR (no ticket)",
    status: "pending",
    active_form: null,
  });
  // A later TaskUpdate for that id finds the task.
  const done = applyClaude(store, {
    hook_event_name: "PostToolUse",
    tool_name: "TaskUpdate",
    tool_input: { taskId: "9", status: "completed" },
  });
  assert.equal(done.tasks[0].status, "completed");
  assert.equal(done.hook_error, undefined);
});

test("I1: TaskUpdate with an unknown id and no subject is logged, not dropped silently", () => {
  const base = emptyStore("t1", "claude-code");
  let store = applyClaude(base, {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "pending" }] },
  });
  const n = store.tasks.length;
  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "99", status: "completed" },
  });
  assert.equal(store.tasks.length, n);
  assert.match(store.hook_error, /unknown task id 99/);

  store = applyClaude(store, {
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "42", status: "deleted" },
  });
  assert.match(store.hook_error, /unknown task id 42/);
});

test("I1: the CLI logs hook_error to adapter.log and never persists it", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  const bin = join(repoRoot, "bin", "ranch-tasks");
  const env = { ...process.env, RANCH_HOME: home, HC_TERMINAL_ID: "te1", RANCH_REMIND: "0" };
  const run = (input) => spawnSync(process.execPath, [bin, "claude"], { input, encoding: "utf8", env });

  const first = run(JSON.stringify({
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "pending" }] },
  }));
  assert.equal(first.status, 0);

  const second = run(JSON.stringify({
    hook_event_name: "PostToolUse", tool_name: "TaskUpdate",
    tool_input: { taskId: "77", status: "completed" },
  }));
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "");

  const disk = parseStore(terminalStoreText(home, "te1"));
  assert.equal(disk.ok, true);
  assert.equal(disk.store.hook_error, undefined);
  const log = readFileSync(join(home, ".herdr", "ranch", "logs", "adapter.log"), "utf8");
  assert.match(log, /unknown task id 77/);
});

// ------------------------------------------------------------- I4: recorded PRs

test("I4: claude records the PR URL from `gh pr create`", () => {
  const base = emptyStore("t1", "claude-code");
  const url = "https://github.com/acme/ranch/pull/1285";
  let store = applyClaude(base, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr create --title t --body b" },
    tool_response: `Creating pull request for feature:\n${url}\n`,
  });
  assert.deepEqual(store.prs, [{ url, number: 1285, at: store.prs[0].at }]);

  // Same URL again: no duplicate.
  store = applyClaude(store, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" },
    tool_response: { stdout: `${url}\n` },
  });
  assert.equal(store.prs.length, 1);

  // Other gh commands record nothing.
  store = applyClaude(store, {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "gh pr view 1285" },
    tool_response: url,
  });
  assert.equal(store.prs.length, 1);
});

test("I4: codex records the PR URL from a shell `gh pr create`", () => {
  const url = "https://github.com/acme/ranch/pull/7";
  const store = applyCodex(emptyStore("t2", "codex"), {
    hook_event_name: "PostToolUse",
    tool_name: "shell",
    tool_input: { command: ["bash", "-lc", "gh pr create --fill"] },
    tool_response: { output: url },
  });
  assert.deepEqual(store.prs.map((p) => p.url), [url]);
});

test("I4: install includes shell tools and replaces old PostToolUse matchers", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  process.env.RANCH_HOME = home;
  const configs = [
    { file: join(home, ".claude", "settings.json"), old: "TodoWrite|TaskCreate|TaskUpdate", wanted: "TodoWrite|TaskCreate|TaskUpdate|Bash" },
    { file: join(home, ".codex", "hooks.json"), old: "update_plan", wanted: "update_plan|Bash|shell" },
  ];
  const ranchGroups = (file) => JSON.parse(readFileSync(file, "utf8")).hooks.PostToolUse
    .filter((group) => group.hooks.some((hook) => hook.command.includes("/.herdr/ranch/bin/ranch-tasks")));
  try {
    await install({ yes: true, agents: ["claude", "codex"] });
    for (const { file, wanted } of configs) assert.equal(ranchGroups(file)[0].matcher, wanted);

    for (const { file, old } of configs) {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      const group = doc.hooks.PostToolUse.find((candidate) =>
        candidate.hooks.some((hook) => hook.command.includes("/.herdr/ranch/bin/ranch-tasks")));
      group.matcher = old;
      writeFileSync(file, JSON.stringify(doc));
    }
    await install({ yes: true, agents: ["claude", "codex"] });
    for (const { file, wanted } of configs) {
      const groups = ranchGroups(file);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].matcher, wanted);
    }
  } finally {
    delete process.env.RANCH_HOME;
  }
});

test("parseStore keeps normalized prs", () => {
  const parsed = parseStore(JSON.stringify({
    ...emptyStore("t1", "claude-code"),
    prs: [
      { url: "https://github.com/a/b/pull/3", number: 3, at: "2026-01-01T00:00:00Z" },
      { url: "http://not-https/pull/4", number: 4 },
      { url: "https://github.com/a/b/pull/x", number: "5" },
      "junk",
    ],
  }));
  assert.deepEqual(parsed.store.prs, [{ url: "https://github.com/a/b/pull/3", number: 3, at: "2026-01-01T00:00:00Z" }]);
  assert.deepEqual(normalizePrRecord({ url: "https://github.com/a/b/pull/9", number: 9 }), {
    url: "https://github.com/a/b/pull/9",
    number: 9,
    at: null,
  });
});

test("I4: recorded PRs dedupe by URL across repositories", () => {
  const source = readFileSync(join(repoRoot, "mods", "ranch-session", "main.js"), "utf8");
  const start = source.indexOf("  recordedPrs(s, pr) {");
  const end = source.indexOf("\n  /** The CI glyph", start);
  assert.ok(start >= 0 && end > start);
  const RecordedPrs = new Function("links", `return class { ${source.slice(start, end)} };`)(links);
  const branchUrl = "https://github.com/acme/ranch/pull/12";
  const otherUrl = "https://github.com/acme/other/pull/12";
  const thirdUrl = "https://github.com/acme/third/pull/12";
  const view = {
    git: { summary: { host: { kind: "github", base: "https://github.com/acme/ranch" } } },
    tasks: { parsed: { ok: true, store: { prs: [
      { url: branchUrl, number: 12 },
      { url: otherUrl, number: 12 },
    ] } } },
    subTerminals: () => [{ address: "sub" }],
    subTasks: new Map([["sub", { parsed: { ok: true, store: { prs: [
      { url: thirdUrl, number: 12 },
      { url: otherUrl, number: 12 },
    ] } } }]]),
  };
  const result = RecordedPrs.prototype.recordedPrs.call(view, {}, { number: 12 });
  assert.deepEqual(result.map((p) => p.url), [otherUrl, thirdUrl]);
});

// ------------------------------------------------------- I12/I10: session ids

test("I12/I10: session.id from every event; a different session id starts fresh", () => {
  const base = emptyStore("t1", "claude-code");
  // No session yet: PostToolUse fills the id.
  let store = applyClaude(base, {
    hook_event_name: "PostToolUse", tool_name: "TodoWrite",
    tool_input: { todos: [{ content: "A", status: "pending" }] },
    session_id: "s1",
  });
  assert.equal(store.session.id, "s1");

  // Same session: tasks survive.
  store = applyClaude(store, {
    hook_event_name: "UserPromptSubmit", prompt: "hello", session_id: "s1",
  });
  assert.equal(store.tasks.length, 1);

  // A different session id without SessionStart (terminal reuse): fresh store.
  store = applyClaude(store, {
    hook_event_name: "UserPromptSubmit", prompt: "new chat", session_id: "s2",
  });
  assert.equal(store.session.id, "s2");
  assert.equal(store.session.first_prompt, "new chat");
  assert.equal(store.session.title, null);
  assert.deepEqual(store.tasks, []);

  // Codex behaves the same.
  let codexStore = applyCodex(emptyStore("t3", "codex"), {
    hook_event_name: "PostToolUse", tool_name: "update_plan",
    tool_input: { plan: [{ step: "a", status: "pending" }] },
    session_id: "c1",
  });
  assert.equal(codexStore.session.id, "c1");
  codexStore = applyCodex(codexStore, {
    hook_event_name: "UserPromptSubmit", prompt: "again", session_id: "c2",
  });
  assert.equal(codexStore.session.id, "c2");
  assert.deepEqual(codexStore.tasks, []);
});

test("I10: readStore never continues another agent's store", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  const dir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "t9.json");
  const claudeStore = { ...emptyStore("t9", "claude-code"), updated_at: "2026-01-01T00:00:00.000Z" };
  claudeStore.tasks = [{ id: "1", title: "theirs", status: "in_progress", active_form: null }];
  claudeStore.prs = [{ url: "https://github.com/a/b/pull/1", number: 1, at: null }];
  writeFileSync(path, JSON.stringify(claudeStore));
  assert.equal(readStore(path, "claude-code", "t9").tasks.length, 1);
  const fresh = readStore(path, "codex", "t9");
  assert.deepEqual(fresh, emptyStore("t9", "codex"));
  // updateStore stamps the writing agent.
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "t9";
  try {
    const next = updateStore("codex", (store) => ({ ...store, tasks: [{ id: "1", title: "mine", status: "pending", active_form: null }] }));
    assert.equal(next.agent.app, "codex");
    // The legacy claude-code list was not adopted: the codex store starts fresh.
    const disk = parseStore(terminalStoreText(home, "t9")).store;
    assert.equal(disk.agent.app, "codex");
    assert.deepEqual(disk.tasks.map((t) => t.title), ["mine"]);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

// -------------------------------------------------------------- I9: lock retry

test("I9: a held lock makes updateStore throw, never write blind", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  const dir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "terminals"), { recursive: true });
  const path = join(dir, "terminals", "t8.json"); // schema-2 store, locked per terminal file
  const before = { ...emptyStore("t8", "codex"), updated_at: "2026-01-01T00:00:00.000Z" };
  writeFileSync(path, JSON.stringify(before));
  writeFileSync(`${path}.lock`, "");
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "t8";
  try {
    assert.throws(
      () => updateStore("codex", () => ({ ...before, tasks: [{ id: "1", title: "x", status: "pending", active_form: null }] })),
      /store lock busy/,
    );
    // The store was left untouched and no tmp leftovers exist.
    assert.deepEqual(parseStore(readFileSync(path, "utf8")).store.updated_at, "2026-01-01T00:00:00.000Z");
    assert.equal(readdirSync(join(dir, "terminals")).filter((n) => n.includes(".tmp-")).length, 0);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});

// -------------------------------------------------------------- I8: gc tmp

test("I8: gc removes old *.json.tmp-* files and keeps fresh ones", () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  const dir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(dir, { recursive: true });
  const old = join(dir, "t1.json.tmp-999");
  const fresh = join(dir, "t2.json.tmp-999");
  const store = join(dir, "t3.json");
  writeFileSync(old, "{}");
  writeFileSync(fresh, "{}");
  writeFileSync(store, JSON.stringify(emptyStore("t3", "codex")));
  const oldTime = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(old, oldTime, oldTime);
  // A failing `hc` (fake on PATH): live is unknown, only the age rules apply.
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "hc"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fakeBin, "hc"), 0o755);
  process.env.RANCH_HOME = home;
  delete process.env.HC_TERMINAL_ID;
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${savedPath}`;
  try {
    const removed = gcStores();
    assert.ok(removed.includes("t1.json.tmp-999"));
    assert.ok(!removed.includes("t2.json.tmp-999"));
    assert.ok(!removed.includes("t3.json"));
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(store), true);
  } finally {
    process.env.PATH = savedPath;
    delete process.env.RANCH_HOME;
  }
});

// ------------------------------------------------------------- I11: codex trust

const TRUST_HOOKS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "/x/.herdr/ranch/bin/ranch-tasks codex", timeout: 5 }] }],
    PostToolUse: [{ matcher: "update_plan", hooks: [{ type: "command", command: "/x/.herdr/ranch/bin/ranch-tasks codex", timeout: 5 }] }],
  },
};

test("I11: codexTrustState reads [hooks.state] positions", () => {
  const trusted = `[model]
gpt = "5"

[hooks.state]
"session_start:0:0" = true
"post_tool_use:0:0" = true
`;
  assert.equal(codexTrustState(TRUST_HOOKS, trusted), "trusted");
  // One position missing -> needs approval.
  assert.equal(codexTrustState(TRUST_HOOKS, `[hooks.state]\n"session_start:0:0" = true\n`), "needs approval");
  // An explicit false is untrusted.
  assert.equal(
    codexTrustState(TRUST_HOOKS, `[hooks.state]\n"session_start:0:0" = true\n"post_tool_use:0:0" = false\n`),
    "needs approval",
  );
  // No [hooks.state] section or no ranch hooks: nothing to decide.
  assert.equal(codexTrustState(TRUST_HOOKS, "[model]\nx = 1\n"), null);
  assert.equal(codexTrustState({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "other" }] }] } }, trusted), null);
  // Positions after a group reorder are checked by index.
  const reordered = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "someone-else" }] },
        { hooks: [{ type: "command", command: "/x/.herdr/ranch/bin/ranch-tasks codex", timeout: 5 }] },
      ],
    },
  };
  assert.equal(codexTrustState(reordered, trusted), "needs approval");
  assert.equal(
    codexTrustState(reordered, `[hooks.state]\n"session_start:1:0" = true\n"post_tool_use:0:0" = true\n`),
    "trusted",
  );
});

test("I11: pruneCodexTrustText drops stale positions and keeps the rest", () => {
  const text = `"$schema" = "x"

[hooks.state]
"session_start:0:0" = true
"gone:2:1" = true
"post_tool_use:0:0" = true

[other]
key = "value"
`;
  const pruned = pruneCodexTrustText(text, TRUST_HOOKS);
  assert.ok(pruned.includes('"session_start:0:0" = true'));
  assert.ok(!pruned.includes('"gone:2:1"'));
  assert.ok(pruned.includes("[other]"));
  // Nothing stale: no change.
  assert.equal(pruneCodexTrustText(`[hooks.state]\n"session_start:0:0" = true\n"post_tool_use:0:0" = true\n`, TRUST_HOOKS), null);
});

test("I11: pruneCodexTrustText refuses multi-line values in hooks.state", () => {
  const values = [
    `"gone:2:1" = [\n  true,\n]`,
    `"gone:2:1" = {\n  trusted = true\n}`,
  ];
  for (const value of values) {
    const text = `[hooks.state]\n"session_start:0:0" = true\n${value}\n"post_tool_use:0:0" = true\n`;
    assert.equal(pruneCodexTrustText(text, TRUST_HOOKS), null);
  }
});

test("I11: install backs up config.toml before pruning stale trust", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  const config = join(home, ".codex", "config.toml");
  const original = `[hooks.state]\n"gone:2:1" = true\n`;
  writeFileSync(config, original);
  process.env.RANCH_HOME = home;
  try {
    await install({ yes: true, agents: ["codex"] });
    const backups = readdirSync(join(home, ".herdr", "ranch", "backups"))
      .filter((name) => name.startsWith("codex-config.") && name.endsWith(".toml"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(home, ".herdr", "ranch", "backups", backups[0]), "utf8"), original);
    assert.ok(!readFileSync(config, "utf8").includes('"gone:2:1"'));
  } finally {
    delete process.env.RANCH_HOME;
  }
});

test("I11: status reports codex 'needs approval' while hooks are untrusted", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  process.env.RANCH_HOME = home;
  try {
    await install({ yes: true, agents: ["codex"] });
    // No config.toml yet: nothing decided, still "installed".
    assert.equal(statusSummary().agents.codex, "installed");
    const hooksDoc = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
    const events = Object.keys(hooksDoc.hooks);
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[hooks.state]\n${events.map((e) => `"${e.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}:0:0" = true`).join("\n")}\n`,
    );
    assert.equal(statusSummary().agents.codex, "installed");
    // Remove one trust entry -> needs approval.
    const lines = readFileSync(join(home, ".codex", "config.toml"), "utf8").split("\n").filter(Boolean);
    writeFileSync(join(home, ".codex", "config.toml"), lines.slice(0, -1).join("\n") + "\n");
    assert.equal(statusSummary().agents.codex, "needs approval");
  } finally {
    delete process.env.RANCH_HOME;
  }
});

// ------------------------------------------------------- I14: matcher-less hook

test("I14: install drops the matcher-less ranch PreToolUse hook on reinstall", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  process.env.RANCH_HOME = home;
  try {
    const mark = `${home}/.herdr/ranch/bin/ranch-tasks`;
    const settings = join(home, ".claude", "settings.json");
    // A previous install wrote the matcher-less PreToolUse hook.
    writeFileSync(settings, JSON.stringify({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: `${mark} claude`, timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "other-hook" }] }],
      },
    }));
    await install({ yes: true, agents: ["claude"] });
    const merged = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(merged.hooks.PreToolUse, undefined);
    // The other event still has its ranch hook and the third-party hook survives.
    assert.ok(JSON.stringify(merged.hooks.SessionStart).includes(mark));
    assert.ok(JSON.stringify(merged.hooks.SessionStart).includes("other-hook"));
    for (const event of ["UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "SessionEnd", "Stop"]) {
      assert.ok(JSON.stringify(merged.hooks[event]).includes(mark), `ranch handler for ${event}`);
    }
  } finally {
    delete process.env.RANCH_HOME;
  }
});

// --------------------------------------------------------- I13: opencode ids

test("I13: opencode todos without an id get index + short hash", () => {
  const store = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "todo.updated",
    properties: {
      sessionID: "s1",
      todos: [
        { content: "first", status: "pending" },
        { id: 5, content: "explicit", status: "pending" },
        { content: "third", status: "pending" },
      ],
    },
  });
  assert.match(store.tasks[0].id, /^1-[0-9a-z]+$/);
  assert.equal(store.tasks[1].id, "5");
  assert.match(store.tasks[2].id, /^3-[0-9a-z]+$/);
  // Stable: the same list maps to the same ids.
  const again = reduceOpencode(emptyStore("t1", "opencode"), {
    type: "todo.updated",
    properties: {
      sessionID: "s1",
      todos: [
        { content: "first", status: "pending" },
        { id: 5, content: "explicit", status: "pending" },
        { content: "third", status: "pending" },
      ],
    },
  });
  assert.deepEqual(again.tasks.map((t) => t.id), store.tasks.map((t) => t.id));
});

test("I10: the opencode plugin starts fresh on a store from another agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "ranch-integrity-"));
  const dir = join(home, ".herdr", "ranch", "tasks");
  mkdirSync(dir, { recursive: true });
  const foreign = { ...emptyStore("top", "claude-code"), updated_at: "2026-01-01T00:00:00.000Z" };
  foreign.tasks = [{ id: "1", title: "theirs", status: "in_progress", active_form: null }];
  writeFileSync(join(dir, "top.json"), JSON.stringify(foreign));
  process.env.RANCH_HOME = home;
  process.env.HC_TERMINAL_ID = "top";
  try {
    const plugin = await RanchTasks({});
    await plugin.event({
      event: { type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "1", content: "mine", status: "pending" }] } },
    });
    const disk = parseStore(terminalStoreText(home, "top"));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.agent.app, "opencode");
    assert.deepEqual(disk.store.tasks.map((t) => t.title), ["mine"]);
  } finally {
    delete process.env.RANCH_HOME;
    delete process.env.HC_TERMINAL_ID;
  }
});
