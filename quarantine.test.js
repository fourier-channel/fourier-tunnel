"use strict";

// quarantine.js: the booru's quarantine list as the tunnel holds it, and the
// re-projection that takes a flagged name out of every room's tag state on a
// flag and puts it back on a release (operator rulings 2026-10-12).
//
// Driven against stand-ins: a booru that answers getQuarantine and
// getTagProjection from a table, and a homeserver whose rooms hold state
// events and record every write. The state file is real, in a temp dir.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const q = require("./quarantine");
const { QuarantineUnreadable } = require("./danbooru");

const TYPE = "net.41chan.media.tags";
const MIN = 60 * 1000;
const SRC = (auto) => ({ creator: [], auto, both: [], meta: [] });

let dir, file, clock;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-quarantine-"));
  file = path.join(dir, "quarantine.json");
  clock = 1_000_000_000_000;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const now = () => clock;
const quiet = { log: () => {}, warn: () => {}, error: () => {} };
function lines() {
  const out = [];
  return { out, log: (l) => out.push(`log: ${l}`), warn: (l) => out.push(`warn: ${l}`), error: (l) => out.push(`error: ${l}`) };
}

function doc(generation, { flagged = [], banished = [], posts = [] } = {}) {
  return { generation, flagged, banished, posts };
}
const qp = (id, mxc = `mxc://41chan.net/m${id}`, extra = {}) => ({ id, md5: id.toString(16).padStart(32, "0"), mxc, flagged: true, banished: false, ...extra });

// A booru: getQuarantine answers from `answers` (one per call, the last
// repeated), getTagProjection from `projections` (post id -> projection, null
// for 404, an Error to throw).
function booru({ answers = [], projections = {} } = {}) {
  const calls = { quarantine: [], projection: [] };
  return {
    calls,
    answers,
    projections,
    async getQuarantine(opts) {
      calls.quarantine.push(opts);
      const a = answers.length > 1 ? answers.shift() : answers[0];
      if (a instanceof Error) throw a;
      return a;
    },
    async getTagProjection(id) {
      calls.projection.push(id);
      const p = projections[id];
      if (p instanceof Error) throw p;
      return p === undefined ? null : p;
    },
  };
}
const ok = (d, etag = `"${d.generation}-n"`) => ({ status: "ok", doc: d, etag });

// A homeserver: room id -> { [state_key]: content } for the tag state type,
// plus `writes` in order. `refuse` maps a room to the errcode its writes get.
function homeserver(rooms, { refuse = {}, failRead = new Set() } = {}) {
  const writes = [];
  const reads = [];
  const bridge = {
    getIntent: () => ({
      roomState: async (roomId) => {
        reads.push(roomId);
        if (failRead.has(roomId)) throw new Error("M_UNKNOWN: state unreadable");
        return [
          { type: "m.room.create", state_key: "", content: {} },
          ...Object.entries(rooms[roomId] || {}).map(([key, content]) => ({ type: TYPE, state_key: key, content })),
        ];
      },
      sendStateEvent: async (roomId, type, key, content) => {
        if (refuse[roomId]) throw Object.assign(new Error(`${refuse[roomId]}: no`), { errcode: refuse[roomId] });
        assert.equal(type, TYPE);
        writes.push({ roomId, key, content });
        rooms[roomId][key] = content;
      },
    }),
  };
  return { bridge, writes, reads, rooms };
}
const state = (postId, tags, sources = SRC(tags), rating = "q") => ({ post_id: postId, tags, rating, sources, updated_by: "tunnel", updated_at: 1 });
const deps = (hs, extra = {}) => ({ stateType: TYPE, roomIds: async () => Object.keys(hs.rooms), skipRoom: () => false, now, paceMs: 0, log: quiet, ...extra });

// --- names and freshness ---------------------------------------------------------

