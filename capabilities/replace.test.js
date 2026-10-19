"use strict";

// A creator's picture edit: who may replace, what the booru is asked, what the
// room is told -- and that no edit is ever posted as a picture of its own.

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleReplace, isEdit, pictureEdit, localMediaId } = require("./replace");
const { imagesIn: backfillImages } = require("../backfill");
const { imagesIn: catchupImages } = require("../catchup");

const D = "41chan.net";
const ROOM = "!r:41chan.net";
const ORIG = { event_id: "$orig", sender: "@ann:41chan.net", content: { msgtype: "m.image", body: "a.png", url: "mxc://41chan.net/OLD" } };

let n = 0;
function edit(over = {}, nc = {}) {
  return {
    event_id: `$edit${++n}`,
    room_id: ROOM,
    sender: "@ann:41chan.net",
    type: "m.room.message",
    content: {
      msgtype: "m.image",
      body: "* b.png",
      url: "mxc://41chan.net/NEW",
      "m.new_content": { msgtype: "m.image", body: "b.png", filename: "b.png", url: "mxc://41chan.net/NEW", ...nc },
      "m.relates_to": { rel_type: "m.replace", event_id: "$orig" },
      ...over,
    },
  };
}

function harness({ original = ORIG, enabled = true, post = { id: 9, md5: "oldmd5" }, booru, canonNew, pointed = "posted", recordThrows, forget = async () => true, mapped } = {}) {
  const said = [], audits = [], replaced = [], recorded = [], logs = [], repoints = [], versions = [], forgot = [], sent = [];
  const deps = {
    settings: { enabled },
    domain: D,
    botUserId: "@tunnel:41chan.net",
    readEvent: async () => original,
    canonicalize: async (id, opts) => {
      if (id === "OLD") return { kind: "canonical", md5: "oldmd5", raw_md5: "oldraw" };
      return canonNew || { kind: "canonical", md5: "newmd5", raw_md5: "newraw", media_type: "image/png", uploader: "@ann:41chan.net", removed: { parameters: "1girl" }, booru: { status: "completed", upload_media_asset_id: 55 }, opts };
    },
    uploadMediaAssetFor: async (c) => c.booru.upload_media_asset_id,
    findPost: async ({ strippedMd5 }) => (strippedMd5 === "oldmd5" && post ? { post } : null),
    replacePost: async (id, body) => {
      replaced.push({ id, body });
      return booru || { status: 201, data: { id: 1, post_id: id, md5: "newmd5", old_md5: "oldmd5", image_width: 2048, image_height: 2048, old_image_width: 512, old_image_height: 512 } };
    },
    getPost: async (id) => ({ id, md5: "newmd5" }),
    pointRoom: async () => pointed,
    getTagProjection: async () => ({ sources: { auto: ["solo"], both: [], meta: [] } }),
    recordTagSources: async (id, partition) => {
      if (recordThrows) throw new Error("hub down");
      recorded.push({ id, partition });
    },
    creatorTags: () => ({ tags: ["1girl"], meta: [], characters: [] }),
    mappedMxcs: async () => mapped || [
      { room: ROOM, mxc: "mxc://41chan.net/OLD", content: { post_id: 9, tags: ["a"] } },
      { room: "!other:41chan.net", mxc: "mxc://41chan.net/REPOST", content: { post_id: 9, tags: ["a"] } },
    ],
    repoint: async (a) => {
      repoints.push(a);
      return { media_ids: a.mediaIds.filter((id) => id !== "BROKEN"), failed: a.mediaIds.includes("BROKEN") ? [{ id: "BROKEN" }] : [] };
    },
    forget: forget && (async (ids) => { forgot.push(ids); return forget(ids); }),
    writeFileVersion: async (room, mxc, content, md5) => versions.push({ room, mxc, md5 }),
    sendMessage: async (room, c) => { sent.push(c); said.push(c.body); },
    audit: (r) => audits.push(r),
    log: (l) => logs.push(l),
    seen: new Set(),
  };
  return { deps, said, audits, replaced, recorded, logs, repoints, versions, forgot, sent };
}

test("pure: an edit is an edit; a picture edit names its original, new content and old-file choice (keep by default)", () => {
  assert.equal(isEdit({ "m.relates_to": { rel_type: "m.replace", event_id: "$x" } }), true);
  assert.equal(isEdit({ "m.relates_to": { "m.in_reply_to": { event_id: "$x" } } }), false);
  assert.equal(pictureEdit(edit().content).oldFile, "keep");
  assert.equal(pictureEdit(edit({ "net.41chan.replace": { old_file: "expire" } }).content).oldFile, "expire");
  assert.equal(pictureEdit(edit({ "net.41chan.replace": { old_file: "delete-now" } }).content).oldFile, "keep");
  assert.equal(pictureEdit({ "m.relates_to": { rel_type: "m.replace", event_id: "$x" }, "m.new_content": { msgtype: "m.text", body: "x" } }), null);
  assert.equal(localMediaId("mxc://41chan.net/AbC", D), "AbC");
  assert.equal(localMediaId("mxc://elsewhere.org/AbC", D), null);
});

