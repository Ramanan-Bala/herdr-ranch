// tests lib/tasks-command.js: the ranch-tasks exec command per OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksWindows, tasksCommand } from "../lib/tasks-command.js";

test("tasksCommand returns the sh launcher on macOS/Linux", () => {
  assert.deepEqual(
    tasksCommand("/Users/x", ["status", "--json"], false),
    ["/Users/x/.herdr/ranch/bin/ranch-tasks", ["status", "--json"]],
  );
});

test("tasksCommand calls node on the .js entry on Windows", () => {
  assert.deepEqual(
    tasksCommand("C:/Users/x", ["install", "--yes"], true),
    ["node", ["C:/Users/x/.herdr/ranch/bin/ranch-tasks.js", "install", "--yes"]],
  );
});

test("tasksCommand decides Windows by the home path when no platform is given", () => {
  assert.deepEqual(
    tasksCommand("C:\\Users\\x", ["gc"])[0],
    "node",
  );
  assert.deepEqual(tasksCommand("/Users/x", ["gc"])[0], "/Users/x/.herdr/ranch/bin/ranch-tasks");
});

test("looksWindows recognizes drive-letter and UNC paths only", () => {
  assert.equal(looksWindows("C:\\Users\\x"), true);
  assert.equal(looksWindows("C:/Users/x"), true);
  assert.equal(looksWindows("\\\\server\\share"), true);
  assert.equal(looksWindows("/Users/x"), false);
  assert.equal(looksWindows(""), false);
  assert.equal(looksWindows(null), false);
});
