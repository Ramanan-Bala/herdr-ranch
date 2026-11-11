// doctor runs synthetic hook events through node, so it must pick the
// installed .js entry, never the sh launcher installed beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliPath } from "../adapters/doctor.js";

test("doctor runs the installed ranch-tasks.js, not the sh launcher", (t) => {
  const home = mkdtempSync(join(tmpdir(), "ranch-doctor-"));
  const bin = join(home, ".herdr", "ranch", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ranch-tasks"), "#!/bin/sh\n# launcher\n");
  writeFileSync(join(bin, "ranch-tasks.js"), "// node entry\n");
  const saved = process.env.RANCH_HOME;
  process.env.RANCH_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.RANCH_HOME; else process.env.RANCH_HOME = saved; });
  assert.equal(cliPath(), join(bin, "ranch-tasks.js"));
});