// STALE GRACE (operator ruling 2026-10-12): when the booru's list cannot be
// read, the tunnel keeps working on the LAST GOOD list for up to 30 minutes,
// loudly, and only then holds its fallback writes (fail closed).
test("the quarantined names are flagged and banished together; fresh means read in the last 30 minutes", () => {
  const d = { ...doc("g", { flagged: ["a"], banished: ["b"] }), checked_at: clock };
  assert.deepEqual([...q.quarantinedNames(d)].sort(), ["a", "b"]);
  assert.equal(q.QUARANTINE_FRESH_MS, 30 * MIN);
  assert.equal(q.fresh(d, clock + 30 * MIN - 1), true);
  assert.equal(q.fresh(d, clock + 30 * MIN), false);
  assert.equal(q.fresh(null, clock), false);
  assert.equal(q.fresh({ ...d, checked_at: undefined }, clock), false);
  assert.deepEqual(q.stripNames(["a", "x", "b"], new Set(["a", "b"])), ["x"]);
  assert.deepEqual(q.stripSources({ creator: ["a"], auto: ["a", "x"], both: [], meta: ["b"] }, new Set(["a", "b"])), { creator: [], auto: ["x"], both: [], meta: [] });
});

// --- the watch: reading, keeping, persisting ----------------------------------------

test("a good read is kept with its time and etag and written to the state file; a 304 refreshes the time", async () => {
  const d1 = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const b = booru({ answers: [ok(d1), { status: "not-modified" }] });
  const w = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  assert.equal(w.current(), null, "nothing read yet");
  assert.equal(await w.refresh(), "ok");
  assert.equal(w.current().generation, "g1");
  assert.equal(w.current().checked_at, clock);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.doc.generation, "g1");
  assert.equal(saved.doc.etag, '"g1-n"');
  assert.equal(saved.doc.checked_at, clock);

  clock += 2 * MIN;
  assert.equal(await w.refresh(), "not-modified");
  assert.deepEqual(b.calls.quarantine[1], { ifNoneMatch: '"g1-n"' }, "the etag is sent back");
  assert.equal(w.current().checked_at, clock, "a 304 is a good read");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).doc.checked_at, clock);
});

test("an unreadable list keeps the last good one for the 30-minute grace, LOUDLY from the first failure, then nothing is fresh -- and the reason says why", async () => {
  const unreadable = new QuarantineUnreadable("the booru is older than the quarantine build -- deploy chanbooru");
  const b = booru({ answers: [ok(doc("g1", { flagged: ["secret"] })), unreadable, unreadable] });
  const log = lines();
  const w = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log });
  await w.refresh();
  clock += 1 * MIN;
  assert.equal(await w.refresh(), "unreadable");
  assert.equal(q.fresh(w.current(), clock), true, "a minute-old good read still stands");
  assert.ok(log.out.some((l) => /^error: \[quarantine\] the booru's quarantine list is UNREADABLE: the booru is older .*deploy chanbooru\. Working on the last good list, read 60s ago: a tag flagged since then is not stripped until the booru answers; fallback tag writes are held in 29 min/.test(l)), log.out.join("\n"));
  clock += 25 * MIN;
  assert.equal(q.fresh(w.current(), clock), true, "26 minutes old: still inside the grace");
  clock += 4 * MIN;
  assert.equal(q.fresh(w.current(), clock), false);
  assert.match(w.reason(), /last read 1800s ago.*deploy chanbooru/);
  // The grace running out is said at once, not at the next nag.
  assert.equal(await w.refresh(), "unreadable");
  assert.ok(log.out.some((l) => /^error: \[quarantine\] .*the 30-minute grace is over: fallback tag writes are held until it is read/.test(l)), log.out.join("\n"));
});

test("a never-read list is not fresh, and its reason says so", () => {
  const w = q.createQuarantineWatch({ danbooru: booru(), file: () => file, now, log: quiet });
  assert.equal(q.fresh(w.current(), clock), false);
  assert.match(w.reason(), /never read/);
});

