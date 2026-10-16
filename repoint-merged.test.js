"use strict";

// tools/repoint-merged.js: after the booru MERGES duplicate posts of one
// picture (operator ruling 2026-10-16) -- one post survives, the other is
// retired and its image becomes an mxc alias of the survivor -- every room's
// tag state naming a retired post is re-pointed at its survivor, through
// index.js pointRoomAtPost itself.
//
// Driven against the REAL pointRoomAtPost (index.js loaded from a throwaway
// config, as index.test.js does) and the real DanbooruClient, talking HTTP to
// a stand-in booru that records every request; the homeserver is an
// in-memory bridge whose rooms hold tag state and record every write.
//
// What it must never do: write in a dry run; touch a post that is not
// retired; write a pair whose survivor the tunnel cannot see; write a flagged
// or banished name; send a second alias report; stop the walk for one bad
// room; write anything on a re-run; carry the api key in a URL.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DanbooruClient } = require("./danbooru");
const quarantineLib = require("./quarantine");

const TYPE = "net.41chan.media.tags";
const SRC = (auto, both = []) => ({ creator: [], auto, both, meta: [] });
const QDOC = { generation: "0123456789abcdef", flagged: ["secret_tag"], banished: ["gross"], posts: [], next_after: null };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// --- the booru ---------------------------------------------------------------------

let world;
function resetWorld() {
  world = {
    posts: {
      20: { id: 20, md5: "2".repeat(32), rating: "s", tag_string: "cat dog" },
      // A legacy survivor: no recorded provenance, so pointRoomAtPost falls
      // back to its tag string -- which carries a flagged and a banished name.
      22: { id: 22, md5: "3".repeat(32), rating: "q", tag_string: "1girl secret_tag gross hoodie" },
      // 21 is absent: deleted, jailed, or hidden from the tunnel's account.
    },
    projections: {
      20: { tags: ["cat", "dog"], sources: SRC(["cat"], ["dog"]) },
      22: { tags: [], sources: SRC([]) },
    },
    quarantine: QDOC,
    projectionDown: new Set(), // post ids whose tag_sources read answers 503
    requests: [], // { method, path, query, authorization }
  };
}

function handle(req, res) {
  const url = new URL(req.url, "http://x");
  world.requests.push({ method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization });
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const post = /^\/posts\/(\d+)\.json$/.exec(url.pathname);
  const projection = /^\/posts\/(\d+)\/tag_sources\.json$/.exec(url.pathname);
  if (req.method === "GET" && post) {
    const p = world.posts[post[1]];
    return p ? send(200, p) : send(404, { success: false, message: "That record was not found." });
  }
  if (req.method === "GET" && projection) {
    if (world.projectionDown.has(Number(projection[1]))) return send(503, { error: "busy", fix: "wait" });
    const p = world.posts[projection[1]] && world.projections[projection[1]];
    return p ? send(200, p) : send(404, { success: false, message: "That record was not found." });
  }
  if (req.method === "GET" && url.pathname === "/fourier_jail/release.json") {
    return world.quarantine ? send(200, world.quarantine) : send(503, { error: "down", fix: "wait" });
  }
  return send(599, { error: `the stand-in has no route for ${req.method} ${url.pathname}` });
}

// --- the homeserver ------------------------------------------------------------------

// room id -> { [mxc]: content }. Every room also carries a non-tag state event.
function seedRooms() {
  const c = (post_id, tags) => ({ post_id, rating: "q", tags, sources: SRC(tags), updated_by: "tunnel", updated_at: 1 });
  return {
    "!a:41chan.net": {
      "mxc://41chan.net/r1": c(10, ["old_tag"]),     // retired 10 -> 20
      "mxc://41chan.net/u1": c(99, ["unrelated"]),   // not in any pair
      "mxc://41chan.net/s1": c(20, ["cat", "dog"]),  // already the survivor
    },
    "!b:41chan.net": {
      "mxc://41chan.net/r2": c(11, ["x"]),           // retired 11 -> 21, survivor hidden
      "mxc://41chan.net/r3": c(12, ["y"]),           // retired 12 -> 22, legacy survivor
    },
    "!c:41chan.net": { "mxc://41chan.net/r5": c(10, ["z"]) }, // unreadable
    "!d:41chan.net": { "mxc://41chan.net/r4": c(10, ["w"]) }, // retired 10 again, another room
    "!denied:41chan.net": { "mxc://41chan.net/r6": c(10, ["v"]) },
  };
}

