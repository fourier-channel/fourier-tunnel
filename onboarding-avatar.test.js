"use strict";
// Regression: an admin's "!setavatar" in a DM with @tunnel pulled @fourier INTO
// that DM (bug-20260925-7434f348, 2026-09-24, room !ugBiZyGTZeRLIXZXIq).
//
// Her avatar flow asked "is this a two-member room?" through the library
// Intent. Intent.roomState() calls _ensureJoined() first, and when her join is
// refused the library has the BRIDGE BOT -- the courier -- invite her and try
// again. So asking about somebody else's DM put her in it, the room had three
// members, and both her flow and the courier's own "!setavatar" refused. The
// question must be asked through a read that can never join.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.ONBOARDING_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-avatar-"));
const { Onboarding } = require("./onboarding");

const HER = "@fourier:example.org";
const ADMIN = "@admin:example.org";
const HER_DM = "!herdm:example.org";
const TUNNEL_DM = "!tunneldm:example.org";

function rig() {
  const calls = { roomState: [], sent: [], joinedMembers: [] };
  const intent = {
    // What the library does: joining (and, refused, having the courier invite
    // her) happens before the read. Any call here IS the bug.
    roomState: async (room) => { calls.roomState.push(room); return []; },
    sendText: async (room, text) => { calls.sent.push({ room, text }); },
    setAvatarUrl: async () => {},
    matrixClient: {
      getJoinedRoomMembers: async (room) => {
        calls.joinedMembers.push(room);
        if (room === HER_DM) return [HER, ADMIN];
        const e = new Error("You are not in this room.");
        e.errcode = "M_FORBIDDEN";
        throw e;
      },
    },
  };
  const bridge = { getIntent: () => intent };
  const config = {
    homeserver: { domain: "example.org" },
    bridge: { strike_reset_admins: [ADMIN], onboarding: { enabled: true, engine: "off" } },
  };
  const o = new Onboarding(bridge, config, "as-token", () => {});
  return { o, calls };
}

const cmd = (room) => ({ type: "m.room.message", room_id: room, sender: ADMIN,
                         content: { msgtype: "m.text", body: "!setavatar" } });

test("an admin's !setavatar in a room she is not in never touches it", async () => {
  const { o, calls } = rig();
  assert.equal(await o.handleAvatarFlow(cmd(TUNNEL_DM)), false, "the courier's own flow must get the event");
  assert.deepEqual(calls.roomState, [], "she asked through a call that joins, and so would be pulled in");
  assert.deepEqual(calls.sent, []);
});

test("in her own DM, !setavatar still arms and prompts", async () => {
  const { o, calls } = rig();
  assert.equal(await o.handleAvatarFlow(cmd(HER_DM)), true);
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0].room, HER_DM);
  assert.deepEqual(calls.roomState, []);
});