test("a restarted tunnel picks up the persisted list and what it last projected", async () => {
  const d1 = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const w1 = q.createQuarantineWatch({ danbooru: booru({ answers: [ok(d1)] }), file: () => file, now, log: quiet });
  await w1.refresh();
  w1.markProjected(w1.current());
  const w2 = q.createQuarantineWatch({ danbooru: booru(), file: () => file, now, log: quiet });
  assert.equal(w2.current().generation, "g1");
  assert.deepEqual(w2.projected(), { generation: "g1", flagged: ["secret"], banished: [], posts: [{ id: 1, mxc: "mxc://41chan.net/m1" }] });
});

test("a corrupt state file is said out loud and treated as never read -- never as an empty list", () => {
  fs.writeFileSync(file, "{not json");
  const log = lines();
  const w = q.createQuarantineWatch({ danbooru: booru(), file: () => file, now, log });
  assert.equal(w.current(), null);
  assert.ok(log.out.some((l) => /^warn: \[quarantine\] .*quarantine\.json.*unreadable/.test(l)), log.out.join("\n"));
});

// --- re-projection: flag, release, hidden, idempotent ---------------------------------

test("FLAG: every room's state for a post carrying the flagged name is rewritten from the booru's stripped projection -- by mxc AND by post id", async () => {
  const hs = homeserver({
    "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]), "mxc://41chan.net/other": state(9, ["dog"]) },
    // The same picture re-posted in another room: its own mxc, the same post.
    "!b:41chan.net": { "mxc://41chan.net/repost": state(1, ["cat", "secret"]) },
  });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const next = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const log = lines();
  const r = await q.reprojectQuarantine(hs.bridge, b, null, next, deps(hs, { log }));
  assert.equal(r.complete, true);
  assert.equal(r.written, 2);
  assert.deepEqual(hs.writes.map((x) => [x.roomId, x.key]), [["!a:41chan.net", "mxc://41chan.net/m1"], ["!b:41chan.net", "mxc://41chan.net/repost"]]);
  for (const wr of hs.writes) {
    assert.deepEqual(wr.content.tags, ["cat"]);
    assert.deepEqual(wr.content.sources, SRC(["cat"]));
    assert.equal(wr.content.post_id, 1);
    assert.equal(wr.content.rating, "q");
    assert.equal(wr.content.updated_by, "tunnel");
    assert.equal(wr.content.updated_at, clock);
  }
  assert.deepEqual(hs.rooms["!a:41chan.net"]["mxc://41chan.net/other"].tags, ["dog"], "an unaffected picture is not touched");
  assert.ok(log.out.some((l) => /room 1\/2/.test(l)) && log.out.some((l) => /room 2\/2/.test(l)), log.out.join("\n"));
});

test("the booru's projection is stripped here too: a flagged name never reaches a room even from an older booru", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) } });
  const b = booru({ projections: { 1: { tags: ["cat", "secret"], sources: SRC(["cat", "secret"]) } } });
  await q.reprojectQuarantine(hs.bridge, b, null, doc("g1", { flagged: ["secret"], posts: [qp(1)] }), deps(hs));
  assert.deepEqual(hs.writes[0].content.tags, ["cat"]);
  assert.deepEqual(hs.writes[0].content.sources, SRC(["cat"]));
});

test("RELEASE: a post that left the list gets the booru's whole projection back", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"]) } });
  const b = booru({ projections: { 1: { tags: ["cat", "secret"], sources: SRC(["cat", "secret"]) } } });
  const prev = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const r = await q.reprojectQuarantine(hs.bridge, b, prev, doc("g2"), deps(hs));
  assert.equal(r.complete, true);
  assert.deepEqual(hs.writes[0].content.tags, ["cat", "secret"]);
});

test("one of two flagged names released: the post stays affected and keeps losing the other", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"]) } });
  const b = booru({ projections: { 1: { tags: ["cat", "one"], sources: SRC(["cat", "one"]) } } });
  const prev = doc("g1", { flagged: ["one", "two"], posts: [qp(1)] });
  const next = doc("g2", { flagged: ["two"], posts: [qp(1)] });
  await q.reprojectQuarantine(hs.bridge, b, prev, next, deps(hs));
  assert.deepEqual(hs.writes[0].content.tags, ["cat", "one"]);
});