function homeserver(rooms, { failRead = new Set(), refuse = new Set() } = {}) {
  const writes = [];
  const bridge = {
    getIntent: () => ({
      roomState: async (roomId) => {
        if (failRead.has(roomId)) throw new Error("M_UNKNOWN: state unreadable");
        return [
          { type: "m.room.create", state_key: "", content: {} },
          ...Object.entries(rooms[roomId] || {}).map(([key, content]) => ({ type: TYPE, state_key: key, content })),
        ];
      },
      getStateEvent: async (roomId, type, key) => {
        const content = type === TYPE && rooms[roomId] && rooms[roomId][key];
        if (!content) throw Object.assign(new Error("M_NOT_FOUND"), { errcode: "M_NOT_FOUND" });
        return content;
      },
      sendStateEvent: async (roomId, type, key, content) => {
        if (refuse.has(roomId)) throw Object.assign(new Error("M_FORBIDDEN: power level"), { errcode: "M_FORBIDDEN" });
        writes.push({ roomId, type, key, content });
        rooms[roomId][key] = content;
        return {};
      },
    }),
  };
  return { bridge, writes, rooms };
}

// --- the module under test ---------------------------------------------------------

let server, dir, index, tool;
before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-repoint-"));
  fs.writeFileSync(path.join(dir, "config.yaml"), [
    "homeserver:", `  url: "${base}"`, "  domain: \"41chan.net\"",
    "danbooru:", `  url: "${base}"`, "  username: \"tunnel\"", "  api_key: \"TESTKEY\"",
    "bridge:", "  disabled_rooms: []", "  default_rating: \"q\"", "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "registration.yaml"), "as_token: TESTTOKEN\nsender_localpart: tunnel\n");
  process.env.FOURIER_TUNNEL_CONFIG = path.join(dir, "config.yaml");
  process.env.FOURIER_TUNNEL_REGISTRATION = path.join(dir, "registration.yaml");
  process.env.ONBOARDING_STATE_DIR = dir;
  delete process.env.HOMESERVER_URL;
  index = require("./index");
  tool = require("./tools/repoint-merged");
});
after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});
// A never-read quarantine watch, read from the stand-in booru on demand.
function freshWatch() {
  const file = path.join(dir, "quarantine-under-test.json");
  fs.rmSync(file, { force: true });
  index.setQuarantine(quarantineLib.createQuarantineWatch({
    danbooru: new DanbooruClient(index.config.danbooru), file: () => file, log: quiet, service: false,
  }));
}
beforeEach(() => {
  resetWorld();
  freshWatch();
});

const PAIRS = new Map([[10, 20], [11, 21], [12, 22]]);

// One run of the tool's core with everything it prints, and console quietened
// (pointRoomAtPost logs through console).
async function run(hs, { apply, pairs = PAIRS, rooms = Object.keys(hs.rooms), paceMs = 0, sleep = async () => {} } = {}) {
  const out = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = () => {};
  try {
    const danbooru = new DanbooruClient(index.config.danbooru);
    const s = await tool.repointMerged({
      pairs, apply, bridge: hs.bridge, stateType: index.TAG_STATE_TYPE,
      roomIds: async () => rooms,
      skipRoom: (roomId) => roomId === "!denied:41chan.net",
      findSurvivor: (id) => danbooru.findVisiblePost(id),
      readProjection: (id) => danbooru.getTagProjection(id),
      pointRoomAtPost: index.pointRoomAtPost,
      paceMs, sleep,
      out: (l) => out.push(l),
    });
    return { s, out };
  } finally {
    Object.assign(console, saved);
  }
}

