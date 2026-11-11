// Prints Claude Code's usage (one `control_response` JSON line) and exits.
// Node port of claude-usage.sh (fixes doc F11); same output and exit codes.
//
// Runs your own `claude` CLI briefly and sends it the `get_usage` control
// request; the CLI authenticates itself. This script reads no tokens or
// credential files, sends no prompt and starts no turn. `--safe-mode` keeps
// hooks, MCP servers and customizations out of it.
//
// Exit: 0 = printed the reply, 127 = claude CLI not found, 1 = no reply in 15 s.
// Override the binary with HERDR_USAGE_CLAUDE_BIN.
import { runUntil, printLine } from "./run.mjs";

const MARKER = '"control_response"';
const REQUEST =
  '{"type":"control_request","request_id":"herdr-usage-limits","request":{"subtype":"get_usage","skip_behaviors":true}}';

try {
  const { out } = await runUntil({
    cmd: process.env.HERDR_USAGE_CLAUDE_BIN || "claude",
    args: ["-p", "--safe-mode", "--no-session-persistence",
      "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    input: [REQUEST],
    marker: MARKER,
  });
  const line = out.split("\n").find((l) => l.includes(MARKER));
  if (line) printLine(line);
  process.exit(1);
} catch (e) {
  process.exit(e?.enoent ? 127 : 1);
}
