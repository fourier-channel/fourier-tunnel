"use strict";

// Discord acquisition against a stand-in Discord that behaves the way the
// 2026-09-21 probe MEASURED the real one: `?after=` returns the block adjacent
// to the cursor, newest first within the page, and ids are snowflakes far past
// 2^53, where Number() would silently merge neighbours.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const acq = require("./discordAcquire.js");

const CH = "1551446881308250114";
const CH2 = "1551446881308250999";
const GUILD = "1551446880385245275";
const SELF = "1551416120580374528";
const BASE = 1551446881308250200n;

// ---- a real, tiny PNG (4x4 RGB), with optional text chunks -----------------
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
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR = chunk("IHDR", Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 2, 0, 0, 0]));
const IDAT = chunk("IDAT", zlib.deflateSync(Buffer.concat(
  [0, 1, 2, 3].map((y) => Buffer.from([0, ...[0, 1, 2, 3].flatMap((x) => [x * 60, y * 60, 128])])),
)));
const IEND = chunk("IEND", Buffer.alloc(0));
const png = (extra = []) => Buffer.concat([SIG, IHDR, ...extra, IDAT, IEND]);
const PROMPT = "masterpiece, best quality, 1girl, solo\nNegative prompt: lowres\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 512x512, Model: test";

// ---- the stand-in Discord --------------------------------------------------
function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    json: async () => body,
    arrayBuffer: async () => {
      const b = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

function message(n, { attachments = [], content = "look", author = { id: "111", username: "alice", global_name: "Alice" } } = {}) {
  return {
    id: (BASE + BigInt(n)).toString(),
    type: 0,
    content,
    author,
    timestamp: new Date(Date.UTC(2026, 8, 21, 5, 0, n)).toISOString(),
    attachments,
    embeds: [],
    sticker_items: [],
    components: [],
  };
}

function attachment(n, filename, bytes, contentType = "image/png") {
  return {
    id: `9${n}`,
    filename,
    size: bytes.length,
    content_type: contentType,
    url: `https://cdn.test/attachments/${n}/${filename}?ex=6700&is=66ff&hm=SECRETSIGNATURE`,
  };
}

function fakeDiscord({ channels = { [CH]: { id: CH, type: 0, name: "general", guild_id: GUILD } }, messages = {}, cdn = {}, route = () => null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url, host: u.host, auth: init && init.headers ? init.headers.Authorization : undefined });
    const special = route(u, calls);
    if (special) return special;
    if (u.host === "cdn.test") {
      const body = cdn[u.pathname];
      return body ? res(200, body) : res(404, {});
    }
    const p = u.pathname.replace(/^\/api\/v10/, "");
    const m = p.match(/^\/channels\/(\d+)(\/messages)?$/);
    if (!m || !channels[m[1]]) return res(404, {});
    if (!m[2]) return res(200, channels[m[1]]);
    const sorted = [...(messages[m[1]] || [])].sort((a, b) => acq.snowflakeCompare(a.id, b.id));
    const limit = Number(u.searchParams.get("limit") || 50);
    const after = u.searchParams.get("after");
    if (after === null) return res(200, sorted.slice(-limit).reverse());
    return res(200, sorted.filter((x) => acq.snowflakeCompare(x.id, after) > 0).slice(0, limit).reverse());
  };
  return { fetchImpl, calls };
}

