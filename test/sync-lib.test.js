// scripts/sync-lib.mjs copies each mod only the lib/ files it imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { syncLib, neededLibFiles, relativeImports } from "../scripts/sync-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("relativeImports finds static, bare and dynamic relative imports", () => {
  const src = `import a from "./a.js";\nimport { b } from '../b.js';\nimport "./c.js";\nconst d = await import("./d.js");\nimport x from "herdr";`;
  assert.deepEqual(relativeImports(src), ["./a.js", "../b.js", "./c.js", "./d.js"]);
});

test("syncLib copies what a mod imports (and what those import), and removes the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranch-sync-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib/a.js"), `import { b } from "./b.js";\nexport const a = 1;`);
  writeFileSync(join(dir, "lib/b.js"), "export const b = 1;");
  writeFileSync(join(dir, "lib/c.js"), "export const c = 1;");
  mkdirSync(join(dir, "mods/ranch-x/lib"), { recursive: true });
  mkdirSync(join(dir, "mods/ranch-x/sub"));
  writeFileSync(join(dir, "mods/ranch-x/main.js"), `import "./sub/view.js";`);
  writeFileSync(join(dir, "mods/ranch-x/sub/view.js"), `import { a } from "../lib/a.js";`);
  writeFileSync(join(dir, "mods/ranch-x/lib/stale.js"), "// old copy");
  mkdirSync(join(dir, "mods/ranch-y"));
  writeFileSync(join(dir, "mods/ranch-y/main.js"), "export default 1;");
  const out = syncLib(dir);
  assert.deepEqual(out["ranch-x"], ["a.js", "b.js"]);
  assert.deepEqual(readdirSync(join(dir, "mods/ranch-x/lib")).sort(), ["a.js", "b.js"]);
  assert.equal(existsSync(join(dir, "mods/ranch-y/lib")), false, "a mod that imports nothing gets no lib/");
});

test("neededLibFiles fails loudly for an import lib/ does not have", () => {
  const dir = mkdtempSync(join(tmpdir(), "ranch-sync-"));
  mkdirSync(join(dir, "lib"));
  mkdirSync(join(dir, "mods/ranch-x"), { recursive: true });
  writeFileSync(join(dir, "mods/ranch-x/main.js"), `import { q } from "./lib/missing.js";`);
  assert.throws(() => neededLibFiles(join(dir, "mods/ranch-x"), join(dir, "lib")), /lib\/missing\.js/);
});

test("every Ranch mod's lib/ copies are exactly what it imports, byte for byte", () => {
  syncLib(root);
  for (const mod of readdirSync(join(root, "mods")).filter((m) => m.startsWith("ranch-"))) {
    const need = neededLibFiles(join(root, "mods", mod), join(root, "lib"));
    const libDir = join(root, "mods", mod, "lib");
    const have = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith(".js")).sort() : [];
    assert.deepEqual(have, need, mod);
    for (const f of need) assert.equal(readFileSync(join(libDir, f), "utf8"), readFileSync(join(root, "lib", f), "utf8"), `${mod}/lib/${f}`);
  }
});
