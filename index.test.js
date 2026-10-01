"use strict";

// handleImageEvent -- the real one in index.js -- driven end to end against
// stand-ins that speak HTTP: a Synapse that serves the media, a booru that
// records every request it is sent, and a spectrum that tags whatever bytes
// arrive. Nothing in index.js is stubbed or reached around. It is loaded
// against a throwaway config (FOURIER_TUNNEL_CONFIG) that points at them.
//
// WHY THIS EXISTS. Every other test of the generation-data work tested a plan
// or a stripper, and index.js merely FOLLOWED the plan: changing the upload
// back to the raw Matrix bytes left 220 of 220 tests green. The line that
// decides whether a prompt is published -- which cannot be undone -- is
// covered here, and so are the creator and metadata calls and their order.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { stripGeneration, crc32 } = require("./strip-generation");
const { extractCreatorTags } = require("./prompt-tags");
const { createCanon, keys } = require("./canon");
const { DanbooruClient } = require("./danbooru");

const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");
const ALICE = "@alice:41chan.net";
const BOB = "@bob:41chan.net";
const POST_ID = 42;

// --- fixtures -------------------------------------------------------------------

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const PNG_PARTS = [
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
  chunk("IDAT", zlib.deflateSync(Buffer.from([0, 200, 100, 50]))),
];
const IEND = chunk("IEND", Buffer.alloc(0));
const PARAMS = "masterpiece, 1girl, hoodie, backpack\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1";
const A1111_PNG = Buffer.concat([...PNG_PARTS, chunk("tEXt", Buffer.from(`parameters\0${PARAMS}`, "latin1")), IEND]);
const PLAIN_PNG = Buffer.concat([...PNG_PARTS, chunk("tEXt", Buffer.from("Software\0GIMP", "latin1")), IEND]);
// Two pictures where reading the RAW bytes and reading what the strip TOOK
// give different creator tags -- the only way a test can tell which one the
// handler used. Easy Diffusion's bare-text "prompt" chunk: prompt-tags cannot
// read it from the bytes (it expects a ComfyUI graph there), the strip
// identifies it. And a sentence in a JPEG UserComment: prompt-tags reads it
// from the bytes as a prompt, the strip keeps it, public, as a caption.
const ED_PNG = Buffer.concat([...PNG_PARTS,
  chunk("tEXt", Buffer.from("prompt\0a lighthouse, stormy sea, gulls", "latin1")),
  chunk("tEXt", Buffer.from("negative_prompt\0blurry", "latin1")),
  chunk("tEXt", Buffer.from("use_stable_diffusion_model\0secretmodel_v3", "latin1")), IEND]);
const BASE_JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");
const CAPTION = "a photograph of an astronaut riding a horse on the moon, dramatic lighting";
const CAPTION_JPEG = (() => {
  const value = Buffer.from(`ASCII\0\0\0${CAPTION}`, "latin1");
  const t = Buffer.alloc(26);
  t.write("MM\0*", 0, "latin1"); t.writeUInt32BE(8, 4); t.writeUInt16BE(1, 8);
  t.writeUInt16BE(0x9286, 10); t.writeUInt16BE(7, 12); t.writeUInt32BE(value.length, 14); t.writeUInt32BE(26, 18);
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t, value]);
  const len = Buffer.alloc(2); len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([BASE_JPEG.subarray(0, 20), Buffer.from([0xff, 0xe1]), len, exif, BASE_JPEG.subarray(20)]);
})();
// An AVIF whose item list carries an Exif item: a format the tunnel cannot
// verify, with a metadata carrier in it, so it must never be posted.
function box(type, ...payload) {
  const body = Buffer.concat(payload);
  const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length, 0); h.write(type, 4, "latin1");
  return Buffer.concat([h, body]);
}
const fullBox = (type, v, ...payload) => box(type, Buffer.from([v, 0, 0, 0]), ...payload);
const infe = (id, type) => fullBox("infe", 2, Buffer.from([0, id, 0, 0]), Buffer.from(type, "latin1"), Buffer.from([0]));
const AVIF_WITH_EXIF = Buffer.concat([
  box("ftyp", Buffer.from("avif\0\0\0\0avifmif1", "latin1")),
  fullBox("meta", 0, fullBox("iinf", 0, Buffer.from([0, 2]), infe(1, "av01"), infe(2, "Exif"))),
  box("mdat", Buffer.from(PARAMS)),
]);