async function rig(t, discord, { queue = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tunnel-dacq-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dropRoot = path.join(root, "spool");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(dropRoot, { recursive: true });
  if (queue) await fs.mkdir(path.join(dropRoot, "_drop", "discord", "ready"), { recursive: true });
  const slept = [];
  const logs = [];
  const http = new acq.DiscordHttp({
    token: "TOKEN", ua: acq.userAgent("https://example.test", "1.0.0"),
    fetchImpl: discord.fetchImpl, sleep: async (ms) => { slept.push(ms); }, now: () => 1_790_000_000_000, spacingMs: 0,
  });
  const run = (extra = {}) => acq.acquireOnce({
    http, channels: [CH], dropRoot, stateDir, startFrom: "beginning", pageSize: 2, selfId: SELF,
    now: () => 1_790_000_000_000, log: (m) => logs.push(m), ...extra,
  });
  const ready = async () => {
    const dir = path.join(dropRoot, "_drop", "discord", "ready");
    const ids = (await fs.readdir(dir)).sort();
    return Promise.all(ids.map(async (id) => ({
      id,
      sidecar: JSON.parse(await fs.readFile(path.join(dir, id, "entry.json"), "utf8")),
      bytes: await fs.readFile(path.join(dir, id, "bytes")),
    })));
  };
  const watermark = async (ch = CH) => (await acq.readChannelState(stateDir, ch)).after;
  return { root, dropRoot, stateDir, http, run, ready, watermark, slept, logs };
}

test("delivers every attachment in id order from descending pages, and the watermark is the exact last snowflake", async (t) => {
  const img = png();
  const msgs = [1, 2, 3].map((n) => message(n, { attachments: [attachment(n, `pic${n}.png`, img)] }));
  const cdn = Object.fromEntries([1, 2, 3].map((n) => [`/attachments/${n}/pic${n}.png`, img]));
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs }, cdn }));
  const { results } = await r.run();
  assert.equal(results[0].delivered, 3);
  assert.equal(results[0].pages, 2, "a page of 2 then a page of 1: the walk crossed a truncated page");
  const entries = await r.ready();
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.sidecar.message_ref), msgs.map((m) => m.id));
  const s = entries[0].sidecar;
  assert.equal(s.source, "discord");
  assert.equal(s.namespace, "discord");
  assert.equal(s.container_ref, CH);
  assert.equal(s.attachment_ref, "91");
  assert.equal(s.author, "Alice");
  assert.equal(s.author_ref, "111");
  assert.equal(s.permalink, `https://discord.com/channels/${GUILD}/${CH}/${msgs[0].id}`);
  assert.equal(s.ext, ".png");
  assert.equal(await r.watermark(), msgs[2].id, "the watermark is the string id; Number() would have rounded it");
  assert.equal(Number(msgs[1].id), Number(msgs[2].id), "these ids are beyond 2^53: as Numbers two neighbours collide, which is why they are never Numbers here");
});

test("a second pass asks only for what came after the watermark", async (t) => {
  const img = png();
  const msgs = [message(1, { attachments: [attachment(1, "a.png", img)] })];
  const cdn = { "/attachments/1/a.png": img, "/attachments/4/b.png": img };
  const d = fakeDiscord({ messages: { [CH]: msgs }, cdn });
  const r = await rig(t, d);
  await r.run();
  const mark = await r.watermark();
  msgs.push(message(4, { attachments: [attachment(4, "b.png", img)] }));
  d.calls.length = 0;
  const { results } = await r.run();
  assert.equal(results[0].delivered, 1);
  assert.ok(d.calls.some((c) => c.url.includes(`after=${mark}`)), "resumed from the stored watermark");
  assert.equal((await r.ready()).length, 2);
});

test("start-from now enrols at the newest message and collects nothing older", async (t) => {
  const img = png();
  const msgs = [1, 2].map((n) => message(n, { attachments: [attachment(n, `p${n}.png`, img)] }));
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs } }));
  const { results } = await r.run({ startFrom: "now" });
  assert.equal(results[0].enrolled, true);
  assert.equal(await r.watermark(), msgs[1].id);
  assert.equal((await r.ready()).length, 0);
});

test("a 401 stops the whole pass at once, with no retry, and the status file says why", async (t) => {
  const d = fakeDiscord({ route: (u) => (u.host === "discord.com" ? res(401, { message: "401: Unauthorized" }) : null) });
  const r = await rig(t, d);
  await assert.rejects(r.run({ channels: [CH, CH2] }), acq.AuthFailed);
  assert.equal(d.calls.length, 1, "one request, never retried: invalid requests get an IP banned");
  const status = JSON.parse(await fs.readFile(path.join(r.stateDir, "discord-status.json"), "utf8"));
  assert.match(status.fatal, /token is wrong or has been reset/);
  assert.equal(status.ok, false);
});

