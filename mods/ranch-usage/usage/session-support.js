// Whether the focused terminal's session usage can be read at all, decided
// before any helper runs. Pure: no Herdr imports.
//
// The session helpers match a PID against THIS machine's session files, so a
// terminal on a remote machine must not use them: they would report some other
// machine's numbers as if they were here. Codex also needs pgrep and lsof
// (helpers/session.sh), which don't exist on Windows.
//
// platform is Herdr's window().platform: "macos", "windows" or "linux".
export function sessionUsageSupport({ remote, agent, platform }) {
  if (remote) return { ok: false, reason: "not available for remote terminals" };
  if (agent === "codex" && platform === "windows") return { ok: false, reason: "not available on Windows" };
  return { ok: true };
}
