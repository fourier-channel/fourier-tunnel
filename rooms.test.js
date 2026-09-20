"use strict";

// The denied-room list and the guard in front of the Intent.
//
// What is under test is the RULE, not the filesystem: the guard takes its
// predicate injected, so these exercise what it refuses and what it must keep
// allowing. The persistence half is exercised against a real temp directory,
// because a denial that does not survive a restart is not a denial.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOM = "!denied:41chan.net";
const OK = "!fine:41chan.net";

function freshModule(stateDir) {
  // rooms.js reads the state dir at require time, so each persistence test
  // gets its own module instance rather than sharing one path.
  process.env.ONBOARDING_STATE_DIR = stateDir;
  delete require.cache[require.resolve("./rooms")];
  return require("./rooms");
}

function fakeIntent() {
  const calls = [];
  return {
    calls,
    join: (room) => { calls.push(["join", room]); return "joined"; },
    leave: (room) => { calls.push(["leave", room]); return "left"; },
    sendEvent: (room, type) => { calls.push(["sendEvent", room, type]); return { event_id: "$1" }; },
    sendStateEvent: (room, type) => { calls.push(["sendStateEvent", room, type]); return {}; },
    // A READ. This is the one that surprised everybody: roomState joins too.
    roomState: (room) => { calls.push(["roomState", room]); return []; },
    // Something nobody thought of, added later by the library.
    somethingNew: (room) => { calls.push(["somethingNew", room]); return "did it"; },
    setDisplayName: (name) => { calls.push(["setDisplayName", name]); return "named"; },
    notAFunction: 42,
  };
}

const guardFor = (rooms, denied) => rooms.guard(fakeIntent(), { isDenied: (r) => denied.includes(r) });

test("a denied room is refused for writes, and the error says how to lift it", () => {
  const rooms = require("./rooms");
  const intent = fakeIntent();
  const g = rooms.guard(intent, { isDenied: (r) => r === ROOM });
  assert.throws(() => g.sendEvent(ROOM, "m.room.message", {}), (e) =>
    e instanceof rooms.RoomDeniedError && /!rejoinroom !denied:41chan.net/.test(e.message));
  assert.deepEqual(intent.calls, [], "nothing may reach the library before the refusal");
});

test("a denied room is refused for READS too, which is the whole point", () => {
  // Intent.roomState calls _ensureJoined. Reading a room you were kicked from
  // puts you back in it, so a guard that only covered writes would be useless.
  const rooms = require("./rooms");
  const intent = fakeIntent();
  const g = rooms.guard(intent, { isDenied: (r) => r === ROOM });
  assert.throws(() => g.roomState(ROOM), rooms.RoomDeniedError);
  assert.throws(() => g.join(ROOM), rooms.RoomDeniedError);
  assert.deepEqual(intent.calls, []);
});

test("a method nobody has thought of is covered, because the check is on the argument", () => {
  const rooms = require("./rooms");
  const intent = fakeIntent();
  const g = rooms.guard(intent, { isDenied: (r) => r === ROOM });
  assert.throws(() => g.somethingNew(ROOM), rooms.RoomDeniedError);
  assert.equal(g.somethingNew(OK), "did it");
});

test("leaving a denied room is ALWAYS allowed", () => {
  // A bot that may not leave a room it must not be in is a worse trap than
  // the one this fixes.
  const rooms = require("./rooms");
  const intent = fakeIntent();
  const g = rooms.guard(intent, { isDenied: () => true });
  assert.equal(g.leave(ROOM), "left");
  assert.deepEqual(intent.calls, [["leave", ROOM]]);
});

test("a room that is not denied passes straight through, unchanged", () => {
  const rooms = require("./rooms");
  const intent = fakeIntent();
  const g = rooms.guard(intent, { isDenied: (r) => r === ROOM });
  assert.deepEqual(g.sendEvent(OK, "m.room.message", {}), { event_id: "$1" });
  assert.deepEqual(intent.calls, [["sendEvent", OK, "m.room.message"]]);
});

test("a call whose first argument is not a room id is not second-guessed", () => {
  const rooms = require("./rooms");
  const g = rooms.guard(fakeIntent(), { isDenied: () => true });
  assert.equal(g.setDisplayName("Neru-chan"), "named");
  assert.equal(g.notAFunction, 42);
});

test("the denial survives a restart, keeps its first reason, and lifts cleanly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
  try {
    let rooms = freshModule(dir);
    assert.equal(rooms.isDenied(ROOM), false);
    assert.equal(rooms.deny(ROOM, { by: "@saber:41chan.net", reason: "kicked" }), true);
    assert.equal(rooms.deny(ROOM, { by: "@someone:41chan.net", reason: "again" }), false,
      "denying twice is not an error, and must not rewrite who decided it");

    // A fresh module instance: this is the restart.
    rooms = freshModule(dir);
    assert.equal(rooms.isDenied(ROOM), true);
    const [rec] = rooms.listDenied();
    assert.equal(rec.room, ROOM);
    assert.equal(rec.by, "@saber:41chan.net");
    assert.equal(rec.reason, "kicked");

    assert.equal(rooms.allow(ROOM), true);
    assert.equal(rooms.allow(ROOM), false);
    assert.equal(freshModule(dir).isDenied(ROOM), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ONBOARDING_STATE_DIR;
    delete require.cache[require.resolve("./rooms")];
  }
});

test("a corrupt list is NOT read as permission, and says so", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rooms-"));
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    fs.writeFileSync(path.join(dir, "rooms-denied.json"), "{not json");
    const rooms = freshModule(dir);
    assert.equal(rooms.isDenied(ROOM), false, "it cannot know, so it does not claim a denial");
    assert.match(warnings.join("\n"), /unreadable, continuing with NO denials/,
      "silence here would be every denial becoming permission with nobody told");
  } finally {
    console.warn = realWarn;
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ONBOARDING_STATE_DIR;
    delete require.cache[require.resolve("./rooms")];
  }
});

test("looksLikeRoomId accepts ids and nothing else", () => {
  const rooms = require("./rooms");
  assert.equal(rooms.looksLikeRoomId("!a:b.net"), true);
  for (const no of ["#alias:b.net", "@user:b.net", "!noserver", "", null, undefined, 7, {}]) {
    assert.equal(rooms.looksLikeRoomId(no), false, `${JSON.stringify(no)} is not a room id`);
  }
});

void guardFor;
