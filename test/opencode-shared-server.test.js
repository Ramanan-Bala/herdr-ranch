// OpenCode's shared server (`opencode serve --service`) runs this plugin for
// every plain TUI, with whatever HC_TERMINAL_ID started the service. Task
// writes must land on the live terminal showing the session, never on that
// stale terminal. A fake `hc` (RANCH_HC_BIN) stands in for Herdr; the
// RANCH_OPENCODE_SHARED switch stands in for argv containing "serve". Session
// ids are unique per test because resolved bindings are cached per process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RanchTasks } from "../adapters/opencode-plugin.js";

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A temp home plus a fake hc answering `ls --json` and `get --json <t>`. */
function setup(t, terminals) {
  const home = mkdtempSync(join(tmpdir(), "ranch-shared-"));
  const fake = join(home, "fake-hc");
  mkdirSync(fake);
  writeFileSync(join(fake, "ls.json"), JSON.stringify({
    terminals: terminals.map(({ title, ...rest }) => ({ state: "live", ...rest })),
  }));
  for (const term of terminals) {
    writeFileSync(join(fake, `${term.address}.json`), JSON.stringify({ address: term.address, title: term.title ?? null, created_ms: 1 }));
  }
  const bin = join(fake, "hc");
  writeFileSync(bin, `#!/bin/sh\ndir=$(dirname "$0")\nif [ "$1" = ls ]; then cat "$dir/ls.json"; exit 0; fi\nif [ "$1" = get ] && [ -f "$dir/$3.json" ]; then cat "$dir/$3.json"; exit 0; fi\nexit 1\n`);
  chmodSync(bin, 0o755);
  withEnv(t, { RANCH_HOME: home, HOME: home, HC_TERMINAL_ID: "stale", RANCH_OPENCODE_SHARED: "1", RANCH_HC_BIN: bin });
  return home;
}

const tasksDir = (home) => join(home, ".herdr", "ranch", "tasks");
const pointer = (home, terminal) => join(tasksDir(home), "terminals", `${terminal}.json`);
const sessionStore = (home, sid) => join(tasksDir(home), "sessions", `${sid}.json`);

function writePointer(home, terminal, sid) {
  mkdirSync(join(tasksDir(home), "terminals"), { recursive: true });
  writeFileSync(pointer(home, terminal), JSON.stringify({ version: 2, terminal, agent: { app: "opencode", session: sid }, session: sid }));
}

async function todo(sid, titles) {
  const plugin = await RanchTasks({});
  await plugin.event({
    event: { type: "todo.updated", properties: { sessionID: sid, todos: titles.map((content, i) => ({ id: String(i), content, status: "pending" })) } },
  });
}

test("shared server: writes land on the only live OpenCode terminal, not the stale env one", async (t) => {
  const home = setup(t, [
    { address: "t4h", agent: "zsh" },
    { address: "t4j", agent: "opencode", title: "OC | something" },
  ]);
  await todo("ses_only", ["a", "b"]);
  assert.equal(existsSync(pointer(home, "stale")), false);
  assert.equal(JSON.parse(readFileSync(pointer(home, "t4j"), "utf8")).session, "ses_only");
  const store = JSON.parse(readFileSync(sessionStore(home, "ses_only"), "utf8"));
  assert.equal(store.terminal, "t4j");
  assert.deepEqual(store.tasks.map((x) => x.title), ["a", "b"]);
});

test("shared server: a session moves from a finished terminal's pointer to its live TUI by title", async (t) => {
  const home = setup(t, [
    { address: "t5a", agent: "opencode", title: "OC | Other work" },
    { address: "t5b", agent: "opencode", title: "OC | Panel tests" },
  ]);
  // Old pointer on a terminal that is no longer live; t5a is busy elsewhere.
  writePointer(home, "t3f", "ses_title");
  writePointer(home, "t5a", "ses_other");
  mkdirSync(join(tasksDir(home), "sessions"), { recursive: true });
  writeFileSync(sessionStore(home, "ses_title"), JSON.stringify({
    version: 2, terminal: "t3f", agent: { app: "opencode", session: "ses_title" }, seq: 3,
    session: { id: "ses_title", title: "Panel tests", state: "running" }, tasks: [],
  }));
  await todo("ses_title", ["x"]);
  assert.equal(JSON.parse(readFileSync(pointer(home, "t5b"), "utf8")).session, "ses_title");
  assert.equal(JSON.parse(readFileSync(pointer(home, "t5a"), "utf8")).session, "ses_other");
  assert.equal(JSON.parse(readFileSync(sessionStore(home, "ses_title"), "utf8")).terminal, "t5b");
});

test("shared server: a session already bound to a live terminal stays there", async (t) => {
  const home = setup(t, [
    { address: "t6a", agent: "opencode", title: "OC | A" },
    { address: "t6b", agent: "opencode", title: "OC | B" },
  ]);
  writePointer(home, "t6a", "ses_bound");
  await todo("ses_bound", ["kept"]);
  assert.equal(JSON.parse(readFileSync(sessionStore(home, "ses_bound"), "utf8")).terminal, "t6a");
  assert.equal(existsSync(pointer(home, "t6b")), false);
});

test("shared server: a new session goes to the one unbound OpenCode terminal", async (t) => {
  const home = setup(t, [
    { address: "t7a", agent: "opencode", title: "OC | A" },
    { address: "t7b", agent: "opencode", title: "OC | New session" },
  ]);
  writePointer(home, "t7a", "ses_a7");
  await todo("ses_new7", ["n"]);
  assert.equal(JSON.parse(readFileSync(pointer(home, "t7b"), "utf8")).session, "ses_new7");
  assert.equal(JSON.parse(readFileSync(pointer(home, "t7a"), "utf8")).session, "ses_a7");
});

test("shared server: an ambiguous session is skipped rather than written to the wrong terminal", async (t) => {
  const home = setup(t, [
    { address: "t8a", agent: "opencode", title: "OC | A" },
    { address: "t8b", agent: "opencode", title: "OC | B" },
  ]);
  writePointer(home, "t8a", "ses_a8");
  writePointer(home, "t8b", "ses_b8");
  await todo("ses_amb8", ["?"]);
  assert.equal(existsSync(sessionStore(home, "ses_amb8")), false);
  assert.equal(JSON.parse(readFileSync(pointer(home, "t8a"), "utf8")).session, "ses_a8");
  assert.equal(JSON.parse(readFileSync(pointer(home, "t8b"), "utf8")).session, "ses_b8");
  assert.equal(existsSync(pointer(home, "stale")), false);
});

test("standalone TUI: HC_TERMINAL_ID is still used as is", async (t) => {
  const home = setup(t, [{ address: "t9z", agent: "opencode" }]);
  withEnv(t, { RANCH_OPENCODE_SHARED: "0", HC_TERMINAL_ID: "t9own" });
  await todo("ses_standalone", ["s"]);
  assert.equal(JSON.parse(readFileSync(pointer(home, "t9own"), "utf8")).session, "ses_standalone");
  assert.equal(existsSync(pointer(home, "t9z")), false);
});
