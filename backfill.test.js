"use strict";

// Tests for the backfill walk. The homeserver and the booru are injected, so
// what is under test is the paging and the failure behaviour -- which is the
// part that can loop forever, stop early, or lose pictures.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillRoom, imagesIn, summarise, MAX_PAGES } = require("./backfill");

const img = (url) => ({ type: "m.room.message", content: { msgtype: "m.image", url } });
const txt = (body) => ({ type: "m.room.message", content: { msgtype: "m.text", body } });

test("only real image events are picked up", () => {
  const out = imagesIn([
    img("mxc://a/1"),
    txt("hello"),
    { type: "m.reaction", content: {} },
    { type: "m.room.message", content: { msgtype: "m.image" } },        // no url
    { type: "m.room.message", content: { msgtype: "m.image", url: "https://x" } }, // not mxc
    null,
  ]);
  assert.deepEqual(out.map((e) => e.content.url), ["mxc://a/1"]);
});

test("images come back oldest first", () => {
  // /messages dir=b hands back newest-first; posting in that order would put a
  // room's history into the booru backwards.
  const out = imagesIn([img("mxc://a/3"), img("mxc://a/2"), img("mxc://a/1")]);
  assert.deepEqual(out.map((e) => e.content.url), ["mxc://a/1", "mxc://a/2", "mxc://a/3"]);
});

test("walks every page and processes each image once", async () => {
  const pages = {
    undefined: { chunk: [img("mxc://a/2"), img("mxc://a/1")], end: "p1" },
    p1: { chunk: [img("mxc://a/0")], end: "p2" },
    p2: { chunk: [], end: null },
  };
  const seen = [];
  const r = await backfillRoom({
    roomId: "!r:x", fetchPage: async (f) => pages[String(f)],
    onImage: async (e) => seen.push(e.content.url),
    log: () => {},
  });
  assert.deepEqual(seen, ["mxc://a/1", "mxc://a/2", "mxc://a/0"]);
  assert.equal(r.done, 3);
  assert.equal(r.failed, 0);
});

test("one bad picture does not stop the rest", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], end: null } : { chunk: [img("mxc://a/2"), img("mxc://a/1")], end: "p1" }),
    onImage: async (e) => { if (e.content.url === "mxc://a/1") throw new Error("boom"); },
    log: () => {},
  });
  assert.equal(r.done, 1);
  assert.equal(r.failed, 1);
});

test("a token that never moves does not loop forever", async () => {
  // A homeserver handing back the same pagination token is the shape that turns
  // a walk into a spin.
  let calls = 0;
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async () => { calls++; return { chunk: [], end: "same" }; },
    onImage: async () => {},
    log: () => {},
  });
  // TWO, not one: the first call is what hands us the token, so a repeat can
  // only be detected by using it once. What matters is that it terminates.
  assert.equal(calls, 2, "stops on the second sight of the same token");
  assert.equal(r.pages, 2);
});

test("an endless supply of pages stops at MAX_PAGES", async () => {
  let n = 0;
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async () => ({ chunk: [], end: `p${++n}` }),
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.pages, MAX_PAGES);
});

test("the cap is honoured and reported", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", cap: 2,
    fetchPage: async () => ({ chunk: [img("a"), img("b"), img("c")].map((e, i) => ({ ...e, content: { ...e.content, url: `mxc://a/${i}` } })), end: "next" }),
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.done, 2);
  assert.equal(r.capped, true);
});

test("an empty room is not an error", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", fetchPage: async () => ({ chunk: [], end: null }), onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.seen, 0);
  assert.equal(r.done, 0);
  assert.equal(r.failed, 0);
});

// A FAILURE NOBODY CAN READ IS NOT A REPORT.
//
// log defaulted to a no-op and the only caller never passed one, so on
// 2026-09-13 a run of 266 images reported "0 done, 266 failed" with not one
// reason recorded anywhere. The cause was a ReferenceError thrown AFTER each
// image was fully uploaded and tagged, and it stayed invisible for exactly as
// long as that default existed.
test("refuses to run without a log, rather than discarding what it cannot say", async () => {
  await assert.rejects(
    () => backfillRoom({
      roomId: "!r:x",
      fetchPage: async () => ({ chunk: [], end: null }),
      onImage: async () => {},
    }),
    (err) => err instanceof TypeError && /log/.test(err.message),
  );
});

test("every per-image failure reaches the log, with its reason", async () => {
  const lines = [];
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], end: null } : { chunk: [img("mxc://a/1")], end: "p1" }),
    onImage: async () => { throw new Error("sleep is not defined"); },
    log: (line) => lines.push(line),
  });
  assert.equal(r.failed, 1);
  assert.equal(lines.length, 1, "the one failure was reported once");
  assert.match(lines[0], /mxc:\/\/a\/1/, "names the picture");
  assert.match(lines[0], /sleep is not defined/, "names the reason");
});

// THE PICTURE REACHED THE BOORU; ONLY THE ROOM'S COPY OF ITS TAGS DID NOT.
// Recoverable by re-running once the power level is granted, and not the same
// fact as a failure. Calling it failed is what made a working run read as a
// total loss.
test("a blocked tag state is counted apart from done and from failed", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], end: null }
      : { chunk: [img("mxc://a/3"), img("mxc://a/2"), img("mxc://a/1")], end: "p1" }),
    onImage: async (e) => {
      if (e.content.url === "mxc://a/1") return "tags-blocked";
      if (e.content.url === "mxc://a/2") throw new Error("real failure");
      return "posted";
    },
    log: () => {},
  });
  assert.equal(r.done, 1);
  assert.equal(r.blocked, 1);
  assert.equal(r.failed, 1);
});

test("the summary says posted-but-blocked in words, and stays quiet when there are none", () => {
  const line = summarise({ roomId: "!r:x", seen: 3, done: 1, blocked: 2, failed: 0, capped: false, ms: 1000 });
  assert.match(line, /1 done/);
  assert.match(line, /2 posted but tag state blocked/);
  assert.doesNotMatch(line, /failed/);
  const clean = summarise({ roomId: "!r:x", seen: 1, done: 1, blocked: 0, failed: 0, capped: false, ms: 1000 });
  assert.doesNotMatch(clean, /blocked/);
});

test("the cap counts blocked pictures too, so a blocked room cannot walk forever", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", cap: 2,
    fetchPage: async () => ({ chunk: [img("mxc://a/1"), img("mxc://a/2"), img("mxc://a/3")], end: "next" }),
    onImage: async () => "tags-blocked",
    log: () => {},
  });
  assert.equal(r.blocked, 2);
  assert.equal(r.capped, true);
});
