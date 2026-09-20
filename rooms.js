"use strict";

// Rooms this bridge's bots must stay out of, and the one place that enforces it.
//
// WHY THIS EXISTS. Removing a bot from a room does not stick.
// matrix-appservice-bridge's Intent calls `_ensureJoined(roomId)` before
// sendEvent, sendStateEvent, sendMessage, roomState, getStateEvent and the
// rest -- its own docs say "this will automatically make the client join the
// room" -- and `_joinGuard` re-joins and retries when a send comes back
// forbidden. So a kick is undone by the next thing that touches that room,
// including a READ. Nothing in this repo asked for that and nothing in this
// repo could have prevented it call site by call site: the join is underneath
// every method.
//
// THEREFORE THE CHECK IS A PROXY, not a list of guarded call sites. A list
// would be correct on the day it was written and would rot the first time
// somebody used a method nobody thought of, or the library grew one. Any
// method called with a room id as its first argument is refused for a denied
// room; leaving is always allowed, because a bot that may not leave a room it
// must not be in is a worse trap than the one this fixes.
//
// REMOVING THE BOT IS THE GESTURE THAT DENIES THE ROOM. Being kicked or
// banned adds the room here by itself (index.js), so the natural action -- ask
// it to leave, in a client, like any other member -- is the one that works.
// An involuntary removal gets the same treatment as a voluntary one, which is
// the standing rule. `!leaveroom` exists for doing it from elsewhere, and
// `!rejoinroom` is how a room comes back: it only lifts the denial, because
// the door back in is still an invite from somebody with the power to send
// one, which is the rule invites.js already enforces.

const fs = require("fs");
const path = require("path");

// The same mounted state directory the strike ledger uses. Beside the code it
// would live inside the image, and a rebuild would silently invite every
// denied room back.
const STATE_DIR = process.env.ONBOARDING_STATE_DIR || __dirname;
const DENIED_PATH = path.join(STATE_DIR, "rooms-denied.json");

/** Methods that must keep working while a room is denied. */
const ALWAYS_ALLOWED = new Set(["leave", "forget"]);

function looksLikeRoomId(value) {
  return typeof value === "string" && value.startsWith("!") && value.includes(":");
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DENIED_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    // An ABSENT file is the ordinary first run. An unreadable one is every
    // denial silently becoming permission, and the caller cannot tell those
    // apart from an empty object -- so it is said out loud rather than
    // discovered later by a bot turning up somewhere it was thrown out of.
    if (err.code !== "ENOENT") {
      console.warn(`[rooms] denied-room list at ${DENIED_PATH} unreadable, continuing with NO denials: ${err.message}`);
    }
    return {};
  }
}

function save(state) {
  const tmp = DENIED_PATH + ".tmp";
  fs.mkdirSync(path.dirname(DENIED_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DENIED_PATH);
}

/** Every denied room, newest first, with why and by whom. */
function listDenied() {
  const state = load();
  return Object.entries(state)
    .map(([room, rec]) => ({ room, ...rec }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

function isDenied(roomId) {
  return Object.prototype.hasOwnProperty.call(load(), roomId);
}

/**
 * Keep the bots out of this room. Idempotent, and it keeps the FIRST reason:
 * a kick that follows a `!leaveroom` should not overwrite who decided it.
 */
function deny(roomId, { by, reason } = {}) {
  const state = load();
  if (state[roomId]) return false;
  state[roomId] = { at: Date.now(), by: by || "unknown", reason: reason || "unspecified" };
  save(state);
  return true;
}

/** Let the room be joined again -- by invitation, which is a separate gate. */
function allow(roomId) {
  const state = load();
  if (!state[roomId]) return false;
  delete state[roomId];
  save(state);
  return true;
}

class RoomDeniedError extends Error {
  constructor(roomId, method) {
    super(
      `${roomId} is on this bridge's denied-room list, so "${method}" was refused. ` +
      "The bot was removed from it and must not go back. Fix: an admin may lift it with " +
      `"!rejoinroom ${roomId}" in a DM, after which an invite from somebody with the power ` +
      "to send one gets it back in.");
    this.name = "RoomDeniedError";
    this.roomId = roomId;
    this.method = method;
  }
}

/**
 * Wrap an Intent so no denied room can be joined, read or written.
 *
 * The check is on the ARGUMENT rather than on a list of method names, so a
 * method nobody here has thought of is covered the day it is used. `deps` is
 * injectable so the tests exercise the rule rather than the filesystem.
 */
function guard(intent, deps = {}) {
  const denied = deps.isDenied || isDenied;
  return new Proxy(intent, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      if (ALWAYS_ALLOWED.has(prop)) return value.bind(target);
      return function (...args) {
        if (looksLikeRoomId(args[0]) && denied(args[0])) {
          throw new RoomDeniedError(args[0], prop);
        }
        return value.apply(target, args);
      };
    },
  });
}

module.exports = {
  DENIED_PATH, ALWAYS_ALLOWED, RoomDeniedError,
  isDenied, deny, allow, listDenied, guard, looksLikeRoomId,
};
