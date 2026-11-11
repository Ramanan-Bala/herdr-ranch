// Prints Codex's rate limits as one JSON line and exits.
// Node port of codex-limits.sh (fixes doc F11); same output and exit codes.
// Approach credit: Joseph Malicki's jmalicki/herdr-mod-ai-usage (MIT), whose collector
// reads `codex app-server` account/rateLimits/read. No code is copied from it.
//
// Asks `codex app-server` (JSON-RPC: initialize, initialized,
// account/rateLimits/read); Codex authenticates itself and this script reads no
// tokens. If that fails, prints the newest rate-limit snapshot Codex logged in
// its sessions (last 14 days) as {"snapshot": <line>}.
//
// Exit: 0 = printed something, 127 = codex CLI not found,
// 1 = codex found but no reply and no snapshot.
// Override the binary with HERDR_USAGE_CODEX_BIN; sessions follow CODEX_HOME.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runUntil, printLine } from "./run.mjs";

const MARKER = '"id":2';

try {
  const { out } = await runUntil({
    cmd: process.env.HERDR_USAGE_CODEX_BIN || "codex",
    args: ["app-server"],
    input: [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr-usage-limits","version":"1.0"}}}',
      '{"jsonrpc":"2.0","method":"initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}',
    ],
    marker: MARKER,
  });
  const line = out.split("\n").find((l) => l.includes(MARKER));
  if (line) printLine(line);

  // app-server didn't answer: offer the newest logged snapshot (the mod shows
  // it as the last reading, dated, with the provider marked as failing).
  const sessions = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push({ p, at: statSync(p).mtimeMs });
    }
  };
  try {
    walk(sessions);
  } catch {
    process.exit(1); // no session logs
  }
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const recent = files.filter((f) => f.at >= cutoff).sort((a, b) => b.at - a.at).slice(0, 30);
  for (const f of recent) {
    let snap = null;
    try {
      for (const l of readFileSync(f.p, "utf8").split("\n")) {
        if (l.includes('"rate_limits":{')) snap = l;
      }
    } catch {}
    if (snap) printLine(`{"snapshot":${snap.trim()}}`);
  }
  process.exit(1);
} catch (e) {
  process.exit(e?.enoent ? 127 : 1);
}
