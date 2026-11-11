// Runs `herdr-app check` on every Ranch mod (after copying lib/ into it) and
// validates layout JSON. Workers run one mod with:
//   node --test --test-name-pattern="herdr check ranch-chrome" test/herdr-check.test.js
// Skips when herdr-app isn't installed (e.g. CI without Herdr).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("sh", [join(root, "scripts/sync-lib.sh")]);
const hasHerdr = spawnSync("herdr-app", ["--version"]).status === 0;
const mods = readdirSync(join(root, "mods")).filter((m) => m.startsWith("ranch-") && existsSync(join(root, "mods", m, "main.js")));

for (const mod of mods) {
  test(`herdr check ${mod}`, { skip: !hasHerdr && "herdr-app not installed" }, () => {
    const r = spawnSync("herdr-app", ["check", join(root, "mods", mod)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  });
}

test("herdr check layout JSON", () => {
  for (const f of readdirSync(join(root, "layouts")).filter((f) => f.endsWith(".json"))) {
    JSON.parse(readFileSync(join(root, "layouts", f), "utf8"));
  }
  if (existsSync(join(root, "keys.json"))) JSON.parse(readFileSync(join(root, "keys.json"), "utf8"));
});
