// Prints one line of numbers about the session a process is running, and exits:
//   claude:      tokens=N calls=N compactions=N [lastTrigger=auto lastPre=N lastPost=N]
//   codex:       tokens=N window=N calls=N
//   antigravity: tokens=N calls=N
//
// Usage:
//   session.mjs claude|codex <pid of the agent in the terminal>
//   session.mjs antigravity <HC terminal address>
//
// Node port of session.sh (fixes doc F11). The claude branch is pure file
// reading and matches the sh+awk logic line for line, including its string
// matching: text in the session files is JSON-escaped, so \"type\" can't match
// the "type" looked for here. The codex branch needs pgrep and lsof, which
// have no Node equivalent, so it re-runs the sh helper (the sh path stays).
// The antigravity branch resolves the terminal's conversation id via Ranch's
// local task store (~/.herdr/ranch/tasks/) and reads the tail of its
// transcript (~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl).
//
// Exit: 0 = printed, 1 = no session found for that process/terminal (never a guess).
// Claude's files follow CLAUDE_CONFIG_DIR; Antigravity's home follows RANCH_HOME.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.argv[2];
const arg = process.argv[3];

const fail = () => process.exit(1);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function storeFileName(address) {
  const safe = String(address ?? "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe && safe !== "." && safe !== ".." ? `${safe}.json` : null;
}

function agentApp(agent) {
  if (typeof agent === "string") return agent.trim() || null;
  if (agent && typeof agent === "object" && typeof agent.app === "string") return agent.app.trim() || null;
  return null;
}

// Reads a file only when its realpath stays strictly inside `root`, capped at
// `maxBytes`. With `tail: true`, reads only the last `maxBytes` (dropping any
// partial first line).
function readCappedInside(root, filePath, maxBytes, { tail = false } = {}) {
  let absRoot;
  let absFile;
  try {
    absRoot = realpathSync(root);
    absFile = realpathSync(filePath);
  } catch (e) {
    return { ok: false, enoent: e?.code === "ENOENT" };
  }
  const rel = relative(absRoot, absFile);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, enoent: false };
  try {
    const fd = openSync(absFile, "r");
    try {
      const size = fstatSync(fd).size;
      if (!tail && size > maxBytes) return { ok: false, enoent: false };
      if (size === 0) return { ok: true, text: "" };
      const start = tail ? Math.max(0, size - maxBytes) : 0;
      const len = size - start;
      const buf = Buffer.allocUnsafe(len);
      let offset = 0;
      while (offset < len) {
        const n = readSync(fd, buf, offset, len - offset, start + offset);
        if (n <= 0) break;
        offset += n;
      }
      let text = buf.subarray(0, offset).toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        text = nl === -1 ? "" : text.slice(nl + 1);
      }
      return { ok: true, text };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return { ok: false, enoent: e?.code === "ENOENT" };
  }
}

