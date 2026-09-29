"use strict";

// The decisions handleImageEvent makes about one picture, without a homeserver
// or a booru: the order (the strip, then creator tags from what it took, then
// the duplicate check), the three ways the duplicate check asks, the
// "ai-generated" tag, and whose name a generation record carries.
// index.test.js runs the real handler around these.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const {
  planImage, findPostForBytes, generationRecord, publicTagsFor, recordGeneration, recordCreator, md5hex,
  STRIP_REFUSED, AI_GENERATED_TAG,
} = require("./image-plan");
const { stripGeneration } = require("./strip-generation");
const { extractCreatorTags, extractCreatorTagsFromFields } = require("./prompt-tags");
const { BooruRefusal } = require("./danbooru");

const ALICE = "@alice:41chan.net";
const BOB = "@bob:41chan.net";
const RAW = Buffer.from("raw bytes with a prompt in them");
const STRIPPED = Buffer.from("raw bytes");
const OLDER = Buffer.from("raw bytes, as an older strip left them");
const REMOVED = { "png:parameters": "1girl, smile\nSteps: 20, Sampler: Euler a" };

// A 1x1 JPEG from PIL with one EXIF text field added in IFD0 (UserComment
// belongs in the ExifIFD, but prompt-tags and the strip read IFD0 too).
const BASE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
function jpegWithText(tag, type, value) {
  const t = Buffer.alloc(26);
  t.write("MM\0*", 0, "latin1"); t.writeUInt32BE(8, 4);
  t.writeUInt16BE(1, 8);
  t.writeUInt16BE(tag, 10); t.writeUInt16BE(type, 12); t.writeUInt32BE(value.length, 14); t.writeUInt32BE(26, 18);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t, value]);
  const len = Buffer.alloc(2); len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([BASE_JPEG.subarray(0, 20), Buffer.from([0xff, 0xe1]), len, exif, BASE_JPEG.subarray(20)]);
}

// A rig whose every call lands in one ordered log.
function rig(over = {}) {
  const calls = [], logs = [];
  const posts = over.posts || {};
  const rawRecords = over.rawRecords || {};
  const deps = {
    strip: (buffer) => { calls.push(["strip", buffer]); return { buffer: STRIPPED, removed: REMOVED, changed: true, confident: true }; },
    creatorTags: (removed) => { calls.push(["creatorTags", removed]); return { tags: ["smile"], meta: ["masterpiece"], characters: ["oc_kayla"] }; },
    findPostByMd5: async (md5) => { calls.push(["find", md5]); return posts[md5] || null; },
    findByRawMd5: async (md5) => { calls.push(["raw", md5]); return rawRecords[md5] || null; },
    maxCreatorTags: 40,
    log: (line) => logs.push(line),
    ...(over.deps || {}),
  };
  return { deps, calls, logs };
}

test("the order: the strip, creator tags from what it TOOK, then stripped md5, the raw record, the raw md5", async () => {
  const r = rig();
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.deepEqual(r.calls, [
    ["strip", RAW],
    ["creatorTags", REMOVED],
    ["find", md5hex(STRIPPED)],
    ["raw", md5hex(RAW)],
    ["find", md5hex(RAW)],
  ]);
  assert.equal(plan.action, "upload");
  assert.equal(plan.upload.buffer, STRIPPED, "the stripped bytes are what gets uploaded");
  assert.equal(plan.upload.md5, md5hex(STRIPPED));
  assert.equal(plan.rawMd5, md5hex(RAW));
  assert.deepEqual(plan.scraped.tags, ["smile"]);
});

test("a new AI image: ai-generated, and a record for its sender keyed by the stripped md5, with the raw md5 beside it", async () => {
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, rig().deps);
  assert.equal(plan.aiGenerated, true);
  assert.deepEqual(plan.record, { md5: md5hex(STRIPPED), rawMd5: md5hex(RAW), source: "matrix", poster: ALICE, fields: REMOVED });
});

