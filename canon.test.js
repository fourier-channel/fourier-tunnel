"use strict";

// canon.js: one file per image, stripped, with every write checked and nothing
// deleted -- only moved to superseded/ once its copy is verified.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const { createCanon, keys, md5hex, synapseMediaInfo } = require("./canon");
const { crc32 } = require("./strip-generation");

const ID = "AbCdEfGhIjKlMnOpQrStUvWx";

// A real 1x1 PNG, optionally carrying an A1111 "parameters" tEXt chunk.
function png(parameters) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (parameters) parts.push(chunk("tEXt", Buffer.from(`parameters\0${parameters}`, "latin1")));
  parts.push(chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
const PROMPT = "masterpiece, best quality, 1girl, looking at viewer\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Model: secretmodel";

function fakeStore(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { body: v.body, type: v.type, modified: v.modified }]));
  const writes = [];
  const store = {
    objects,
    writes,
    failCopyVerify: false,
    async head(key) {
      const o = objects.get(key);
      if (!o) return null;
      return { size: o.body.length, etag: store.failCopyVerify && key.startsWith("superseded/") ? "broken" : md5hex(o.body), type: o.type };
    },
    async get(key) {
      const o = objects.get(key);
      return o ? Buffer.from(o.body) : null;
    },
    async put(key, body, type) {
      writes.push(["put", key]);
      objects.set(key, { body: Buffer.from(body), type });
      return md5hex(body);
    },
    async copy(from, to) {
      writes.push(["copy", from, to]);
      objects.set(to, { ...objects.get(from) });
    },
    async remove(key) {
      writes.push(["remove", key]);
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
    // Objects carry `modified` when a test sets it; otherwise they are old.
    async listDated(prefix) {
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, modified: o.modified || new Date(0) }));
    },
  };
  return store;
}

// The booru, in memory: what it holds, what it was sent, how it answers.
//   posts        md5 -> post, what findPostByMd5 finds
//   rawRecords   raw md5 -> booru md5, its generation records
//   uploadError  the booru's verdict on every upload ("File type is not supported")
//   busy         every createUploadFromBytes answers 429 while true
//   rendering    every waitForUpload runs out of time while true
function fakeBooru({ posts = {}, rawRecords = {}, uploadError = null } = {}) {
  const b = {
    posts,
    rawRecords,
    uploadError,
    busy: false,
    rendering: false,
    filed: [],
    uploads: [],
    waited: [],
    async recordGenerationMetadata(md5, rec) { b.filed.push({ md5, ...rec }); return { md5 }; },
    async findPostByMd5(md5) { return b.posts[md5] || null; },
    async findGenerationByRawMd5(rawMd5) { return b.rawRecords[rawMd5] || null; },
    async createUploadFromBytes(buffer, filename, type) {
      if (b.busy) throw Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });
      b.uploads.push({ buffer: Buffer.from(buffer), filename, type });
      return { id: 100 + b.uploads.length, status: "pending" };
    },
    async waitForUpload(id) {
      b.waited.push(id);
      if (b.uploadError) throw Object.assign(new Error(`Upload ${id} failed: ${b.uploadError}`), { code: "UPLOAD_ERROR", uploadError: b.uploadError });
      if (b.rendering) throw Object.assign(new Error(`Upload ${id} timed out`), { code: "UPLOAD_TIMEOUT" });
      return { id, status: "completed", upload_media_assets: [{ id: id * 10, media_asset_id: id * 100, status: "active" }] };
    },
    async createPost() { throw new Error("canon must never make a post"); },
  };
  return b;
}

function rig({ body = png(PROMPT), type = "image/png", info, booru, storeInit } = {}) {
  const store = fakeStore(storeInit || { [keys.source(ID)]: { body, type } });
  const theBooru = booru || fakeBooru();
  const canon = createCanon({
    store,
    mediaInfo: async (id) => (id === ID ? (info === undefined ? { media_type: type, user_id: "@alice:41chan.net" } : info) : null),
    booru: theBooru,
  });
  return { store, canon, filed: theBooru.filed || [], booru: theBooru };
}

