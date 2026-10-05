"use strict";

// Posting a Discord image the way a Matrix image is posted (operator ruling
// 2026-10-04), against a stand-in booru that records every call.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { BooruDuplicate, BooruRefusal } = require("./danbooru");
const { extractCreatorTagsFromFields } = require("./prompt-tags");
const { booruDeliverer } = require("./discordPost");
const acq = require("./discordAcquire");

const GUILD = "1551446880385245275";
const CHANNEL = { id: "1551446881308250114", type: 0, name: "general", guild_id: GUILD };

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}
const png = (extra = []) => Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0])),
  ...extra,
  chunk("IDAT", zlib.deflateSync(Buffer.concat([0, 1, 2, 3].map((y) => Buffer.from([0, ...[0, 1, 2, 3].flatMap((x) => [x * 60, y * 60, 128])]))))),
  chunk("IEND", Buffer.alloc(0)),
]);
const PROMPT = "masterpiece, best quality, 1girl, solo, smile\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 512x512, Model: test";

function fakeBooru(over = {}) {
  const calls = [];
  const rec = (name, fn) => async (...args) => { calls.push({ name, args }); return fn(...args); };
  const booru = {
    findPostByMd5: rec("findPostByMd5", async () => null),
    findGenerationByRawMd5: rec("findGenerationByRawMd5", async () => null),
    createUploadFromBytes: rec("createUploadFromBytes", async () => ({ id: 1 })),
    waitForUpload: rec("waitForUpload", async () => ({ upload_media_assets: [{ id: 7 }] })),
    createPost: rec("createPost", async () => ({ id: 42 })),
    recordGenerationMetadata: rec("recordGenerationMetadata", async (md5) => ({ md5 })),
    recordTagSources: rec("recordTagSources", async () => ({ projection: { tags: [] } })),
    recordPostCreator: rec("recordPostCreator", async () => ({})),
    ...over,
  };
  for (const k of Object.keys(over)) booru[k] = rec(k, over[k]);
  return { booru, calls, named: (n) => calls.filter((c) => c.name === n) };
}

function deliverer(booru, extra = {}) {
  const logs = [];
  const categorised = [];
  const d = booruDeliverer({
    danbooru: booru,
    autotag: async () => ({ tags: ["1girl", "solo", "outdoors"], rating: "g" }),
    extractCreatorTagsFromFields,
    categoriseArtist: async (t) => { categorised.push(t); },
    config: { autotagger: {}, bridge: { default_rating: "q" } },
    prefixFor: (g) => (g === GUILD ? "aichan" : null),
    log: (m) => logs.push(m),
    ...extra,
  });
  return { d, logs, categorised };
}

const msg = (over = {}) => ({
  id: "1551459230517821480", type: 0, content: "art", timestamp: "2026-09-21T05:05:05.274Z",
  author: { id: "136983939662348288", username: "selphdestruct", global_name: "Selph" }, ...over,
});
const att = (filename = "pic.png", contentType = "image/png") => ({ id: "155", filename, content_type: contentType, size: 1, url: "https://cdn.test/x" });

test("a Discord image is posted with the guild's creator tag and its permalink as the source", async () => {
  const f = fakeBooru();
  const { d, categorised, logs } = deliverer(f.booru);
  const r = await d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  const { md5, ...rest } = r;
  assert.deepEqual(rest, { delivered: true, postId: 42, stripped: false });
  assert.match(md5, /^[0-9a-f]{32}$/, "the post's md5, for the panel's thumbnail");
  // The service labels each line "[discord] " itself; a label here doubled it.
  assert.ok(logs.some((l) => l.startsWith("post #42 from ")), logs.join("\n"));
  assert.ok(!logs.some((l) => l.startsWith("[discord]")), logs.join("\n"));
  const [post] = f.named("createPost");
  const { tagString, source } = post.args[1];
  assert.ok(tagString.split(" ").includes("aichan_selphdestruct"), tagString);
  assert.ok(tagString.split(" ").includes("1girl"), "spectrum's tags, as on Matrix");
  assert.equal(source, `https://discord.com/channels/${GUILD}/${CHANNEL.id}/1551459230517821480`);
  assert.deepEqual(categorised, ["aichan_selphdestruct"]);
  assert.equal(f.named("recordTagSources").length, 1);
});

test("no creator record is written: a Discord author has no Matrix account until they claim the tag", async () => {
  const f = fakeBooru();
  await deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  assert.equal(f.named("recordPostCreator").length, 0);
});