test("the creator's picture edit replaces the post's file with the new upload's media asset, on their behalf", async () => {
  const h = harness();
  assert.equal(await handleReplace(edit(), h.deps), true);
  assert.equal(h.replaced.length, 1);
  assert.deepEqual(h.replaced[0], { id: 9, body: { uploadMediaAssetId: 55, finalSource: "mxc://41chan.net/NEW", onBehalfOf: "@ann:41chan.net", oldFile: "keep", expectedMd5: "oldmd5" } });
  assert.equal(h.recorded[0].partition.replace_creator, true);
  assert.deepEqual(h.recorded[0].partition.creator, ["1girl"]);
  assert.match(h.said[0], /post #9 now has the new version \(512x512 -> 2048x2048\)\. All \d+ copies of it now show the new version\. The old version is kept on record\./);
  assert.equal(h.audits.at(-1).kind, "replace_done");
});

test("expire is passed through and said", async () => {
  const h = harness();
  await handleReplace(edit({ "net.41chan.replace": { old_file: "expire" } }), h.deps);
  assert.equal(h.replaced[0].body.oldFile, "expire");
  assert.match(h.said[0], /will expire and be collected for deletion/);
});

test("an edit by anyone but the original's sender changes nothing and says nothing", async () => {
  const h = harness({ original: { ...ORIG, sender: "@bob:41chan.net" } });
  assert.equal(await handleReplace(edit(), h.deps), true);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.said.length, 0);
  assert.equal(h.audits[0].kind, "replace_not_sender");
});

test("every edit is consumed, and only a picture-to-new-picture edit does anything", async () => {
  const h = harness();
  // A text edit.
  assert.equal(await handleReplace({ event_id: "$t", room_id: ROOM, sender: "@ann:41chan.net", content: { body: "* hi", "m.new_content": { msgtype: "m.text", body: "hi" }, "m.relates_to": { rel_type: "m.replace", event_id: "$orig" } } }, h.deps), true);
  // A caption-only edit of the picture: same url.
  assert.equal(await handleReplace(edit({}, { url: "mxc://41chan.net/OLD" }), h.deps), true);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.said.length, 0);
  // Not an edit at all: not consumed.
  assert.equal(await handleReplace({ event_id: "$p", room_id: ROOM, sender: "@ann:41chan.net", content: ORIG.content }, h.deps), false);
});

test("a redelivered edit replaces once", async () => {
  const h = harness();
  const e = edit();
  await handleReplace(e, h.deps);
  await handleReplace(e, h.deps);
  assert.equal(h.replaced.length, 1);
});

test("switched off: the booru is not asked, and the room is told the booru keeps the old version", async () => {
  const h = harness({ enabled: false });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
  assert.match(h.said[0], /not switched on yet, so the booru still has the old version/);
});

test("a picture not on the booru: just an edit -- nothing replaced, nothing posted, nothing said", async () => {
  const h = harness({ post: null });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.said.length, 0);
});

test("the stripper refusing the new picture: not used, and said", async () => {
  const h = harness({ canonNew: { kind: "refused", reason: "unknown carrier" } });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
  assert.match(h.said[0], /could not safely remove the generation data/);
  assert.doesNotMatch(h.said[0], /unknown carrier/);
});

test("the same file as the post already has: nothing to do", async () => {
  const h = harness({ canonNew: { kind: "canonical", md5: "oldmd5", raw_md5: "x", booru: { status: "completed", upload_media_asset_id: 1 } } });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
});

