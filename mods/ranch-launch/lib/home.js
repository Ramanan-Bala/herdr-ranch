// Machine-aware home lookup shared by the mods (integrity audit finding 17).
// Pure module, no herdr imports: callers pass their `exec` so it can be
// tested in Node. Same strategy as ranch-session's homeFor: POSIX `sh`
// first, then `cmd.exe` for a Windows remote without sh.

/** How long a failed lookup is remembered before it is tried again. */
export const HOME_RETRY_MS = 30 * 1000;

/**
 * Home from a Windows remote's `cmd.exe /c echo %USERPROFILE%`: backslashes
 * normalized to "/", or null when the variable was unset (echo repeats it).
 */
export function windowsHomeFrom(out) {
  const s = String(out ?? "").trim();
  if (!s || s.includes("%")) return null;
  return s.replace(/\\/g, "/");
}

/**
 * Asks `machine` for its home directory: `sh -c 'printf %s "$HOME"'`, then
 * `cmd.exe /c echo %USERPROFILE%`. Returns the path with "/" separators, or
 * null when neither answered (offline, or no usable shell).
 */
export async function probeHome(exec, machine) {
  try {
    const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine });
    const out = r?.code === 0 ? String(r.stdout ?? "").trim() : "";
    if (out) return out.replace(/\\/g, "/");
  } catch {}
  try {
    const r = await exec("cmd.exe", ["/c", "echo %USERPROFILE%"], { on: machine });
    const out = windowsHomeFrom(r?.code === 0 ? r.stdout : "");
    if (out) return out;
  } catch {}
  return null;
}

/**
 * A per-view cache around probeHome: successes are kept, failures are
 * remembered for HOME_RETRY_MS so an offline machine is not asked every
 * frame, then retried. `local` answers for the local machine (machine falsy).
 */
export function homeCache(exec, local, now = () => Date.now()) {
  const hits = new Map();
  const failed = new Map();
  const pending = new Map();
  return async function homeFor(machine) {
    if (!machine) return local();
    if (hits.has(machine)) return hits.get(machine);
    const at = failed.get(machine);
    if (at !== undefined && now() - at < HOME_RETRY_MS) return null;
    if (pending.has(machine)) return pending.get(machine);
    const p = probeHome(exec, machine).then((dir) => {
      pending.delete(machine);
      if (dir) {
        hits.set(machine, dir);
        failed.delete(machine);
      } else {
        failed.set(machine, now());
      }
      return dir;
    });
    pending.set(machine, p);
    return p;
  };
}
