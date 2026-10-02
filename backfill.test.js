"use strict";

// Tests for the backfill walk. The homeserver and the booru are injected, so
// what is under test is the paging and the failure behaviour -- which is the
// part that can loop forever, stop early, or lose pictures.

const test = require("node:test");
const assert = require("node:assert/strict");
const { backfillRoom, imagesIn, summarise, planWalk, nextState, retryable, describeFailure, MAX_PAGES, MAX_ATTEMPTS } = require("./backfill");

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

test("a picture refused by the strip is counted apart from done, and the summary says it was NOT posted", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], end: null } : { chunk: [img("mxc://a/2"), img("mxc://a/1")], end: "p1" }),
    onImage: async (e) => (e.content.url === "mxc://a/1" ? "strip-refused" : "posted"),
    log: () => {},
  });
  assert.deepEqual([r.done, r.refused, r.failed], [1, 1, 0]);
  assert.match(summarise(r), /1 NOT posted: generation data would not strip/);
  assert.doesNotMatch(summarise({ ...r, refused: 0 }), /NOT posted/);
});

// --- THE HORIZON (2026-10-01) ----------------------------------------------------
//
// Every run used to start at the live edge and walk at most MAX_PAGES pages, keep
// no cursor, and report a spent page budget exactly like a finished room. 38
// pictures in 8 watched rooms sat beyond that line, and !backfill could never get
// past it either. These pin the three facts that were missing: where to resume,
// whether the start was really reached, and which pictures to retry.

const ev = (id, url) => ({ event_id: id, type: "m.room.message", content: { msgtype: "m.image", url } });

test("a page budget spent with history left is NOT the start of the room, and is not the cap either", async () => {
  let n = 0;
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async () => ({ chunk: [], end: `p${++n}` }),   // page 40 still hands back a token
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.pages, MAX_PAGES);
  assert.equal(r.reachedStart, false, "older history remains");
  assert.equal(r.capped, false, "the picture cap was never the reason");
  assert.equal(r.cursor, `p${MAX_PAGES}`, "the next run resumes from the last token");
  assert.match(summarise(r), /OLDER HISTORY NOT YET WALKED/);
  assert.match(summarise(r), /40-page budget/);
});

test("the start of the room is reached only when the homeserver hands back no token", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], start: f } : { chunk: [], start: "edge", end: "p1" }),
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.reachedStart, true);
  assert.equal(r.head, "edge", "where the live edge was when this walk began");
  assert.match(summarise(r), /reached the start of the room/);
  assert.doesNotMatch(summarise(r), /NOT YET WALKED/);
});

test("a run handed a cursor starts there, not at the live edge", async () => {
  const asked = [];
  const r = await backfillRoom({
    roomId: "!r:x", from: "c7",
    fetchPage: async (f) => { asked.push(f); return { chunk: [], end: null }; },
    onImage: async () => {},
    log: () => {},
  });
  assert.deepEqual(asked, ["c7"]);
  assert.equal(r.head, undefined, "a resumed walk does not know where the live edge is");
});

test("`to` reaches the homeserver, so a rejoin's gap walk stops at the last head", async () => {
  const asked = [];
  await backfillRoom({
    roomId: "!r:x", to: "oldhead",
    fetchPage: async (f, t) => { asked.push([f, t]); return { chunk: [], end: null }; },
    onImage: async () => {},
    log: () => {},
  });
  assert.deepEqual(asked, [[undefined, "oldhead"]]);
});

test("a failed picture is counted, logged AND returned with the id that lets a later run retry it", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => (f ? { chunk: [], end: null } : { chunk: [ev("$2", "mxc://a/2"), ev("$1", "mxc://a/1")], end: "p1" }),
    onImage: async (e) => { if (e.content.url === "mxc://a/1") throw new Error("boom"); },
    log: () => {},
  });
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failedMediaIds, ["mxc://a/1"]);
  assert.deepEqual(r.failures, [{ eventId: "$1", url: "mxc://a/1", attempts: 1, error: "boom" }]);
});

test("stopping part-way through a page leaves the cursor AT that page, so the rest is not skipped", async () => {
  const r = await backfillRoom({
    roomId: "!r:x", cap: 1, from: "c3",
    fetchPage: async () => ({ chunk: [ev("$2", "mxc://a/2"), ev("$1", "mxc://a/1")], end: "c4" }),
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.done, 1);
  assert.equal(r.capped, true);
  assert.equal(r.cursor, "c3", "mxc://a/2 is still on page c3");
  assert.equal(r.reachedStart, false);
});

test("a homeserver error mid-walk keeps the pages already walked and says why it stopped", async () => {
  const lines = [];
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async (f) => { if (f === "p2") throw new Error("messages 502"); return { chunk: [], end: f ? "p2" : "p1" }; },
    onImage: async () => {},
    log: (l) => lines.push(l),
  });
  assert.equal(r.pages, 2);
  assert.equal(r.cursor, "p2", "resumes at the page that failed");
  assert.equal(r.error, "messages 502");
  assert.equal(r.reachedStart, false);
  assert.match(lines.join("\n"), /messages 502/);
  assert.match(summarise(r), /stopped by an error: messages 502/);
});