test("a PNG with a prompt becomes ONE stripped file, indexed, its prompt filed privately, its original MOVED", async () => {
  const raw = png(PROMPT);
  const { store, canon, filed } = rig({ body: raw });
  const r = await canon.canonicalize(ID);

  assert.equal(r.kind, "canonical");
  assert.equal(r.stripped, true);
  assert.equal(r.fields, 1);
  assert.equal(r.raw_md5, md5hex(raw));
  assert.notEqual(r.md5, r.raw_md5, "the file changed");
  assert.equal(r.key, `media/${r.md5}.png`);

  const file = store.objects.get(r.key).body;
  assert.equal(md5hex(file), r.md5, "the key is the md5 of the bytes it holds");
  assert.ok(!file.includes(Buffer.from("secretmodel")), "the one file carries no prompt");
  assert.ok(!file.includes(Buffer.from("parameters")), "nor the chunk that held it");

  assert.deepEqual(JSON.parse(store.objects.get(keys.index(ID)).body.toString()).key, r.key);
  assert.ok(store.objects.has(keys.byMd5(r.md5)));

  assert.equal(filed.length, 1);
  assert.equal(filed[0].md5, r.md5);
  assert.equal(filed[0].rawMd5, md5hex(raw));
  assert.equal(filed[0].poster, "@alice:41chan.net", "the uploader, from Synapse's own record");
  assert.match(filed[0].fields["png:parameters"], /secretmodel/);

  assert.equal(store.objects.has(keys.source(ID)), false, "Synapse's original is gone from its key");
  assert.deepEqual(store.objects.get(keys.superseded(ID)).body, raw, "and sits whole in superseded/");
  assert.equal(r.moved, "moved");
  // Nothing was ever removed that was not first copied and verified.
  const removes = store.writes.filter((w) => w[0] === "remove").map((w) => w[1]);
  assert.deepEqual(removes, [keys.source(ID)]);
});

test("a clean image is the same bytes under its md5; nothing is filed", async () => {
  const raw = png(null);
  const { store, canon, filed } = rig({ body: raw });
  const r = await canon.canonicalize(ID);
  assert.equal(r.stripped, false);
  assert.equal(r.md5, md5hex(raw));
  assert.deepEqual(store.objects.get(r.key).body, raw);
  assert.equal(filed.length, 0);
  assert.equal(r.moved, "moved");
});

test("the booru's own copy of the same stripped bytes IS the one file: no second write", async () => {
  const raw = png(PROMPT);
  const first = rig({ body: raw });
  const r1 = await first.canon.canonicalize(ID);
  const strippedBytes = first.store.objects.get(r1.key).body;
  // A bucket where the booru already stored those exact bytes at that key.
  const { store, canon } = rig({ storeInit: { [keys.source(ID)]: { body: raw, type: "image/png" }, [r1.key]: { body: strippedBytes, type: "image/png" } } });
  await canon.canonicalize(ID);
  assert.equal(store.writes.filter((w) => w[0] === "put" && w[1] === r1.key).length, 0);
});

test("not an image: indexed where it is, nothing moved, nothing written to media/", async () => {
  const { store, canon } = rig({ body: Buffer.from("ciphertext"), type: "application/octet-stream" });
  const r = await canon.canonicalize(ID);
  assert.equal(r.kind, "source");
  assert.equal(r.key, keys.source(ID));
  assert.ok(store.objects.has(keys.source(ID)));
  assert.equal(store.writes.filter((w) => w[1] && w[1].startsWith("media/")).length, 0);
});

test("an image the stripper refuses is indexed as refused and its original stays put", async () => {
  // An AVIF-shaped file carrying an Exif signature: a format the stripper cannot
  // verify, with a metadata carrier in it.
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypavif"), Buffer.alloc(12), Buffer.from("Exif\0\0MM\0*"), Buffer.alloc(64)]);
  const { store, canon } = rig({ body: avif, type: "image/avif" });
  const r = await canon.canonicalize(ID);
  assert.equal(r.kind, "refused");
  assert.ok(store.objects.has(keys.source(ID)), "not moved");
  assert.equal(store.writes.filter((w) => w[1] && w[1].startsWith("media/")).length, 0);
});

test("a dry run computes everything and writes NOTHING", async () => {
  const { store, canon, filed } = rig();
  const r = await canon.canonicalize(ID, { dryRun: true });
  assert.equal(r.kind, "canonical");
  assert.equal(r.stripped, true);
  assert.deepEqual(store.writes, []);
  assert.equal(filed.length, 0);
});

