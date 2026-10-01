"use strict";

// How far each room's history walk has got, kept across restarts.
//
// WHY THIS EXISTS. backfill.js walks a room backwards from the live edge, at
// most MAX_PAGES pages per run. Until 2026-10-01 nothing remembered where a run
// stopped, so every run -- the join trigger, and an admin's !backfill alike --
// started at the live edge again and could never get past the first run's
// horizon. 38 pictures in 8 watched rooms were never posted that way. This file
// is the memory: per room, the cursor to resume from, whether the start was
// reached, the pictures that failed (with the event id that lets a later run
// re-read and retry them), and when the room was last walked.
//
// Shape, keyed by room id:
//   { head, cursor, reachedStart, failed: [{ eventId, url, attempts, error }],
//     abandoned: [...], lastRunAt, lastKind, lastError }
//
// SAME PATTERN AS rooms.js: one JSON file on the mounted state directory
// (beside the code it would live inside the image, and a rebuild would forget
// every room's progress), written to a .tmp and renamed so a crash mid-write
// cannot leave half a file. Every read goes to the FILE, never a copy held in
// memory: the sweep, the join trigger and !backfill all decide from it, and a
// long-lived process deciding from a snapshot is the bug this org has paid for
// seven times (memory stale-index-check-then-act).

const fs = require("fs");
const path = require("path");

const STATE_DIR = process.env.ONBOARDING_STATE_DIR || __dirname;
const STATE_PATH = path.join(STATE_DIR, "backfill-state.json");

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // ABSENT is the first run. UNREADABLE means every room looks unwalked and
    // is walked again from the live edge: harmless at the booru (a replay is a
    // no-op there) but a download per picture, so it is said out loud.
    if (err.code !== "ENOENT") {
      console.warn(`[backfill] state at ${STATE_PATH} unreadable, every room will be walked again from the live edge: ${err.message}`);
    }
    return {};
  }
}

function save(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

/** One room's record, read from the file now. */
function get(roomId) {
  return load()[roomId];
}

/** Replace one room's record; every other room's is re-read and kept. */
function put(roomId, record) {
  const state = load();
  state[roomId] = record;
  save(state);
}

module.exports = { STATE_PATH, load, get, put };