test("a channel the bot cannot read is reported, and the next channel is still read", async (t) => {
  const img = png();
  const d = fakeDiscord({
    channels: { [CH]: { id: CH, type: 0, name: "general", guild_id: GUILD }, [CH2]: { id: CH2, type: 0, name: "art", guild_id: GUILD } },
    messages: { [CH2]: [message(1, { attachments: [attachment(1, "x.png", img)] })] },
    cdn: { "/attachments/1/x.png": img },
    route: (u) => (u.pathname.startsWith(`/api/v10/channels/${CH}`) ? res(403, { message: "Missing Access" }) : null),
  });
  const r = await rig(t, d);
  const { results } = await r.run({ channels: [CH, CH2] });
  assert.match(results[0].stopped, /View Channel and Read Message History/);
  assert.equal(results[1].delivered, 1);
});

test("a 429 waits Discord's own retry_after and then succeeds", async (t) => {
  let limited = false;
  const d = fakeDiscord({
    route: (u) => {
      if (!limited && u.pathname === `/api/v10/channels/${CH}`) {
        limited = true;
        return res(429, { retry_after: 0.25, global: false }, { "retry-after": "1" });
      }
      return null;
    },
  });
  const r = await rig(t, d);
  const { results } = await r.run();
  assert.equal(results[0].stopped, null);
  assert.ok(r.slept.includes(300), `waited the body's 0.25 s (+50 ms), not the header's rounded 1 s: ${JSON.stringify(r.slept)}`);
});

test("a failed download holds the watermark behind its message, and the next pass re-lists it", async (t) => {
  const img = png();
  const msgs = [1, 2, 3].map((n) => message(n, { attachments: [attachment(n, `p${n}.png`, img)] }));
  const cdn = { "/attachments/1/p1.png": img, "/attachments/2/p2.png": img, "/attachments/3/p3.png": img };
  let broken = true;
  const d = fakeDiscord({
    messages: { [CH]: msgs }, cdn,
    route: (u) => (broken && u.pathname === "/attachments/2/p2.png" ? res(500, {}) : null),
  });
  const r = await rig(t, d);
  const first = await r.run();
  assert.match(first.results[0].stopped, /re-listed \(with a fresh URL\) next cycle/);
  assert.equal(await r.watermark(), msgs[0].id);
  broken = false;
  const second = await r.run();
  assert.equal(second.results[0].delivered, 2);
  assert.equal((await r.ready()).length, 3);
});

test("an unsupported type is refused by name and the walk moves on past it", async (t) => {
  const txt = Buffer.from("hello");
  const msgs = [message(1, { attachments: [attachment(1, "notes.txt", txt, "text/plain")] })];
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs } }));
  const { results, status } = await r.run();
  assert.equal(results[0].refused.length, 1);
  assert.match(results[0].refused[0].reason, /"notes\.txt" \(text\/plain\) is not a type this archive carries/);
  assert.equal(await r.watermark(), msgs[0].id, "a deliberate refusal is a disposition; the watermark advances");
  assert.equal(status.channels[0].refused, 1);
});

test("a person's message with nothing in it stops the walk: that is MESSAGE CONTENT switched off", async (t) => {
  const img = png();
  const msgs = [
    message(1, { attachments: [attachment(1, "a.png", img)] }),
    message(2, { content: "", attachments: [] }),
    message(3, { attachments: [attachment(3, "c.png", img)] }),
  ];
  const cdn = { "/attachments/1/a.png": img, "/attachments/3/c.png": img };
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs }, cdn }));
  const { results } = await r.run();
  assert.match(results[0].stopped, /MESSAGE CONTENT intent/);
  assert.equal(await r.watermark(), msgs[0].id, "held before the empty message, so nothing it hid is skipped");
  assert.equal((await r.ready()).length, 1);
});