test("idempotent: a second run writes nothing new; an interrupted move is finished", async () => {
  const { store, canon } = rig();
  const r = await canon.canonicalize(ID);
  const before = store.writes.length;
  const again = await canon.canonicalize(ID);
  assert.equal(again.key, JSON.parse(store.objects.get(keys.index(ID)).body.toString()).key);
  assert.equal(store.writes.length, before, "nothing rewritten");

  // Put the source back as if the delete had never happened: the next run finishes it.
  store.objects.set(keys.source(ID), { ...store.objects.get(keys.superseded(ID)) });
  await canon.canonicalize(ID);
  assert.equal(store.objects.has(keys.source(ID)), false);
  assert.ok(store.objects.has(keys.superseded(ID)));
  assert.equal(r.kind, "canonical");
});

test("if the private store fails, the original stays where it is (the text must exist somewhere)", async () => {
  let fail = true;
  const booru = { ...fakeBooru(),
    recordGenerationMetadata: async (md5) => {
      if (fail) throw Object.assign(new Error("booru down"), { status: 502 });
      return { md5 };
    },
  };
  const { store, canon } = rig({ booru });
  const r = await canon.canonicalize(ID);
  assert.equal(r.record, "pending");
  assert.ok(store.objects.has(keys.source(ID)), "raw original NOT moved while its text is unfiled");
  assert.ok(store.objects.has(r.key), "but the stripped file exists and is indexed, so links lead to it");
});

test("EVERY 409 leaves the original in place: this upload's text is not on record, and the original is the only place it is", async () => {
  for (const reason of ["poster_mismatch", "raw_md5_conflict", "raw_md5_mismatch"]) {
    const booru = { ...fakeBooru(), recordGenerationMetadata: async () => { throw Object.assign(new Error("409"), { status: 409, reason }); } };
    const { store, canon } = rig({ booru });
    const r = await canon.canonicalize(ID);
    assert.equal(r.record, `conflict (${reason})`);
    assert.ok(store.objects.has(keys.source(ID)), `${reason}: not moved`);
    assert.ok(store.objects.has(r.key), `${reason}: the stripped file still exists and is what links lead to`);
  }
});

test("a move whose copy does not verify removes NOTHING -- and does not stop the image being served or posted", async () => {
  const { store, canon } = rig();
  store.failCopyVerify = true;
  const r = await canon.canonicalize(ID, { withBytes: true });
  assert.equal(r.moved, "move failed");
  assert.ok(store.objects.has(keys.source(ID)), "source kept");
  assert.equal(md5hex(r.bytes), r.md5, "the one file is still returned");
  store.failCopyVerify = false;
  const again = await canon.canonicalize(ID);
  assert.equal(again.moved, "moved", "the next touch finishes it");
  assert.equal(store.objects.has(keys.source(ID)), false);
});

test("what the BYTES are decides: a PNG sent as octet-stream is stripped, and a PNG labelled jpeg gets a .png key", async () => {
  const hidden = rig({ body: png(PROMPT), type: "application/octet-stream" });
  const r1 = await hidden.canon.canonicalize(ID);
  assert.equal(r1.kind, "canonical");
  assert.equal(r1.stripped, true, "its prompt was not served just because the upload said octet-stream");
  assert.match(r1.key, /\.png$/);
  const mislabelled = rig({ body: png(PROMPT), type: "image/jpeg" });
  const r2 = await mislabelled.canon.canonicalize(ID);
  assert.match(r2.key, /\.png$/, "the booru keys these bytes as png, so canon must too");
});

test("the same raw bytes under a second media id are the SAME one file, never a second", async () => {
  const raw = png(PROMPT);
  const OTHER = "ZyXwVuTsRqPoNmLkJiHgFeDc";
  const { store, canon } = rig({ storeInit: { [keys.source(ID)]: { body: raw, type: "image/png" }, [keys.source(OTHER)]: { body: raw, type: "image/png" } }, info: { media_type: "image/png", user_id: "@alice:41chan.net" } });
  const a = await canon.canonicalize(ID);
  const putsBefore = store.writes.filter((w) => w[0] === "put" && w[1].startsWith("media/")).length;
  // canon's mediaInfo in rig() answers only ID; answer OTHER the same way.
  const other = createCanon({ store, mediaInfo: async () => ({ media_type: "image/png", user_id: "@bob:41chan.net" }), booru: fakeBooru() });
  const b = await other.canonicalize(OTHER);
  assert.equal(b.key, a.key);
  assert.equal(store.writes.filter((w) => w[0] === "put" && w[1].startsWith("media/")).length, putsBefore, "no second media/ object");
});

