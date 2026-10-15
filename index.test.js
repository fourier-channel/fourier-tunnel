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
const { createAliasOutbox } = require("./gate3-aliases");

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
let dir;
function reset() {
  world = {
    media: {},           // media id -> { bytes, type }
    posts: {},           // md5 -> post
    rawRecords: {},      // raw md5 -> booru md5
    requests: [],        // "METHOD /path", in order
    uploads: [],         // the file bytes each POST /uploads.json carried
    uploadNames: [],     // and the file name each one was sent under
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
    quarantine: null,    // the quarantine document GET /fourier_jail/release.json?quarantine=1
                         // answers (null: 503), or a [status, body] to answer instead
    held: {},            // md5 -> { id, visible, ... }: a post the md5 lookup does NOT
                         // return -- deleted or jailed, as the booru hides them --
                         // which POST /posts.json answers with a 302 to it
    aliases: new Map(),  // gate 3: the booru's mxc -> post id record, UNIQUE(mxc)
    aliasAuth: [],       // { query, authorization } of every POST /posts/:id/tag_sources.json
    rawAuth: [],         // { query, authorization } of every raw-md5 lookup
    hangJoined: false,   // /joined_rooms never answers: a room walk that does not end
    hung: [],            // the responses held open by it
    noSuchPost: new Set(), // post ids the booru answers no_such_post for
  };
  // The alias outbox lives in the state directory; a test starts with none.
  if (dir) fs.rmSync(path.join(dir, "gate3-aliases.json"), { force: true });
}

// The booru's gate 3 verdict for one mxc (contract B): UNIQUE(mxc), so the
// same (post, mxc) again is accepted and changes nothing.
function aliasVerdict(postId, mxc) {
  if (world.noSuchPost.has(postId)) return { accepted: false, reason: "no_such_post" };
  const had = world.aliases.get(mxc);
  if (had !== undefined && had !== postId) return { accepted: false, reason: "mxc_mapped_elsewhere" };
  world.aliases.set(mxc, postId);
  return { accepted: true };
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
  ["GET", /^\/_matrix\/client\/v3\/joined_rooms$/, () => (world.hangJoined ? { hang: true } : [200, { joined_rooms: world.joined }])],
  ["GET", /^\/_matrix\/client\/v1\/media\/download\/[^/]+\/(.+)$/, (req, m) => {
    if (req.headers.authorization !== "Bearer TESTTOKEN") return [401, { errcode: "M_UNAUTHORIZED" }];
    const media = world.media[m[1]];
    return media ? { raw: media.bytes, type: media.type } : [404, { errcode: "M_NOT_FOUND" }];
  }],
  ["GET", /^\/posts\.json$/, (req, m, body, url) => {
    const post = world.posts[(url.searchParams.get("tags") || "").replace(/^md5:/, "")];
    return [200, post ? [post] : []];
  }],
  ["GET", /^\/fourier\/generation_metadata\/raw\/([0-9a-f]{32})\.json$/, (req, m, body, url) => {
    world.rawAuth.push({ query: url.search, authorization: req.headers.authorization });
    return world.rawRecords[m[1]] ? [200, { md5: world.rawRecords[m[1]] }] : [404, { error: "no record", fix: "none" }];
  }],
  ["POST", /^\/uploads\.json$/, (req, m, body) => {
    // replies.upload: answered ONCE instead, then the booru takes uploads again.
    if (world.replies.upload) { const r = world.replies.upload; delete world.replies.upload; return r; }
    world.uploads.push(multipartFile(req, body));
    world.uploadNames.push((/filename="([^"]*)"/.exec(body.toString("latin1")) || [])[1]);
    return [200, { id: 1, status: "pending" }];
  }],
  ["GET", /^\/uploads\/1\.json$/, () => world.replies.uploadStatus || [200, { id: 1, status: "completed", upload_media_assets: [{ id: 11 }] }]],
  ["POST", /^\/tag$/, (req, m, body) => { world.tagged.push(body); return [200, { rating: { general: 0.9 }, general: { "1girl": 0.9 }, characters: {} }]; }],
  ["POST", /^\/posts\.json$/, (req, m, body) => {
    const sent = JSON.parse(body);
    world.created.push(sent);
    // chanbooru PostsController#create on a taken md5: a redirect to the
    // original post, whoever may see it.
    const held = world.held[md5(world.uploads[world.uploads.length - 1])];
    // Since chanbooru's hidden-duplicate fix (2026-10-02) a post the uploader
    // may not see is neither redirected to nor named: 422, reason unpostable.
    if (held && held.unpostable) {
      const why = "This file cannot be posted.";
      return [422, { success: false, error: why, message: why, fix: "Do not retry: this file will not be posted. Upload a different file.", reason: "unpostable" }];
    }
    if (held) return [302, {}, { location: `http://${req.headers.host}/posts/${held.id}` }];
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
  ["POST", /^\/posts\/(\d+)\/tag_sources\.json$/, (req, m, body, url) => {
    const sent = JSON.parse(body);
    world.tagSources.push({ postId: Number(m[1]), ...sent });
    world.aliasAuth.push({ query: url.search, authorization: req.headers.authorization });
    if (world.replies.tagSourcesFail) return world.replies.tagSourcesFail;
    // A body carrying ONLY mxc is gate 3's alias report: no partition.
    if (Object.keys(sent).length === 1 && "mxc" in sent) {
      if (world.replies.alias) return world.replies.alias;
      return [200, { mxc: aliasVerdict(Number(m[1]), sent.mxc) }];
    }
    // replies.noMxcVerdict: a booru older than gate 3, which ignores the key.
    const verdict = "mxc" in sent && !world.replies.noMxcVerdict ? { mxc: aliasVerdict(Number(m[1]), sent.mxc) } : {};
    return [200, { post_id: Number(m[1]), recorded: 1, projection: { tags: ["1girl"], sources: { creator: [], auto: ["1girl"], both: [], meta: [] } }, ...verdict, ...(world.replies.tagSources || {}) }];
  }],
  ["GET", /^\/posts\/(\d+)\/tag_sources\.json$/, () => world.replies.projection || [200, { tags: ["1girl"], sources: { creator: [], auto: ["1girl"], both: [], meta: [] } }]],
  // chanbooru's quarantine document, as the tunnel's account reads it.
  ["GET", /^\/fourier_jail\/release\.json$/, (req, m, body, url) => {
    if (url.searchParams.get("quarantine") !== "1") return [403, { success: false }];
    if (world.quarantine instanceof Array) return world.quarantine;
    if (!world.quarantine) return [503, { error: "down" }];
    return [200, { ...world.quarantine, next_after: null }, { etag: `"${world.quarantine.generation}-n"` }];
  }],
  ["GET", /^\/tags\.json$/, () => [200, []]],
  // A post's page, as the tunnel's account sees it: a hidden post answers 404,
  // exactly as a missing one does (chanbooru Post#hidden_as_deleted?).
  ["GET", /^\/posts\/(\d+)(\.json)?$/, (req, m) => {
    const held = Object.values(world.held).find((p) => p.id === Number(m[1]));
    return held && held.visible ? [200, held] : [404, { success: false, message: "That record was not found." }];
  }],
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
      if (out.hang) { world.hung.push(res); return; }
      if (out.raw) { res.writeHead(200, { "content-type": out.type }); res.end(out.raw); return; }
      res.writeHead(out[0], { "content-type": "application/json", ...(out[2] || {}) });
      res.end(JSON.stringify(out[1]));
      return;
    }
    res.writeHead(599, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `the stand-in has no route for ${req.method} ${url.pathname}` }));
  });
}

