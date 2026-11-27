// Herdr mods cannot import outside their own folder, so the shared helpers in
// lib/ are copied into mods/ranch-*/lib/. Edit lib/, never the copies.
//
// Each mod gets only the lib files it imports (directly, or through another
// lib file): following the import graph keeps an install about a quarter of
// the size of copying every file into every mod. Copies a mod no longer
// imports are deleted, so a stale one can't linger.
//
// Usage: node scripts/sync-lib.mjs          -> every mods/ranch-*
//        import { syncLib } from "./sync-lib.mjs"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

/** Relative import specifiers in a JS source (static `from`, bare `import "x"`, and `import("x")`). */
export function relativeImports(source) {
  const out = [];
  for (const m of String(source).matchAll(IMPORT_RE)) out.push(m[1]);
  return out;
}

function jsFiles(dir, skip) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === skip) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p, skip));
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * The lib/ file names one mod needs: every `./lib/x.js` its own code imports,
 * plus what those import inside lib/. Reads lib sources from `libDir` (the
 * shared source), so it works before any copy exists.
 * @returns {string[]} sorted file names, e.g. ["format.js", "git.js"]
 */
export function neededLibFiles(modDir, libDir) {
  const modLib = join(modDir, "lib");
  const need = new Set();
  const queue = [];
  const visit = (fromFile, spec) => {
    const target = resolve(dirname(fromFile), spec);
    if (!target.startsWith(modLib + sep)) return;
    const name = relative(modLib, target);
    if (need.has(name)) return;
    need.add(name);
    queue.push(name);
  };
  for (const f of jsFiles(modDir, modLib)) {
    for (const spec of relativeImports(readFileSync(f, "utf8"))) visit(f, spec);
  }
  while (queue.length) {
    const name = queue.pop();
    const src = join(libDir, name);
    if (!existsSync(src)) throw new Error(`${relative(process.cwd(), modDir)} imports lib/${name}, which lib/ does not have`);
    // Resolve as if it sat in the mod's lib/ copy.
    for (const spec of relativeImports(readFileSync(src, "utf8"))) visit(join(modLib, name), spec);
  }
  return [...need].sort();
}

/** Syncs every mods/ranch-* under `root`. Returns { mod: [files] }. */
export function syncLib(root, { mods } = {}) {
  const libDir = join(root, "lib");
  const names = mods ?? readdirSync(join(root, "mods")).filter((m) => m.startsWith("ranch-"));
  const result = {};
  for (const mod of names) {
    const modDir = join(root, "mods", mod);
    if (!existsSync(join(modDir, "main.js"))) continue;
    const files = neededLibFiles(modDir, libDir);
    const dest = join(modDir, "lib");
    if (files.length) mkdirSync(dest, { recursive: true });
    for (const f of files) {
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      copyFileSync(join(libDir, f), join(dest, f));
    }
    if (existsSync(dest)) {
      const keep = new Set(files);
      for (const f of readdirSync(dest)) {
        if (/\.m?js$/.test(f) && !keep.has(f)) rmSync(join(dest, f));
      }
      if (!readdirSync(dest).length) rmSync(dest, { recursive: true });
    }
    result[mod] = files;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  syncLib(root, { mods: process.argv[2] ? [process.argv[2]] : undefined });
}
