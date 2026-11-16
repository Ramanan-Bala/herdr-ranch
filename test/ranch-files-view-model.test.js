// Unit tests for mods/ranch-files/view-model.js (pure helpers only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const {
  treeMarks,
  breadcrumbs,
  viewerBreadcrumbs,
  parentPath,
  previewText,
  lineCount,
} = await import(pathToFileURL(join(root, "mods/ranch-files/view-model.js")).href);

const state = (tabs, active = null, recent = tabs) => ({ tabs, active, recent });

test("treeMarks: relative file marks and the most severe descendant on every ancestor folder", () => {
  const marks = {
    "/repo/src/app/a.ts": "A",
    "/repo/src/app/deep/b.ts": "M",
    "/repo/src/lib/c.ts": "U",
    "/repo/dir/d.ts": "D",
    "/repo/readme.md": "M",
    "/elsewhere/x.ts": "A",
  };
  const { files, folders } = treeMarks(marks, "/repo");
  assert.deepEqual([...files.entries()].sort(), [
    ["dir/d.ts", "D"],
    ["readme.md", "M"],
    ["src/app/a.ts", "A"],
    ["src/app/deep/b.ts", "M"],
    ["src/lib/c.ts", "U"],
  ]);
  assert.equal(folders.get("dir"), "D"); // U/D > M > A
  assert.equal(folders.get("src"), "U");
  assert.equal(folders.get("src/app"), "M");
  assert.equal(folders.get("src/app/deep"), "M");
  assert.equal(folders.get("src/lib"), "U");
  assert.equal(folders.has("readme.md"), false);
});

test("treeMarks: Windows separators and a trailing root slash still match", () => {
  const { files, folders } = treeMarks(
    { "C:\\repo\\src\\a.ts": "A", "C:/repo/src/b.ts": "M" },
    "C:\\repo\\",
  );
  assert.deepEqual([...files.entries()].sort(), [
    ["src/a.ts", "A"],
    ["src/b.ts", "M"],
  ]);
  assert.equal(folders.get("src"), "M");
});

test("breadcrumbs: relative and absolute paths, both separators", () => {
  assert.deepEqual(breadcrumbs("/repo/src/a.ts"), ["repo", "src", "a.ts"]);
  assert.deepEqual(breadcrumbs("C:\\repo\\a.ts"), ["C:", "repo", "a.ts"]);
  assert.deepEqual(breadcrumbs(""), []);
});

test("viewerBreadcrumbs: panel paths contain only the root name and relative path", () => {
  assert.deepEqual(
    viewerBreadcrumbs("/Users/me/ranch/mods/ranch-files/main.js", "/Users/me/ranch"),
    ["ranch", "mods", "ranch-files", "main.js"],
  );
});

test("viewerBreadcrumbs: pane paths keep four segments and mark shortening", () => {
  assert.deepEqual(
    viewerBreadcrumbs("/Users/me/ranch/mods/ranch-files/main.js"),
    ["…", "ranch", "mods", "ranch-files", "main.js"],
  );
  assert.deepEqual(viewerBreadcrumbs("/repo/a.js"), ["repo", "a.js"]);
});

test("parentPath: normal, root and drive folders", () => {
  assert.equal(parentPath("/repo/src/a.ts"), "/repo/src");
  assert.equal(parentPath("/"), "/");
  assert.equal(parentPath("/repo"), "/");
  assert.equal(parentPath("C:\\repo\\a.ts"), "C:\\repo");
  assert.equal(parentPath("C:\\repo"), "C:\\");
});

test("previewText: unchanged under the cap, marked and flagged above it", () => {
  assert.deepEqual(previewText("hello", 10), { value: "hello", truncated: false });
  const cut = previewText("x".repeat(11), 10);
  assert.equal(cut.truncated, true);
  assert.equal(cut.value, "x".repeat(10) + "\n… (file truncated)");
});

test("lineCount: empty, trailing newline and multiple lines", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\nb\n"), 2);
});