// --- the world the handler talks to ----------------------------------------------

let world;
function reset() {
  world = {
    media: {},           // media id -> { bytes, type }
    posts: {},           // md5 -> post
    rawRecords: {},      // raw md5 -> booru md5
    requests: [],        // "METHOD /path", in order
    uploads: [],         // the file bytes each POST /uploads.json carried
    tagged: [],          // the bytes each spectrum call carried
    created: [],         // POST /posts.json bodies
    creators: [],        // POST /fourier/posts/:id/creator.json bodies
    metadata: [],        // POST /fourier/generation_metadata.json bodies
    tagSources: [],      // POST /posts/:id/tag_sources.json bodies
    state: [],           // state events the bridge sent
    replies: {},         // overrides: { creator: [status, body], generation: [status, body] }
    bucket: new Map(),   // R2, in memory: key -> { body, type }
    history: {},         // room id -> { [from token or "edge"]: /messages page }
    paged: [],           // { room, from, to } for every /messages call, in order
    events: {},          // event id -> event, for /rooms/:room/event/:id
    joined: [],          // what /joined_rooms answers
  };
}

// R2 for canon.js, over world.bucket. Real canon, real strip, real booru client
// against the stand-in: only the object store is in memory.
const md5hex = (b) => crypto.createHash("md5").update(b).digest("hex");
const store = {
  async head(k) { const o = world.bucket.get(k); return o ? { size: o.body.length, etag: md5hex(o.body), type: o.type } : null; },
  async get(k) { const o = world.bucket.get(k); return o ? Buffer.from(o.body) : null; },
  async put(k, body, type) { world.bucket.set(k, { body: Buffer.from(body), type }); return md5hex(body); },
  async copy(from, to) { world.bucket.set(to, { ...world.bucket.get(from) }); },
  async remove(k) { world.bucket.delete(k); },
};
reset();

function multipartFile(req, body) {
  const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] || "")[1];
  const start = body.indexOf("\r\n\r\n") + 4;
  const end = body.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
  return body.subarray(start, end);
}

const ROUTES = [
  ["GET", /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/, (req, m, body, url) => {
    if (req.headers.authorization !== "Bearer TESTTOKEN") return [401, { errcode: "M_UNAUTHORIZED" }];
    const room = decodeURIComponent(m[1]);
    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;
    world.paged.push({ room, from, to });
    const page = (world.history[room] || {})[from || "edge"];
    return page ? [200, page] : [200, { chunk: [] }];
  }],
  ["GET", /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/([^/]+)$/, (req, m) => {
    const e = world.events[decodeURIComponent(m[2])];
    return e ? [200, e] : [404, { errcode: "M_NOT_FOUND" }];
  }],
  ["GET", /^\/_matrix\/client\/v3\/joined_rooms$/, () => [200, { joined_rooms: world.joined }]],
  ["GET", /^\/_matrix\/client\/v1\/media\/download\/[^/]+\/(.+)$/, (req, m) => {
    if (req.headers.authorization !== "Bearer TESTTOKEN") return [401, { errcode: "M_UNAUTHORIZED" }];
    const media = world.media[m[1]];
    return media ? { raw: media.bytes, type: media.type } : [404, { errcode: "M_NOT_FOUND" }];
  }],
  ["GET", /^\/posts\.json$/, (req, m, body, url) => {
    const post = world.posts[(url.searchParams.get("tags") || "").replace(/^md5:/, "")];
    return [200, post ? [post] : []];
  }],
  ["GET", /^\/fourier\/generation_metadata\/raw\/([0-9a-f]{32})\.json$/, (req, m) => (
    world.rawRecords[m[1]] ? [200, { md5: world.rawRecords[m[1]] }] : [404, { error: "no record", fix: "none" }]
  )],
  ["POST", /^\/uploads\.json$/, (req, m, body) => { world.uploads.push(multipartFile(req, body)); return [200, { id: 1, status: "pending" }]; }],
  ["GET", /^\/uploads\/1\.json$/, () => [200, { id: 1, status: "completed", upload_media_assets: [{ id: 11 }] }]],
  ["POST", /^\/tag$/, (req, m, body) => { world.tagged.push(body); return [200, { rating: { general: 0.9 }, general: { "1girl": 0.9 }, characters: {} }]; }],
  ["POST", /^\/posts\.json$/, (req, m, body) => {
    const sent = JSON.parse(body);
    world.created.push(sent);
    const post = { id: POST_ID, md5: md5(world.uploads[world.uploads.length - 1]), tag_string: sent.post.tag_string, rating: sent.post.rating, source: sent.post.source };
    world.posts[post.md5] = post;
    return [200, post];
  }],
  ["POST", /^\/fourier\/posts\/(\d+)\/creator\.json$/, (req, m, body) => {
    const sent = JSON.parse(body);
    world.creators.push({ postId: Number(m[1]), ...sent });
    return world.replies.creator || [200, { post_id: Number(m[1]), mxid: sent.mxid }];
  }],
  ["POST", /^\/fourier\/generation_metadata\.json$/, (req, m, body) => {
    const sent = JSON.parse(body);
    world.metadata.push(sent);
    return world.replies.generation || [200, { md5: sent.md5, stored: Object.keys(sent.fields).length }];
  }],
  ["POST", /^\/posts\/(\d+)\/tag_sources\.json$/, (req, m, body) => {
    world.tagSources.push({ postId: Number(m[1]), ...JSON.parse(body) });
    return [200, { post_id: Number(m[1]), recorded: 1, projection: { tags: ["1girl"], sources: { creator: [], auto: ["1girl"], both: [], meta: [] } } }];
  }],
  ["GET", /^\/posts\/(\d+)\/tag_sources\.json$/, () => [200, { tags: ["1girl"], sources: { creator: [], auto: ["1girl"], both: [], meta: [] } }]],
  ["GET", /^\/tags\.json$/, () => [200, []]],
  ["POST", /^\/artists\.json$/, () => [200, {}]],
];

