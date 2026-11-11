// Prints one line of numbers about the session a process is running, and exits:
//   claude: tokens=N calls=N compactions=N [lastTrigger=auto lastPre=N lastPost=N]
//   codex:  tokens=N window=N calls=N
//
// Usage: session.mjs claude|codex <pid of the agent in the terminal>
//
// Node port of session.sh (fixes doc F11). The claude branch is pure file
// reading and matches the sh+awk logic line for line, including its string
// matching: text in the session files is JSON-escaped, so \"type\" can't match
// the "type" looked for here. The codex branch needs pgrep and lsof, which
// have no Node equivalent, so it re-runs the sh helper (the sh path stays).
//
// Exit: 0 = printed, 1 = no session found for that process (never a guess).
// Claude's files follow CLAUDE_CONFIG_DIR.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const app = process.argv[2];
const pid = process.argv[3];

const fail = () => process.exit(1);

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
