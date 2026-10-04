// A WRITER REMOVES WHAT IT MADE (installed-locations law; the /tmp incident
// of 2026-10-04, when about 500,000 leaked test folders made vesper's /tmp
// unlistable -- tunnel-presence-*, tunnel-gw-*, tunnel-drop-* among them).
//
// Preloaded into every test process (`node --import ./tools/tmp-root.mjs
// --test`; the runner passes --import on to each file's process). It gives
// the process its own private root and points TMPDIR at it, so every
// mkdtemp(path.join(os.tmpdir(), ...)) in a test -- and in anything the test
// spawns -- lands inside it. The root is removed when the process exits,
// pass or fail. One helper for the repo, not a cleanup per fixture.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-test-"));
process.env.TMPDIR = root;

function removeTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); return; } catch { /* below */ }
  // A test that chmod'ed a directory unreadable: reopen, then remove.
  const reopen = (d) => {
    let st;
    try { st = fs.lstatSync(d); } catch { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(d, 0o700); } catch { /* the final rm reports */ }
    for (const e of fs.readdirSync(d)) reopen(path.join(d, e));
  };
  reopen(p);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

process.on("exit", () => {
  try { removeTree(root); } catch (e) { process.stderr.write(`tmp-root: could not remove ${root}: ${e.message}\n`); }
});