test("a token that never moves is NOT reported as the start of the room", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async () => ({ chunk: [], end: "same" }),
    onImage: async () => {},
    log: () => {},
  });
  assert.equal(r.stalled, true);
  assert.equal(r.reachedStart, false);
  assert.match(summarise(r), /token stopped moving/);
});

test("earlier failures are re-read and retried first; a deleted one is dropped, never posted from memory", async () => {
  const replayed = [];
  const events = { $ok: ev("$ok", "mxc://a/ok"), $again: ev("$again", "mxc://a/again"), $gone: { event_id: "$gone", type: "m.room.message", content: {} } };
  const r = await backfillRoom({
    roomId: "!r:x",
    retry: [
      { eventId: "$ok", url: "mxc://a/ok", attempts: 1 },
      { eventId: "$again", url: "mxc://a/again", attempts: 2 },
      { eventId: "$gone", url: "mxc://a/gone", attempts: 1 },
    ],
    fetchEvent: async (id) => events[id],
    fetchPage: async () => ({ chunk: [], end: null }),
    onImage: async (e) => { replayed.push(e.content.url); if (e.content.url === "mxc://a/again") throw new Error("still broken"); },
    log: () => {},
  });
  assert.deepEqual(replayed, ["mxc://a/ok", "mxc://a/again"], "the redacted one was not replayed");
  assert.equal(r.retried, 2);
  assert.equal(r.done, 1);
  assert.deepEqual(r.failures.map((f) => [f.eventId, f.attempts]), [["$again", 3]]);
  assert.deepEqual(r.dropped.map((f) => f.eventId), ["$gone"]);
});

test("planWalk: what each trigger does with what earlier runs left", () => {
  const none = undefined;
  const partway = { cursor: "c9", head: "h1", reachedStart: false, failed: [] };
  const finished = { cursor: "c40", head: "h1", reachedStart: true, failed: [] };
  const owed = { ...finished, failed: [{ eventId: "$1", url: "mxc://a/1", attempts: 1 }] };
  const givenUp = { ...finished, failed: [{ eventId: "$1", url: "mxc://a/1", attempts: MAX_ATTEMPTS }] };
  const neverStarted = { reachedStart: false, failed: [], lastError: "messages 403" };

  assert.equal(planWalk(none, { trigger: "join" }).kind, "initial");
  assert.equal(planWalk(neverStarted, { trigger: "sweep" }).kind, "initial");
  assert.deepEqual(planWalk(partway, { trigger: "join" }), { kind: "resume", from: "c9", to: undefined });
  assert.deepEqual(planWalk(partway, { trigger: "sweep" }), { kind: "resume", from: "c9", to: undefined });
  assert.deepEqual(planWalk(partway, { trigger: "command" }), { kind: "resume", from: "c9", to: undefined });
  assert.equal(planWalk(finished, { trigger: "join" }).kind, "skip", "a second walk of a finished room is wasted work");
  assert.equal(planWalk(finished, { trigger: "sweep" }).kind, "skip");
  assert.equal(planWalk(finished, { trigger: "command" }).kind, "initial", "an explicit ask overrides done");
  assert.equal(planWalk(partway, { trigger: "command", restart: true }).kind, "initial");
  assert.equal(planWalk(owed, { trigger: "sweep" }).kind, "retry");
  assert.equal(planWalk(givenUp, { trigger: "sweep" }).kind, "skip", "an abandoned picture is not retried for ever");
  assert.deepEqual(planWalk(finished, { trigger: "rejoin" }), { kind: "gap", from: undefined, to: "h1" });
});

test("nextState: progress only moves forward, and each side of the walk keeps its own marker", () => {
  const before = { cursor: "c9", head: "h1", reachedStart: false, failed: [] };
  const resumed = nextState(before, { kind: "resume" }, { pages: 3, cursor: "c12", reachedStart: false, failures: [] }, 1000);
  assert.deepEqual([resumed.cursor, resumed.head, resumed.reachedStart, resumed.lastRunAt], ["c12", "h1", false, 1000]);

  const gap = nextState(resumed, { kind: "gap" }, { pages: 1, cursor: "x", head: "h2", reachedStart: true, failures: [] }, 2000);
  assert.deepEqual([gap.cursor, gap.head, gap.reachedStart], ["c12", "h2", false], "a gap walk never moves the older side");

  const failedFirst = nextState(before, { kind: "resume" }, { pages: 0, cursor: "c9", reachedStart: false, failures: [], error: "messages 502" }, 3000);
  assert.deepEqual([failedFirst.cursor, failedFirst.lastError], ["c9", "messages 502"]);

  const first = nextState(undefined, { kind: "initial" }, { pages: 2, cursor: undefined, head: "h0", reachedStart: true, failures: [] }, 4000);
  assert.deepEqual([first.head, first.reachedStart], ["h0", true]);
  assert.equal(nextState(first, { kind: "initial" }, { pages: 1, reachedStart: true, failures: [] }).lastError, undefined);
});