test("a post HIDDEN from the tunnel (404: flagged, uploaded by another bot) is rewritten from the room's own state, minus the names", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret", "gross"], { creator: [], auto: ["cat", "secret"], both: [], meta: ["gross"] }) } });
  const b = booru({ projections: { 1: null } });
  const r = await q.reprojectQuarantine(hs.bridge, b, null, doc("g1", { flagged: ["secret"], banished: ["gross"], posts: [qp(1)] }), deps(hs));
  assert.equal(r.complete, true);
  assert.deepEqual(hs.writes[0].content.tags, ["cat"]);
  assert.deepEqual(hs.writes[0].content.sources, { creator: [], auto: ["cat"], both: [], meta: [] });
});

test("idempotent: a second run over the same documents writes nothing", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) } });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const next = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  await q.reprojectQuarantine(hs.bridge, b, null, next, deps(hs));
  assert.equal(hs.writes.length, 1);
  const again = await q.reprojectQuarantine(hs.bridge, b, null, next, deps(hs));
  assert.equal(hs.writes.length, 1, "nothing new written");
  assert.equal(again.current, 1);
  assert.equal(again.complete, true);
});

test("a denied room is passed by; a room that refuses the write is reported with its remedy and does not hold the run open", async () => {
  const hs = homeserver({
    "!denied:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) },
    "!locked:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) },
  }, { refuse: { "!locked:41chan.net": "M_FORBIDDEN" } });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const log = lines();
  const r = await q.reprojectQuarantine(hs.bridge, b, null, doc("g1", { flagged: ["secret"], posts: [qp(1)] }),
    deps(hs, { skipRoom: (room) => room === "!denied:41chan.net", log }));
  assert.deepEqual(hs.reads, ["!locked:41chan.net"], "the denied room is not even read");
  assert.equal(r.refused, 1);
  assert.equal(r.complete, true);
  assert.ok(log.out.some((l) => /^error: \[quarantine\] .*!locked:41chan\.net.*refused.*tools\/grant-tag-write\.sh/.test(l)), log.out.join("\n"));
});

test("a booru that cannot answer for a post: a name in the room is stripped anyway, and the run is NOT complete, so it is retried", async () => {
  const hs = homeserver({
    "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]), "mxc://41chan.net/m2": state(2, ["cat"]) },
  });
  const boom = new Error("GET /posts/1/tag_sources.json -> 500");
  const b = booru({ projections: { 1: boom, 2: boom } });
  const prev = doc("g0", { flagged: ["old"], posts: [qp(2)] });
  const r = await q.reprojectQuarantine(hs.bridge, b, prev, doc("g1", { flagged: ["secret"], posts: [qp(1)] }), deps(hs));
  assert.equal(r.complete, false);
  assert.equal(r.failed, 2);
  assert.deepEqual(hs.writes.map((x) => [x.key, x.content.tags]), [["mxc://41chan.net/m1", ["cat"]]], "the name is out; the release waits for the booru");
});

test("a room whose state cannot be read leaves the run incomplete; the other rooms are still done", async () => {
  const hs = homeserver({
    "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) },
    "!b:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) },
  }, { failRead: new Set(["!a:41chan.net"]) });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const r = await q.reprojectQuarantine(hs.bridge, b, null, doc("g1", { flagged: ["secret"], posts: [qp(1)] }), deps(hs));
  assert.equal(r.complete, false);
  assert.deepEqual(hs.writes.map((x) => x.roomId), ["!b:41chan.net"]);
});

// --- the tick: read, then re-project against what was last projected -----------------

