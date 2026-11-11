// Windows-only bits of the session panel, kept pure so tests can run them
// without Herdr (fixes doc F10/F12/F14). Nothing here reads process.platform:
// callers decide "is Windows" from home() (a Windows home contains ":" or
// starts with an UNC "\\\\"), so the same code runs unchanged on macOS/Linux.

/** True when a home() value is a Windows one ("C:/Users/x" or "\\\\server/x"). */
export function isWinHome(h) {
  return typeof h === "string" && (h.includes(":") || h.startsWith("\\\\"));
}

/**
 * First real path in `where.exe` output: it prints an "INFO: Could not find…"
 * line (and exits 1) when no name matches, so take the first line that isn't.
 */
export function whereFirstPath(stdout) {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^INFO:/i.test(l)) ?? null;
}

/** A `.cmd` editor needs cmd.exe to start; .exe and sh-found paths don't. */
export function editorLaunch(path, top) {
  if (/\.cmd$/i.test(String(path))) return ["cmd.exe", ["/c", path, top]];
  return [path, [top]];
}

/**
 * Home from a Windows remote's `cmd.exe /c echo %USERPROFILE%`: backslashes
 * normalized to "/", or null when the variable was unset (echo repeats it).
 */
export function windowsHome(out) {
  const s = String(out ?? "").trim();
  if (!s || s.includes("%")) return null;
  return s.replace(/\\/g, "/");
}
