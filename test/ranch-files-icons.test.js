// Unit tests for lib/file-icons.js (pure lookup tables).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const {
  fileIcon,
  folderIcon,
  languageFor,
  iconPath,
  fileExactIcons,
  fileExtensionIcons,
  folderIcons,
} = await import(pathToFileURL(join(root, "lib/file-icons.js")).href);

test("fileIcon: exact names beat their extension", () => {
  assert.deepEqual(fileIcon("package.json"), { icon: "package", color: "ansi2" });
  assert.deepEqual(fileIcon("tsconfig.json"), { icon: "settings", color: "ansi4" });
});

test("fileIcon: test files beat their extension", () => {
  assert.deepEqual(fileIcon("a.test.ts"), { icon: "flask-conical", color: "ansi2" });
  assert.deepEqual(fileIcon("b.spec.js"), { icon: "flask-conical", color: "ansi2" });
});

test("fileIcon: names match case-insensitively", () => {
  assert.deepEqual(fileIcon("README.md"), { icon: "book-open", color: "ansi4" });
  assert.deepEqual(fileIcon("Dockerfile"), { icon: "container", color: "ansi4" });
});

test("fileIcon: .env variants and config patterns", () => {
  assert.deepEqual(fileIcon(".env"), { icon: "key-round", color: "ansi3" });
  assert.deepEqual(fileIcon(".env.local"), { icon: "key-round", color: "ansi3" });
  assert.deepEqual(fileIcon("vite.config.ts"), { icon: "settings", color: "muted" });
  assert.deepEqual(fileIcon(".babelrc"), { icon: "settings", color: "muted" });
});

test("fileIcon: extensions and unknown fall back to file/muted", () => {
  assert.deepEqual(fileIcon("main.ts"), { icon: "file-code", color: "ansi4" });
  assert.deepEqual(fileIcon("unknown.zzz"), { icon: "file", color: "muted" });
  assert.deepEqual(fileIcon("noextension"), { icon: "file", color: "muted" });
});

test("folderIcon: known names, and open vs closed default", () => {
  assert.deepEqual(folderIcon("src"), { icon: "folder-code", color: "ansi4" });
  assert.deepEqual(folderIcon("node_modules"), { icon: "folder-archive", color: "dim" });
  assert.deepEqual(folderIcon(".github"), { icon: "folder-git", color: "ansi1" });
  assert.deepEqual(folderIcon("misc"), { icon: "folder", color: "muted" });
  assert.deepEqual(folderIcon("misc", true), { icon: "folder-open", color: "muted" });
});

test("languageFor: extensions, aliases, whole names and fallbacks", () => {
  assert.equal(languageFor("src/main.ts"), "ts");
  assert.equal(languageFor("src/App.tsx"), "tsx");
  assert.equal(languageFor("src/index.mjs"), "js");
  assert.equal(languageFor("ci.yml"), "yaml");
  assert.equal(languageFor("tools/setup.zsh"), "bash");
  assert.equal(languageFor("Dockerfile"), "dockerfile");
  assert.equal(languageFor("Makefile"), "makefile");
  assert.equal(languageFor("LICENSE"), "txt");
  assert.equal(languageFor("README.MD"), "md");
});

test("iconPath: points at the mod's icons folder", () => {
  assert.equal(iconPath("file-code"), "mods/ranch-files/icons/file-code.svg");
});

test("every icon used by the tables has an SVG", () => {
  const icons = [
    ...[...fileExactIcons.values()].map(([icon]) => icon),
    ...[...fileExtensionIcons.values()].map(([icon]) => icon),
    ...[...folderIcons.values()].map(([icon]) => icon),
    "file",
    "folder",
    "folder-open",
  ];
  for (const icon of new Set(icons)) {
    assert.ok(existsSync(join(root, iconPath(icon))), `missing SVG for ${icon}`);
  }
});
