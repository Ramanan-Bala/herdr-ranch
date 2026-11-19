// Puts Ranch's task-reporting bridge on another machine. Pure module, no
// herdr imports: callers pass their `exec` so it can be tested in Node.
//
// A remote machine that never ran `ranch-tasks install` has no
// ~/.herdr/ranch/bin, so the Set up button has nothing to run there. This
// copies this computer's installed bridge (bin, adapters, lib) over with
// `tar | hc exec -i --on <machine>` and runs `install --yes` on that machine,
// which wires its own agents' hooks and rewrites the launcher for its node.

/** What gets copied, relative to ~/.herdr/ranch (never tasks/, logs/, backups/). */
export const BRIDGE_FILES = ["bin/ranch-tasks", "bin/ranch-tasks.js", "adapters", "lib", "package.json"];

/**
 * Runs on the target machine with the tar stream on stdin. $1 is this
 * computer's Ranch commit (or ""). A first push records a bridge-only update
 * manifest, so `ranch-tasks update` there refreshes only the bridge and the
 * update check has a commit to compare.
 */
export const REMOTE_SCRIPT = [
  "set -e",
  'd="$HOME/.herdr/ranch"',
  'mkdir -p "$d"',
  'tar -xf - -C "$d"',
  'chmod +x "$d/bin/ranch-tasks" "$d/bin/ranch-tasks.js"',
  'if [ ! -f "$d/update.json" ]; then',
  '  if [ -n "$1" ]; then c="\\"$1\\""; else c=null; fi',
  '  printf \'{ "version": 1, "commit": %s, "bridgeOnly": true, "files": {} }\\n\' "$c" > "$d/update.json"',
  "fi",
  'exec sh "$d/bin/ranch-tasks" install --yes',
].join("\n");

/**
 * Runs on this computer: $1 machine, $2 commit, $3 the remote script. The
 * machine name and script are positional arguments, never part of the text.
 * Exit 3: the bridge is not installed here either.
 */
export const PUSH_SCRIPT = [
  'src="$HOME/.herdr/ranch"',
  'if [ ! -f "$src/bin/ranch-tasks.js" ] || [ ! -f "$src/bin/ranch-tasks" ]; then',
  '  echo "Task reporting is not installed on this computer: set it up here first." >&2',
  "  exit 3",
  "fi",
  'cd "$src" || exit 3',
  // macOS tar adds xattr headers GNU tar warns about; drop them where supported.
  'x=; tar --no-xattrs -cf /dev/null package.json 2>/dev/null && x=--no-xattrs',
  `COPYFILE_DISABLE=1 tar $x -cf - ${BRIDGE_FILES.join(" ")} | hc exec -i --on "$1" sh -c "$3" ranch-bootstrap "$2"`,
].join("\n");

/** A full or short git commit, else "" (it lands in a remote shell argument). */
export function cleanCommit(commit) {
  const c = String(commit ?? "").trim();
  return /^[0-9a-f]{7,40}$/.test(c) ? c : "";
}

/** The commit in an update.json text (this computer's), or "". */
export function commitFromManifest(text) {
  try {
    return cleanCommit(JSON.parse(String(text ?? "")).commit);
  } catch {
    return "";
  }
}

/** [command, args] for exec(): runs on this computer, never with `on`. */
export function pushBridgeArgs(machine, commit = "") {
  return ["sh", ["-c", PUSH_SCRIPT, "ranch-push", String(machine), cleanCommit(commit), REMOTE_SCRIPT]];
}

/**
 * Why a push can't run, or null when it can: the bridge copy needs a POSIX
 * shell and tar on both ends. `localWindows`: this computer runs Windows;
 * `remoteHome`: the target's home (a Windows path means no sh there).
 */
export function pushBlocker({ machine, localWindows = false, remoteHome = null } = {}) {
  if (!machine) return "Set up runs on this computer directly.";
  if (localWindows) return `Copying the bridge needs sh and tar on this computer: run \`node bin/ranch-tasks install --yes\` from the Ranch repo on ${machine}.`;
  if (!remoteHome) return `Can't reach ${machine}.`;
  if (/^[A-Za-z]:/.test(remoteHome) || remoteHome.startsWith("\\\\")) {
    return `${machine} runs Windows: run \`node bin/ranch-tasks install --yes\` from the Ranch repo there.`;
  }
  return null;
}

/** A push's exec result as text for the panel. */
export function pushResultText(machine, r) {
  if (!r) return `Couldn't copy task reporting to ${machine}.`;
  const out = `${String(r.stdout ?? "").trim()}\n${String(r.stderr ?? "").trim()}`.trim();
  if (r.code === 0) return out || `Task reporting set up on ${machine}.`;
  if (r.code === 3) return out || "Task reporting is not installed on this computer: set it up here first.";
  if (r.code === 127 && /hc/.test(out)) return `Can't find hc on this computer to reach ${machine}.`;
  return out ? `${machine}: ${out.split("\n").slice(-3).join("\n")}` : `Setting up ${machine} failed (exit ${r.code}).`;
}

/**
 * Copies the bridge to `machine` and installs it there. `exec` is herdr's
 * (or a stub); `readLocal(path)` reads a local text file (for the commit).
 * Resolves { ok, text }; never rejects.
 */
export async function pushBridge({ exec, machine, localHome, readLocal, localWindows = false, remoteHome = null }) {
  const blocked = pushBlocker({ machine, localWindows, remoteHome });
  if (blocked) return { ok: false, text: blocked };
  let commit = "";
  try {
    commit = commitFromManifest(await readLocal(`${localHome}/.herdr/ranch/update.json`));
  } catch {}
  try {
    const r = await exec(...pushBridgeArgs(machine, commit), { timeout: 180000 });
    return { ok: r?.code === 0, text: pushResultText(machine, r) };
  } catch (err) {
    return { ok: false, text: `Couldn't copy task reporting to ${machine}: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}

/** True when a ranch-tasks exec result means the bridge isn't on that machine. */
export function bridgeMissing(r) {
  if (!r) return true;
  if (r.code === 127 || r.code === 126) return true;
  return r.code !== 0 && /no such file|not found/i.test(String(r.stderr ?? ""));
}
