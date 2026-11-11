// Prints GitHub Copilot's usage limits (one JSON object) and exits.
// Node port of copilot-usage.sh (fixes doc F11); same output and exit codes.
//
// Runs `gh api /copilot_internal/user`; gh authenticates itself. This script
// reads no tokens or credential files.
//
// Exit: 0 = printed the reply, 127 = gh not found, 1 = gh failed.
// Override the binary with HERDR_USAGE_GH_BIN.
import { runUntil } from "./run.mjs";

try {
  const { code, out } = await runUntil({
    cmd: process.env.HERDR_USAGE_GH_BIN || "gh",
    args: ["api", "/copilot_internal/user"],
  });
  if (code !== 0) process.exit(1);
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  process.exit(0);
} catch (e) {
  process.exit(e?.enoent ? 127 : 1);
}