const bridge = { getIntent: () => ({ sendStateEvent: async (room, type, key, content) => { world.state.push({ room, type, key, content }); } }) };

let server, index;
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
    // The alias flush is not awaited by the handler (contract B); a test
    // waits for it, so no report lands in the next test's world.
    await index.getAliasOutbox().idle();
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

  // ONE upload, and it is canon's (every Matrix image gets a booru record):
  // the post is made from that upload's media asset, never a second upload.
  assert.equal(world.uploads.length, 1);
  assert.equal(world.uploadNames[0], `${md5(stripped)}.png`, "named by its md5, never the sender's file name");
  assert.equal(world.created[0].upload_media_asset_id, 11, "the post is made from canon's upload");
  assert.equal(JSON.parse(world.bucket.get(keys.index("a1111")).body.toString()).booru.status, "completed");
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

test("a booru too busy for canon's upload: the post path uploads for itself, and the picture is posted", async () => {
  world.replies.upload = [429, { error: "rate limited" }];
  const { outcome, lines } = await post("busybooru", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.ok(lines.some((l) => /\[canon\] busybooru: booru record NOT made \(the booru answered 429\)/.test(l)), lines.join("\n"));
  assert.equal(world.uploads.length, 1, "one upload reached the booru: the post path's");
  assert.equal(world.created[0].upload_media_asset_id, 11);
  assert.equal(JSON.parse(world.bucket.get(keys.index("busybooru")).body.toString()).booru.status, "pending", "and canon's record is owed, for the sweep");
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

// ORIGINAL CHARACTERS (operator rulings 2026-10-11/12). Everything the booru
// may declare goes in the hub's `oc` list and NOT in the tag string the post
// is created with: the booru puts a name it declares on the post itself, and
// refuses to re-file a general tag that already has a post -- which a name in
// the creating tag string is, by the time the hub reads `oc`.
//   - the poster's own <name>_(<localpart>): in `oc` alone, declared or refused
//     by name;
//   - a LEGACY form (oc_<name>, <name>_oc and their character_ variants): in
//     `oc` alone, as written, for ANY sender -- the booru declares it as
//     itself, or as its alias's consequent once the operator has mapped it;
//   - any other qualified name ("Many of these characters belong to other
//     creators, I'll just be the first one to post them"): a private creator
//     term AND in `oc`, for the booru to declare only if it is an established
//     original character and to leave private, silently, otherwise.
const OC_PARAMS = "masterpiece, oc_kayla, (maple_\\(saber\\):1.2), kayla_\\(selphdestruct\\), saber_(fate)\nSteps: 20, Sampler: Euler a";
const OC_PNG = Buffer.concat([...PNG_PARTS, chunk("tEXt", Buffer.from(`parameters\0${OC_PARAMS}`, "latin1")), IEND]);

test("an original character: the poster's own name and the legacy forms are sent to be declared; other creators' names are private and offered", async () => {
  const { outcome, lines } = await post("ocpic", OC_PNG, "image/png", "@saber:41chan.net");
  assert.equal(outcome, "posted", lines.join("\n"));
  const tags = world.created[0].post.tag_string.split(" ");
  for (const name of ["maple_(saber)", "oc_kayla", "kayla_(selphdestruct)", "saber_(fate)"]) {
    assert.ok(!tags.includes(name), `${name}: the booru puts a declared name on the post, and a private term stays private: ${tags.join(" ")}`);
  }
  const sent = world.tagSources[0];
  assert.deepEqual(sent.oc, ["oc_kayla", "maple_(saber)", "kayla_(selphdestruct)", "saber_(fate)"]);
  assert.deepEqual(sent.creator, ["kayla_(selphdestruct)", "saber_(fate)"]);
  assert.deepEqual(sent.meta, ["masterpiece"]);
  assert.ok(lines.some((l) => /4 oc\)/.test(l)), lines.join("\n"));
});

test("the same picture from someone else: maple_(saber) is a private term for alice, offered like every other creator's name; the legacy form still goes to the booru", async () => {
  const { outcome, lines } = await post("ocpic2", OC_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  const tags = world.created[0].post.tag_string.split(" ");
  assert.ok(!tags.includes("maple_(saber)") && !tags.includes("oc_kayla"), tags.join(" "));
  assert.deepEqual(world.tagSources[0].oc, ["oc_kayla", "maple_(saber)", "kayla_(selphdestruct)", "saber_(fate)"]);
  assert.deepEqual(world.tagSources[0].creator, ["maple_(saber)", "kayla_(selphdestruct)", "saber_(fate)"]);
});

test("an original character the booru would not declare is logged with the booru's reason", async () => {
  world.replies.tagSources = { original_characters_not_declared: {
    "maple_(saber)": "maple_(saber) is already a general tag on 3 posts, so it is not re-filed",
    "oc_kayla": "oc_kayla is filed as copyright: ask an admin to re-file it as a character, then send the tags again",
  } };
  const { outcome, lines } = await post("ocpic3", OC_PNG, "image/png", "@saber:41chan.net");
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.ok(lines.some((l) => /^warn: \[tag-hub\] post #42: original character NOT declared: maple_\(saber\) is already a general tag on 3 posts/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^warn: \[tag-hub\] post #42: original character NOT declared: oc_kayla is filed as copyright/.test(l)), lines.join("\n"));
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
    const value = await fn();
    await index.getAliasOutbox().idle();
    return { value, lines };
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

// --- A PICTURE THE BOORU HOLDS UNDER A POST THIS ACCOUNT CANNOT SEE ---------------
//
// 2026-10-02, the resumable sweep: 39 images in one room, 36 done, 3 failed with
// a bare "Request failed with status code 404" -- every run. Each one's booru
// post was DELETED (troll jail), so the md5 lookup found nothing (the booru
// hides a deleted post from every lookup), the handler made a post, the booru
// answered 302 to the original, axios followed it, and the deleted post's page
// answered 404.

test("a picture whose booru post was deleted or jailed: not posted, no state, no creator -- \"held-hidden\", and no redirect followed", async () => {
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false };
  const { outcome, lines } = await post("jailedpic", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "held-hidden", lines.join("\n"));
  assert.equal(world.created.length, 1, "the booru was asked once, and refused");
  assert.deepEqual(world.state, [], "no tag state for a picture the booru withholds");
  assert.deepEqual(world.creators, [], "no creator recorded on somebody else's post");
  assert.deepEqual(world.tagSources, [{ postId: 25, mxc: "mxc://41chan.net/jailedpic" }],
    "nothing hung on a post that was not made -- but its mxc is reported as that post's image (gate 3), alone");
  assert.equal(at("GET /posts/25"), -1, "the 302 was not followed");
  assert.ok(at("GET /posts/25.json") > at("POST /posts.json"), "the post it named was looked up as this account sees it");
  assert.ok(lines.some((l) => /\[skip\] mxc:\/\/41chan\.net\/jailedpic: the booru already holds these bytes .* under post #25, which this account cannot see -- deleted or jailed\..*nothing to retry/.test(l)), lines.join("\n"));
});

test("the booru's own refusal of a hidden duplicate (422 unpostable, no post named) is held-hidden too, and not retried", async () => {
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false, unpostable: true };
  const { outcome, lines } = await post("jailedpic2", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "held-hidden", lines.join("\n"));
  assert.equal(world.created.length, 1, "the booru was asked once, and refused");
  assert.deepEqual(world.state, [], "no tag state for a picture the booru withholds");
  assert.deepEqual(world.creators, [], "no creator recorded");
  assert.equal(at("GET /posts/25.json"), -1, "no post was named, so none is looked up");
  assert.ok(lines.some((l) => /\[skip\] mxc:\/\/41chan\.net\/jailedpic2: the booru refuses these bytes .*unpostable.*nothing to retry/.test(l)), lines.join("\n"));
});

test("a post that appeared between the lookup and the post (visible): the room's state points at it, nothing posted twice", async () => {
  world.held[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), visible: true, tag_string: "1girl", rating: "q" };
  const { outcome, lines } = await post("racedpic", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.equal(world.state.length, 1);
  assert.equal(world.state[0].content.post_id, 7);
  assert.deepEqual(world.creators, [], "a post somebody else made keeps its own creator");
  assert.ok(lines.some((l) => /\[skip\] duplicate md5 [0-9a-f]{32} \(the booru's own md5 check at post time\) -> existing post #7/.test(l)), lines.join("\n"));
});

test("the sweep counts a held-hidden picture apart: not done, not failed, not owed a retry -- and says so", async () => {
  const room = "!jailroom:41chan.net";
  for (const [id, bytes] of [["jailwalk", PLAIN_PNG], ["freshwalk", A1111_PNG]]) {
    world.media[id] = { bytes, type: "image/png", sender: ALICE };
    world.bucket.set(keys.source(id), { body: Buffer.from(bytes), type: "image/png" });
  }
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false };
  const ev = (id) => ({ event_id: `$${id}`, type: "m.room.message", sender: ALICE, content: { msgtype: "m.image", url: `mxc://41chan.net/${id}`, body: `${id}.png` } });
  world.history[room] = { edge: { chunk: [ev("freshwalk"), ev("jailwalk")], start: "hj" } };
  const { value: r, lines } = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "join" }));
  assert.equal(r.hidden, 1, lines.join("\n"));
  assert.equal(r.done, 1);
  assert.equal(r.failed, 0, "a deleted post is not a failure");
  assert.deepEqual(backfillState()[room].failed, [], "and is not retried every ten minutes");
  assert.ok(lines.some((l) => /1 NOT posted: the booru holds them under a deleted or jailed post/.test(l)), lines.join("\n"));
});

test("a backfill failure names the request that failed -- method and path, never the api_key -- and what happens next", async () => {
  const room = "!failroom:41chan.net";
  world.media.failwalk = { bytes: PLAIN_PNG, type: "image/png", sender: ALICE };
  world.bucket.set(keys.source("failwalk"), { body: Buffer.from(PLAIN_PNG), type: "image/png" });
  world.history[room] = { edge: { chunk: [{ event_id: "$failwalk", type: "m.room.message", sender: ALICE, content: { msgtype: "m.image", url: "mxc://41chan.net/failwalk", body: "f.png" } }], start: "hf" } };
  world.replies.uploadStatus = [404, { success: false, message: "That record was not found." }];
  const { value: r, lines } = await quietly(() => index.backfillRoomNow(bridge, room, BOT, { trigger: "join" }));
  assert.equal(r.failed, 1, lines.join("\n"));
  const line = lines.find((l) => l.includes("[backfill] !failroom:41chan.net mxc://41chan.net/failwalk:"));
  assert.ok(line, lines.join("\n"));
  assert.match(line, /: GET \/uploads\/1\.json: Request failed with status code 404; retried on the next run \(attempt 1 of 5\)$/);
  assert.doesNotMatch(line, /TESTKEY|api_key|127\.0\.0\.1|only=/);
  assert.match(backfillState()[room].failed[0].error, /^GET \/uploads\/1\.json: /, "and the saved failure says the same");
});

// --- THE BOORU'S QUARANTINE LIST IN THE FALLBACK WRITES -----------------------------
//
// Operator rulings 2026-10-12: a flagged or banished tag's name never enters a
// room's tag state. The booru's projection is stripped by the booru; the two
// FALLBACKS (the booru's tag_string, or the tags the tunnel posted with) are
// the tunnel's own words and are stripped here -- and, when the list is not
// fresh, not written at all but held until it is.

const quarantineLib = require("./quarantine");
let qclock = Date.now();
function freshWatch() {
  const file = path.join(dir, "quarantine-under-test.json");
  fs.rmSync(file, { force: true });
  const w = quarantineLib.createQuarantineWatch({
    danbooru: new DanbooruClient(index.config.danbooru), file: () => file, now: () => qclock,
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  index.setQuarantine(w);
  return w;
}
const QDOC = { generation: "0123456789abcdef", flagged: ["secret_tag"], banished: ["gross"], posts: [] };

test("a duplicate with no recorded provenance falls back to tag_string WITHOUT a flagged or banished name", async () => {
  const w = freshWatch();
  world.quarantine = QDOC;
  assert.equal(await w.refresh(), "ok");
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl secret_tag gross hoodie", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome, lines } = await post("legacydup", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.equal(world.state.length, 1);
  assert.deepEqual(world.state[0].content.tags, ["1girl", "hoodie"]);
});

test("the same fallback while the list is unread writes NOTHING, says why, and the held write lands stripped on the next good read", async () => {
  const w = freshWatch();
  world.quarantine = null; // the booru cannot answer for it
  await w.refresh();
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl secret_tag", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome, lines } = await post("unreaddup", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "tags-blocked", lines.join("\n"));
  assert.deepEqual(world.state, []);
  assert.ok(lines.some((l) => /^warn: \[tag-state\] post #7: the booru's quarantine list is unread \(never read.*\), so the fallback tags cannot be checked; not written -- it is written, stripped, on the next good read of the list$/.test(l)), lines.join("\n"));

  world.quarantine = QDOC;
  const t = await quarantineLib.quarantineTick(w, { bridge, danbooru: new DanbooruClient(index.config.danbooru), stateType: index.TAG_STATE_TYPE, roomIds: async () => [], now: () => qclock, paceMs: 0, log: { log: () => {}, warn: () => {}, error: () => {} } });
  assert.equal(t.heldWritten, 1);
  assert.deepEqual(world.state.map((x) => [x.room, x.key, x.content.tags]), [["!room:41chan.net", "mxc://41chan.net/unreaddup", ["1girl"]]]);
});

test("a list never read is read ON DEMAND by the fallback, which then writes, stripped", async () => {
  freshWatch();
  world.quarantine = QDOC;
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl secret_tag", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome, lines } = await post("ondemand", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.deepEqual(world.state[0].content.tags, ["1girl"]);
});

test("inside the 30-minute grace an unreadable booru leaves the last good list governing: the fallback is written, stripped by it", async () => {
  const w = freshWatch();
  world.quarantine = QDOC;
  await w.refresh();
  world.quarantine = null;
  qclock += 25 * 60 * 1000;
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl secret_tag", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome, lines } = await post("gracedup", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.deepEqual(world.state.map((x) => x.content.tags), [["1girl"]]);
});

test("a list read more than 30 minutes ago (the grace) that cannot be read again is not fresh: the fallback is held, not written", async () => {
  const w = freshWatch();
  world.quarantine = QDOC;
  await w.refresh();
  world.quarantine = null;
  qclock += 30 * 60 * 1000;
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome, lines } = await post("staledup", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "tags-blocked", lines.join("\n"));
  assert.deepEqual(world.state, []);
  assert.ok(lines.some((l) => /quarantine list is unread \(last read 1800s ago: GET \/fourier_jail\/release\.json\?quarantine=1 -> 503/.test(l)), lines.join("\n"));
});

test("a new post whose tag hub fails falls back to the posted tags WITHOUT a flagged name; unread, the post stands and no state is written", async () => {
  const w = freshWatch();
  world.quarantine = { ...QDOC, flagged: ["1girl"] }; // spectrum's tag, so it is among the posted ones
  await w.refresh();
  world.replies.tagSourcesFail = [500, { error: "hub down" }];
  const a = await post("hubdown", PLAIN_PNG, "image/png", ALICE);
  assert.equal(a.outcome, "posted", a.lines.join("\n"));
  assert.ok(world.created[0].post.tag_string.split(" ").includes("1girl"), "the booru is still told, and hides the post itself");
  assert.equal(world.state.length, 1);
  assert.ok(!world.state[0].content.tags.includes("1girl"), world.state[0].content.tags.join(" "));
  assert.ok(world.state[0].content.tags.includes("41chan_alice"));

  reset();
  freshWatch(); // never read
  world.replies.tagSourcesFail = [500, { error: "hub down" }];
  const b = await post("hubdown2", PLAIN_PNG, "image/png", ALICE);
  assert.equal(b.outcome, "tags-blocked", b.lines.join("\n"));
  assert.equal(world.created.length, 1, "the post is made");
  assert.deepEqual(world.state, []);
});

// --- A PICTURE HELD HIDDEN BY ANOTHER BOT'S FLAGGED POST -------------------------------
//
// Review 2026-10-12. A picture posted in a room while the booru holds its bytes
// under a post this account may not see is "held-hidden": no post, no state,
// never retried -- right for a deleted or jailed post. But a post hidden
// because it carries a FLAGGED tag and another bot uploaded it comes back when
// the flag is released ("Turning the flag off restores everything at once"),
// and nothing ever revisited the room: its picture stayed without tag state
// for good. It is parked now, and written when the post leaves the list.

const releaseDeps = () => ({ bridge, danbooru: new DanbooruClient(index.config.danbooru), stateType: index.TAG_STATE_TYPE, roomIds: async () => [], now: () => qclock, paceMs: 0, log: { log: () => {}, warn: () => {}, error: () => {} } });

test("held hidden by another bot's FLAGGED post: parked, and the room gets its tag state, stripped, when the flag is released", async () => {
  const w = freshWatch();
  const m = md5(PLAIN_PNG);
  world.quarantine = { ...QDOC, posts: [{ id: 25, md5: m, mxc: null, flagged: true, banished: false }] };
  await w.refresh();
  world.held[m] = { id: 25, md5: m, visible: false, unpostable: true };
  const { outcome, lines } = await post("flaggedrepost", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "held-hidden", lines.join("\n"));
  assert.deepEqual(world.state, []);
  assert.ok(lines.some((l) => /flaggedrepost.*FLAGGED.*written when the flag is released/.test(l)), lines.join("\n"));

  // Still flagged: a tick writes nothing.
  assert.equal((await quarantineLib.quarantineTick(w, releaseDeps())).parkedWritten, 0);
  assert.deepEqual(world.state, []);

  // Released: the post is visible again, and leaves the list.
  world.quarantine = { ...QDOC, generation: "fedcba9876543210", posts: [] };
  world.held[m].visible = true;
  world.posts[m] = { id: 25, md5: m, tag_string: "1girl secret_tag", rating: "q" };
  world.replies.projection = [200, { tags: ["1girl", "gross"], sources: { creator: [], auto: ["1girl", "gross"], both: [], meta: [] } }];
  const t = await quarantineLib.quarantineTick(w, releaseDeps());
  assert.equal(t.parkedWritten, 1);
  assert.deepEqual(world.state.map((x) => [x.room, x.key, x.content.post_id, x.content.tags]), [["!room:41chan.net", "mxc://41chan.net/flaggedrepost", 25, ["1girl"]]]);
  assert.deepEqual(w.parked(), [], "and it is parked no longer");
});

test("held hidden by a deleted or jailed post (not in the list): not parked, nothing written later", async () => {
  const w = freshWatch();
  world.quarantine = QDOC;
  await w.refresh();
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false };
  const { outcome } = await post("jailedagain", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "held-hidden");
  assert.deepEqual(w.parked(), []);
});

test("released from the flag but jailed meanwhile: the parked picture is let go, still held-hidden, and says so", async () => {
  const w = freshWatch();
  const m = md5(PLAIN_PNG);
  world.quarantine = { ...QDOC, posts: [{ id: 25, md5: m, mxc: null, flagged: true, banished: false }] };
  await w.refresh();
  world.held[m] = { id: 25, md5: m, visible: false };
  await post("flaggedthenjailed", PLAIN_PNG, "image/png", ALICE);
  assert.equal(w.parked().length, 1);
  world.quarantine = { ...QDOC, generation: "fedcba9876543210", posts: [] };
  const t = await quarantineLib.quarantineTick(w, releaseDeps());
  assert.equal(t.parkedWritten, 0);
  assert.deepEqual(world.state, []);
  assert.deepEqual(w.parked(), []);
});

test("a parked picture whose post is then BANISHED is let go: the review ended, nothing comes back", async () => {
  const w = freshWatch();
  const m = md5(PLAIN_PNG);
  world.quarantine = { ...QDOC, posts: [{ id: 25, md5: m, mxc: null, flagged: true, banished: false }] };
  await w.refresh();
  world.held[m] = { id: 25, md5: m, visible: false, unpostable: true };
  await post("flaggedthenbanished", PLAIN_PNG, "image/png", ALICE);
  assert.equal(w.parked().length, 1);
  world.quarantine = { ...QDOC, generation: "fedcba9876543210", posts: [{ id: 25, md5: m, mxc: null, flagged: false, banished: true }] };
  // The pipeline sees a banished post; it still gets no tag state here.
  world.held[m].visible = true;
  world.held[m].tag_string = "1girl gross";
  const t = await quarantineLib.quarantineTick(w, releaseDeps());
  assert.equal(t.parkedWritten, 0);
  assert.deepEqual(world.state, []);
  assert.deepEqual(w.parked(), []);
});

// --- GATE 3: THE OTHER ADDRESSES OF A POST'S IMAGE --------------------------------------
//
// Operator rulings 2026-10-14/15 (GATE3_MATRIX_POSTS.md; contract B in
// GATE3_CONTRACTS.md): a Matrix post is visible to exactly the viewers its
// image is. A re-upload of the same bytes is a NEW mxc that only the tunnel
// can map to the post (by md5), so it reports (post_id, mxc) -- with the
// partition on create, as a body carrying ONLY mxc on a duplicate and on a
// held-hidden post -- through a durable outbox, and never rooms.

const outboxFile = () => path.join(dir, "gate3-aliases.json");
const outbox = () => (fs.existsSync(outboxFile()) ? JSON.parse(fs.readFileSync(outboxFile(), "utf8")) : {});
const aliasBodies = () => world.tagSources.filter((t) => Object.keys(t).length === 2 && "mxc" in t);
// Time passes: every kept entry's backoff runs out. The outbox re-reads its
// file on every use, so this is what the sweep would find ten minutes on.
const makeDue = () => {
  const o = outbox();
  for (const e of Object.values(o)) e.next_try_at = 0;
  fs.writeFileSync(outboxFile(), JSON.stringify(o));
};

test("gate 3: a new post's own mxc rides in the create request it already makes; accepted, nothing owed, no second request", async () => {
  const { outcome, lines } = await post("g3new", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.equal(world.tagSources.length, 1, "one tag_sources request: the create path's own");
  assert.equal(world.tagSources[0].mxc, "mxc://41chan.net/g3new");
  assert.ok(Array.isArray(world.tagSources[0].creator), "beside the partition, not instead of it");
  assert.equal(world.aliases.get("mxc://41chan.net/g3new"), POST_ID);
  assert.deepEqual(outbox(), {}, "acknowledged, so the outbox owes nothing");
});

test("gate 3: the other duplicate paths report the mxc ALONE too -- the raw-md5 record, the race at post time, a hidden post -- and never rooms", async () => {
  // Posted under older strip rules, found through the booru's raw-md5 record.
  const older = "0123456789abcdef0123456789abcdef";
  world.rawRecords[md5(A1111_PNG)] = older;
  world.posts[older] = { id: 8, md5: older, tag_string: "1girl", rating: "q" };
  assert.equal((await post("g3dupb", A1111_PNG, "image/png", BOB)).outcome, "posted");
  const b = aliasBodies();
  // Appeared between the lookup and the post: the booru's redirect names it, visible.
  reset();
  world.held[md5(PLAIN_PNG)] = { id: 9, md5: md5(PLAIN_PNG), visible: true, tag_string: "1girl", rating: "q" };
  assert.equal((await post("g3race", PLAIN_PNG, "image/png", ALICE)).outcome, "posted");
  const c = aliasBodies();
  // Held hidden: deleted or jailed, named by the redirect, never visible.
  reset();
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false };
  assert.equal((await post("g3hidden", PLAIN_PNG, "image/png", ALICE)).outcome, "held-hidden");
  const d = aliasBodies();

  assert.deepEqual(b, [{ postId: 8, mxc: "mxc://41chan.net/g3dupb" }]);
  assert.deepEqual(c, [{ postId: 9, mxc: "mxc://41chan.net/g3race" }], "once, though the race path passes through the duplicate path");
  assert.deepEqual(d, [{ postId: 25, mxc: "mxc://41chan.net/g3hidden" }]);
  assert.deepEqual(world.tagSources, d, "no partition, no tag change: the body carries ONLY mxc");
  assert.deepEqual(outbox(), {});
});

test("gate 3: the first duplicate path (stripped md5) reports too", async () => {
  const stripped = stripGeneration(A1111_PNG, "image/png").buffer;
  world.posts[md5(stripped)] = { id: 7, md5: md5(stripped), tag_string: "1girl", rating: "q" };
  assert.equal((await post("g3dupa", A1111_PNG, "image/png", BOB)).outcome, "posted");
  assert.deepEqual(aliasBodies(), [{ postId: 7, mxc: "mxc://41chan.net/g3dupa" }]);
  assert.deepEqual(world.tagSources, aliasBodies());
});

test("gate 3: a REPLAY whose room already carries the tags still reports -- and a resend has no second effect", async () => {
  await post("g3replay", PLAIN_PNG, "image/png", ALICE);
  const written = world.state[0];
  const ev = { room_id: "!room:41chan.net", sender: ALICE, content: { url: "mxc://41chan.net/g3replay", body: "g3replay.png", msgtype: "m.image" } };
  const sent = [];
  const reading = { getIntent: () => ({ getStateEvent: async () => written.content, sendStateEvent: async (r, t, k, c) => { sent.push(c); } }) };
  const first = await quietly(() => index.handleImageEvent(reading, ev));
  assert.equal(first.value, "posted");
  assert.deepEqual(sent, [], "the replay wrote no state");
  assert.ok(first.lines.some((l) => /already carries its tags/.test(l)), first.lines.join("\n"));
  const second = await quietly(() => index.handleImageEvent(reading, ev));
  assert.equal(second.value, "posted");
  assert.deepEqual(aliasBodies(), [{ postId: POST_ID, mxc: "mxc://41chan.net/g3replay" }, { postId: POST_ID, mxc: "mxc://41chan.net/g3replay" }],
    "each replay reports the mxc, before the early return");
  assert.equal(world.aliases.size, 1, "the booru's record holds it once");
  assert.equal(world.aliases.get("mxc://41chan.net/g3replay"), POST_ID);
  assert.deepEqual(outbox(), {});
});

test("gate 3: a duplicate whose fallback is held (list unread) still reports the alias -- the report is about the image, not the room's tags", async () => {
  freshWatch(); // never read, and the booru cannot answer for it
  world.quarantine = null;
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl", rating: "q" };
  world.replies.projection = [200, { tags: [], sources: { creator: [], auto: [], both: [], meta: [] } }];
  const { outcome } = await post("g3held", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "tags-blocked");
  assert.deepEqual(aliasBodies(), [{ postId: 7, mxc: "mxc://41chan.net/g3held" }]);
});

test("gate 3: NO report for a strip refusal, the booru's unpostable, media from another server, or an encrypted event", async () => {
  assert.equal((await post("g3avif", AVIF_WITH_EXIF, "image/avif", ALICE)).outcome, "strip-refused");
  world.held[md5(PLAIN_PNG)] = { id: 25, md5: md5(PLAIN_PNG), visible: false, unpostable: true };
  assert.equal((await post("g3unpostable", PLAIN_PNG, "image/png", ALICE)).outcome, "held-hidden");
  const remote = await quietly(() => index.handleImageEvent(bridge, { room_id: "!room:41chan.net", sender: ALICE, content: { url: "mxc://elsewhere.org/abc", msgtype: "m.image" } }));
  assert.equal(remote.value, "not-local");
  // An encrypted attachment carries `file`, not `url`: the tunnel has no crypto
  // and cannot read it, so it is never posted and never reported.
  const enc = await quietly(() => index.handleImageEvent(bridge, { room_id: "!room:41chan.net", sender: ALICE, content: { file: { url: "mxc://41chan.net/encrypted1", key: {} }, msgtype: "m.image" } }));
  assert.equal(enc.value, undefined);
  assert.deepEqual(aliasBodies(), []);
  assert.deepEqual(world.tagSources, []);
  assert.deepEqual(outbox(), {});
});

test("gate 3: a booru failure KEEPS the outbox entry, the picture still reports posted, and the sweep's flush delivers it", async () => {
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl", rating: "q" };
  world.replies.alias = [503, { error: "down", fix: "wait" }];
  const { outcome, lines } = await post("g3down", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  const owed = outbox()["7\nmxc://41chan.net/g3down"];
  assert.ok(owed, JSON.stringify(outbox()));
  assert.equal(owed.attempts, 1);
  assert.match(owed.last_error, /^POST \/posts\/7\/tag_sources\.json \(mxc\) -> 503: down -- fix: wait$/);
  assert.ok(lines.some((l) => /^error: \[gate3\] 1 alias report\(s\) kept in the outbox: the booru did not answer, or answered 5xx/.test(l)), lines.join("\n"));

  delete world.replies.alias;
  const early = await quietly(() => index.flushAliases());
  assert.equal(early.value.sent, 0, "not due again until its backoff (10 minutes)");
  makeDue();
  const swept = await quietly(() => index.flushAliases());
  assert.equal(swept.value.accepted, 1, swept.lines.join("\n"));
  assert.equal(swept.value.depth, 0);
  assert.deepEqual(outbox(), {});
  assert.equal(world.aliases.get("mxc://41chan.net/g3down"), 7);
});

test("gate 3: on create, a failed tag hub keeps the post's mxc owed; the sweep sends it alone and it lands", async () => {
  freshWatch();
  world.quarantine = QDOC;
  world.replies.tagSourcesFail = [500, { error: "hub down" }];
  const { outcome, lines } = await post("g3hub", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.equal(outbox()[`${POST_ID}\nmxc://41chan.net/g3hub`].attempts, 1);
  delete world.replies.tagSourcesFail;
  world.tagSources = [];
  makeDue();
  const swept = await quietly(() => index.flushAliases());
  assert.equal(swept.value.accepted, 1, swept.lines.join("\n"));
  assert.deepEqual(world.tagSources, [{ postId: POST_ID, mxc: "mxc://41chan.net/g3hub" }], "the retry carries only the mxc: the partition is not the outbox's to resend");
  assert.deepEqual(outbox(), {});
});

test("gate 3: a booru older than the contract (no mxc verdict) is not an acknowledgement -- the entry is kept, and the fix named", async () => {
  world.replies.noMxcVerdict = true;
  const { outcome, lines } = await post("g3old", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.ok(outbox()[`${POST_ID}\nmxc://41chan.net/g3old`], "kept");
  assert.ok(lines.some((l) => /kept in the outbox: the booru's answer is not gate 3's mxc verdict.*deploy chanbooru/.test(l)), lines.join("\n"));
});

test("gate 3: 404 and 403 are kept and said ONCE per flush with the fix; no_such_post and mxc_mapped_elsewhere are dropped, loudly", async () => {
  const o = index.getAliasOutbox();
  for (const n of [1, 2, 3]) o.add(100 + n, `mxc://41chan.net/g3nf${n}`);
  world.replies.alias = [404, { success: false, message: "That record was not found." }];
  const nf = await quietly(() => index.flushAliases());
  assert.equal(nf.value.kept, 3);
  assert.equal(nf.lines.filter((l) => /\[gate3\] .*kept in the outbox/.test(l)).length, 1, nf.lines.join("\n"));
  assert.match(nf.lines.find((l) => /kept in the outbox/.test(l)), /^error: \[gate3\] 3 alias report\(s\) kept in the outbox: the booru answered 404: .*deploy chanbooru/);
  world.replies.alias = [403, { success: false, message: "Access denied" }];
  makeDue();
  const fb = await quietly(() => index.flushAliases());
  assert.equal(fb.lines.filter((l) => /kept in the outbox/.test(l)).length, 1, fb.lines.join("\n"));
  assert.match(fb.lines.find((l) => /kept in the outbox/.test(l)), /3 alias report\(s\) kept in the outbox: the booru refused the tunnel's account: .*Builder/);
  assert.equal(Object.values(outbox()).every((e) => e.attempts === 2), true, JSON.stringify(outbox()));

  delete world.replies.alias;
  world.noSuchPost.add(101);
  world.aliases.set("mxc://41chan.net/g3nf2", 999);
  makeDue();
  const settled = await quietly(() => index.flushAliases());
  assert.deepEqual([settled.value.accepted, settled.value.dropped, settled.value.depth], [1, 2, 0], settled.lines.join("\n"));
  assert.ok(settled.lines.some((l) => /^error: \[gate3\] alias DROPPED: post #101 <- mxc:\/\/41chan\.net\/g3nf1: .*no_such_post/.test(l)), settled.lines.join("\n"));
  assert.ok(settled.lines.some((l) => /^error: \[gate3\] alias DROPPED: post #102 <- mxc:\/\/41chan\.net\/g3nf2: .*mxc_mapped_elsewhere/.test(l)), settled.lines.join("\n"));
  assert.equal(world.aliases.get("mxc://41chan.net/g3nf2"), 999, "the booru's mapping stands");
});

test("gate 3: every alias request carries the key in a Basic header, NEVER in the URL", async () => {
  await post("g3keya", PLAIN_PNG, "image/png", ALICE);
  world.posts[md5(A1111_PNG)] = { id: 7, md5: md5(A1111_PNG), tag_string: "1girl", rating: "q" };
  world.rawRecords[md5(A1111_PNG)] = md5(A1111_PNG);
  await post("g3keyb", A1111_PNG, "image/png", ALICE);
  assert.equal(world.aliasAuth.length, 2, JSON.stringify(world.tagSources));
  // The raw-md5 lookup that found g3keyb's post runs once per such image: it
  // too carries the key in a header, never the URL.
  assert.ok(world.rawAuth.length >= 1, "the raw-md5 lookup ran");
  for (const a of [...world.aliasAuth, ...world.rawAuth]) {
    assert.equal(a.query, "", "no query string at all");
    assert.equal(a.authorization, `Basic ${Buffer.from("tunnel:TESTKEY").toString("base64")}`);
  }
});

test("gate 3: an outbox that is not JSON is never written over -- the picture is posted, and the error names the fix", async () => {
  fs.writeFileSync(outboxFile(), "{ half a file");
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl", rating: "q" };
  const { outcome, lines } = await post("g3corrupt", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.equal(fs.readFileSync(outboxFile(), "utf8"), "{ half a file", "left exactly as it was");
  assert.ok(lines.some((l) => /^error: \[gate3\] post #7 <- mxc:\/\/41chan\.net\/g3corrupt: the alias was NOT queued \(.*is not a JSON object.*rename it to .*superseded/.test(l)), lines.join("\n"));
});

test("gate 3: the race path reports its mxc ONCE -- the held-hidden report covers the duplicate path it hands over to (`aliased`)", async () => {
  // An outbox whose booru answers at once, so the first report is settled
  // and gone before the redirect's post is looked up: a second report from
  // pointRoomAtPost would be a second request, not one absorbed in flight.
  const calls = [];
  index.setAliasOutbox(createAliasOutbox({
    danbooru: { reportMxcAlias: async (postId, mxc) => { calls.push([postId, mxc]); return { accepted: true }; } },
    file: outboxFile, log: console,
  }));
  try {
    world.held[md5(PLAIN_PNG)] = { id: 9, md5: md5(PLAIN_PNG), visible: true, tag_string: "1girl", rating: "q" };
    const { outcome, lines } = await post("g3raceonce", PLAIN_PNG, "image/png", ALICE);
    assert.equal(outcome, "posted", lines.join("\n"));
    assert.deepEqual(calls, [[9, "mxc://41chan.net/g3raceonce"]]);
  } finally {
    index.setAliasOutbox(null);
  }
});

test("gate 3: the 10-minute sweep retries owed reports on its OWN timer -- delivered while a room walk that never ends holds the walk's timer", async () => {
  world.hangJoined = true; // the walk's first step never answers
  const o = index.getAliasOutbox();
  o.add(7, "mxc://41chan.net/g3tickA");
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => lines.push(`${k}: ${a.join(" ")}`);
  const sweep = index.startBackfillSweep(bridge, "@tunnel:41chan.net", { intervalMs: 20, firstMs: 1, aliasIntervalMs: 20, aliasFirstMs: 5 });
  const until = async (what, ok) => {
    const deadline = Date.now() + 3000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`${what} never happened:\n${lines.join("\n")}`);
      await new Promise((r) => { setTimeout(r, 10); });
    }
  };
  try {
    await until("the walk to start", () => world.hung.length > 0);
    await until("report A to land", () => world.aliases.get("mxc://41chan.net/g3tickA") === 7);
    // Added after the walk is stuck: only a later tick of a timer the walk
    // does not hold can deliver it.
    o.add(7, "mxc://41chan.net/g3tickB");
    await until("report B to land", () => world.aliases.get("mxc://41chan.net/g3tickB") === 7);
    assert.equal(world.hung.length, 1, "the walk is still the first one, still stuck");
  } finally {
    sweep.stop();
    await index.getAliasOutbox().idle();
    for (const res of world.hung) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ joined_rooms: [] })); }
    Object.assign(console, saved);
  }
  assert.deepEqual(outbox(), {});
});

test("gate 3: a new duplicate costs ONE request however much is owed -- the image path sends its own report, never the backlog", async () => {
  const o = index.getAliasOutbox();
  for (const n of [1, 2, 3]) o.add(200 + n, `mxc://41chan.net/g3owed${n}`); // owed, and due
  world.posts[md5(PLAIN_PNG)] = { id: 7, md5: md5(PLAIN_PNG), tag_string: "1girl", rating: "q" };
  const { outcome, lines } = await post("g3onecost", PLAIN_PNG, "image/png", ALICE);
  assert.equal(outcome, "posted", lines.join("\n"));
  assert.deepEqual(aliasBodies(), [{ postId: 7, mxc: "mxc://41chan.net/g3onecost" }]);
  assert.equal(Object.keys(outbox()).length, 3, "the backlog waits for the sweep");
});