test("generation data is stripped from the upload and filed privately as source discord", async () => {
  const f = fakeBooru();
  const tagged = png([chunk("tEXt", Buffer.from(`parameters\0${PROMPT}`, "latin1"))]);
  const r = await deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att("gen.png"), bytes: tagged });
  assert.equal(r.stripped, true);
  const [up] = f.named("createUploadFromBytes");
  assert.ok(!up.args[0].includes(Buffer.from("Steps: 20")), "the booru never receives the prompt");
  const [gen] = f.named("recordGenerationMetadata");
  assert.equal(gen.args[1].source, "discord");
  assert.equal(gen.args[1].poster, "discord:136983939662348288");
  assert.match(gen.args[1].fields["png:parameters"], /Steps: 20/);
  const tags = f.named("createPost")[0].args[1].tagString.split(" ");
  assert.ok(!tags.includes("smile"), "a creator-only prompt tag stays out of the public tag string");
  const [ts] = f.named("recordTagSources");
  assert.ok(ts.args[1].creator.includes("smile"), "they travel in the private partition instead");
});

test("an image already on the booru is not uploaded again", async () => {
  const f = fakeBooru({ findPostByMd5: async () => ({ id: 9, md5: "a".repeat(32) }) });
  const r = await deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  assert.deepEqual(r, { alreadyQueued: true, postId: 9, md5: "a".repeat(32) }, "the post it already is, so the panel can link it");
  assert.equal(f.named("createUploadFromBytes").length, 0);
});

test("a username that cannot be tagged exactly is refused, not folded, and nothing is uploaded", async () => {
  const f = fakeBooru();
  const r = await deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg({ author: { id: "5", username: "a.b" } }), att: att(), bytes: png() });
  assert.match(r.refused, /outside \[a-z0-9_-\]/);
  assert.equal(f.calls.length, 0);
});

test("a bot or webhook is not a creator", async () => {
  const f = fakeBooru();
  const r = await deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg({ author: { id: "6", username: "hook", bot: true } }), att: att(), bytes: png() });
  assert.match(r.refused, /not a creator/);
  assert.equal(f.calls.length, 0);
});

test("a guild with no configured prefix stops its channel: every post must have a creator", async () => {
  const f = fakeBooru();
  await assert.rejects(
    deliverer(f.booru).d.deliver({ channel: { ...CHANNEL, guild_id: "999" }, msg: msg(), att: att(), bytes: png() }),
    (err) => err instanceof acq.ChannelRefused && /no creator prefix is configured for guild 999/.test(err.message),
  );
});

test("only images are posted, as from Matrix", () => {
  const { d } = deliverer(fakeBooru().booru);
  assert.equal(d.accepts(att("clip.mp4", "video/mp4")) !== null, true);
  assert.equal(d.accepts(att("notes.pdf", "application/pdf")) !== null, true);
  assert.equal(d.accepts(att("PIC.PNG")), null, "an uppercase extension is still an image");
});

test("a booru that cannot be reached holds the message for the next cycle", async () => {
  const f = fakeBooru({ createUploadFromBytes: async () => { throw new Error("connect ECONNREFUSED"); } });
  await assert.rejects(deliverer(f.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() }), acq.Transient);
});

test("a hidden duplicate and a named duplicate are both final, never retried", async () => {
  const hidden = fakeBooru({ createPost: async () => { const e = new BooruRefusal("unpostable", 422, {}); e.reason = "unpostable"; throw e; } });
  const r1 = await deliverer(hidden.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  assert.match(r1.refused, /cannot see, deleted or jailed/);
  const named = fakeBooru({ createPost: async () => { throw new BooruDuplicate("dup", 422, 77); } });
  const r2 = await deliverer(named.booru).d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  assert.equal(r2.alreadyQueued, true);
  assert.equal(r2.postId, 77, "the post the booru named, so the panel can link it");
  assert.match(r2.md5, /^[0-9a-f]{32}$/);
});

test("a tagger outage still posts, with the creator tag", async () => {
  const f = fakeBooru();
  const { d } = deliverer(f.booru, { autotag: async () => { throw new Error("spectrum down"); } });
  const r = await d.deliver({ channel: CHANNEL, msg: msg(), att: att(), bytes: png() });
  assert.equal(r.delivered, true);
  assert.equal(f.named("createPost")[0].args[1].tagString, "aichan_selphdestruct");
});

test("a sub-account merged under a master is posted under the master's name", async () => {
  const f = fakeBooru();
  const { d } = deliverer(f.booru, { creatorFor: async (a) => (a.id === "5" ? "selphdestruct" : a.username) });
  const r = await d.deliver({ channel: CHANNEL, msg: msg({ author: { id: "5", username: "a.b" } }), att: att(), bytes: png() });
  assert.equal(r.delivered, true, "the sub's own name could not be tagged; the master's can");
  assert.ok(f.named("createPost")[0].args[1].tagString.split(" ").includes("aichan_selphdestruct"));
});
