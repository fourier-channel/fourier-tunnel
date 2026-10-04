"use strict";

// The ONE resolver for the mounted state directory (installed-locations audit
// 2026-10-04, rooms.js:65, backfill-state.js:49, invites.js:10).
//
// Four modules used to read `ONBOARDING_STATE_DIR || __dirname` and create the
// directory on save. A missing variable or an unmounted directory then looked
// exactly like a first run: no denials, no strikes, every room unwalked, and
// progress written inside the image where a rebuild throws it away.
//
// Now the location comes from the one explicit place and is never created
// here. The install step (README: `mkdir -p onboarding-state`, compose mounts
// it at /state) creates it; a reader that does not find it refuses and says so.
// Resolved at CALL time, not require time, so a test points it at a temp dir
// by setting the variable and there is no production fallback to forget.

const fs = require("fs");
const path = require("path");

const INSTALL_STEP =
  "Fix: run `mkdir -p onboarding-state` next to docker-compose.yaml and bring the service up with " +
  "ONBOARDING_STATE_DIR=/state and the `./onboarding-state:/state` volume (README, Setup step 1).";

function stateDir() {
  const dir = process.env.ONBOARDING_STATE_DIR;
  if (!dir) {
    throw new Error(
      "ONBOARDING_STATE_DIR is not set, so the bridge has nowhere to keep the strike ledger, the denied-room list " +
      "and backfill progress, and will not guess one inside the image. " + INSTALL_STEP);
  }
  const abs = path.resolve(dir);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (err) {
    throw new Error(`state directory ${abs} cannot be read (${err.code || err.message}). It is created by the install step, never by the bridge. ${INSTALL_STEP}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`state path ${abs} exists but is not a directory. ${INSTALL_STEP}`);
  }
  return abs;
}

/** Absolute path of a named file inside the verified state directory. */
function statePath(name) {
  return path.join(stateDir(), name);
}

module.exports = { stateDir, statePath, INSTALL_STEP };
