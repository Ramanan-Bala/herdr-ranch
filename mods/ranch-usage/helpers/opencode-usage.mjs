// Prints OpenCode Go's usage limits (one JSON object) and exits.
// Node port of opencode-usage.sh (fixes doc F11); same output and exit codes.
//
// Runs `opencode api GET /api/experimental/usage/limits`, which asks OpenCode's
// own local server; the CLI authenticates itself. This script reads no tokens
// or credential files.
//
// Exit: 0 = printed the reply, 127 = opencode CLI not found, 1 = no reply in
// 15 s or no usable reply.
// Override the binary with HERDR_USAGE_OPENCODE_BIN.
import { homedir } from "node:os";
import { join } from "node:path";
import { runUntil } from "./run.mjs";

const MARKER = '"data"';
const ARGS = ["api", "GET", "/api/experimental/usage/limits"];

try {
  // OpenCode's installer puts it at ~/.opencode/bin/opencode, often not on
  // PATH: spawn falls back there when the PATH one is not found.
  let out = null;
  for (const cmd of [process.env.HERDR_USAGE_OPENCODE_BIN || "opencode", join(homedir(), ".opencode", "bin", "opencode")]) {
    try {
      ({ out } = await runUntil({ cmd, args: ARGS, marker: MARKER }));
      break;
    } catch (e) {
      if (!e?.enoent) throw e;
    }
  }
  if (out == null) process.exit(127);
  if (out.includes(MARKER)) {
    process.stdout.write(out);
    process.exit(0);
  }
  process.exit(1);
} catch (e) {
  process.exit(e?.enoent ? 127 : 1);
}