function handle(req, res) {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const body = Buffer.concat(parts);
    const url = new URL(req.url, "http://stand-in");
    world.requests.push(`${req.method} ${url.pathname}`);
    for (const [method, re, fn] of ROUTES) {
      const m = re.exec(url.pathname);
      if (req.method !== method || !m) continue;
      const out = fn(req, m, body, url);
      if (out.raw) { res.writeHead(200, { "content-type": out.type }); res.end(out.raw); return; }
      res.writeHead(out[0], { "content-type": "application/json" });
      res.end(JSON.stringify(out[1]));
      return;
    }
    res.writeHead(599, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `the stand-in has no route for ${req.method} ${url.pathname}` }));
  });
}

const bridge = { getIntent: () => ({ sendStateEvent: async (room, type, key, content) => { world.state.push({ room, type, key, content }); } }) };

let server, dir, index;
before(async () => {
  server = http.createServer(handle);
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-index-"));
  fs.writeFileSync(path.join(dir, "config.yaml"), [
    "homeserver:", `  url: "${base}"`, "  domain: \"41chan.net\"",
    "danbooru:", `  url: "${base}"`, "  username: \"tunnel\"", "  api_key: \"TESTKEY\"",
    "autotagger:", `  url: "${base}"`, "  timeout_ms: 5000",
    "bridge:", "  disabled_rooms: []", "  default_rating: \"q\"", "  admins: [\"@admin:41chan.net\"]", "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "registration.yaml"), "as_token: TESTTOKEN\nsender_localpart: tunnel\n");
  process.env.FOURIER_TUNNEL_CONFIG = path.join(dir, "config.yaml");
  process.env.FOURIER_TUNNEL_REGISTRATION = path.join(dir, "registration.yaml");
  process.env.ONBOARDING_STATE_DIR = dir;
  delete process.env.HOMESERVER_URL;
  index = require("./index");
  index.setCanon(createCanon({
    store,
    mediaInfo: async (id) => (world.media[id] ? { media_type: world.media[id].type, user_id: world.media[id].sender } : null),
    booru: new DanbooruClient(index.config.danbooru),
    log: (line) => console.warn(line),
  }));
});
after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(reset);

// One image event through the real handler, with everything it logs.
async function post(id, bytes, type, sender) {
  world.media[id] = { bytes, type, sender };
  world.bucket.set(keys.source(id), { body: Buffer.from(bytes), type });
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(`${k}: ${a.join(" ")}`);
  try {
    const outcome = await index.handleImageEvent(bridge, {
      room_id: "!room:41chan.net", sender, content: { url: `mxc://41chan.net/${id}`, body: `${id}.png`, msgtype: "m.image" },
    });
    return { outcome, lines };
  } finally {
    Object.assign(console, saved);
  }
}
const at = (req) => world.requests.indexOf(req);

test("index.js loaded from the throwaway config, and pointed nowhere else", () => {
  assert.equal(index.config.danbooru.api_key, "TESTKEY");
  assert.equal(index.AS_TOKEN, "TESTTOKEN");
});

test("a new AI image: the STRIPPED bytes are what the booru and spectrum get, and the creator then the record follow the post", async () => {
  const stripped = stripGeneration(A1111_PNG, "image/png").buffer;
  const { outcome, lines } = await post("a1111", A1111_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));

  assert.equal(world.uploads.length, 1);
  assert.ok(world.uploads[0].equals(stripped), "the booru was sent the stripped bytes");
  assert.ok(!world.uploads[0].equals(A1111_PNG));
  assert.equal(world.uploads[0].indexOf("Negative prompt"), -1, "no prompt in what was uploaded");
  assert.ok(world.tagged[0].equals(stripped), "spectrum was sent the stripped bytes too");

  // Canon filed the record FIRST (one writer of it), then the duplicate check
  // asked all three ways, all BEFORE anything was uploaded. Nothing was
  // downloaded from Synapse: its copy is not the file.
  const lookups = world.requests.slice(0, at("POST /uploads.json"));
  assert.deepEqual(lookups, [
    "POST /fourier/generation_metadata.json",
    "GET /posts.json", `GET /fourier/generation_metadata/raw/${md5(A1111_PNG)}.json`, "GET /posts.json",
  ]);

  const created = at("POST /posts.json");
  const creator = at(`POST /fourier/posts/${POST_ID}/creator.json`);
  assert.ok(created >= 0 && creator > created, `post, then creator: ${world.requests.join(", ")}`);
  assert.equal(world.requests.filter((r) => r === "POST /fourier/generation_metadata.json").length, 1, "one record, from canon");

  // THE ONE FILE: the stripped bytes, at their md5, in the bucket; Synapse's
  // original moved to superseded/, not deleted.
  assert.ok(world.bucket.get(`media/${md5(stripped)}.png`).body.equals(stripped));
  assert.equal(world.bucket.has(keys.source("a1111")), false);
  assert.ok(world.bucket.get(keys.superseded("a1111")).body.equals(A1111_PNG));
  assert.deepEqual(world.creators, [{ postId: POST_ID, mxid: ALICE }]);
  assert.deepEqual(world.metadata, [{ md5: md5(stripped), raw_md5: md5(A1111_PNG), source: "matrix", poster: ALICE, fields: { "png:parameters": PARAMS } }]);

  const tags = world.created[0].post.tag_string.split(" ");
  assert.ok(tags.includes("ai-generated") && tags.includes("41chan_alice") && tags.includes("1girl"), tags.join(" "));
  assert.ok(!tags.includes("hoodie"), "a creator-only prompt tag never enters the public tag string");
  assert.equal(world.state[0].content.post_id, POST_ID);
});

test("an image the strip refuses uploads NOTHING -- not the file, not a post, not a creator, not a record", async () => {
  const { outcome, lines } = await post("avif1", AVIF_WITH_EXIF, "image/avif", ALICE);
  assert.equal(outcome, "strip-refused");
  assert.deepEqual(world.requests, [], "nothing asked of anyone");
  assert.ok(world.bucket.has(keys.source("avif1")), "its original stays where it is");
  assert.equal(world.uploads.length + world.tagged.length + world.creators.length + world.metadata.length, 0);
  assert.ok(lines.some((l) => /^error: \[strip\] refusing to post mxc:\/\/41chan.net\/avif1: .*an Exif item/.test(l)), lines.join("\n"));
});

test("a plain picture goes up byte for byte: its creator is recorded, no record is sent, and it is not ai-generated", async () => {
  const { outcome } = await post("plain", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted");
  assert.ok(world.uploads[0].equals(PLAIN_PNG));
  assert.deepEqual(world.creators, [{ postId: POST_ID, mxid: ALICE }]);
  assert.deepEqual(world.metadata, []);
  assert.ok(!world.created[0].post.tag_string.split(" ").includes("ai-generated"));
  assert.equal(at(`GET /fourier/generation_metadata/raw/${md5(PLAIN_PNG)}.json`) >= 0, true, "the raw record is asked even when nothing was stripped");
});

test("someone else re-posting it: nothing uploaded, NO creator recorded, the record sent as the SENDER's, and a 409 is kept, not failed", async () => {
  const stripped = stripGeneration(A1111_PNG, "image/png").buffer;
  // The tags name bob; any member could have put them there. They decide nothing.
  world.posts[md5(stripped)] = { id: POST_ID, md5: md5(stripped), tag_string: "1girl 41chan_bob", tag_string_artist: "41chan_bob", rating: "q" };
  world.replies.generation = [409, { error: "a record from another poster exists for this md5", fix: "nothing: it stands", reason: "poster_mismatch" }];
  const { outcome, lines } = await post("repost", A1111_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted");
  assert.equal(world.uploads.length, 0, "not uploaded twice");
  assert.deepEqual(world.creators, [], "a re-post never records a creator");
  assert.deepEqual(world.metadata, [{ md5: md5(stripped), raw_md5: md5(A1111_PNG), source: "matrix", poster: ALICE, fields: { "png:parameters": PARAMS } }]);
  assert.ok(lines.some((l) => /^warn: \[canon\] repost: the booru keeps the record it already has for /.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /NOT filed|NOT RECORDED/.test(l)), "a 409 from another poster is not reported as a failure");
  assert.equal(world.state[0].content.post_id, POST_ID);
});

test("a picture posted under OLDER strip rules is found through the booru's raw-md5 record, not posted twice", async () => {
  const older = "0123456789abcdef0123456789abcdef";
  world.rawRecords[md5(A1111_PNG)] = older;
  world.posts[older] = { id: 7, md5: older, tag_string: "1girl", rating: "q" };
  const { outcome } = await post("older", A1111_PNG, "image/png", BOB);
  assert.equal(outcome, "posted");
  assert.equal(world.uploads.length, 0);
  // Canon files the record for the ONE file -- the stripped bytes under today's
  // rules -- once, with the uploader as poster.
  assert.equal(world.metadata[0].md5, md5(stripGeneration(A1111_PNG, "image/png").buffer));
  assert.equal(world.metadata[0].poster, BOB);
});

test("the creator call failing is LOUD, says the private data is visible to nobody, and does not lose the post", async () => {
  world.replies.creator = [503, { error: "down", fix: "wait" }];
  const { outcome, lines } = await post("nocreator", A1111_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted");
  assert.equal(world.metadata.length, 1, "the record is still sent");
  const warning = lines.find((l) => /\[creator\] NOT RECORDED for post #42/.test(l));
  assert.ok(warning, lines.join("\n"));
  assert.match(warning, /^warn: .*visible to nobody/);
});

test("a raw_md5 already filed under another md5 is NOT \"kept\": the new post has no record, and the log says so in its own words", async () => {
  world.replies.generation = [409, { error: "raw_md5 is already filed under md5 0123", fix: "GET the raw lookup", reason: "raw_md5_conflict" }];
  const { outcome, lines } = await post("conflict", A1111_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", "the post itself is made");
  assert.ok(lines.some((l) => /^warn: \[canon\] conflict: NOT filed under .*already filed under a DIFFERENT md5.*Fix: GET \/fourier\/generation_metadata\/raw\//.test(l)), lines.join("\n"));
  assert.ok(!lines.some((l) => /keeps the record it already has/.test(l)), "never the line a stood record gets");
});

test("the private creator tags come from what the strip TOOK -- never from the raw bytes -- whichever way the two differ", async () => {
  // Easy Diffusion: only the strip can read the prompt.
  assert.deepEqual(extractCreatorTags(ED_PNG, "image/png").tags, [], "precondition: nothing readable from the raw bytes");
  const ed = await post("edpng", ED_PNG, "image/png", ALICE);
  assert.equal(ed.outcome, "posted", ed.lines.join("\n"));
  assert.deepEqual(world.tagSources[0].creator, ["a_lighthouse", "stormy_sea", "gulls"], "the prompt the strip took, as private creator tags");
  assert.ok(!world.created[0].post.tag_string.split(" ").includes("gulls"), "and none of it public");

  // A caption the strip keeps: readable from the raw bytes, so a handler
  // reading them would file a PUBLIC caption as private creator tags.
  reset();
  assert.ok(extractCreatorTags(CAPTION_JPEG, "image/jpeg").tags.length > 0, "precondition: the raw bytes read as a prompt");
  const cap = await post("caption", CAPTION_JPEG, "image/jpeg", ALICE);
  assert.equal(cap.outcome, "posted", cap.lines.join("\n"));
  assert.ok(world.uploads[0].includes(CAPTION), "the caption is kept in the file");
  assert.deepEqual(world.tagSources[0].creator, [], "so it is nobody's private creator tag");
  assert.deepEqual(world.metadata, [], "and nothing was recorded privately");
});

// --- THE HISTORY WALK, through backfillRoomNow ------------------------------------
//
// The persisted state is what makes a walk resumable, so these drive the REAL
// backfillRoomNow and the real sweep against the stand-in homeserver, with the
// state file in this test's ONBOARDING_STATE_DIR. 2026-10-01: 38 pictures in 8
// rooms sat beyond a 40-page horizon that no run, automatic or typed, could
// ever get past.

const BOT = "@tunnel:41chan.net";
const backfillState = () => JSON.parse(fs.readFileSync(path.join(dir, "backfill-state.json"), "utf8"));
const writeBackfillState = (obj) => fs.writeFileSync(path.join(dir, "backfill-state.json"), JSON.stringify(obj));
async function quietly(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(`${k}: ${a.join(" ")}`);
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

test("a room walked to its start is not walked again by the automatic trigger", async () => {
  const room = "!done:41chan.net";
  world.history[room] = { edge: { chunk: [], start: "h0", end: "p1" }, p1: { chunk: [] } };
  const first = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "join" }));
  assert.equal(first.value.reachedStart, true, first.lines.join("\n"));
  assert.equal(world.paged.length, 2);
  assert.equal(backfillState()[room].reachedStart, true, "persisted, so a restart remembers it");

  world.paged = [];
  const second = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "join" }));
  assert.match(second.value.skipped, /walked to the start/);
  assert.deepEqual(world.paged, [], "no history was read");
});

test("a room NOT walked to its start resumes from its saved cursor, and the picture beyond the old horizon is posted", async () => {
  const room = "!deep:41chan.net";
  writeBackfillState({ ...backfillState(), [room]: { head: "h0", cursor: "c40", reachedStart: false, failed: [], lastRunAt: 1 } });
  world.media.oldpic1 = { bytes: PLAIN_PNG, type: "image/png", sender: ALICE };
  world.bucket.set(keys.source("oldpic1"), { body: Buffer.from(PLAIN_PNG), type: "image/png" });
  world.history[room] = {
    c40: { chunk: [{ event_id: "$oldpic1", type: "m.room.message", sender: ALICE, content: { msgtype: "m.image", url: "mxc://41chan.net/oldpic1", body: "oldpic1.png" } }], start: "c40" },
  };
  const { value: r, lines } = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "sweep" }));
  assert.deepEqual(world.paged.map((p) => p.from), ["c40"], "started at the cursor, not the live edge");
  assert.equal(r.done, 1, lines.join("\n"));
  assert.equal(world.created.length, 1, "the old picture reached the booru");
  const rec = backfillState()[room];
  assert.equal(rec.reachedStart, true);
  assert.equal(rec.head, "h0", "a resume leaves the head alone");
});

