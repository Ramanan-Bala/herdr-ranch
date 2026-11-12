// Wiring tests for mods/ranch-session/main.js: the panel's Git/PR data must
// come from the per-context cache (gitctx), so a late result filed for one
// machine/folder/branch never shows for another. main.js is loaded under Node
// with the bare imports "herdr", "gpui-kit" and "gpui-base" replaced by
// in-test stubs (module.registerHooks), and exec is faked by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// lib/ must be inside the mod folder before its imports resolve.
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);

globalThis.localStorage = { getItem: () => null, setItem() {} };

// The herdr surface the tests can swap per case: exec and watchFolder are
// deferred so a result can be resolved manually after a tab switch.
globalThis.__herdr = {
  exec: () => new Promise(() => {}),
  watchFolder: () => new Promise(() => {}),
};

const herdrSource = `
const H = globalThis.__herdr;
export const exec = (...a) => H.exec(...a);
export const watchFolder = (...a) => H.watchFolder(...a);
export const home = () => "/home/u";
export const readTextFile = () => Promise.resolve(null);
export const spaces = () => [];
export const agents = () => [];
export const panes = () => [];
export const terminals = () => [];
export const focused = () => null;
export const theme = () => new Proxy({}, { get: () => "#fff" });
export const run = () => {};
export const shared = () => undefined;
export const setShared = () => {};
export const window = () => ({ platform: "macos" });
`;

const chainSource = `
const chain = () => new Proxy(() => {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => "" : (..._args) => chain()),
  apply: () => chain(),
});
export default chain;
export const chain2 = chain;
`;

const gpuiKitSource = `
${chainSource}
export class View {}
export const div = () => chain();
export const svg = () => chain();
export const image = () => chain();
`;

const gpuiBaseSource = `
${chainSource}
export const v_flex = () => chain();
export const h_flex = () => chain();
`;

const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "herdr") return { url: data(herdrSource), shortCircuit: true };
    if (specifier === "gpui-kit") return { url: data(gpuiKitSource), shortCircuit: true };
    if (specifier === "gpui-base") return { url: data(gpuiBaseSource), shortCircuit: true };
    return nextResolve(specifier, _context);
  },
});

const RanchSession = (await import(join(root, "mods/ranch-session/main.js"))).default;
const { ctxKey } = await import(join(root, "mods/ranch-session/gitctx.js"));

// ---- fake exec -----------------------------------------------------------

let pending = [];
const answers = new Map(); // "program|args joined" -> {code, stdout, stderr}
// Calls matching hold() wait in `pending` until drained; the rest answer at once.
let hold = () => false;

function fakeExec(program, args, opts = {}) {
  const call = { program, args, opts };
  if (!hold(call)) return Promise.resolve(answer(call));
  return new Promise((resolve) => pending.push({ call, resolve }));
}
globalThis.__herdr.exec = fakeExec;

function answer(call) {
  return answers.get(`${call.program}|${call.args.join(" ")}`) ?? { code: 1, stdout: "", stderr: "" };
}

/** Resolve every pending exec matching `keep(call)`; the rest stay deferred. */
function drain(keep = null) {
  const q = pending;
  pending = [];
  for (const p of q) {
    if (keep && !keep(p.call)) {
      pending.push(p);
      continue;
    }
    p.resolve(answer(p.call));
  }
}

/** Settle one folder's whole repoSnapshot: resolve, let the next round queue, repeat. */
async function settleCwd(cwd) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r)); // let queued rounds issue
    if (!pending.some((p) => p.call.opts.cwd === cwd)) return;
    drain((c) => c.opts.cwd === cwd);
  }
  throw new Error(`exec calls for ${cwd} never settled`);
}

// ---- canned repo answers (args mirror lib/git.js repoSnapshot) ------------

const PR_JSON_FIELDS =
  "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,author,baseRefName,updatedAt,mergeStateStatus,reviewRequests,latestReviews";

const PR_JSON = {
  number: 7,
  title: "Fix the thing",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  reviewDecision: null,
  statusCheckRollup: [],
  author: { login: "a" },
  baseRefName: "main",
  updatedAt: "2026-11-01T00:00:00Z",
  mergeStateStatus: "CLEAN",
  reviewRequests: [],
  latestReviews: [],
};

/** Answers a repoSnapshot run for a repo at `top` on `branch`. */
function repoAnswers(top, branch, base = "b".repeat(40)) {
  return [
    ["git|rev-parse --show-toplevel --path-format=absolute --git-common-dir", { code: 0, stdout: `${top}\n${top}/.git\n`, stderr: "" }],
    [
      "git|--no-optional-locks status --porcelain=v2 --branch --untracked-files=no",
      { code: 0, stdout: `# branch.oid ${"1".repeat(40)}\n# branch.head ${branch}\n# branch.upstream origin/${branch}\n# branch.ab +1 -0\n`, stderr: "" },
    ],
    [
      "git|for-each-ref --format=%(refname)%09%(symref) refs/remotes/origin/HEAD refs/remotes/origin/main refs/remotes/origin/master refs/heads/main refs/heads/master",
      { code: 0, stdout: "refs/remotes/origin/HEAD\trefs/remotes/origin/main\nrefs/remotes/origin/main\t\nrefs/heads/main\t\n", stderr: "" },
    ],
    ["git|remote get-url origin", { code: 0, stdout: "git@github.com:o/r.git\n", stderr: "" }],
    ["git|merge-base HEAD origin/main", { code: 0, stdout: `${base}\n`, stderr: "" }],
    ["git|rev-list --left-right --count HEAD...origin/main", { code: 0, stdout: "2 0\n", stderr: "" }],
    [`git|diff --numstat -z ${base}`, { code: 0, stdout: "3\t1\tsrc/a.js\n", stderr: "" }],
    [`git|log -n 5 --format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e ${base}..HEAD`, { code: 0, stdout: "", stderr: "" }],
    [`gh|pr view ${branch} --json ${PR_JSON_FIELDS}`, { code: 0, stdout: JSON.stringify(PR_JSON), stderr: "" }],
  ];
}

