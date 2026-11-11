// check.sh for contributors without a POSIX shell (Windows, docs/fixes/
// ranch-tasks-windows-install-plan.md §3.4): re-syncs lib/ into the Ranch
// mods, runs `herdr-app check` on every mods/ranch-* and validates layout and
// keys JSON. Usage: node scripts/check.mjs [mod-name]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const mods = (process.argv[2] ? [process.argv[2]] : readdirSync(join(root, "mods")).filter((m) => m.startsWith("ranch-")))
  .filter((m) => existsSync(join(root, "mods", m, "main.js")));
let status = 0;

// sync-lib.sh: Herdr mods can't import outside their own folder.
for (const mod of mods) {
  mkdirSync(join(root, "mods", mod, "lib"), { recursive: true });
  for (const f of readdirSync(join(root, "lib")).filter((f) => f.endsWith(".js"))) {
    cpSync(join(root, "lib", f), join(root, "mods", mod, "lib", f));
  }
}

if (spawnSync("herdr-app", ["--version"]).status !== 0) {
  console.error("herdr-app not found on PATH; mod checks cannot run");
  status = 1;
} else {
  for (const mod of mods) {
    const r = spawnSync("herdr-app", ["check", join(root, "mods", mod)], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`check failed: ${mod}`);
      status = 1;
    }
  }
}

for (const f of [...readdirSync(join(root, "layouts")).map((f) => join(root, "layouts", f)), join(root, "keys.json")]) {
  if (!f.endsWith(".json") || !existsSync(f)) continue;
  try {
    JSON.parse(readFileSync(f, "utf8"));
  } catch (err) {
    console.error(`invalid JSON: ${f} (${err.message})`);
    status = 1;
  }
}

process.exit(status);