test("ai-generated only on a CONFIDENT signal: a caption stripped for its prompt shape is recorded, but labels nothing", async () => {
  const r = rig({ deps: { strip: () => ({ buffer: STRIPPED, removed: { "exif:ImageDescription": "Paris, France, summer, 2019" }, changed: true, confident: false }) } });
  const plan = await planImage({ buffer: RAW, contentType: "image/jpeg", sender: ALICE }, r.deps);
  assert.equal(plan.action, "upload");
  assert.equal(plan.aiGenerated, false);
  assert.deepEqual(plan.record.fields, { "exif:ImageDescription": "Paris, France, summer, 2019" }, "still kept privately");
});

test("with the REAL stripper: a photo's caption is stripped, recorded, and does NOT make it ai-generated", async () => {
  const raw = jpegWithText(0x010e, 2, Buffer.from("Paris, France, summer, 2019\0", "latin1"));
  const plan = await planImage({ buffer: raw, contentType: "image/jpeg", sender: ALICE }, {
    strip: stripGeneration, creatorTags: extractCreatorTagsFromFields, findPostByMd5: async () => null, findByRawMd5: async () => null, log: () => {},
  });
  assert.equal(plan.action, "upload");
  assert.deepEqual(Object.keys(plan.removed), ["exif:ImageDescription"]);
  assert.equal(plan.aiGenerated, false);
});

test("an image with no generation data: the raw md5 is not asked twice, no ai-generated, no record", async () => {
  const r = rig({ deps: { strip: (buffer) => { r.calls.push(["strip", buffer]); return { buffer, removed: {}, changed: false, confident: false }; } } });
  const plan = await planImage({ buffer: RAW, contentType: "image/jpeg", sender: ALICE }, r.deps);
  assert.deepEqual(r.calls.filter((c) => c[0] === "find" || c[0] === "raw"), [["find", md5hex(RAW)], ["raw", md5hex(RAW)]]);
  assert.equal(plan.upload.buffer, RAW);
  assert.equal(plan.aiGenerated, false);
  assert.equal(plan.record, null);
});

test("a strip that throws REFUSES: nothing is looked up, nothing uploaded, and the reason comes back", async () => {
  const r = rig({ deps: { strip: () => { throw new Error("generation data survived the strip: x"); } } });
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.equal(plan.action, "refuse");
  assert.equal(plan.status, STRIP_REFUSED);
  assert.equal(plan.status, "strip-refused", "the literal backfill.js and catchup.js count");
  assert.match(plan.reason, /survived the strip/);
  assert.equal(r.calls.filter((c) => c[0] === "find" || c[0] === "raw").length, 0);
});

test("a creator-tag scrape that throws is logged and posts without them, rather than refusing", async () => {
  const r = rig({ deps: { creatorTags: () => { throw new Error("bad prompt"); } } });
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.equal(plan.action, "upload");
  assert.deepEqual(plan.scraped, { tags: [], meta: [], characters: [] });
  assert.match(r.logs[0], /\[creator-tags\] prompt scrape failed: bad prompt/);
});

test("duplicate by the STRIPPED md5: the record goes under the booru's md5 with the SENDER as poster, whoever the tags name", async () => {
  // The tags say bob. They are editable by any member and decide nothing: the
  // record carries who sent these bytes, and the booru keeps an existing
  // record from anyone else (409) -- see recordGeneration.
  const post = { id: 5, md5: md5hex(STRIPPED), tag_string: "1girl 41chan_bob", tag_string_artist: "41chan_bob" };
  const r = rig({ posts: { [md5hex(STRIPPED)]: post } });
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.equal(plan.action, "duplicate");
  assert.equal(plan.via, "stripped");
  assert.equal(plan.post, post);
  assert.deepEqual(plan.record, { md5: md5hex(STRIPPED), rawMd5: md5hex(RAW), source: "matrix", poster: ALICE, fields: REMOVED });
  assert.equal(r.calls.filter((c) => c[0] === "find").length, 1, "found on the first ask");
});