test("the booru's refusals: its MESSAGE relayed (never its fix), 422 reasons, a 404 silent -- and never an address", async () => {
  for (const [booru, want] of [
    [{ status: 403, data: { success: false, error: "Forbidden", message: "Only the post's creator can replace it.", fix: "ops: check FourierPostCreator", reason: "not_creator" } }, /did not take the new version of post #9: Only the post's creator can replace it\./],
    [{ status: 422, data: { success: false, message: "The post changed while you were replacing it. Try again.", reason: "stale" } }, /The post changed while you were replacing it/],
    [{ status: 422, data: { errors: [{ reason: "these bytes are already post #12" }] } }, /refused the new version of post #9[\s\S]*already post #12/],
    [{ status: 500, data: {} }, /did not expect/],
    [{ status: 403, data: { message: "see http://10.0.0.1:3000" } }, /\[address removed\]/],
  ]) {
    const h = harness({ booru });
    await handleReplace(edit(), h.deps);
    assert.match(h.said[0], want);
    assert.doesNotMatch(h.said[0], /FourierPostCreator|ops:/);
    assert.doesNotMatch(h.said[0], /https?:\/\/|\d+\.\d+\.\d+\.\d+|[a-z0-9-]+:\d{2,5}\b/i);
    assert.equal(h.recorded.length, 0);
  }
  const silent = harness({ booru: { status: 404, data: { message: "not found" } } });
  await handleReplace(edit(), silent.deps);
  assert.equal(silent.said.length, 0, "a 404 is missing, deleted, jailed or quarantined: nothing is said");
});

test("SPOOFING: a new picture someone else uploaded is refused, and canon is never told the editor is its poster", async () => {
  const seen = [];
  const h = harness({ canonNew: { kind: "canonical", md5: "theirs", raw_md5: "r", uploader: "@bob:41chan.net", booru: { status: "completed", upload_media_asset_id: 7 } } });
  const canon = h.deps.canonicalize;
  h.deps.canonicalize = async (id, opts) => { seen.push(opts); return canon(id, opts); };
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.repoints.length, 0);
  assert.match(h.said[0], /only be replaced with one you uploaded yourself/);
  assert.ok(seen.every((o) => !o || o.poster === undefined), "no poster is ever passed to canon");
});

test("a deleted post is no post: nothing replaced, nothing said", async () => {
  const h = harness({ post: { id: 9, md5: "oldmd5", is_deleted: true } });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.said.length, 0);
});

test("after the swap, a failed follow-up is named in the reply and the replacement still stands", async () => {
  const h = harness({ pointed: "tags-blocked", recordThrows: true });
  await handleReplace(edit(), h.deps);
  assert.equal(h.replaced.length, 1);
  assert.match(h.said[0], /now has the new version[\s\S]*Not yet updated: its tags on the new picture in this room and the creator tags/);
});

test("backfill and catch-up never replay an edit as a picture", () => {
  const chunk = [edit(), { type: "m.room.message", content: ORIG.content }];
  assert.equal(backfillImages(chunk).length, 1);
  assert.equal(catchupImages(chunk).length, 1);
});

test("reposts are the same picture: every copy is re-pointed, the gate forgets, THEN each room gets the file version", async () => {
  const h = harness({ booru: { status: 201, data: { id: 41, post_id: 9, md5: "newmd5", old_md5: "oldmd5", mxcs: ["mxc://41chan.net/ELSEWHERE", "mxc://remote.org/X"] } } });
  await handleReplace(edit(), h.deps);
  assert.deepEqual(h.repoints[0].mediaIds.sort(), ["ELSEWHERE", "OLD", "OLD", "REPOST"].sort());
  assert.equal(h.repoints[0].toMediaId, "NEW");
  assert.equal(h.repoints[0].oldMd5, "oldmd5");
  assert.equal(h.forgot.length, 1);
  assert.deepEqual(h.versions.map((v) => v.mxc).sort(), ["mxc://41chan.net/OLD", "mxc://41chan.net/REPOST"]);
  assert.ok(h.versions.every((v) => v.md5 === "newmd5"));
  assert.match(h.said[0], /copies of it now show the new version/);
  assert.deepEqual(h.sent[0]["net.41chan.replacement"], { id: 41, post_id: 9 });
});

test("the gate not forgetting: NO file version is written (it would pin the old bytes under the new URL), and the reply says so", async () => {
  const h = harness({ forget: async () => false });
  await handleReplace(edit(), h.deps);
  assert.equal(h.repoints.length, 1);
  assert.equal(h.versions.length, 0);
  assert.match(h.said[0], /other copies, which switch within a day/);
});

test("no forget at all (not wired): nothing versioned either", async () => {
  const h = harness({ forget: null });
  await handleReplace(edit(), h.deps);
  assert.equal(h.versions.length, 0);
});

test("a copy that could not be re-pointed is named, and its room gets no version", async () => {
  const h = harness({ mapped: [{ room: ROOM, mxc: "mxc://41chan.net/BROKEN", content: { post_id: 9, tags: [] } }] });
  await handleReplace(edit(), h.deps);
  assert.equal(h.versions.filter((v) => v.mxc.endsWith("BROKEN")).length, 0);
  assert.match(h.said[0], /Not yet updated: every copy of the old picture/);
});
