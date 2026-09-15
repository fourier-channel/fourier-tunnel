// The avatar capability, tested without a homeserver -- every dependency is
// injected for exactly that reason.
//
// What these pin is mostly what it must REFUSE. The flow arms a state that
// swallows the next image from an admin, so the guards around who, where and
// how long are the whole feature; the happy path is three calls.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleAvatarFlow, PROMPT, DONE } = require("./avatar");

const ADMIN = "@saber:41chan.net";
const ROOM = "!r:41chan.net";

function rig(over = {}) {
  const sent = [];
  const audited = [];
  const set = [];
  return {
    sent, audited, set,
    deps: {
      setAvatarUrl: async (mxc) => { set.push(mxc); },
      sendText: async (room, text) => { sent.push([room, text]); },
      joinedMemberCount: async () => 2,
      admins: [ADMIN],
      pending: new Map(),
      audit: (r) => audited.push(r),
      now: () => 1_000_000,
      ...over,
    },
  };
}

const text = (body, sender = ADMIN) => ({
  type: "m.room.message", sender, room_id: ROOM, content: { msgtype: "m.text", body },
});
const image = (url, sender = ADMIN) => ({
  type: "m.room.message", sender, room_id: ROOM, content: { msgtype: "m.image", url },
});

test("the command arms the request and says so", async () => {
  const r = rig();
  assert.equal(await handleAvatarFlow(text("!setavatar"), r.deps), true);
  assert.deepEqual(r.sent, [[ROOM, PROMPT]]);
  assert.equal(r.deps.pending.get(ADMIN), 1_000_000 + 120_000);
  assert.equal(r.audited[0].kind, "avatar_armed");
});

test("the following image becomes the avatar, and is recorded", async () => {
  const r = rig();
  await handleAvatarFlow(text("!setavatar"), r.deps);
  assert.equal(await handleAvatarFlow(image("mxc://x/1"), r.deps), true);
  assert.deepEqual(r.set, ["mxc://x/1"]);
  assert.deepEqual(r.sent[1], [ROOM, DONE]);
  // The record is the point: these two copies had drifted so that only one of
  // them left evidence that a bot's face had changed.
  assert.equal(r.audited.at(-1).kind, "avatar_set");
  assert.equal(r.audited.at(-1).mxc, "mxc://x/1");
  assert.equal(r.deps.pending.size, 0, "the request is spent");
});

test("a non-admin gets nothing, not even a refusal", async () => {
  const r = rig();
  assert.equal(await handleAvatarFlow(text("!setavatar", "@someone:x"), r.deps), false);
  assert.deepEqual(r.sent, []);
});

test("it refuses outside a DM, because it would swallow someone else's picture", async () => {
  const r = rig({ joinedMemberCount: async () => 7 });
  assert.equal(await handleAvatarFlow(text("!setavatar"), r.deps), false);
  assert.equal(r.deps.pending.size, 0);
});

test("an image with no armed request is an ordinary image", async () => {
  const r = rig();
  assert.equal(await handleAvatarFlow(image("mxc://x/1"), r.deps), false);
  assert.deepEqual(r.set, []);
});

test("an expired request releases the image rather than eating it", async () => {
  let t = 1_000_000;
  const r = rig({ now: () => t });
  await handleAvatarFlow(text("!setavatar"), r.deps);
  t += 120_001;
  // NOT consumed: past the window it is a picture again, and a picture the
  // bridge is meant to tag. Returning true here would silently drop it.
  assert.equal(await handleAvatarFlow(image("mxc://x/1"), r.deps), false);
  assert.deepEqual(r.set, []);
  assert.equal(r.deps.pending.size, 0, "and the dead request is cleared");
  assert.equal(r.audited.at(-1).kind, "avatar_expired");
});

test("a failure is said in the room AND recorded", async () => {
  const r = rig({ setAvatarUrl: async () => { throw new Error("boom"); } });
  await handleAvatarFlow(text("!setavatar"), r.deps);
  assert.equal(await handleAvatarFlow(image("mxc://x/1"), r.deps), true);
  assert.match(r.sent.at(-1)[1], /Failed to set avatar: boom/);
  assert.equal(r.audited.at(-1).kind, "avatar_failed");
});

test("two bots cannot share one half-finished request", async () => {
  // The pending store is the caller's, so arming with one bot's does not arm
  // the other's. In the hub this is what keeps one bot's prompt from being
  // answered by a picture meant for another.
  const a = rig();
  const b = rig();
  await handleAvatarFlow(text("!setavatar"), a.deps);
  assert.equal(await handleAvatarFlow(image("mxc://x/1"), b.deps), false);
  assert.deepEqual(b.set, []);
});

test("it refuses to run without an audit sink", async () => {
  const r = rig();
  await assert.rejects(
    () => handleAvatarFlow(text("!setavatar"), { ...r.deps, audit: undefined }),
    (e) => e instanceof TypeError && /audit/.test(e.message),
  );
});

test("it refuses a caller that did not bring its own pending store", async () => {
  const r = rig();
  await assert.rejects(
    () => handleAvatarFlow(text("!setavatar"), { ...r.deps, pending: undefined }),
    (e) => e instanceof TypeError && /pending/.test(e.message),
  );
});