test("a pending record is retried on the next touch, and only then does the original move", async () => {
  let up = false;
  const filed = [];
  const booru = { ...fakeBooru(), recordGenerationMetadata: async (md5, rec) => { if (!up) throw Object.assign(new Error("booru down"), { status: 502 }); filed.push(rec); return { md5 }; } };
  const { store, canon } = rig({ booru });
  const r = await canon.canonicalize(ID);
  assert.equal(r.record, "pending");
  assert.ok(store.objects.has(keys.source(ID)));
  up = true;
  const again = await canon.canonicalize(ID);
  assert.equal(again.record, "filed");
  assert.equal(filed.length, 1);
  assert.equal(store.objects.has(keys.source(ID)), false, "moved once filed");
  assert.equal(JSON.parse(store.objects.get(keys.index(ID)).body.toString()).record, "filed");
});

test("a content-addressed key already holding different bytes is refused, nothing else written", async () => {
  const raw = png(PROMPT);
  const probe = rig({ body: raw });
  const r = await probe.canon.canonicalize(ID, { dryRun: true });
  const { store, canon } = rig({ storeInit: { [keys.source(ID)]: { body: raw, type: "image/png" }, [r.key]: { body: Buffer.from("not those bytes"), type: "image/png" } } });
  await assert.rejects(() => canon.canonicalize(ID), /wrong content/);
  assert.equal(store.objects.has(keys.index(ID)), false);
  assert.ok(store.objects.has(keys.source(ID)));
});

test("an existing index is final: withBytes serves the one file and never writes a second", async () => {
  const { store, canon } = rig();
  const r = await canon.canonicalize(ID);
  const before = store.writes.length;
  const again = await canon.canonicalize(ID, { withBytes: true });
  assert.equal(again.key, r.key);
  assert.equal(md5hex(again.bytes), r.md5);
  assert.match(again.removed["png:parameters"], /secretmodel/, "the removed text, read back from superseded/ for creator tags");
  assert.equal(store.writes.length, before, "nothing written");
});

test("bad ids, unknown media and quarantined media are refused before anything is read", async () => {
  const { canon } = rig();
  await assert.rejects(() => canon.canonicalize("../../etc"), (e) => e.status === 400);
  await assert.rejects(() => canon.canonicalize("ZZZZZZZZZZZZZZZZ"), (e) => e.status === 404);
  const q = rig({ info: { media_type: "image/png", user_id: "@a:x", quarantined_by: "@mod:x" } });
  await assert.rejects(() => q.canon.canonicalize(ID), (e) => e.status === 404);
});

test("synapseMediaInfo reads Synapse's { media_info } envelope, and refuses a reply without it", async () => {
  const reply = (status, data) => ({ get: async () => ({ status, data }) });
  const ok = synapseMediaInfo({ axios: reply(200, { media_info: { media_type: "image/png", user_id: "@a:41chan.net", quarantined_by: null } }), homeserverUrl: "http://s", domain: "41chan.net", adminToken: "t" });
  assert.deepEqual(await ok(ID), { media_type: "image/png", user_id: "@a:41chan.net", quarantined_by: null });
  const flat = synapseMediaInfo({ axios: reply(200, { media_type: "image/png" }), homeserverUrl: "http://s", domain: "41chan.net", adminToken: "t" });
  await assert.rejects(() => flat(ID), /without media_info/);
  const gone = synapseMediaInfo({ axios: reply(404, {}), homeserverUrl: "http://s", domain: "41chan.net", adminToken: "t" });
  assert.equal(await gone(ID), null);
});

// A JPEG carrying a prompt in its COMMENT segment -- what Synapse's thumbnailer
// (Pillow) carries into a JPEG thumbnail.
function jpegWithComment(text) {
  const base = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
  const body = Buffer.from(text, "latin1");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([base.subarray(0, 20), Buffer.from([0xff, 0xfe]), len, body, base.subarray(20)]);
}