test("a picture that failed is retried on the next run, re-read by its event id", async () => {
  const room = "!retry:41chan.net";
  writeBackfillState({ ...backfillState(), [room]: { head: "h0", cursor: "c1", reachedStart: true, lastRunAt: 1,
    failed: [{ eventId: "$r1", url: "mxc://41chan.net/retrypic1", attempts: 1, error: "earlier" }] } });
  world.media.retrypic1 = { bytes: PLAIN_PNG, type: "image/png", sender: BOB };
  world.bucket.set(keys.source("retrypic1"), { body: Buffer.from(PLAIN_PNG), type: "image/png" });
  world.events.$r1 = { event_id: "$r1", type: "m.room.message", sender: BOB, content: { msgtype: "m.image", url: "mxc://41chan.net/retrypic1", body: "retrypic1.png" } };
  const { value: r, lines } = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "sweep" }));
  assert.equal(r.kind, "retry", lines.join("\n"));
  assert.equal(r.retried, 1);
  assert.equal(r.done, 1);
  assert.deepEqual(world.paged, [], "a retry walks no pages");
  assert.deepEqual(backfillState()[room].failed, []);
});

test("a denied room is refused whatever its saved state, and the sweep passes it by", async () => {
  const rooms = require("./rooms");
  const room = "!denied:41chan.net";
  rooms.deny(room, { by: "@admin:41chan.net", reason: "test" });
  writeBackfillState({ ...backfillState(), [room]: { cursor: "c3", reachedStart: false, failed: [], lastRunAt: 1 } });
  world.history[room] = { c3: { chunk: [] } };
  const { value } = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "command" }));
  assert.match(value.skipped, /denied/);
  world.joined = [room];
  const swept = await quietly(() => index.backfillSweep(bridge, BOT));
  assert.deepEqual(swept.value, []);
  assert.deepEqual(world.paged, [], "nothing of it was read");
});