function parseJsonObject(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function antigravity(terminal) {
  const termFile = storeFileName(terminal);
  if (!termFile) fail();
  const home = process.env.RANCH_HOME || homedir();
  const ranchRoot = resolve(home, ".herdr", "ranch");
  const agyRoot = resolve(home, ".gemini", "antigravity-cli");

  const ptrRes = readCappedInside(ranchRoot, join(ranchRoot, "tasks", "terminals", termFile), MAX_READ_BYTES);
  if (!ptrRes.ok) fail();
  const doc = parseJsonObject(ptrRes.text);
  if (!doc) fail();
  const ptrApp = agentApp(doc.agent);
  if (ptrApp && ptrApp !== "antigravity") fail();

  let conversationId = null;
  if (typeof doc.session === "string" && doc.session) {
    const sessFile = storeFileName(doc.session);
    if (!sessFile) fail();
    const sessRes = readCappedInside(ranchRoot, join(ranchRoot, "tasks", "sessions", sessFile), MAX_READ_BYTES);
    if (sessRes.ok) {
      const store = parseJsonObject(sessRes.text);
      if (!store) fail();
      const sApp = agentApp(store.agent);
      if (sApp && sApp !== "antigravity") fail();
      if (store.session?.state === "ended") fail();
      conversationId = typeof store.session?.id === "string" && store.session.id ? store.session.id : doc.session;
    } else if (sessRes.enoent && ptrApp === "antigravity") {
      conversationId = doc.session;
    } else {
      fail();
    }
  } else if (doc.session && typeof doc.session === "object") {
    if (doc.session.state === "ended") fail();
    conversationId = doc.session.id;
  }

  // Validate conversation id as a canonical UUID before building any path.
  if (typeof conversationId !== "string" || !UUID_RE.test(conversationId)) fail();

  const transcriptPath = join(agyRoot, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  const tRes = readCappedInside(agyRoot, transcriptPath, MAX_READ_BYTES, { tail: true });
  if (!tRes.ok) fail();

  let tokens = 0;
  let calls = 0;
  for (const line of tRes.text.split("\n")) {
    if (!line.includes('"PLANNER_RESPONSE"')) continue;
    const step = parseJsonObject(line);
    if (!step || step.type !== "PLANNER_RESPONSE") continue;
    calls++;
    const inp = typeof step.input_tokens === "number" && Number.isFinite(step.input_tokens) && step.input_tokens >= 0 ? step.input_tokens : 0;
    const cache = typeof step.cache_read_tokens === "number" && Number.isFinite(step.cache_read_tokens) && step.cache_read_tokens >= 0 ? step.cache_read_tokens : 0;
    const total = Math.round(inp + cache);
    if (total > 0) tokens = total;
  }
  if (!tokens) fail();
  process.stdout.write(`tokens=${tokens} calls=${calls}\n`);
  process.exit(0);
}

if (app === "antigravity") {
  if (!arg) fail();
  antigravity(arg);
}

const pid = arg;
if ((app !== "claude" && app !== "codex") || !/^\d+$/.test(pid ?? "")) fail();

if (app === "codex") {
  // No Node equivalent for pgrep -P / lsof: pass through to the sh original.
  const r = spawnSync("sh", [join(here, "session.sh"), "codex", pid], { stdio: ["ignore", "pipe", "ignore"] });
  if (r.stdout?.length) process.stdout.write(r.stdout);
  process.exit(r.status ?? 1);
}

// The number after "key": in a line, 0 if there is none (the awk NUM function).
const num = (s, key) => {
  const m = new RegExp('"' + key + '":[0-9]+').exec(s);
  return m ? Number(m[0].slice(key.length + 3)) : 0;
};

const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
let id = null;
try {
  id = /"sessionId":"([^"]*)"/.exec(readFileSync(join(dir, "sessions", pid + ".json"), "utf8"))?.[1] ?? null;
} catch {
  fail();
}
if (!id || !/^[0-9a-zA-Z-]+$/.test(id)) fail();

// projects/<any>/<id>.jsonl: the first match, like the sh glob.
let file = null;
try {
  for (const project of readdirSync(join(dir, "projects"))) {
    const candidate = join(dir, "projects", project, id + ".jsonl");
    if (existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
} catch {
  fail();
}
if (!file) fail();

let tokens = 0;
let calls = 0;
let compactions = 0;
let pre = 0;
let post = 0;
let trigger = "";
for (const line of readFileSync(file, "utf8").split("\n")) {
  if (
    line.includes('"type":"user"') && line.includes('"isSidechain":false')
    && !line.includes('"isMeta":true') && !line.includes('"isCompactSummary":true')
    && !line.includes('"type":"tool_result"')
  ) calls++;
  if (line.includes('"subtype":"compact_boundary"')) {
    compactions++;
    pre = num(line, "preTokens");
    post = num(line, "postTokens");
    tokens = post;
    trigger = /"trigger":"([a-z]+)"/.exec(line)?.[1] ?? "";
  }
  if (line.includes('"type":"assistant"') && line.includes('"isSidechain":false')) {
    const u = line.indexOf('"usage":{');
    if (u !== -1) {
      let s = line.slice(u);
      const i = s.indexOf('"iterations":[');
      if (i !== -1) {
        // With server tools, usage adds up every request of the turn: the last
        // {"input_tokens": occurrence in the iterations is the context.
        let t = s.slice(i);
        let j;
        while ((j = t.indexOf('{"input_tokens":')) >= 0) {
          s = t.slice(j);
          t = t.slice(j + 1);
        }
      }
      const n = num(s, "input_tokens") + num(s, "cache_creation_input_tokens") + num(s, "cache_read_input_tokens");
      if (n > 0) tokens = n;
    }
  }
}
if (!tokens) fail();
let out = `tokens=${tokens} calls=${calls} compactions=${compactions}`;
if (compactions) out += ` lastTrigger=${trigger} lastPre=${pre} lastPost=${post}`;
process.stdout.write(out + "\n");