test("a thumbnail still carrying a prompt is stripped in place; the one it replaced is moved to superseded/", async () => {
  const thumbKey = `${keys.thumbnails(ID)}320-240-image-jpeg-scale`;
  const dirty = jpegWithComment(PROMPT);
  const clean = jpegWithComment("just a caption");
  const { store, canon } = rig({ storeInit: {
    [keys.source(ID)]: { body: png(PROMPT), type: "image/png" },
    [thumbKey]: { body: dirty, type: "image/jpeg" },
    [`${keys.thumbnails(ID)}96-96-image-jpeg-crop`]: { body: clean, type: "image/jpeg" },
  } });
  const r = await canon.canonicalize(ID);
  assert.deepEqual(r.thumbnails, { checked: 2, replaced: 1 });
  assert.ok(!store.objects.get(thumbKey).body.includes(Buffer.from("secretmodel")), "the rendition every surface uses has no prompt");
  assert.ok(store.objects.get(`superseded/${thumbKey}`).body.equals(dirty), "what it replaced is kept, aside");
  assert.ok(store.objects.get(`${keys.thumbnails(ID)}96-96-image-jpeg-crop`).body.equals(clean), "a clean rendition is untouched");
});

test("a refused image is asked again on the next touch, and served once the stripper can handle it", async () => {
  const { store, canon } = rig();
  store.objects.set(keys.index(ID), { body: Buffer.from(JSON.stringify({ kind: "refused", reason: "old stripper" })), type: "application/json" });
  const r = await canon.canonicalize(ID);
  assert.equal(r.kind, "canonical", "re-evaluated, not stuck");
});

test("a MULTIPART original moves once its copy matches the raw md5 canon recorded -- and only then", async () => {
  const raw = png(PROMPT);
  const { store, canon } = rig({ body: raw });
  // Synapse's provider uploaded it in parts: its ETag is "<hash>-2", which no copy can equal.
  const plainHead = store.head;
  store.head = async (key) => {
    const h = await plainHead(key);
    return h && key === keys.source(ID) ? { ...h, etag: "0123456789abcdef0123456789abcdef-2" } : h;
  };
  const r = await canon.canonicalize(ID);
  assert.equal(r.moved, "moved", "verified by the raw md5, not the multipart ETag");
  assert.equal(store.objects.has(keys.source(ID)), false);
  assert.ok(store.objects.get(keys.superseded(ID)).body.equals(raw));
});

test("a multipart original whose raw md5 is unknown is NOT moved", async () => {
  const { store, canon } = rig({ body: png(null) });
  const plainHead = store.head;
  store.head = async (key) => {
    const h = await plainHead(key);
    return h && key === keys.source(ID) ? { ...h, etag: "0123456789abcdef0123456789abcdef-3" } : h;
  };
  const r = await canon.canonicalize(ID);
  // A clean image's raw md5 IS known (it is the file's own md5), so this one moves;
  // the unknown case is the index with no raw_md5 at all.
  assert.equal(r.moved, "moved");
  assert.equal(await canon.moveSource("QqQqQqQqQqQqQqQq", undefined), "absent", "nothing there, nothing moved");
});

test("moveSource refuses a multipart original when no raw md5 is known, and removes nothing", async () => {
  const raw = png(null);
  const { store, canon } = rig({ body: raw });
  const plainHead = store.head;
  store.head = async (key) => {
    const h = await plainHead(key);
    return h && key === keys.source(ID) ? { ...h, etag: "0123456789abcdef0123456789abcdef-3" } : h;
  };
  await assert.rejects(() => canon.moveSource(ID, undefined), /not verified/);
  assert.ok(store.objects.has(keys.source(ID)), "source kept");
  assert.equal(await canon.moveSource(ID, md5hex(raw)), "moved", "and moves once the md5 is known");
});

// ONE SET OF RENDITIONS (operator, 2026-09-30): Synapse's renditions of an image
// the booru holds are moved to superseded/; the booru's variants are the set.
const { RETIRE_THUMBNAILS_AFTER_MS } = require("./canon");
const MD5 = "60afcbe772caded03b35238685f63696";
const RAW = "535f0df6cc535647290653d9ce222874";
const T0 = new Date("2026-09-30T12:00:00Z");
const LATER = T0.getTime() + RETIRE_THUMBNAILS_AFTER_MS + 1;
const thumbKeys = ["96-96-image-jpeg-crop", "320-231-image-jpeg-scale"].map((n) => `${keys.thumbnails(ID)}${n}`);

