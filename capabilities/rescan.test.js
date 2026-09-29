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
const TAGS = { tags: ["hilda_(pokemon)", "smile"], meta: ["masterpiece"], characters: ["oc_kayla"] };

function rig(over = {}) {
  const sent = [], audited = [], written = [], generation = [], lookups = [], rawLookups = [];
  const deps = {
    download: async (mxc) => ({ buffer: BYTES, contentType: "image/jpeg" }),
    findPostByMd5: async (md5) => { lookups.push(md5); return md5 === MD5 ? { id: 7, md5: MD5, source: MXC, tag_string: "1girl hilda_(pokemon)" } : null; },
    findByRawMd5: async (md5) => { rawLookups.push(md5); return null; },
    getTagProjection: async () => ({ tags: ["1girl", "hilda_(pokemon)", "highres"], sources: { creator: [], auto: ["1girl"], both: ["hilda_(pokemon)"], meta: ["highres"] } }),
    recordTagSources: async (id, partition) => { written.push([id, partition]); return { post_id: id, recorded: 4 }; },
    recordGenerationMetadata: async (md5, body) => { generation.push([md5, body]); return { md5, stored: Object.keys(body.fields).length }; },
    // Creator tags come from what the strip took; reading the bytes is only
    // for a strip that refused.
    creatorTags: () => TAGS,
    extract: () => { throw new Error("extract() is for a refused strip only"); },
    strip: (buffer) => ({ buffer, removed: {}, changed: false }),
    sendText: async (room, text) => { sent.push([room, text]); },
    admins: [ADMIN],
    isDm: async () => true,
    audit: (r) => { audited.push(r); },
    ...over,
  };
  return { deps, sent, audited, written, generation, lookups, rawLookups };
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
  assert.deepEqual(p.oc, ["oc_kayla"]);
  assert.match(out.report, /Post #7 \(jpeg\): read 2 creator tag/);
  assert.match(out.report, /Original characters: oc_kayla/);
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
  const r = rig({ creatorTags: () => ({ tags: [], meta: [] }) });
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

// --- generation data (operator rulings 2026-09-28 and 2026-09-29) ------------------
// The booru holds the STRIPPED bytes. A rescan by mxc strips the raw bytes the
// way the live path does, finds the post by the stripped md5, the booru's
// record of the raw md5, then the raw md5, takes creator tags from what the
// strip removed, and re-sends the private record as an ADMIN'S RE-READ:
// poster null, never a creator read off the post's member-editable tags.

const RAW = Buffer.from("raw bytes with a prompt in them");
const STRIPPED = Buffer.from("raw bytes");
const OLDER = Buffer.from("raw bytes, as an older strip left them");
const md5 = (b) => require("crypto").createHash("md5").update(b).digest("hex");
const REMOVED = { "png:parameters": "1girl, smile\nSteps: 20, Sampler: Euler a" };
const stripFake = (buffer) => (buffer.equals(RAW) ? { buffer: STRIPPED, removed: REMOVED, changed: true } : { buffer, removed: {}, changed: false });

test("by mxc, a stripped post: found by the STRIPPED md5, creator tags from what the strip TOOK, record as an admin re-read", async () => {
  const fromRemoved = [];
  const r = rig({
    download: async () => ({ buffer: RAW, contentType: "image/png" }),
    strip: stripFake,
    // The tags name alice. They are editable by anyone and decide nothing.
    findPostByMd5: async (m) => { r.lookups.push(m); return m === md5(STRIPPED) ? { id: 11, md5: md5(STRIPPED), source: MXC, tag_string: "1girl 41chan_alice" } : null; },
    creatorTags: (removed) => { fromRemoved.push(removed); return { tags: ["smile"], meta: [], characters: [] }; },
  });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(r.lookups, [md5(STRIPPED)], "the stripped md5 answered first; nothing else was needed");
  assert.deepEqual(fromRemoved, [REMOVED], "the prompt is read from what the strip removed");
  assert.deepEqual(r.generation, [[md5(STRIPPED), { rawMd5: md5(RAW), source: "matrix", poster: null, fields: REMOVED }]]);
  assert.equal(out.generation, "recorded");
  assert.match(out.report, /1 field\(s\) recorded privately, readable by the post's recorded creator and whoever they allow/);
});

test("by mxc, a post made under older strip rules: found through the booru's record of the RAW md5", async () => {
  const r = rig({
    download: async () => ({ buffer: RAW, contentType: "image/png" }),
    strip: stripFake,
    findByRawMd5: async (m) => { r.rawLookups.push(m); return m === md5(RAW) ? md5(OLDER) : null; },
    findPostByMd5: async (m) => { r.lookups.push(m); return m === md5(OLDER) ? { id: 16, md5: md5(OLDER), source: MXC } : null; },
  });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.equal(out.postId, 16);
  assert.deepEqual(r.rawLookups, [md5(RAW)]);
  assert.deepEqual(r.lookups, [md5(STRIPPED), md5(OLDER)]);
  assert.equal(r.generation[0][0], md5(OLDER), "keyed by the md5 of the bytes the booru holds");
});

test("by mxc, a post made before the strip: found by the RAW md5, and the record is keyed by that md5", async () => {
  const r = rig({
    download: async () => ({ buffer: RAW, contentType: "image/png" }),
    strip: stripFake,
    findPostByMd5: async (m) => { r.lookups.push(m); return m === md5(RAW) ? { id: 12, md5: md5(RAW), source: MXC, tag_string_artist: "41chan_bob", tag_string: "41chan_bob" } : null; },
  });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(r.lookups, [md5(STRIPPED), md5(RAW)], "stripped first, raw second");
  assert.equal(out.postId, 12);
  assert.equal(r.generation[0][0], md5(RAW));
  assert.equal(r.generation[0][1].poster, null, "a 41chan_bob tag does not make bob the poster");
});

test("a rescan never names a poster, whatever tags the post carries -- one, two, or none", async () => {
  for (const tags of ["41chan_alice", "41chan_alice 41chan_mallory", "1girl"]) {
    const r = rig({
      download: async () => ({ buffer: RAW, contentType: "image/png" }),
      strip: stripFake,
      findPostByMd5: async (m) => (m === md5(STRIPPED) ? { id: 13, md5: md5(STRIPPED), source: MXC, tag_string: tags, tag_string_artist: tags } : null),
    });
    await rescan(md5(STRIPPED), r.deps);
    assert.equal(r.generation[0][1].poster, null, tags);
  }
});

test("by md5 of the Matrix original: found through the booru's raw record, and the record re-sent from the post's own mxc", async () => {
  const seen = [];
  const r = rig({
    download: async (mxc) => { seen.push(mxc); return { buffer: RAW, contentType: "image/png" }; },
    strip: stripFake,
    findByRawMd5: async (m) => (m === md5(RAW) ? md5(STRIPPED) : null),
    findPostByMd5: async (m) => (m === md5(STRIPPED) ? { id: 17, md5: md5(STRIPPED), source: MXC } : null),
  });
  const out = await rescan(md5(RAW), r.deps);
  assert.equal(out.ok, true);
  assert.equal(out.postId, 17);
  assert.deepEqual(seen, [MXC]);
  assert.equal(r.generation[0][0], md5(STRIPPED));
});

test("by an md5 nothing knows: the refusal says to rescan by mxc", async () => {
  const r = rig({ findPostByMd5: async () => null });
  const out = await rescan(md5(RAW), r.deps);
  assert.equal(out.ok, false);
  assert.match(out.report, /Rescan by the image's mxc url instead/);
});

test("a strip that refuses: creator tags are still rewritten from the bytes, nothing is recorded, and the report says why", async () => {
  const r = rig({
    download: async () => ({ buffer: RAW, contentType: "image/png" }),
    strip: () => { throw new Error("generation data survived the strip: something"); },
    findPostByMd5: async (m) => { r.lookups.push(m); return m === md5(RAW) ? { id: 14, md5: md5(RAW), source: MXC, tag_string: "41chan_alice" } : null; },
    extract: (buffer) => { assert.equal(buffer, RAW); return { tags: ["smile"], meta: [], characters: [] }; },
    creatorTags: () => { throw new Error("there is nothing the strip took"); },
  });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.deepEqual(r.lookups, [md5(RAW)]);
  assert.equal(r.written.length, 1, "creator provenance still written");
  assert.deepEqual(r.written[0][1].creator, ["smile"]);
  assert.equal(r.generation.length, 0);
  assert.equal(out.generation, "strip-refused");
  assert.match(out.report, /Generation metadata NOT re-recorded: generation data survived the strip/);
});

test("the booru refusing the record is a sentence and an audit line, never a throw, and never the field text", async () => {
  const r = rig({
    download: async () => ({ buffer: RAW, contentType: "image/png" }),
    strip: stripFake,
    findPostByMd5: async (m) => (m === md5(STRIPPED) ? { id: 15, md5: md5(STRIPPED), source: MXC, tag_string: "41chan_alice" } : null),
    recordGenerationMetadata: async () => { throw new Error("generation_metadata -> 422: fields must be an object -- fix: send an object"); },
  });
  const out = await rescan(MXC, r.deps);
  assert.equal(out.ok, true);
  assert.equal(out.generation, "failed");
  assert.match(out.report, /NOT re-recorded -- the booru refused it: generation_metadata -> 422/);
  assert.equal(r.audited.find((a) => a.kind === "rescan_generation_failed").post_id, 15);
  assert.doesNotMatch(JSON.stringify(r.audited), /Steps: 20/);
});

test("the booru's 409s are told apart on a re-read too: a raw md5 filed elsewhere, or a record from another original, is NOT recorded", async () => {
  const { BooruRefusal } = require("../danbooru");
  for (const [reason, state, words] of [
    ["raw_md5_conflict", "raw-md5-conflict", /NOT re-recorded -- the booru refused it: its original \(raw md5 [0-9a-f]{32}\) is already filed under a DIFFERENT md5.*Fix: GET \/fourier\/generation_metadata\/raw\//],
    ["raw_md5_mismatch", "raw-md5-mismatch", /NOT re-recorded -- the booru refused it: the booru's record for this md5 was filed from a DIFFERENT original/],
    [undefined, "failed", /NOT re-recorded -- the booru refused it: .*a 409 with no reason the tunnel knows/],
  ]) {
    const r = rig({
      download: async () => ({ buffer: RAW, contentType: "image/png" }),
      strip: stripFake,
      findPostByMd5: async (m) => (m === md5(STRIPPED) ? { id: 15, md5: md5(STRIPPED), source: MXC, tag_string: "" } : null),
      recordGenerationMetadata: async () => { throw new BooruRefusal("generation_metadata -> 409: e", 409, { error: "e", fix: "f", reason }); },
    });
    const out = await rescan(MXC, r.deps);
    assert.equal(out.generation, state, String(reason));
    assert.match(out.report, words, String(reason));
    assert.equal(r.audited.find((a) => a.kind === "rescan_generation_failed").state, state);
  }
});

test("rescan will not run without its wiring: a missing dependency is a bug, said at once", async () => {
  await assert.rejects(rescan(MXC, rig({ strip: undefined }).deps), /requires strip/);
  await assert.rejects(rescan(MXC, rig({ recordGenerationMetadata: undefined }).deps), /requires recordGenerationMetadata/);
  await assert.rejects(rescan(MXC, rig({ findByRawMd5: undefined }).deps), /requires findByRawMd5/);
  await assert.rejects(rescan(MXC, rig({ creatorTags: undefined }).deps), /requires creatorTags/);
});
