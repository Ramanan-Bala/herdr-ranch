// ranch-tasks launcher command for mods (and any caller): Windows cannot exec
// the POSIX sh launcher, so it calls node on the .js entry instead. Keep the
// paths forward-slashed so they still contain the ranch-tasks marker.

/** True when `home` looks like a Windows path (drive letter or UNC share). */
export function looksWindows(home) {
  const h = String(home ?? "");
  return /^[A-Za-z]:/.test(h) || h.startsWith("\\\\");
}

/**
 * [command, args] to hand to exec(): the sh launcher on macOS/Linux, `node`
 * on the .js entry on Windows. `isWin` defaults to a Windows-home check; pass
 * Herdr's window().platform === "windows" for the local machine, or decide by
 * a remote machine's home dir.
 */
export function tasksCommand(home, args, isWin = looksWindows(home)) {
  const dir = `${home}/.herdr/ranch/bin`;
  return isWin
    ? ["node", [`${dir}/ranch-tasks.js`, ...args]]
    : [`${dir}/ranch-tasks`, args];
}
