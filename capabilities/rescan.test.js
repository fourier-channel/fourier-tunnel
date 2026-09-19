// The rescan capability, without a homeserver or a booru: what it refuses,
// how it rebuilds the partition against the autotagger's rows, and that it
// asks the booru to replace the previous read.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rescan, handleRescanCommand, USAGE } = require("./rescan");

const ADMIN = "@saber:41chan.net";
const ROOM = "!dm:41chan.net";
const MXC = "mxc://41chan.net/abc123";
const BYTES = Buffer.from("not really a jpeg");
const MD5 = require("crypto").createHash("md5").update(BYTES).digest("hex");

function rig(over = {}) {
  const sent = [], audited = [], written = [];
  const deps = {
    download: async (mxc) => ({ buffer: BYTES, contentType: "image/jpeg" }),
    findPostByMd5: async (md5) => (md5 === MD5 ? { id: 7, source: MXC, tag_string: "1girl hilda_(pokemon)" } : null),
    getTagProjection: async () => ({ tags: ["1girl", "hilda_(pokemon)", "highres"], sources: { creator: [], auto: ["1girl"], both: ["hilda_(pokemon)"], meta: ["highres"] } }),
    recordTagSources: async (id, partition) => { written.push([id, partition]); return { post_id: id, recorded: 4 }; },
    extract: () => ({ tags: ["hilda_(pokemon)", "smile"], meta: ["masterpiece"] }),
    sendText: async (room, text) => { sent.push([room, text]); },
    admins: [ADMIN],
    isDm: async () => true,
    audit: (r) => { audited.push(r); },
    ...over,
  };
  return { deps, sent, audited, written };
}

test("by mxc: downloads, finds the post by md5, rebuilds the split against the autotagger's rows, replaces", async () => {
  const r = rig();
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.equal(out.postId, 7);
  const [id, p] = r.written[0];
  assert.equal(id, 7);
  assert.deepEqual(p.both, ["hilda_(pokemon)"]);
  assert.deepEqual(p.creator, ["smile"]);
  assert.deepEqual(p.auto, ["1girl"]);
  assert.deepEqual(p.meta, ["highres", "masterpiece"]);
  assert.equal(p.replace_creator, true);
  assert.match(out.report, /Post #7 \(jpeg\): read 2 creator tag/);
});

test("by md5: fetches the bytes from the post's own mxc source", async () => {
  const seen = [];
  const r = rig({ download: async (mxc) => { seen.push(mxc); return { buffer: BYTES, contentType: "image/png" }; } });
  const out = await rescan(MD5, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [MXC]);
});

test("an image the booru does not have is refused with the reason, and nothing is written", async () => {
  const r = rig({ findPostByMd5: async () => null });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, false);
  assert.match(out.report, /not on the booru/);
  assert.equal(r.written.length, 0);
});

test("a post not posted through the tunnel (no mxc source) is refused by md5", async () => {
  const r = rig({ findPostByMd5: async () => ({ id: 9, source: "https://twitter.com/x" }) });
  const out = await rescan(MD5, r.deps);
  assert.equal(out.ok, false);
  assert.match(out.report, /not an mxc url/);
});

test("no prompt in the bytes still writes, so the old read is cleared, and says so", async () => {
  const r = rig({ extract: () => ({ tags: [], meta: [] }) });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.match(out.report, /no prompt in these bytes/);
  assert.deepEqual(r.written[0][1].creator, []);
  assert.deepEqual(r.written[0][1].both, []);
  assert.deepEqual(r.written[0][1].auto, ["1girl", "hilda_(pokemon)"], "the autotagger's both row survives as auto");
});

test("a fetch failure is a sentence, not a throw", async () => {
  const r = rig({ download: async () => { throw new Error("403 Federation denied"); } });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, false);
  assert.match(out.report, /Could not fetch the bytes: 403/);
  assert.equal(r.audited[0].kind, "rescan_fetch_failed");
});

test("the command: non-admin and non-DM are refused silently and audited; usage on no target", async () => {
  const r = rig();
  assert.equal(await handleRescanCommand({ sender: "@x:41chan.net", room_id: ROOM, content: { body: "!rescan " + MXC } }, r.deps), true);
  assert.equal(r.sent.length, 0);
  assert.equal(r.audited[0].kind, "rescan_denied_not_admin");
  const r2 = rig({ isDm: async () => false });
  assert.equal(await handleRescanCommand({ sender: ADMIN, room_id: ROOM, content: { body: "!rescan " + MXC } }, r2.deps), true);
  assert.equal(r2.sent.length, 0);
  assert.equal(r2.audited[0].kind, "rescan_denied_not_dm");
  const r3 = rig();
  await handleRescanCommand({ sender: ADMIN, room_id: ROOM, content: { body: "!rescan" } }, r3.deps);
  assert.deepEqual(r3.sent[0], [ROOM, USAGE]);
});

test("the command: an admin in a DM gets the report, and other messages are not consumed", async () => {
  const r = rig();
  assert.equal(await handleRescanCommand({ sender: ADMIN, room_id: ROOM, content: { body: "hello" } }, r.deps), false);
  assert.equal(await handleRescanCommand({ sender: ADMIN, room_id: ROOM, content: { body: "!rescan " + MXC } }, r.deps), true);
  assert.match(r.sent[0][1], /Post #7/);
});