test("the signed URL's query never reaches a log, a stop message or the status file", async (t) => {
  const img = png();
  const msgs = [message(1, { attachments: [attachment(1, "a.png", img)] })];
  const d = fakeDiscord({ messages: { [CH]: msgs }, route: (u) => (u.host === "cdn.test" ? res(503, {}) : null) });
  const r = await rig(t, d);
  const { results } = await r.run();
  const status = await fs.readFile(path.join(r.stateDir, "discord-status.json"), "utf8");
  const everything = JSON.stringify(results) + r.logs.join("\n") + status;
  assert.ok(everything.includes("cdn.test/attachments/1/a.png"), "the failure names the file");
  assert.ok(!everything.includes("SECRETSIGNATURE") && !everything.includes("hm="), "but never its signature");
});

test("the bot token goes to discord.com and nowhere else", async (t) => {
  const img = png();
  const msgs = [message(1, { attachments: [attachment(1, "a.png", img)] })];
  const d = fakeDiscord({ messages: { [CH]: msgs }, cdn: { "/attachments/1/a.png": img } });
  const r = await rig(t, d);
  await r.run();
  const api = d.calls.filter((c) => c.host === "discord.com");
  const cdnCalls = d.calls.filter((c) => c.host === "cdn.test");
  assert.ok(api.length > 0 && api.every((c) => c.auth === "Bot TOKEN"));
  assert.ok(cdnCalls.length === 1 && cdnCalls.every((c) => c.auth === undefined));
});

test("no drop queue: the pass stops, delivers nothing, and does not advance", async (t) => {
  const img = png();
  const msgs = [message(1, { attachments: [attachment(1, "a.png", img)] })];
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs }, cdn: { "/attachments/1/a.png": img } }), { queue: false });
  await assert.rejects(r.run(), (err) => err instanceof acq.DeliveryUnavailable && /does NOT create it/.test(err.message));
  assert.equal(await r.watermark(), undefined, "no watermark was written");
});

test("generation data is stripped before delivery and kept only in private state", async (t) => {
  const tagged = png([chunk("tEXt", Buffer.from(`parameters\0${PROMPT}`, "latin1"))]);
  const msgs = [message(1, { attachments: [attachment(1, "gen.png", tagged)] })];
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs }, cdn: { "/attachments/1/gen.png": tagged } }));
  const { results } = await r.run();
  assert.equal(results[0].stripped, 1);
  const [entry] = await r.ready();
  assert.ok(!entry.bytes.includes(Buffer.from("Steps: 20")), "the delivered bytes carry no prompt");
  assert.ok(entry.bytes.length < tagged.length);
  const ledger = (await fs.readFile(path.join(r.stateDir, "discord-generation.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.match(ledger[0].removed["png:parameters"], /Steps: 20/);
  assert.notEqual(ledger[0].md5, ledger[0].raw_md5);
});

test("her own messages are not collected, and the walk still moves past them", async (t) => {
  const img = png();
  const msgs = [message(1, { attachments: [attachment(1, "mine.png", img)], author: { id: SELF, username: "tunnel", bot: true } })];
  const r = await rig(t, fakeDiscord({ messages: { [CH]: msgs }, cdn: { "/attachments/1/mine.png": img } }));
  const { results } = await r.run();
  assert.equal(results[0].delivered, 0);
  assert.equal(await r.watermark(), msgs[0].id);
});

test("contentWithheld: only a person's genuinely empty message counts", () => {
  assert.equal(acq.contentWithheld({ type: 0, author: { id: "1" }, content: "", attachments: [], embeds: [] }), true);
  assert.equal(acq.contentWithheld({ type: 0, author: { id: "1" }, content: "hi", attachments: [] }), false);
  assert.equal(acq.contentWithheld({ type: 0, author: { id: "1", bot: true }, content: "" }), false);
  assert.equal(acq.contentWithheld({ type: 7, author: { id: "1" }, content: "" }), false, "a join notice is a system message, empty by nature");
  assert.equal(acq.contentWithheld({ type: 0, author: { id: "1" }, content: "", message_snapshots: [{}] }), false, "a forward carries its content in a snapshot");
});