function renditionRig({ variantsUnder = MD5, variantsAt = T0, index = { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5, raw_md5: RAW }, extra = {} } = {}) {
  const init = { ...extra };
  if (index) init[keys.index(ID)] = { body: Buffer.from(JSON.stringify(index)), type: "application/json" };
  for (const k of thumbKeys) init[k] = { body: Buffer.from(`thumb ${k}`), type: "image/jpeg" };
  if (variantsUnder) {
    for (const n of ["180x180.jpg", "360x360.jpg", "720x720.webp", "sample.jpg"]) {
      init[`variants/${variantsUnder}/${n}`] = { body: Buffer.from(n), type: "image/jpeg", modified: variantsAt };
    }
  }
  const store = fakeStore(init);
  const lines = [];
  const canon = createCanon({ store, mediaInfo: async () => null, booru: {}, log: (l) => lines.push(l) });
  return { store, canon, lines };
}

test("a booru-held image: Synapse's renditions move to superseded/, the variants stay", async () => {
  const { store, canon } = renditionRig();
  const r = await canon.retireSynapseThumbnails(ID, { now: LATER });
  assert.equal(r.status, "retired");
  assert.equal(r.moved, 2);
  for (const k of thumbKeys) {
    assert.ok(!store.objects.has(k), `${k} left at Synapse's key`);
    assert.ok(store.objects.has(`superseded/${k}`), `${k} not in superseded/`);
  }
  assert.ok(store.objects.has(`variants/${MD5}/360x360.jpg`), "the booru's variants are the set and stay");
  assert.ok(!store.writes.some(([op, key]) => op === "remove" && key.startsWith("variants/")), "nothing of the booru's is touched");
});

test("variants younger than the gate's memory of 'none': nothing moves yet", async () => {
  const { store, canon } = renditionRig({ variantsAt: new Date(LATER - 60 * 1000) });
  const r = await canon.retireSynapseThumbnails(ID, { now: LATER });
  assert.equal(r.status, "too-recent");
  for (const k of thumbKeys) assert.ok(store.objects.has(k));
});

test("an image the booru does not hold keeps Synapse's renditions -- its only set", async () => {
  const { store, canon } = renditionRig({ variantsUnder: null });
  assert.equal((await canon.retireSynapseThumbnails(ID, { now: LATER })).status, "not-on-booru");
  for (const k of thumbKeys) assert.ok(store.objects.has(k));
  const noIndex = renditionRig({ index: null });
  assert.equal((await noIndex.canon.retireSynapseThumbnails(ID, { now: LATER })).status, "no-index");
});

test("a tunnel post made before stripping: variants under the raw md5 count", async () => {
  const { canon } = renditionRig({ variantsUnder: RAW });
  const r = await canon.retireSynapseThumbnails(ID, { now: LATER });
  assert.equal(r.status, "retired");
  assert.equal(r.variantsUnder, RAW);
});

test("an older object already at the superseded/ key: the rendition stays, loudly", async () => {
  const clash = { [`superseded/${thumbKeys[0]}`]: { body: Buffer.from("pre-strip bytes of another size"), type: "image/jpeg" } };
  const { store, canon, lines } = renditionRig({ extra: clash });
  const r = await canon.retireSynapseThumbnails(ID, { now: LATER });
  assert.equal(r.moved, 1);
  assert.equal(r.failed, 1);
  assert.ok(store.objects.has(thumbKeys[0]), "never removed without a verified copy");
  assert.ok(lines.some((l) => l.includes("NOT retired")));
});

test("a dry run moves nothing and says what it would", async () => {
  const { store, canon } = renditionRig();
  const r = await canon.retireSynapseThumbnails(ID, { now: LATER, dryRun: true });
  assert.equal(r.status, "would-retire");
  assert.equal(r.count, 2);
  assert.equal(store.writes.length, 0);
});

test("the sweep finds every media id with renditions and retires only booru-held ones", async () => {
  const other = "ZyXwVuTsRqPoNmLkJiHgFeDc";
  const otherThumb = `${keys.thumbnails(other)}96-96-image-jpeg-crop`;
  const { store, canon } = renditionRig({ extra: { [otherThumb]: { body: Buffer.from("avatar"), type: "image/jpeg" } } });
  const r = await canon.retireSweep({ now: LATER });
  assert.equal(r.images, 2);
  assert.equal(r.moved, 2);
  assert.deepEqual(r.tally, { retired: 1, "no-index": 1 });
  assert.ok(store.objects.has(otherThumb), "an avatar's only renditions stay");
});