test("the sweep walks every unfinished room one at a time, and leaves alone what was walked minutes ago", async () => {
  const fresh = "!fresh:41chan.net", partway = "!partway:41chan.net", recent = "!recent:41chan.net", done = "!finished:41chan.net";
  const now = Date.now();
  writeBackfillState({
    ...backfillState(),
    [partway]: { head: "h0", cursor: "q5", reachedStart: false, failed: [], lastRunAt: now - 60 * 60 * 1000 },
    [recent]: { head: "h0", cursor: "q5", reachedStart: false, failed: [], lastRunAt: now - 1000 },
    [done]: { head: "h0", reachedStart: true, failed: [], lastRunAt: 1 },
  });
  world.history[fresh] = { edge: { chunk: [], start: "hf" } };
  world.history[partway] = { q5: { chunk: [] } };
  world.joined = [fresh, partway, recent, done];
  const { value, lines } = await quietly(() => index.backfillSweep(bridge, BOT));
  assert.deepEqual(world.paged.map((p) => [p.room, p.from]), [[fresh, undefined], [partway, "q5"]], lines.join("\n"));
  assert.deepEqual(value.map((r) => r.roomId), [fresh, partway]);
  const state = backfillState();
  assert.equal(state[fresh].reachedStart, true);
  assert.equal(state[fresh].head, "hf");
  assert.equal(state[partway].reachedStart, true);
  assert.equal(state[recent].lastRunAt, now - 1000, "untouched");
});