test("nextState: failures replace the retried list, and one that keeps failing is set aside, not dropped", () => {
  const before = { reachedStart: true, failed: [{ eventId: "$1", url: "mxc://a/1", attempts: MAX_ATTEMPTS - 1 }] };
  const after = nextState(before, { kind: "retry" }, {
    pages: 0, failures: [{ eventId: "$1", url: "mxc://a/1", attempts: MAX_ATTEMPTS, error: "still" }, { eventId: "$2", url: "mxc://a/2", attempts: 1, error: "new" }],
  });
  assert.deepEqual(after.failed.map((f) => f.eventId), ["$2"]);
  assert.deepEqual(after.abandoned.map((f) => f.eventId), ["$1"], "kept with its error, out of the retry list");
  assert.deepEqual(retryable(after).map((f) => f.eventId), ["$2"]);
  const fixed = nextState(after, { kind: "retry" }, { pages: 0, failures: [] });
  assert.deepEqual(fixed.failed, []);
  assert.deepEqual(fixed.abandoned.map((f) => f.eventId), ["$1"]);
});

test("a picture the booru holds under a deleted or jailed post is counted apart: not done, not failed, not retried", async () => {
  const r = await backfillRoom({
    roomId: "!r:x",
    fetchPage: async () => ({ chunk: [img("mxc://a/2"), img("mxc://a/1")] }),
    onImage: async (e) => (e.content.url === "mxc://a/1" ? "held-hidden" : "posted"),
    log: () => {},
  });
  assert.equal(r.hidden, 1);
  assert.equal(r.done, 1);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.failures, [], "nothing owed a retry");
  assert.match(summarise({ ...r, kind: "initial" }), /1 done, 1 NOT posted: the booru holds them under a deleted or jailed post \(see the \[skip\] lines; not retried\)/);
  assert.doesNotMatch(summarise({ ...r, hidden: 0, kind: "initial" }), /deleted or jailed/);
});

// THE ERROR ITSELF, from real axios against a real socket: the shape that
// reached the log on 2026-10-02 as nothing but "Request failed with status
// code 404". A POST answered by a redirect to a page that 404s.
test("describeFailure names an axios failure by method and path -- and the redirect it followed -- never the query, host or key", async () => {
  const http = require("node:http");
  const axios = require("axios");
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") { res.writeHead(302, { location: "/posts/25" }); res.end(); return; }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = axios.create({ baseURL: base, params: { login: "bot", api_key: "SECRETKEY" } });
  try {
    const followed = await client.post("/posts.json", { a: 1 }).then(() => null, (e) => e);
    assert.ok(followed, "precondition: the request failed");
    assert.equal(followed.message, "Request failed with status code 404", "precondition: the bare message the sweep logged");
    assert.equal(describeFailure(followed), "POST /posts.json (redirected to GET /posts/25): Request failed with status code 404");

    const plain = await client.get("/uploads/9.json", { params: { only: "id,status" } }).then(() => null, (e) => e);
    assert.equal(describeFailure(plain), "GET /uploads/9.json: Request failed with status code 404");

    const absolute = await axios.get(`${base}/_matrix/client/v3/rooms/x/messages?access_token=SECRETKEY`).then(() => null, (e) => e);
    assert.equal(describeFailure(absolute), "GET /_matrix/client/v3/rooms/x/messages: Request failed with status code 404");

    for (const e of [followed, plain, absolute]) assert.doesNotMatch(describeFailure(e), /SECRETKEY|api_key|access_token|127\.0\.0\.1|\?/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
  // Not an HTTP error: its own message, untouched.
  assert.equal(describeFailure(new Error("the index for x names y, which is not in the bucket")), "the index for x names y, which is not in the bucket");
  assert.equal(describeFailure("a string"), "a string");
});

test("a failure's log line says what happens next: the next run retries it, or after the last attempt it is set aside", async () => {
  const lines = [];
  const boom = Object.assign(new Error("Request failed with status code 503"), { config: { method: "post", url: "/uploads.json", baseURL: "http://booru" }, response: { status: 503 } });
  const r = await backfillRoom({
    roomId: "!r:x", fetchPage: async () => ({ chunk: [] }), fetchEvent: async (id) => ({ ...img(`mxc://a/${id}`), event_id: id }),
    retry: [{ eventId: "e1", url: "mxc://a/e1", attempts: 0 }, { eventId: "e2", url: "mxc://a/e2", attempts: MAX_ATTEMPTS - 1 }],
    onImage: async () => { throw boom; },
    log: (l) => lines.push(l), maxPages: 0,
  });
  assert.equal(r.failed, 2);
  assert.match(lines[0], /^\[backfill\] !r:x mxc:\/\/a\/e1: POST \/uploads\.json: Request failed with status code 503; retried on the next run \(attempt 1 of 5\)$/);
  assert.match(lines[1], /mxc:\/\/a\/e2: POST \/uploads\.json: .*; failed 5 runs in a row, so the sweep stops retrying it \(kept under "abandoned"\); fix the cause, then !backfill restart walks it again$/);
  assert.equal(r.failures[0].error, "POST /uploads.json: Request failed with status code 503");
});