test("duplicate by the booru's RAW-MD5 RECORD: a post made under older strip rules is found, not posted twice", async () => {
  const post = { id: 9, md5: md5hex(OLDER) };
  const r = rig({ posts: { [md5hex(OLDER)]: post }, rawRecords: { [md5hex(RAW)]: md5hex(OLDER) } });
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.equal(plan.action, "duplicate");
  assert.equal(plan.via, "raw-record");
  assert.equal(plan.md5, md5hex(OLDER));
  assert.equal(plan.record.md5, md5hex(OLDER), "the record is keyed by the md5 of the bytes the booru holds");
  assert.deepEqual(r.calls.filter((c) => c[0] === "find").map((c) => c[1]), [md5hex(STRIPPED), md5hex(OLDER)]);
});

test("duplicate by the RAW md5 -- a post from before the strip -- is found, not posted twice", async () => {
  const post = { id: 6, md5: md5hex(RAW) };
  const r = rig({ posts: { [md5hex(RAW)]: post } });
  const plan = await planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps);
  assert.equal(plan.action, "duplicate");
  assert.equal(plan.via, "raw");
  assert.equal(plan.md5, md5hex(RAW));
  assert.equal(plan.record.md5, md5hex(RAW));
});

test("a raw-record lookup that FAILS is not \"no such post\": the plan throws rather than risk posting twice", async () => {
  const r = rig({ deps: { findByRawMd5: async () => { throw new Error("generation_metadata/raw -> 503"); } } });
  await assert.rejects(planImage({ buffer: RAW, contentType: "image/png", sender: ALICE }, r.deps), /503/);
});

test("planImage will not run without a log", async () => {
  await assert.rejects(planImage({ buffer: RAW, contentType: "", sender: ALICE }, { ...rig().deps, log: undefined }), TypeError);
});

test("findPostForBytes: the booru's md5 wins over ours when it reports one; the raw lookup is required", async () => {
  const found = await findPostForBytes({ rawMd5: "a", strippedMd5: "b" }, async (m) => (m === "a" ? { id: 1 } : null), async () => null);
  assert.deepEqual(found, { post: { id: 1 }, md5: "a", via: "raw" });
  assert.equal(await findPostForBytes({ rawMd5: "a", strippedMd5: "a" }, async () => null, async () => null), null);
  await assert.rejects(findPostForBytes({ rawMd5: "a", strippedMd5: "b" }, async () => null), /requires findByRawMd5/);
});

test("image-plan has no way to read a creator off a post's tags", () => {
  assert.equal(require("./image-plan").creatorsOf, undefined);
});

test("generationRecord: null when nothing was removed; poster null rather than undefined; NUL scrubbed", () => {
  assert.equal(generationRecord({ md5: "m", rawMd5: "r", poster: ALICE, removed: {} }), null);
  assert.deepEqual(generationRecord({ md5: "m", rawMd5: "r", poster: undefined, removed: REMOVED }), { md5: "m", rawMd5: "r", source: "matrix", poster: null, fields: REMOVED });
  const rec = generationRecord({ md5: "m", rawMd5: "r", poster: ALICE, removed: { "jpeg:COM": "Steps: 20\0, Sampler: x\0" } });
  assert.equal(rec.fields["jpeg:COM"], "Steps: 20, Sampler: x");
});

test("publicTagsFor: ai-generated only when asked, never duplicated", () => {
  const base = { autoTags: ["1girl", "smile"], metaTags: ["highres"], ocTags: ["oc_kayla"], posterTag: "41chan_alice" };
  assert.deepEqual(publicTagsFor({ ...base, aiGenerated: false }), ["1girl", "smile", "highres", "oc_kayla", "41chan_alice"]);
  assert.deepEqual(publicTagsFor({ ...base, aiGenerated: true }), ["1girl", "smile", "highres", "oc_kayla", "41chan_alice", AI_GENERATED_TAG]);
  assert.deepEqual(publicTagsFor({ autoTags: [AI_GENERATED_TAG], aiGenerated: true }), [AI_GENERATED_TAG]);
  assert.equal(AI_GENERATED_TAG, "ai-generated", "the tag chanbooru's is_ai_generated? used to add");
});