test("a dry run lists exactly the tag state naming a retired post -- room, mxc, retired -> survivor -- and writes and asks NOTHING", async () => {
  const hs = homeserver(seedRooms(), { failRead: new Set(["!c:41chan.net"]) });
  const { s, out } = await run(hs, { apply: false });
  assert.deepEqual(out.filter((l) => !l.startsWith("#")), [
    "REPOINT\t!a:41chan.net\tmxc://41chan.net/r1\t10 -> 20",
    "REPOINT\t!b:41chan.net\tmxc://41chan.net/r2\t11 -> 21",
    "REPOINT\t!b:41chan.net\tmxc://41chan.net/r3\t12 -> 22",
    "ROOM-FAIL\t!c:41chan.net\tits state could not be read (M_UNKNOWN: state unreadable); fix: check the tunnel is joined there and the homeserver answers, then run this again",
    "REPOINT\t!d:41chan.net\tmxc://41chan.net/r4\t10 -> 20",
  ]);
  assert.deepEqual(hs.writes, [], "a dry run writes nothing");
  assert.deepEqual(world.requests, [], "a dry run asks the booru nothing");
  assert.deepEqual([s.rooms, s.unreadable, s.events, s.written, s.failed], [4, 1, 4, 0, 1]);
  // n/N progress, one line per room walked (the denied room is not walked).
  assert.equal(out.filter((l) => /^# room \d+\/4 /.test(l)).length, 4, out.join("\n"));
  assert.equal(tool.exitCodeFor(s), 1, "an unreadable room fails the run");
});

test("--apply re-points only the retired events at the survivor, with the survivor's public projection; unrelated and current state untouched; no alias report", async () => {
  const rooms = seedRooms();
  delete rooms["!c:41chan.net"];
  const hs = homeserver(rooms);
  const { s, out } = await run(hs, { apply: true });
  assert.deepEqual(hs.writes.map((w) => [w.roomId, w.key, w.content.post_id, w.content.rating, w.content.tags, w.content.sources]), [
    ["!a:41chan.net", "mxc://41chan.net/r1", 20, "s", ["cat", "dog"], SRC(["cat"], ["dog"])],
    ["!b:41chan.net", "mxc://41chan.net/r3", 22, "q", ["1girl", "hoodie"], SRC([])],
    ["!d:41chan.net", "mxc://41chan.net/r4", 20, "s", ["cat", "dog"], SRC(["cat"], ["dog"])],
  ]);
  assert.ok(hs.writes.every((w) => w.type === TYPE && w.content.updated_by === "tunnel"));
  assert.equal(rooms["!a:41chan.net"]["mxc://41chan.net/u1"].post_id, 99, "an unrelated post is untouched");
  assert.equal(rooms["!a:41chan.net"]["mxc://41chan.net/s1"].updated_at, 1, "the survivor's own state is untouched");
  assert.deepEqual(world.requests.filter((r) => r.method !== "GET"), [], "aliased: no second alias report");
  assert.deepEqual([s.events, s.written, s.current, s.missing, s.failed], [4, 3, 0, 1, 0]);
  assert.ok(out.includes("REPOINTED\t!a:41chan.net\tmxc://41chan.net/r1\t10 -> 20"), out.join("\n"));
  assert.equal(tool.exitCodeFor(s), 1, "a missing survivor fails the run");
});

test("a survivor the tunnel cannot see is reported loudly, with the fix, and NOTHING is written for that pair", async () => {
  const hs = homeserver({ "!b:41chan.net": seedRooms()["!b:41chan.net"] });
  const { s, out } = await run(hs, { apply: true });
  assert.deepEqual(hs.writes.map((w) => w.key), ["mxc://41chan.net/r3"]);
  assert.equal(hs.rooms["!b:41chan.net"]["mxc://41chan.net/r2"].post_id, 11);
  const missing = out.filter((l) => l.startsWith("MISSING\t"));
  assert.equal(missing.length, 1, out.join("\n"));
  assert.match(missing[0], /^MISSING\t!b:41chan\.net\tmxc:\/\/41chan\.net\/r2\t11 -> 21\tsurvivor #21 is missing or hidden from the tunnel's booru account.*fix: /);
  assert.ok(out.some((l) => /^# FAILED .*#21.*fix: /.test(l)), "listed again in the summary with its fix:\n" + out.join("\n"));
  assert.equal(s.missing, 1);
});

test("a flagged or banished name is never written: the legacy fallback is stripped, and with the list unreadable it is not written at all", async () => {
  const hs = homeserver({ "!b:41chan.net": seedRooms()["!b:41chan.net"] });
  await run(hs, { apply: true });
  assert.deepEqual(hs.writes.map((w) => w.content.tags), [["1girl", "hoodie"]]);

  // A list never read (not one read a moment ago: the 30-minute grace would
  // rightly let that one govern), and the booru cannot answer for it.
  resetWorld();
  freshWatch();
  world.quarantine = null;
  const hs2 = homeserver({ "!b:41chan.net": seedRooms()["!b:41chan.net"] });
  const { s, out } = await run(hs2, { apply: true });
  assert.deepEqual(hs2.writes, [], "nothing that could not be checked is written");
  assert.equal(s.failed, 1);
  assert.ok(out.some((l) => /^FAIL\t!b:41chan\.net\tmxc:\/\/41chan\.net\/r3\t12 -> 22\t.*fix: /.test(l)), out.join("\n"));
});

test("a survivor whose projection read FAILS is not written from its raw tag_string: FAIL with the fix, and a re-run then re-points it", async () => {
  // The booru holds a private creator tag in post 20's tag_string; only the
  // projection keeps it out of rooms. A 503 on that read is not "no
  // projection recorded", and must never reach the tag_string fallback.
  world.posts[20].tag_string = "cat dog creator_secret_private";
  world.projectionDown.add(20);
  const rooms = { "!a:41chan.net": seedRooms()["!a:41chan.net"], "!d:41chan.net": seedRooms()["!d:41chan.net"] };
  const hs = homeserver(rooms);
  const { s, out } = await run(hs, { apply: true });
  assert.deepEqual(hs.writes, [], "nothing written while the projection cannot be read");
  assert.equal(rooms["!a:41chan.net"]["mxc://41chan.net/r1"].post_id, 10, "the room still names the retired post, so a re-run selects it");
  const fails = out.filter((l) => l.startsWith("FAIL\t"));
  assert.equal(fails.length, 2, out.join("\n"));
  for (const l of fails) assert.match(l, /GET \/posts\/20\/tag_sources\.json.*fix: wait for the booru to answer, then run this again with --apply/);
  assert.ok(out.every((l) => !/TESTKEY|http:\/\//.test(l)), "errors name paths, not URLs:\n" + out.join("\n"));
  assert.deepEqual([s.events, s.written, s.failed], [2, 0, 2]);
  assert.equal(tool.exitCodeFor(s), 1);
  // Read once per survivor, not once per room.
  assert.equal(world.requests.filter((r) => r.path === "/posts/20/tag_sources.json").length, 1);

  world.projectionDown.clear();
  world.requests.length = 0;
  const again = await run(hs, { apply: true });
  // pointRoomAtPost writes the projection it was handed and does not read
  // it again per room -- a second read is a second chance to fall back.
  assert.equal(world.requests.filter((r) => r.path === "/posts/20/tag_sources.json").length, 1);
  assert.deepEqual(hs.writes.map((w) => [w.key, w.content.post_id, w.content.tags]), [
    ["mxc://41chan.net/r1", 20, ["cat", "dog"]],
    ["mxc://41chan.net/r4", 20, ["cat", "dog"]],
  ]);
  assert.equal(tool.exitCodeFor(again.s), 0);
});

test("a re-run after success writes nothing", async () => {
  const rooms = seedRooms();
  delete rooms["!b:41chan.net"];
  delete rooms["!c:41chan.net"];
  const hs = homeserver(rooms);
  const first = await run(hs, { apply: true });
  assert.equal(first.s.written, 2);
  assert.equal(tool.exitCodeFor(first.s), 0);
  const again = await run(hs, { apply: true });
  assert.equal(hs.writes.length, 2, "no new writes");
  assert.deepEqual([again.s.events, again.s.written], [0, 0]);
  assert.equal(tool.exitCodeFor(again.s), 0);
});

test("one unreadable room, and one room that refuses the write, do not stop the walk; each is counted and named with its fix", async () => {
  const hs = homeserver(seedRooms(), { failRead: new Set(["!c:41chan.net"]), refuse: new Set(["!a:41chan.net"]) });
  const { s, out } = await run(hs, { apply: true });
  assert.deepEqual(hs.writes.map((w) => [w.roomId, w.key]), [
    ["!b:41chan.net", "mxc://41chan.net/r3"],
    ["!d:41chan.net", "mxc://41chan.net/r4"],
  ]);
  assert.deepEqual([s.unreadable, s.failed, s.missing, s.written], [1, 2, 1, 2]);
  assert.ok(out.some((l) => /^FAIL\t!a:41chan\.net\tmxc:\/\/41chan\.net\/r1\t10 -> 20\t.*grant-tag-write\.sh/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /^ROOM-FAIL\t!c:41chan\.net\t/.test(l)));
  assert.equal(tool.exitCodeFor(s), 1);
});

test("every booru request carries the key in a Basic header, never in the URL", async () => {
  const hs = homeserver(seedRooms());
  await run(hs, { apply: true });
  assert.ok(world.requests.length > 0);
  for (const r of world.requests) {
    assert.doesNotMatch(r.query, /TESTKEY|api_key|login/, `${r.method} ${r.path}${r.query}`);
    assert.equal(r.authorization, `Basic ${Buffer.from("tunnel:TESTKEY").toString("base64")}`, `${r.method} ${r.path}`);
  }
});

test("pairs: integers, retired != survivor, no retired twice, no survivor that is itself retired -- each refusal names its fix", () => {
  assert.deepEqual([...tool.parsePairs({ pairArgs: ["10:20", "11:21"] })], [[10, 20], [11, 21]]);
  assert.deepEqual([...tool.parsePairs({ pairsJson: JSON.stringify([{ retired: 10, survivor: 20 }]) })], [[10, 20]]);
  assert.deepEqual([...tool.parsePairs({ pairArgs: ["10:20"], pairsJson: "[{\"retired\":11,\"survivor\":20}]" })], [[10, 20], [11, 20]]);
  const refuses = (input, re) => assert.throws(() => tool.parsePairs(input), (err) => re.test(err.message) && /fix: /.test(err.message), JSON.stringify(input));
  refuses({ pairArgs: ["10-20"] }, /"10-20" is not <retiredPostId>:<survivorPostId>/);
  refuses({ pairArgs: ["10:2.5"] }, /not <retiredPostId>:<survivorPostId>/);
  refuses({ pairArgs: ["0:20"] }, /positive integers/);
  refuses({ pairArgs: ["10:10"] }, /#10 is both retired and survivor/);
  refuses({ pairArgs: ["10:20", "10:21"] }, /#10 is retired twice/);
  refuses({ pairArgs: ["10:20", "20:30"] }, /survivor #20 .* is itself retired/);
  refuses({ pairArgs: ["20:30", "10:20"] }, /survivor #20 .* is itself retired/);
  refuses({ pairsJson: "{\"retired\":1}" }, /a JSON array/);
  refuses({ pairsJson: "[{\"retired\":\"10\",\"survivor\":20}]" }, /positive integers/);
  refuses({ pairsJson: "not json" }, /not JSON/);
  refuses({}, /no pairs/);
});

test("writes are paced from the second one on (Synapse rate-limits state events); a dry run never pauses", async () => {
  const pauses = [];
  const hs = homeserver(seedRooms(), { failRead: new Set(["!c:41chan.net"]) });
  const { s } = await run(hs, { apply: true, paceMs: 750, sleep: async (ms) => { pauses.push([ms, hs.writes.length]); } });
  assert.equal(s.written, 3);
  assert.deepEqual(pauses, [[750, 1], [750, 2]]);
  pauses.length = 0;
  await run(homeserver(seedRooms()), { apply: false, paceMs: 750, sleep: async (ms) => { pauses.push(ms); } });
  assert.deepEqual(pauses, []);
});
