// Unit tests for the session panel's Windows bits (fixes doc F10/F12/F14):
// pure helpers in mods/ranch-session/win.js, no Herdr imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { isWinHome, whereFirstPath, editorLaunch, windowsHome } = await import(
  join(root, "mods/ranch-session/win.js")
);

// ------------------------------------------------------------------- isWinHome

test("isWinHome: a Windows home contains ':' or starts with an UNC prefix", () => {
  assert.equal(isWinHome("C:\\Users\\ramanan"), true);
  assert.equal(isWinHome("C:/Users/ramanan"), true);
  assert.equal(isWinHome("\\\\server\\share"), true);
  assert.equal(isWinHome("/Users/ramanan"), false);
  assert.equal(isWinHome("/home/dev"), false);
  assert.equal(isWinHome(""), false);
  assert.equal(isWinHome(null), false);
});

// -------------------------------------------------------------- whereFirstPath

test("whereFirstPath: first line of where.exe output", () => {
  assert.equal(whereFirstPath("C:\\Program Files\\code.cmd\r\nC:\\other\\zed.exe\r\n"), "C:\\Program Files\\code.cmd");
  assert.equal(whereFirstPath("/usr/local/bin/code\n"), "/usr/local/bin/code");
});

test("whereFirstPath: skips the INFO line where.exe prints when nothing matches", () => {
  assert.equal(whereFirstPath("INFO: Could not find files for the given pattern(s).\r\n"), null);
  assert.equal(whereFirstPath("\r\n"), null);
  assert.equal(whereFirstPath(undefined), null);
  assert.equal(whereFirstPath("INFO: none\r\nC:\\x\\code.cmd\r\n"), "C:\\x\\code.cmd");
});

// ---------------------------------------------------------------- editorLaunch

test("editorLaunch: .cmd paths go through cmd.exe /c", () => {
  assert.deepEqual(editorLaunch("C:\\Users\\x\\AppData\\Local\\Programs\\bin\\code.cmd", "C:\\repo"), [
    "cmd.exe",
    ["/c", "C:\\Users\\x\\AppData\\Local\\Programs\\bin\\code.cmd", "C:\\repo"],
  ]);
  assert.deepEqual(editorLaunch("C:\\Users\\x\\AppData\\Local\\bin\\zed.exe", "C:\\repo"), [
    "C:\\Users\\x\\AppData\\Local\\bin\\zed.exe",
    ["C:\\repo"],
  ]);
  assert.deepEqual(editorLaunch("/opt/homebrew/bin/cursor", "/Users/x/repo"), [
    "/opt/homebrew/bin/cursor",
    ["/Users/x/repo"],
  ]);
});

// ----------------------------------------------------------------- windowsHome

test("windowsHome: cmd.exe echo output, backslashes normalized", () => {
  assert.equal(windowsHome("C:\\Users\\ramanan\r\n"), "C:/Users/ramanan");
  assert.equal(windowsHome("C:/Users/ramanan"), "C:/Users/ramanan");
});

test("windowsHome: unset variable (echo repeats it) and empty output are null", () => {
  assert.equal(windowsHome("%USERPROFILE%\r\n"), null);
  assert.equal(windowsHome(""), null);
  assert.equal(windowsHome(null), null);
});
