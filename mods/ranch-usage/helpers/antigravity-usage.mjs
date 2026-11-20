// Prints Antigravity's usage limits (one JSON object) and exits.
//
// Runs `agy -p /usage --output-format json`; the CLI authenticates itself,
// starts no agent turn, spends no quota and saves no conversation. This script
// reads no tokens or credential files.
//
// Exit: 0 = printed the reply, 127 = agy CLI not found, 1 = no reply in
// 15 s or no usable reply.
// Override the binary with HERDR_USAGE_AGY_BIN.
import { runUntil } from "./run.mjs";

const ARGS = ["-p", "/usage", "--output-format", "json"];

try {
  const { code, out } = await runUntil({
    cmd: process.env.HERDR_USAGE_AGY_BIN || "agy",
    args: ARGS,
  });
  if (code != null && out.includes('"status"')) {
    process.stdout.write(out.endsWith("\n") ? out : out + "\n");
    process.exit(0);
  }
  process.exit(1);
} catch (e) {
  process.exit(e?.enoent ? 127 : 1);
}
