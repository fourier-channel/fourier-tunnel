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
  const objects = new Map(Object.entries(initial).map(([k, v]) => [k, { body: v.body, type: v.type }]));
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
  };
  return store;
}

function rig({ body = png(PROMPT), type = "image/png", info, booru, storeInit } = {}) {
  const store = fakeStore(storeInit || { [keys.source(ID)]: { body, type } });
  const filed = [];
  const canon = createCanon({
    store,
    mediaInfo: async (id) => (id === ID ? (info === undefined ? { media_type: type, user_id: "@alice:41chan.net" } : info) : null),
    booru: booru || { recordGenerationMetadata: async (md5, rec) => { filed.push({ md5, ...rec }); return { md5 }; } },
  });
  return { store, canon, filed };
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
  const booru = {
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
    const booru = { recordGenerationMetadata: async () => { throw Object.assign(new Error("409"), { status: 409, reason }); } };
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
  const other = createCanon({ store, mediaInfo: async () => ({ media_type: "image/png", user_id: "@bob:41chan.net" }), booru: { recordGenerationMetadata: async (md5) => ({ md5 }) } });
  const b = await other.canonicalize(OTHER);
  assert.equal(b.key, a.key);
  assert.equal(store.writes.filter((w) => w[0] === "put" && w[1].startsWith("media/")).length, putsBefore, "no second media/ object");
});

test("a pending record is retried on the next touch, and only then does the original move", async () => {
  let up = false;
  const filed = [];
  const booru = { recordGenerationMetadata: async (md5, rec) => { if (!up) throw Object.assign(new Error("booru down"), { status: 502 }); filed.push(rec); return { md5 }; } };
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