// THE BOORU HOLDS EVERY IMAGE (operator decision 2026-10-01): an upload record
// with no post, so the booru renders the variants every surface reads -- for a
// DM image or an avatar exactly as for a posted one.
const indexOf = (store) => JSON.parse(store.objects.get(keys.index(ID)).body.toString());

test("every canonical image gets a booru upload and NO post: the one file, named by its md5, recorded in the index", async () => {
  const { store, canon, booru } = rig();
  const r = await canon.canonicalize(ID);
  assert.equal(booru.uploads.length, 1, "uploaded once");
  const sent = booru.uploads[0];
  assert.deepEqual(sent.buffer, store.objects.get(r.key).body, "the bytes the booru got ARE the one file");
  assert.equal(md5hex(sent.buffer), r.md5, "so the booru keys its original at the one file's own key");
  assert.equal(sent.filename, `${r.md5}.png`, "named by its md5, never by what the sender called it");
  assert.equal(sent.type, "image/png");
  assert.equal(r.booru.status, "completed");
  const idx = indexOf(store);
  assert.deepEqual(
    { status: idx.booru.status, upload: idx.booru.upload_id, uma: idx.booru.upload_media_asset_id, asset: idx.booru.media_asset_id },
    { status: "completed", upload: 101, uma: 1010, asset: 10100 },
  );
  assert.ok(store.objects.has(keys.byMd5(r.md5)), "the md5 map (what the booru's media door refuses by) exists before the booru is told");
});

test("the booru is told LAST: after the one file, its md5 map and its index are written", async () => {
  const { store, canon, booru } = rig();
  let seen = null;
  const upload = booru.createUploadFromBytes;
  booru.createUploadFromBytes = async (...a) => {
    seen = [...store.objects.keys()];
    return upload(...a);
  };
  const r = await canon.canonicalize(ID);
  assert.ok(seen.includes(r.key) && seen.includes(keys.byMd5(r.md5)) && seen.includes(keys.index(ID)), seen.join(", "));
});

test("an image the booru already holds is not uploaded again: a post found any of three ways, or variants with no post", async () => {
  const stripped = (await rig().canon.canonicalize(ID, { dryRun: true })).md5;
  const raw = md5hex(png(PROMPT));
  for (const [what, b, md5, via] of [
    ["its stripped md5", fakeBooru({ posts: { [stripped]: { id: 7, md5: stripped, media_asset: { id: 70 } } } }), stripped, "post (stripped)"],
    ["the booru's raw record", fakeBooru({ rawRecords: { [raw]: "0123456789abcdef0123456789abcdef" }, posts: { "0123456789abcdef0123456789abcdef": { id: 8, md5: "0123456789abcdef0123456789abcdef" } } }), "0123456789abcdef0123456789abcdef", "post (raw-record)"],
    ["its raw md5", fakeBooru({ posts: { [raw]: { id: 9, md5: raw } } }), raw, "post (raw)"],
  ]) {
    const { store, canon, booru } = rig({ booru: b });
    await canon.canonicalize(ID);
    assert.equal(booru.uploads.length, 0, `${what}: no upload`);
    const rec = indexOf(store).booru;
    assert.equal(rec.status, "held", what);
    assert.equal(rec.md5, md5, what);
    assert.equal(rec.via, via, what);
  }
  const init = { [keys.source(ID)]: { body: png(PROMPT), type: "image/png" }, [`variants/${stripped}/180x180.jpg`]: { body: Buffer.from("v"), type: "image/jpeg" } };
  const { store, booru } = await (async () => { const x = rig({ storeInit: init }); await x.canon.canonicalize(ID); return x; })();
  assert.equal(booru.uploads.length, 0, "variants with no post: an earlier upload, not uploaded again");
  assert.equal(indexOf(store).booru.via, "variants");
});

test("not an image: no booru record, nothing uploaded", async () => {
  const { canon, booru } = rig({ body: Buffer.from("ciphertext of an encrypted attachment, not an image"), type: "application/octet-stream" });
  const r = await canon.canonicalize(ID);
  assert.equal(r.kind, "source");
  assert.equal(booru.uploads.length, 0);
  assert.equal(r.booru, undefined);
});

