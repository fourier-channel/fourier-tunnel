"use strict";

// Tests for the backfill walk. The homeserver and the booru are injected, so
// what is under test is the paging and the failure behaviour -- which is the
// part that can loop forever, stop early, or lose pictures.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillRoom, imagesIn, MAX_PAGES } = require("./backfill");

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
  });
  assert.equal(r.pages, MAX_PAGES);
});

test("the cap is honoured and reported", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", cap: 2,
    fetchPage: async () => ({ chunk: [img("a"), img("b"), img("c")].map((e, i) => ({ ...e, content: { ...e.content, url: `mxc://a/${i}` } })), end: "next" }),
    onImage: async () => {},
  });
  assert.equal(r.done, 2);
  assert.equal(r.capped, true);
});

test("an empty room is not an error", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", fetchPage: async () => ({ chunk: [], end: null }), onImage: async () => {},
  });
  assert.equal(r.seen, 0);
  assert.equal(r.done, 0);
  assert.equal(r.failed, 0);
});
