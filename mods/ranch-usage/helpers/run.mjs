// Shared runner for the usage helpers (fixes doc F11): the sh originals fed
// the CLI through a fifo and polled its output; here the child's stdout is
// collected until the marker shows up, the CLI exits or timeoutMs pass (then
// it is killed), which keeps the same output and exit-code contract.
import { spawn } from "node:child_process";

/**
 * Runs `cmd args`, writes each `input` line to its stdin (left open, like the
 * sh helpers' fifos) and resolves { code, out } — code null when the helper
 * killed it. Rejects with err.enoent = true when the CLI could not be started
 * (the helpers turn that into exit 127, "not installed").
 */
export function runUntil({ cmd, args, input = [], marker = null, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    // Windows: npm installs CLIs as .cmd shims, which only start through a
    // shell. Args here are fixed flags (requests go through stdin), so this is safe.
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], shell: process.platform === "win32" });
    let out = "";
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    const stop = () => {
      try { child.kill("SIGTERM"); } catch {}
    };
    const timer = setTimeout(() => { stop(); done(null); }, timeoutMs);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error(String(e?.message ?? e));
      if (e?.code === "ENOENT") err.enoent = true;
      reject(err);
    });
    child.stdout.on("data", (d) => {
      out += d;
      if (marker && out.includes(marker)) { stop(); done(null); }
    });
    child.on("close", (code) => done(code));
    child.stdin.on("error", () => {}); // the CLI may close its stdin early
    for (const line of input) child.stdin.write(line + "\n");
  });
}

/** Prints a reply line and exits 0, or the helper's failure code. */
export function printLine(line) {
  process.stdout.write(line + "\n");
  process.exit(0);
}