test("a replayed duplicate whose room already carries its tags writes no new state event; a stale one is rewritten", async () => {
  // Post it once, so the booru holds it and the room's state names it.
  await post("replaypic", PLAIN_PNG, "image/png", ALICE);
  const written = world.state[0];
  assert.ok(written, "the first sighting wrote the room's tag state");
  const ev = { room_id: "!room:41chan.net", sender: ALICE, content: { url: "mxc://41chan.net/replaypic", body: "replaypic.png", msgtype: "m.image" } };

  const sent = [];
  const reading = (content) => ({ getIntent: () => ({
    getStateEvent: async () => content,
    sendStateEvent: async (room, type, key, c) => { sent.push(c); },
  }) });
  const same = await quietly(() => index.handleImageEvent(reading(written.content), ev));
  assert.equal(same.value, "posted");
  assert.deepEqual(sent, [], "nothing changed, so nothing was sent");
  assert.ok(same.lines.some((l) => /already carries its tags/.test(l)), same.lines.join("\n"));

  const stale = await quietly(() => index.handleImageEvent(reading({ ...written.content, tags: ["old_tag"] }), ev));
  assert.equal(stale.value, "posted");
  assert.equal(sent.length, 1, "a state that says something else is rewritten");

  const unreadable = { getIntent: () => ({
    getStateEvent: async () => { throw new Error("M_NOT_FOUND"); },
    sendStateEvent: async (room, type, key, c) => { sent.push(c); },
  }) };
  await quietly(() => index.handleImageEvent(unreadable, ev));
  assert.equal(sent.length, 2, "absent state is written");
});