function setAnswers(rows) {
  answers.clear();
  for (const [k, v] of rows) answers.set(k, v);
}

// ---- harness ---------------------------------------------------------------

let current = null;

/** A fresh view bound to a machine|cwd session; exec calls defer until drained. */
function makeView(machine, cwd, holdIf = () => false) {
  pending = [];
  hold = holdIf;
  const view = new RanchSession();
  const cx = {
    notify() {},
    spawn(fn) {
      return fn(cx);
    },
    timer: {
      every() {},
      after() {},
    },
    sleep: () => new Promise(() => {}),
  };
  view.init(undefined, cx);
  current = { machine, cwd, chosen: null, tab: null };
  view.session = () => current;
  view.ctx.select(machine, cwd);
  return { view, cx };
}

/** Tab switch: what render()/pump() do before any Git/PR read. */
function switchTo(view, machine, cwd) {
  current = { machine, cwd, chosen: null, tab: null };
  view.ctx.select(machine, cwd);
}

// ---- tests -----------------------------------------------------------------

test("deferred A git read finishing after the switch to B lands on A only", async () => {
  setAnswers(repoAnswers("/top/a", "f1"));
  const { view, cx } = makeView(null, "/a", (c) => c.opts.cwd === "/a");
  const p = view.refreshGit(cx);
  await new Promise((r) => setImmediate(r));
  assert.ok(pending.length > 0, "A's read is in flight");
  switchTo(view, null, "/b");
  await settleCwd("/a");
  await p;
  assert.equal(view.gitReady(current), false); // B uncached: never A's data
  const e = view.ctx.git.get(ctxKey(null, "/a"));
  assert.equal(e.summary.branch, "f1");
  assert.equal(e.summary.top, "/top/a");
});

test("A -> B -> A: the cache makes the old tab's data ready immediately", async () => {
  setAnswers(repoAnswers("/top/a", "f1"));
  const { view, cx } = makeView(null, "/a");
  await view.refreshGit(cx);
  setAnswers(repoAnswers("/top/b", "f2"));
  switchTo(view, null, "/b");
  await view.refreshGit(cx);
  switchTo(view, null, "/a");
  assert.equal(view.gitReady(current), true); // no await in between
  assert.equal(view.ctx.gitEntry().summary.branch, "f1");
});

test("same-folder branch change hides the old branch's PR until the new one lands", async () => {
  const rows = repoAnswers("/top/a", "f1");
  setAnswers(rows);
  const { view, cx } = makeView(null, "/a");
  await view.refreshGit(cx);
  await view.refreshPr(cx);
  assert.equal(view.prReady(current), true);
  assert.equal(view.ctx.prEntry().parsed.number, 7);
  // The branch flips in the same folder: only the status line (and the gh
  // answer for the new branch) change.
  for (const [k, v] of repoAnswers("/top/a", "f2")) {
    if (k.startsWith("git|--no-optional-locks") || k.startsWith("gh|")) answers.set(k, v);
  }
  await view.refreshGit(cx);
  assert.equal(view.prReady(current), false); // f1's PR never shows for f2
  assert.equal(view.ctx.prEntry(), null);
  await view.refreshPr(cx);
  assert.equal(view.prReady(current), true);
  assert.equal(view.ctx.prEntry().parsed.number, 7);
});

test("push keeps the context it started on: late finish never shows on B", async () => {
  setAnswers(repoAnswers("/top/a", "f1"));
  const { view, cx } = makeView(null, "/a", (c) => c.args[0] === "push");
  await view.refreshGit(cx);
  const p = view.pushBranch(cx);
  const push = pending.find((x) => x.call.args[0] === "push");
  assert.ok(push, "push exec was issued");
  switchTo(view, null, "/b");
  push.resolve({ code: 0, stdout: "", stderr: "" });
  await p;
  assert.equal(push.call.opts.cwd, "/top/a"); // A's top, not whatever HEAD
  assert.equal(push.call.opts.on, null); // A's machine
  assert.equal(push.call.args[3], "f1"); // the branch the button showed
  const pvB = view.ctx.pushView();
  assert.equal(pvB.busy, false);
  assert.equal(pvB.err, null);
  switchTo(view, null, "/a");
  const pvA = view.ctx.pushView();
  assert.equal(pvA.busy, false);
  assert.ok(pvA.at > 0); // "Pushed" shows on A
  assert.equal(pvA.err, null);
});

test("late A PR result after switching to B does not appear on B", async () => {
  setAnswers(repoAnswers("/top/a", "f1"));
  const { view, cx } = makeView(null, "/a", (c) => c.program === "gh");
  await view.refreshGit(cx);
  const p = view.refreshPr(cx);
  // The gh call goes through the module-level limiter: let it start.
  for (let i = 0; i < 10 && !pending.length; i++) await new Promise((r) => setImmediate(r));
  assert.ok(pending.length > 0, "A's PR lookup is in flight");
  switchTo(view, null, "/b");
  drain((c) => c.program === "gh");
  await p;
  assert.equal(view.prReady(current), false); // B uncached
  assert.equal(view.ctx.prs.get(`${ctxKey(null, "/a")}|f1`).parsed.number, 7);
});