test("the first read after a restart re-projects against the PERSISTED previous list, so a release while the tunnel was down is caught", async () => {
  const prev = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const w1 = q.createQuarantineWatch({ danbooru: booru({ answers: [ok(prev)] }), file: () => file, now, log: quiet });
  await w1.refresh();
  w1.markProjected(w1.current());

  // Down; meanwhile the operator released "secret". Up again.
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"]) } });
  const b = booru({ answers: [ok(doc("g2"))], projections: { 1: { tags: ["cat", "secret"], sources: SRC(["cat", "secret"]) } } });
  const w2 = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  const t = await q.quarantineTick(w2, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(t.read, "ok");
  assert.equal(t.reprojected.complete, true);
  assert.deepEqual(hs.writes[0].content.tags, ["cat", "secret"]);
  assert.equal(w2.projected().generation, "g2");

  // Same generation next time: nothing to do, and the rooms are not read.
  b.answers.splice(0, b.answers.length, { status: "not-modified" });
  const t2 = await q.quarantineTick(w2, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(t2.reprojected, null);
  assert.deepEqual(hs.reads, ["!a:41chan.net"]);
});

test("an incomplete re-projection is kept owed: the projected generation does not move, and it is retried after a pause", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) } }, { failRead: new Set(["!a:41chan.net"]) });
  const b = booru({ answers: [ok(doc("g1", { flagged: ["secret"], posts: [qp(1)] })), { status: "not-modified" }], projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const w = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  const d = { bridge: hs.bridge, danbooru: b, ...deps(hs) };
  const t1 = await q.quarantineTick(w, d);
  assert.equal(t1.reprojected.complete, false);
  assert.equal(w.projected(), null);
  clock += 1 * MIN;
  assert.equal((await q.quarantineTick(w, d)).reprojected, null, "not hammered every minute");
  clock += 5 * MIN;
  const t3 = await q.quarantineTick(w, d);
  assert.ok(t3.reprojected, "retried after the pause");
});

test("no re-projection runs from a list that is not fresh", async () => {
  const hs = homeserver({ "!a:41chan.net": {} });
  const b = booru({ answers: [new QuarantineUnreadable("down")] });
  const w = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  const t = await q.quarantineTick(w, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(t.read, "unreadable");
  assert.equal(t.reprojected, null);
  assert.deepEqual(hs.reads, []);
});

// --- writes held while the list could not be read ---------------------------------------

test("a fallback write held while the list was unread is written, stripped, on the next good read", async () => {
  const hs = homeserver({ "!a:41chan.net": {} });
  const b = booru({ answers: [ok(doc("g1", { flagged: ["secret"] }))], projections: { 5: null } });
  const w = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  w.hold({ roomId: "!a:41chan.net", mxcUrl: "mxc://41chan.net/m5", postId: 5, rating: "s", tags: ["cat", "secret"], sources: SRC(["cat", "secret"]) });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).held.length, 1, "kept across a restart");
  const t = await q.quarantineTick(w, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(t.heldWritten, 1);
  assert.deepEqual(hs.writes[0], {
    roomId: "!a:41chan.net", key: "mxc://41chan.net/m5",
    content: { post_id: 5, tags: ["cat"], rating: "s", sources: SRC(["cat"]), updated_by: "tunnel", updated_at: clock },
  });
  assert.deepEqual(w.held(), []);
});

test("a watch outside the service (a tool) reads the service's saved list but never writes the file and never holds", async () => {
  const d1 = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const svc = q.createQuarantineWatch({ danbooru: booru({ answers: [ok(d1)] }), file: () => file, now, log: quiet });
  await svc.refresh();
  const before = fs.readFileSync(file, "utf8");
  const tool = q.createQuarantineWatch({ danbooru: booru({ answers: [ok(doc("g2"))] }), file: () => file, now, log: quiet, service: false });
  assert.equal(tool.current().generation, "g1", "it starts from what the service last read");
  await tool.refresh();
  assert.equal(tool.current().generation, "g2");
  assert.equal(tool.hold({ roomId: "!a:41chan.net", mxcUrl: "mxc://41chan.net/x", postId: 1, rating: "q", tags: [], sources: {} }), false);
  assert.deepEqual(tool.held(), []);
  assert.equal(fs.readFileSync(file, "utf8"), before, "the service's file is untouched");
});

