"use strict";

// The invite decision, which had no tests until a branch was added to it.
//
// What matters here is ORDER: a room the bot was removed from must be refused
// BEFORE the power-level dance, because that dance joins the room to read the
// power levels when the invite carries no stripped state. A denial checked
// after it would be a denial that joins the room first.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOM = "!room:41chan.net";
const ADMIN = "@saber:41chan.net";
const config = { bridge: { invite_power_level: 50 } };

function freshInvites(stateDir) {
  process.env.ONBOARDING_STATE_DIR = stateDir;
  delete require.cache[require.resolve("./invites")];
  return require("./invites");
}

function deps(over = {}) {
  const calls = [];
  return {
    calls,
    join: async (r) => { calls.push(["join", r]); },
    leave: async (r) => { calls.push(["leave", r]); },
    readPowerLevels: async (r) => { calls.push(["readPowerLevels", r]); return { users: { [ADMIN]: 100 } }; },
    sendDM: async (u, t) => { calls.push(["sendDM", u, t]); },
    ...over,
  };
}

const invite = (sender, stripped) => ({
  type: "m.room.member", room_id: ROOM, sender, state_key: "@tunnel:41chan.net",
  content: { membership: "invite" },
  ...(stripped ? { invite_room_state: stripped } : {}),
});

const powerState = (level) => [
  { type: "m.room.power_levels", state_key: "", content: { users: { [ADMIN]: level } } },
];

// AWAITED, not just returned: the first version let the finally run while the
// test body was still going, so the temp directory vanished under the audit
// log and every test failed with ENOENT instead of its own verdict.
async function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invites-"));
  try {
    return await fn(freshInvites(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.ONBOARDING_STATE_DIR;
    delete require.cache[require.resolve("./invites")];
  }
}

test("an invite from somebody with enough power is accepted", async () => {
  await withTemp(async (invites) => {
    const d = deps();
    assert.equal(await invites.handleInvite(invite(ADMIN, powerState(100)), d, config), "accepted");
    assert.deepEqual(d.calls, [["join", ROOM]]);
  });
});

test("an invite to a DENIED room is refused, and the bot leaves rather than lingering", async () => {
  await withTemp(async (invites) => {
    const d = deps({ isRoomDenied: (r) => r === ROOM });
    const verdict = await invites.handleInvite(invite(ADMIN, powerState(100)), d, config);
    assert.equal(verdict, "ignored_denied_room");
    // Left, never joined: an unanswered invite is a room it might still be
    // dragged into later.
    assert.deepEqual(d.calls, [["leave", ROOM]]);
  });
});

test("the denial beats power, because the usual way back in IS an invite", async () => {
  await withTemp(async (invites) => {
    // No stripped state, so the un-denied path would JOIN to read the power
    // levels. The denied one must not reach that.
    const d = deps({ isRoomDenied: () => true });
    assert.equal(await invites.handleInvite(invite(ADMIN), d, config), "ignored_denied_room");
    assert.ok(!d.calls.some(([m]) => m === "join"), "a denied room is never joined to inspect it");
    assert.ok(!d.calls.some(([m]) => m === "readPowerLevels"));
  });
});

test("a refused leave is recorded and does not throw the invite handler", async () => {
  await withTemp(async (invites) => {
    const d = deps({
      isRoomDenied: () => true,
      leave: async () => { throw new Error("already left"); },
    });
    assert.equal(await invites.handleInvite(invite(ADMIN, powerState(100)), d, config),
                 "ignored_denied_room");
  });
});

test("without the denial predicate at all, nothing changes", async () => {
  // deps is built by index.js; an older or partial one must not crash the
  // handler or silently treat every room as denied.
  await withTemp(async (invites) => {
    const d = deps();
    delete d.isRoomDenied;
    assert.equal(await invites.handleInvite(invite(ADMIN, powerState(100)), d, config), "accepted");
  });
});

test("an invite from somebody without the power is refused and earns a strike", async () => {
  await withTemp(async (invites) => {
    const d = deps();
    const verdict = await invites.handleInvite(invite("@nobody:41chan.net", powerState(0)), d, config);
    assert.equal(verdict, "rejected");
    assert.ok(d.calls.some(([m]) => m === "sendDM"), "the person is told why");
  });
});
