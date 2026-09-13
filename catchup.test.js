// The catch-up walk, tested without a homeserver -- the readers are injected
// for exactly that reason.
//
// What these pin is the thing the live backfill got wrong: a count that reads
// as completeness when it is not. A run that stopped early, a picture the bot
// could never have seen, and a failure with no reason attached are all states
// this must say out loud rather than fold into "found N".

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { catchUpRoom, imagesIn, summarise } = require("./catchup");

const img = (url, extra = {}) => ({
  type: "m.room.message",
  event_id: `$${url}`,
  content: { msgtype: "m.image", url, ...extra },
});
const pager = (pages) => async (from) => pages[String(from)];

test("only real image events are walked", () => {
  const got = imagesIn([
    img("mxc://a/1"),
    { type: "m.room.message", content: { msgtype: "m.text", body: "hi" } },
    { type: "m.reaction", content: {} },
    { type: "m.room.message", content: { msgtype: "m.image", url: "http://not-mxc/x" } },
    null,
  ]);
  assert.deepEqual(got.map((e) => e.content.url), ["mxc://a/1"]);
});

test("images are replayed oldest first, as the room saw them", () => {
  // The API hands back newest-first with dir=b; posting them in that order
  // would put a thread's later pictures on the booru before its earlier ones.
  const got = imagesIn([img("mxc://a/2"), img("mxc://a/1")]);
  assert.deepEqual(got.map((e) => e.content.url), ["mxc://a/1", "mxc://a/2"]);
});

test("refuses to run without a log, rather than discarding what it cannot say", async () => {
  await assert.rejects(
    () => catchUpRoom({
      roomId: "!r:x",
      adminPage: async () => ({ chunk: [], end: null }),
      onImage: async () => {},
    }),
    (err) => err instanceof TypeError && /log/.test(err.message),
  );
});

test("refuses to run without the admin reader, which is its whole point", async () => {
  await assert.rejects(
    () => catchUpRoom({ roomId: "!r:x", onImage: async () => {}, log: () => {} }),
    (err) => err instanceof TypeError && /adminPage/.test(err.message),
  );
});

test("walks every page and counts what the bot is SEALED from", async () => {
  // The admin reader sees three pictures; the bot's own reader sees one. The
  // difference is the sealed window, and it is the number the operator came for.
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({
      undefined: { chunk: [img("mxc://a/3"), img("mxc://a/2")], end: "p1" },
      p1: { chunk: [img("mxc://a/1")], end: null },
    }),
    botPage: pager({ undefined: { chunk: [img("mxc://a/3")], end: null } }),
    onImage: async () => "posted",
    log: () => {},
  });
  assert.equal(r.seen, 3);
  assert.equal(r.done, 3);
  assert.equal(r.botVisible, 1);
  assert.equal(r.sealed, 2);
  assert.match(summarise(r), /2 of them are sealed to the bot/);
});

test("says so when nothing was sealed, instead of implying a rescue", async () => {
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({ undefined: { chunk: [img("mxc://a/1")], end: null } }),
    botPage: pager({ undefined: { chunk: [img("mxc://a/1")], end: null } }),
    onImage: async () => "posted",
    log: () => {},
  });
  assert.equal(r.sealed, 0);
  assert.match(summarise(r), /nothing here was sealed to it/);
});

test("an unreadable bot view is UNKNOWN, never reported as zero sealed", async () => {
  // Zero sealed is a finding. Failing to ask is not, and the two must not share
  // a number -- that conflation is what made a working backfill read as a total
  // loss earlier today.
  const lines = [];
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({ undefined: { chunk: [img("mxc://a/1")], end: null } }),
    botPage: async () => { throw new Error("403"); },
    onImage: async () => "posted",
    log: (l) => lines.push(l),
  });
  assert.equal(r.sealed, null);
  assert.equal(r.botVisible, null);
  assert.match(summarise(r), /sealed count is unknown/);
  assert.equal(lines.length, 1);
});

test("the same picture posted twice is handled once", async () => {
  const seen = [];
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({
      undefined: { chunk: [img("mxc://a/1"), img("mxc://a/1")], end: "p1" },
      p1: { chunk: [img("mxc://a/1")], end: null },
    }),
    onImage: async (e) => { seen.push(e.content.url); return "posted"; },
    log: () => {},
  });
  assert.equal(seen.length, 1, "the pipeline saw it once");
  assert.equal(r.done, 1);
  assert.equal(r.skipped, 2);
});

test("blocked, failed and done are three different facts", async () => {
  const lines = [];
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({ undefined: { chunk: [img("mxc://a/3"), img("mxc://a/2"), img("mxc://a/1")], end: null } }),
    onImage: async (e) => {
      if (e.content.url === "mxc://a/1") return "tags-blocked";
      if (e.content.url === "mxc://a/2") throw new Error("boom");
      return "posted";
    },
    log: (l) => lines.push(l),
  });
  assert.deepEqual([r.done, r.blocked, r.failed], [1, 1, 1]);
  assert.match(lines[0], /mxc:\/\/a\/2/);
  assert.match(lines[0], /boom/);
});

test("stopping early is SAID, not folded into the count", async () => {
  // backfill.js could not distinguish "walked the whole room" from "hit my page
  // cap", so a large room under-reported silently and read as complete.
  const r = await catchUpRoom({
    roomId: "!r:x",
    // The token MOVES every page: a constant one would stop the walk via the
    // did-not-move guard instead, which is a different thing being tested and
    // is what this test asserted by accident on its first draft.
    adminPage: (() => { let n = 0; return async () => ({ chunk: [img(`mxc://a/${n}`)], end: `p${++n}` }); })(),
    onImage: async () => "posted",
    maxPages: 3,
    log: () => {},
  });
  assert.equal(r.truncated, true);
  assert.equal(r.pages, 3);
  assert.match(summarise(r), /STOPPED EARLY/);
});

test("the cap stops the work and is reported as an early stop", async () => {
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: pager({ undefined: { chunk: [img("mxc://a/3"), img("mxc://a/2"), img("mxc://a/1")], end: null } }),
    onImage: async () => "posted",
    cap: 2,
    log: () => {},
  });
  assert.equal(r.done, 2);
  assert.equal(r.truncated, true);
});

test("a token that never moves does not spin", async () => {
  let calls = 0;
  const r = await catchUpRoom({
    roomId: "!r:x",
    adminPage: async () => { calls++; return { chunk: [], end: "same" }; },
    onImage: async () => "posted",
    log: () => {},
  });
  assert.equal(calls, 2, "stops on the second sight of the same token");
  assert.equal(r.pages, 2);
});

test("a dry run says 'to process', never 'done'", () => {
  // The word is the whole safety property. An operator reading "419 done" after
  // a run that deliberately did nothing has been told the opposite of the truth.
  const r = { roomId: "!r:x", seen: 3, done: 3, blocked: 0, failed: 0, skipped: 0, ms: 1000, sealed: 0, botVisible: 3 };
  assert.match(summarise(r, { dryRun: true }), /3 to process/);
  assert.doesNotMatch(summarise(r, { dryRun: true }), /done/);
  assert.match(summarise(r), /3 done/);
});
