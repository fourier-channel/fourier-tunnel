// The suite as the gate runs it: every test under a fresh, EMPTY TMPDIR, and
// a FAILURE, naming what was left, if the suite leaves anything in it.
// Passing tests that leak are not passing (the /tmp incident of 2026-10-04).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-gate-tmp-"));
let code = 1;
try {
  const r = spawnSync(process.execPath, ["--import", "./tools/tmp-root.mjs", "--test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: scratch, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  code = r.status ?? 1;
  const left = fs.readdirSync(scratch);
  if (code === 0 && left.length) {
    console.error(`\nrun-suite.mjs: the suite passed but left ${left.length} entr${left.length === 1 ? "y" : "ies"} in its TMPDIR; fix: the test that makes it must remove it:`);
    for (const n of left.slice(0, 15)) console.error(`  ${n}`);
    code = 1;
  } else if (code === 0) {
    console.log("run-suite.mjs: TMPDIR left empty");
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(code);
