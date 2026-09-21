"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const D = require("./drop.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-drop-"));
}

/** A spool root whose queue already exists, as a real deployment's would. */
function tmpWithQueue(source = "matrix") {
  const root = tmp();
  fs.mkdirSync(path.join(root, "_drop", source, "ready"), { recursive: true });
  fs.mkdirSync(path.join(root, "_drop", source, "staging"), { recursive: true });
  return root;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const good = (over = {}) => Object.assign({
  source: "matrix",
  namespace: "matrix",
  containerRef: "!room:41chan.net",
  messageRef: "$event-id-abc",
  filename: "picture.png",
  author: "saber",
  authorRef: "@saber:41chan.net",
  postedAt: "2026-09-21T05:05:05.000Z",
  permalink: "https://matrix.to/#/!room:41chan.net/$event-id-abc",
}, over);

test("a sidecar carries provenance and NOTHING the drain can derive", () => {
  const r = D.buildSidecar(good());
  assert.equal(r.ok, true);
  const s = r.sidecar;
  assert.equal(s.v, D.DROP_SCHEMA_VERSION);
  assert.equal(s.container_ref, "!room:41chan.net");
  assert.equal(s.message_ref, "$event-id-abc");
  assert.equal(s.ext, ".png");
  // The whole point: no digest, no size, no board, no tim, no dimensions.
  // fourier-sampling's ingestObject takes three independent md5 values and
  // cross-checks none of them, so a digest sent from here would be trusted for
  // all three and a stale one would decouple the bytes from every record.
  for (const forbidden of ["md5", "local_md5", "api_md5", "fsize", "size", "board", "tim", "w", "h", "dhash"]) {
    assert.equal(Object.hasOwn(s, forbidden), false, `sidecar must not carry ${forbidden}`);
  }
});

test("an absent optional field is OMITTED, never sent empty", () => {
  const r = D.buildSidecar(good({ author: "", authorRef: null, permalink: undefined, attachmentRef: "" }));
  assert.equal(r.ok, true);
  // The drain validates required fields as non-empty strings, so an empty
  // optional would be a validation failure dressed up as data.
  for (const k of ["author", "author_ref", "permalink", "attachment_ref"]) {
    assert.equal(Object.hasOwn(r.sidecar, k), false, `${k} should be omitted, not empty`);
  }
});

test("the extension is canonicalised, and an uppercase one is not a refusal", () => {
  const r = D.buildSidecar(good({ filename: "HOLIDAY.JPG" }));
  assert.equal(r.ok, true);
  // Normalising here is what keeps the drain from parking it. fourier-sampling
  // refuses a non-canonical ext on purpose: accepting both spellings would put
  // one object on disk under two names.
  assert.equal(r.sidecar.ext, ".jpg");
  assert.equal(r.sidecar.filename, "HOLIDAY.JPG", "the ORIGINAL name is preserved; only ext is canonical");
});

test("an extension the pipeline does not carry is refused HERE, before bytes are written", () => {
  const r = D.buildSidecar(good({ filename: "clip.mov" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /custody/);
});

test("a filename with no extension at all is refused", () => {
  assert.equal(D.buildSidecar(good({ filename: "no-extension-here" })).ok, false);
});

test("an unparseable postedAt is refused rather than guessed", () => {
  const r = D.buildSidecar(good({ postedAt: "sometime last tuesday" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /calendar/);
});

test("a namespace that could escape its directory is refused", () => {
  assert.equal(D.buildSidecar(good({ namespace: "../etc" })).ok, false);
  assert.equal(D.buildSidecar(good({ namespace: "Matrix" })).ok, false, "uppercase is not a legal store namespace");
  assert.throws(() => D.dropPaths("/tmp", "../escape"), /must match/);
});

test("publishing is ONE rename: staging is left empty and ready holds the whole entry", async () => {
  const root = tmpWithQueue();
  const { sidecar } = D.buildSidecar(good());
  const r = await D.publish(root, sidecar, PNG);
  assert.equal(r.ok, true);

  const p = D.dropPaths(root, "matrix");
  assert.deepEqual(fs.readdirSync(p.staging), [], "staging must be empty -- the entry MOVED");
  assert.deepEqual(fs.readdirSync(p.ready), [r.id]);
  assert.deepEqual(fs.readFileSync(path.join(r.dir, "bytes")), PNG);
  const back = JSON.parse(fs.readFileSync(path.join(r.dir, "entry.json"), "utf8"));
  assert.deepEqual(back, sidecar);
});

test("re-delivering the same attachment replaces its entry rather than queueing a second", async () => {
  const root = tmpWithQueue();
  const { sidecar } = D.buildSidecar(good());
  const a = await D.publish(root, sidecar, PNG);
  const b = await D.publish(root, sidecar, PNG);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.id, b.id, "the entry id must be stable for one attachment");
  assert.equal(a.alreadyQueued, false);
  // The second delivery found it already queued. That is success, not a
  // failure: rename(2) will not replace a non-empty directory, and REMOVING
  // the live entry to make room would be worse -- the drain may be reading it,
  // and an entry that vanishes mid-read is the one state an atomic publish
  // exists to prevent.
  assert.equal(b.alreadyQueued, true);
  const p = D.dropPaths(root, "matrix");
  // A restart mid-room must not grow the queue by one copy per restart. The
  // drain is idempotent on replay, but a tmpfs is still finite.
  assert.equal(fs.readdirSync(p.ready).length, 1);
  assert.deepEqual(fs.readdirSync(p.staging), [], "the discarded re-delivery must not linger in staging");
});

test("two attachments on one message get distinct entries", async () => {
  const root = tmpWithQueue();
  const one = D.buildSidecar(good({ attachmentRef: "a1" })).sidecar;
  const two = D.buildSidecar(good({ attachmentRef: "a2" })).sidecar;
  await D.publish(root, one, PNG);
  await D.publish(root, two, PNG);
  assert.equal(fs.readdirSync(D.dropPaths(root, "matrix").ready).length, 2);
});

test("an entry with no bytes is refused", async () => {
  const root = tmpWithQueue();
  const { sidecar } = D.buildSidecar(good());
  assert.equal((await D.publish(root, sidecar, Buffer.alloc(0))).ok, false);
  assert.equal((await D.publish(root, sidecar, null)).ok, false);
});

test("a missing mount is detected at startup, not discovered one image at a time", async () => {
  const r = await D.mountLooksReal(path.join(tmp(), "not-mounted"));
  assert.equal(r.ok, false);
  // The failure this guards: without the mount, every publish would create a
  // directory INSIDE the container, succeed, and deliver into a filesystem that
  // vanishes with it -- entries written, nothing draining them, no error.
  assert.match(r.reason, /bind mount/);
});

test("a real writable directory passes the mount probe and leaves nothing behind", async () => {
  const root = tmp();
  assert.equal((await D.mountLooksReal(root)).ok, true);
  assert.deepEqual(fs.readdirSync(root), [], "the probe must clean up after itself");
});

// THE TWO REPOS SHIP SEPARATELY, WHICH IS THE WHOLE REASON FOR A VERSION.
//
// This container and fourier-sampling's drain are built and deployed
// independently, so the schema can drift without anything noticing until an
// entry is parked in production. When the sibling checkout is present -- a dev
// box, not the container -- this compares the two directly and fails on a
// disagreement. When it is absent it SKIPS OUT LOUD rather than passing: a
// check that cannot run must not be indistinguishable from one that ran and
// agreed.
test("the sidecar schema agrees with fourier-sampling's canon", (t) => {
  const canon = "/home/saber/fourier-sampling/src/drop/types.ts";
  if (!fs.existsSync(canon)) {
    t.skip(`fourier-sampling is not checked out beside this repo (${canon}); schema agreement was NOT verified`);
    return;
  }
  const src = fs.readFileSync(canon, "utf8");

  const vMatch = src.match(/DROP_SCHEMA_VERSION\s*=\s*(\d+)/);
  assert.ok(vMatch, "could not find DROP_SCHEMA_VERSION in the canon file");
  assert.equal(
    Number(vMatch[1]), D.DROP_SCHEMA_VERSION,
    "schema version disagrees with fourier-sampling/src/drop/types.ts -- that file is canon and this is the copy that drifted",
  );

  const reqMatch = src.match(/REQUIRED_SIDECAR_FIELDS[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(reqMatch, "could not find REQUIRED_SIDECAR_FIELDS in the canon file");
  const required = reqMatch[1].split(",").map((s) => s.trim().replace(/^["']|["'],?$/g, "")).filter(Boolean);

  const { sidecar } = D.buildSidecar(good());
  for (const field of required) {
    assert.ok(
      Object.hasOwn(sidecar, field),
      `the drain requires ${field} and this writer does not send it -- every entry would be parked`,
    );
  }
});

// ---- added 2026-09-21, from an adversarial review of this file -------------

test("it REFUSES to create the queue it delivers into", async () => {
  const root = tmp(); // a spool root with no queue in it
  const { sidecar } = D.buildSidecar(good());
  const r = await D.publish(root, sidecar, PNG);
  // mkdir -p made a wrong root succeed perfectly: a queue appears, every
  // publish returns ok, and the drain -- looking at the real path -- reports
  // "waiting 0" and exits 0. Both halves green, zero objects archived.
  assert.equal(r.ok, false);
  assert.match(r.reason, /--init/);
  assert.equal(fs.existsSync(path.join(root, "_drop")), false, "and it must not have created anything");
});

test("the queue path it writes is the one fourier-sampling reads", () => {
  const canon = "/home/saber/fourier-sampling/src/drop/dropdir.ts";
  if (!fs.existsSync(canon)) {
    console.log("  (skipped: fourier-sampling is not checked out beside this repo; path agreement NOT verified)");
    return;
  }
  // Two repositories that must agree about a directory, shipped independently.
  // The first version of this writer built <root>/<source> while the drain
  // built <spool>/_drop/<source>: both correct alone, and together an
  // undocumented convention a mount can satisfy while pointing elsewhere.
  const src = fs.readFileSync(canon, "utf8");
  assert.match(src, /path\.join\(spoolDir, "_drop", source\)/,
    "the drain no longer builds <spool>/_drop/<source>; this writer must be changed to match it");
  assert.equal(D.relativeQueuePath("matrix"), path.join("_drop", "matrix", "ready"));
  const p = D.dropPaths("/spool", "matrix");
  assert.equal(p.ready, path.join("/spool", "_drop", "matrix", "ready"));
});