test("the booru's verdict on a file is final; a busy booru is retried on the next touch", async () => {
  const refused = rig({ booru: fakeBooru({ uploadError: "File type is not supported" }) });
  await refused.canon.canonicalize(ID);
  assert.equal(indexOf(refused.store).booru.status, "refused");
  await refused.canon.canonicalize(ID);
  assert.equal(refused.booru.uploads.length, 1, "a refusal is not asked again");

  const busy = rig();
  busy.booru.busy = true;
  const r = await busy.canon.canonicalize(ID);
  assert.equal(r.kind, "canonical", "the image is canonical and served whatever the booru says");
  assert.equal(indexOf(busy.store).booru.status, "pending");
  busy.booru.busy = false;
  await busy.canon.canonicalize(ID);
  assert.equal(indexOf(busy.store).booru.status, "completed");
  assert.equal(busy.booru.uploads.length, 1);
});

test("an upload still rendering is asked after on the next touch, never uploaded twice", async () => {
  const { store, canon, booru } = rig();
  booru.rendering = true;
  await canon.canonicalize(ID);
  const first = indexOf(store).booru;
  assert.equal(first.status, "processing");
  assert.equal(first.upload_id, 101);
  booru.rendering = false;
  await canon.canonicalize(ID);
  assert.equal(indexOf(store).booru.status, "completed");
  assert.equal(booru.uploads.length, 1, "the same upload, asked after");
  assert.deepEqual(booru.waited, [101, 101]);
});

test("an index from before every image got a record: the backfill's booruRecord gives it one; its dry run only reads", async () => {
  const { store, canon, booru } = rig();
  booru.busy = true; // canonical, but no record yet
  await canon.canonicalize(ID);
  const legacy = indexOf(store);
  delete legacy.booru; // as written before 2026-10-01
  store.objects.set(keys.index(ID), { body: Buffer.from(JSON.stringify(legacy)), type: "application/json" });
  booru.busy = false;

  const writes = store.writes.length;
  const dry = await canon.booruRecord(ID, { dryRun: true });
  assert.equal(dry.status, "would-upload");
  assert.equal(store.writes.length, writes, "a dry run writes nothing");
  assert.equal(booru.uploads.length, 0, "and uploads nothing");

  const done = await canon.booruRecord(ID);
  assert.equal(done.status, "completed");
  assert.equal(booru.uploads.length, 1);
  assert.equal((await canon.booruRecord(ID)).status, "already");
});

test("the sweep retries only records it tried and could not finish; a legacy index is the backfill's, not the sweep's", async () => {
  const LEGACY = "LegacyLegacyLegacyLegacy";
  const { store, canon, booru } = rig();
  booru.busy = true;
  await canon.canonicalize(ID); // pending
  const legacy = { ...indexOf(store) };
  delete legacy.booru;
  store.objects.set(keys.index(LEGACY), { body: Buffer.from(JSON.stringify(legacy)), type: "application/json" });
  booru.busy = false;
  const r = await canon.booruSweep({ sleep: async () => {} });
  assert.equal(r.tried, 1);
  assert.deepEqual(r.tally, { completed: 1 });
  assert.equal(indexOf(store).booru.status, "completed");
  assert.equal(JSON.parse(store.objects.get(keys.index(LEGACY)).body.toString()).booru, undefined, "the legacy index is left for the backfill");
  const again = await canon.booruSweep({ sleep: async () => {} });
  assert.equal(again.tried, 0, "settled records are not read again");
});

test("an upload record with NO post retires Synapse's renditions like a post does -- and so does a post under a third md5", async () => {
  // Unposted: canon uploaded it, the booru rendered variants, there is no post.
  const { store, canon } = renditionRig({ index: { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5, raw_md5: RAW, booru: { status: "completed", upload_id: 1, upload_media_asset_id: 2, media_asset_id: 3 } } });
  assert.equal((await canon.retireSynapseThumbnails(ID, { now: LATER })).status, "retired");
  for (const k of thumbKeys) assert.ok(!store.objects.has(k));
  // Held under neither md5 canon computed (a post made under older strip rules).
  const THIRD = "0123456789abcdef0123456789abcdef";
  const third = renditionRig({ variantsUnder: THIRD, index: { kind: "canonical", key: `media/${MD5}.jpg`, md5: MD5, raw_md5: RAW, booru: { status: "held", md5: THIRD } } });
  const r = await third.canon.retireSynapseThumbnails(ID, { now: LATER });
  assert.equal(r.status, "retired");
  assert.equal(r.variantsUnder, THIRD);
});