test("RELEASE of a legacy post with no recorded provenance: its tag string, as the tunnel's account sees it, comes back", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"], SRC([])) } });
  const b = booru({ projections: { 1: { tags: [], sources: SRC([]) } } });
  b.findVisiblePost = async (id) => (id === 1 ? { id: 1, tag_string: "cat secret gross" } : null);
  const prev = doc("g1", { flagged: ["secret"], banished: ["gross"], posts: [qp(1)] });
  const next = doc("g2", { banished: ["gross"], posts: [qp(1)] });
  const r = await q.reprojectQuarantine(hs.bridge, b, prev, next, deps(hs));
  assert.equal(r.complete, true);
  assert.deepEqual(hs.writes[0].content.tags, ["cat", "secret"], "the released name is back; the banished one stays out");
});

// --- LEAN: a new carrier of an unchanged list costs only itself ------------------------
//
// Review 2026-10-12: every generation change re-asked the booru for EVERY post
// in the old and new lists that sat in a room. A common tag flagged makes every
// new upload carrying it a new generation, so each minute re-asked the booru
// for the whole flagged set. When the NAMES did not change, a post that stays
// in the list already has its stripped state; only the posts that joined or
// left need anything.

test("names unchanged: only the posts that joined or left the list are asked about and rewritten", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"]), "mxc://41chan.net/m2": state(2, ["dog", "secret"]), "mxc://41chan.net/m3": state(3, ["owl"]) } });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) }, 2: { tags: ["dog"], sources: SRC(["dog"]) }, 3: { tags: ["owl", "fox"], sources: SRC(["owl", "fox"]) } } });
  const prev = doc("g1", { flagged: ["secret"], posts: [qp(1), qp(3)] });
  const next = doc("g2", { flagged: ["secret"], posts: [qp(1), qp(2)] });
  const r = await q.reprojectQuarantine(hs.bridge, b, prev, next, deps(hs));
  assert.equal(r.complete, true);
  assert.deepEqual(b.calls.projection.sort(), [2, 3], "post 1 stayed in an unchanged list: the booru is not asked about it");
  assert.deepEqual(hs.writes.map((x) => [x.key, x.content.tags]), [["mxc://41chan.net/m2", ["dog"]], ["mxc://41chan.net/m3", ["owl", "fox"]]]);
});

test("names unchanged across a restart: what was projected keeps its names, so the next tick asks only about the new post", async () => {
  const g1 = doc("g1", { flagged: ["secret"], posts: [qp(1)] });
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat"]), "mxc://41chan.net/m2": state(2, ["dog", "secret"]) } });
  const b = booru({ answers: [ok(g1)], projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) }, 2: { tags: ["dog"], sources: SRC(["dog"]) } } });
  const w1 = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  await q.quarantineTick(w1, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(w1.projected().generation, "g1");
  b.calls.projection.length = 0;

  b.answers.splice(0, b.answers.length, ok(doc("g2", { flagged: ["secret"], posts: [qp(1), qp(2)] })));
  const w2 = q.createQuarantineWatch({ danbooru: b, file: () => file, now, log: quiet });
  const t = await q.quarantineTick(w2, { bridge: hs.bridge, danbooru: b, ...deps(hs) });
  assert.equal(t.reprojected.complete, true);
  assert.deepEqual(b.calls.projection, [2]);
  assert.deepEqual(hs.rooms["!a:41chan.net"]["mxc://41chan.net/m2"].tags, ["dog"]);
});

test("a projected record saved before names were kept (no names): the whole union is re-projected, as before", async () => {
  const hs = homeserver({ "!a:41chan.net": { "mxc://41chan.net/m1": state(1, ["cat", "secret"]) } });
  const b = booru({ projections: { 1: { tags: ["cat"], sources: SRC(["cat"]) } } });
  const r = await q.reprojectQuarantine(hs.bridge, b, { generation: "g1", posts: [{ id: 1, mxc: "mxc://41chan.net/m1" }] }, doc("g2", { flagged: ["secret"], posts: [qp(1)] }), deps(hs));
  assert.equal(r.complete, true);
  assert.deepEqual(hs.writes.map((x) => x.content.tags), [["cat"]]);
});