test("recordGeneration: skipped for no record; sends md5, raw md5 and body; a failure is LOUD, names the fix, and never the text", async () => {
  const sent = [];
  assert.equal(await recordGeneration(async () => { throw new Error("must not be called"); }, null, { log: () => {}, postId: 1, mxc: "mxc://x/y" }), "skipped");
  const rec = generationRecord({ md5: "m", rawMd5: "r", poster: ALICE, removed: REMOVED });
  assert.equal(await recordGeneration(async (md5, body) => { sent.push([md5, body]); }, rec, { log: () => {}, postId: 1, mxc: "mxc://x/y" }), "recorded");
  assert.deepEqual(sent, [["m", { rawMd5: "r", source: "matrix", poster: ALICE, fields: REMOVED }]]);
  const lines = [];
  const out = await recordGeneration(async () => { throw new BooruRefusal("generation_metadata -> 503", 503, {}); }, rec, { log: (l) => lines.push(l), postId: 9, mxc: "mxc://x/y" });
  assert.equal(out, "failed");
  assert.match(lines[0], /NOT RECORDED for post #9 \(md5 m, 1 field\(s\)\): generation_metadata -> 503/);
  assert.match(lines[0], /!rescan mxc:\/\/x\/y/);
  assert.doesNotMatch(lines[0], /Steps: 20/);
});

// The booru's 409s, told apart by the machine-readable reason it sends with
// its { error, fix }. Only one of them means a record exists and stood.
async function refused409(reason, poster = BOB) {
  const warn = [], info = [];
  const rec = generationRecord({ md5: "m", rawMd5: "r", poster, removed: REMOVED });
  const body = reason === undefined ? { error: "conflict", fix: "look" } : { error: `the booru's words for ${reason}`, fix: "its fix", reason };
  const out = await recordGeneration(
    async () => { throw new BooruRefusal(`generation_metadata -> 409: ${body.error}`, 409, body); },
    rec, { log: (l) => warn.push(l), info: (l) => info.push(l), postId: 5, mxc: "mxc://x/y" },
  );
  return { out, warn, info };
}

test("recordGeneration: a 409 poster_mismatch -- the booru kept a record from a different poster -- is logged plainly and is NOT a failure", async () => {
  const { out, warn, info } = await refused409("poster_mismatch");
  assert.equal(out, "kept");
  assert.deepEqual(warn, [], "no warning");
  assert.match(info[0], /post #5 keeps the record it already has; @bob:41chan.net's copy was not written/);
});

test("recordGeneration: a 409 raw_md5_conflict wrote NOTHING for this post -- LOUD, in its own words, with the raw lookup to resolve it", async () => {
  const { out, warn, info } = await refused409("raw_md5_conflict");
  assert.equal(out, "raw-md5-conflict");
  assert.deepEqual(info, [], "never the quiet \"kept\" line");
  assert.match(warn[0], /NOT RECORDED for post #5 \(md5 m, 1 field\(s\)\): its original \(raw md5 r\) is already filed under a DIFFERENT md5/);
  assert.match(warn[0], /Fix: GET \/fourier\/generation_metadata\/raw\/r\.json names the md5 holding it; resolve that record on the booru, then run !rescan mxc:\/\/x\/y/);
  assert.doesNotMatch(warn[0], /keeps the record/);
});

test("recordGeneration: a 409 raw_md5_mismatch left the fields NOT replaced -- LOUD, in its own words", async () => {
  const { out, warn, info } = await refused409("raw_md5_mismatch");
  assert.equal(out, "raw-md5-mismatch");
  assert.deepEqual(info, []);
  assert.match(warn[0], /NOT RECORDED for post #5 .*filed from a DIFFERENT original than raw md5 r, so its fields were NOT replaced/);
  assert.match(warn[0], /Fix: find which original the post was made from/);
});

test("recordGeneration: a 409 with no reason, or one this does not know, is NOT taken as kept", async () => {
  for (const reason of [undefined, "something_new"]) {
    const { out, warn, info } = await refused409(reason);
    assert.equal(out, "failed", String(reason));
    assert.deepEqual(info, [], String(reason));
    assert.match(warn[0], /NOT RECORDED .*a 409 with no reason the tunnel knows, so not taken as "kept"/, String(reason));
  }
});

test("recordCreator: the sender, once; a failure is LOUD and says the private data is visible to nobody until fixed", async () => {
  const sent = [];
  assert.equal(await recordCreator(async (id, mxid) => { sent.push([id, mxid]); }, { postId: 42, mxid: ALICE, log: () => {} }), "recorded");
  assert.deepEqual(sent, [[42, ALICE]]);
  const lines = [];
  const out = await recordCreator(async () => { throw new BooruRefusal("posts/42/creator -> 409: a different creator is recorded", 409, {}); }, { postId: 42, mxid: ALICE, log: (l) => lines.push(l) });
  assert.equal(out, "failed");
  assert.match(lines[0], /\[creator\] NOT RECORDED for post #42 \(@alice:41chan.net\): posts\/42\/creator -> 409/);
  assert.match(lines[0], /visible to nobody/);
  assert.match(lines[0], /Fix: .*\/fourier\/posts\/42\/creator\.json/);
});

test("with the REAL extractor and stripper: the prompt becomes creator tags AND leaves the uploaded bytes", async () => {
  const chunk = (type, data) => {
    const h = Buffer.alloc(8); h.writeUInt32BE(data.length, 0); h.write(type, 4, "latin1");
    return Buffer.concat([h, data, Buffer.alloc(4)]); // CRC unchecked: nothing here reads it
  };
  // A real 1 x 1 RGB image: the strip reads a PNG's pixels (for a stealth
  // copy of the prompt), and refuses one whose pixels no decoder could read.
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const params = "1girl, hoodie, backpack, masterpiece\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a";
  const raw = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("tEXt", Buffer.from(`parameters\0${params}`, "latin1")),
    chunk("IDAT", zlib.deflateSync(Buffer.from([0, 1, 2, 3]))), chunk("IEND", Buffer.alloc(0)),
  ]);
  const plan = await planImage({ buffer: raw, contentType: "image/png", sender: ALICE }, {
    strip: stripGeneration, creatorTags: extractCreatorTagsFromFields, findPostByMd5: async () => null, findByRawMd5: async () => null, log: () => {},
  });
  assert.equal(plan.action, "upload");
  assert.deepEqual(plan.scraped.tags, ["1girl", "hoodie", "backpack"]);
  assert.deepEqual(plan.scraped.tags, extractCreatorTags(raw, "image/png").tags, "the same tags reading the raw bytes would give");
  assert.deepEqual(plan.removed, { "png:parameters": params });
  assert.equal(plan.upload.buffer.indexOf("parameters"), -1, "not in the uploaded bytes");
  assert.deepEqual(extractCreatorTags(plan.upload.buffer, "image/png").tags, []);
  assert.equal(plan.aiGenerated, true);
});

test("private creator tags never come from text left public: a sentence the strip keeps is not turned into tags", async () => {
  // A UserComment no signal marks as a prompt. prompt-tags would read it as
  // one from the raw bytes; the strip keeps it, public, in the file. So it
  // must not ALSO become private creator tags: one text, one treatment.
  const sentence = "a photograph of an astronaut riding a horse on the moon, dramatic lighting";
  const raw = jpegWithText(0x9286, 7, Buffer.from(`ASCII\0\0\0${sentence}`, "latin1"));
  assert.ok(extractCreatorTags(raw, "image/jpeg").tags.length > 0, "precondition: read from the raw bytes, it would make tags");
  const plan = await planImage({ buffer: raw, contentType: "image/jpeg", sender: ALICE }, {
    strip: stripGeneration, creatorTags: extractCreatorTagsFromFields, findPostByMd5: async () => null, findByRawMd5: async () => null, log: () => {},
  });
  assert.equal(plan.action, "upload");
  assert.equal(plan.upload.buffer, raw, "kept as a caption");
  assert.deepEqual(plan.scraped.tags, [], "and so not a private creator tag");
});
