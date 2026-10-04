"use strict";

// Her voice through the panel (operator ruling 2026-10-04): the outbox worker
// against a stand-in Discord, and the discord index that the panel's
// percentages divide by.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const acq = require("./discordAcquire");
const speak = require("./discordSpeak");
const { indexOnce } = require("./discordIndex");

const CH = "1551446881308250114";
const CH2 = "1551446881308250777";
const GUILD = "1551446880385245275";
const SELF = "1551416120580374528";

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) }, json: async () => body };
}

async function tmp(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "tunnel-speak-"));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}

function http(fetchImpl) {
  return new acq.DiscordHttp({ token: "TOKEN", ua: "DiscordBot (x, 1)", fetchImpl, sleep: async () => {}, now: () => 0, spacingMs: 0 });
}

// A Discord that stores what is posted and gives it back on read.
function fakeDiscord({ onPost } = {}) {
  const posted = new Map();
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || "GET", path: u.pathname, body: init.body ? JSON.parse(init.body) : null });
    const m = u.pathname.match(/^\/api\/v10\/channels\/(\d+)\/messages(?:\/(\d+))?$/);
    if (!m) return res(404, {});
    if ((init.method || "GET") === "POST") {
      if (onPost) { const r = await onPost(calls.filter((c) => c.method === "POST").length); if (r) return r; }
      const id = String(9000000000000000000n + BigInt(++n));
      const body = JSON.parse(init.body);
      posted.set(id, { id, channel_id: m[1], content: body.content });
      return res(200, posted.get(id));
    }
    if (m[2]) return posted.has(m[2]) ? res(200, posted.get(m[2])) : res(404, {});
    return res(200, []);
  };
  return { fetchImpl, calls, posted };
}

async function queue(stateDir, name, entry) {
  await fs.writeFile(path.join(stateDir, "outbox", "ready", name), JSON.stringify(entry));
}

test("a queued message is sent, read back, and filed as sent with its Discord id", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { id: "001", channel: CH, text: "Hello from Neru-chan" });
  const d = fakeDiscord();
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0].verified, true);
  const sent = JSON.parse(await fs.readFile(path.join(dir, "outbox", "sent", "001.json"), "utf8"));
  assert.equal(sent.text, "Hello from Neru-chan");
  assert.ok(sent.message_id);
  assert.deepEqual(d.calls.find((c) => c.method === "POST").body.allowed_mentions, { parse: ["users"] }, "no @everyone, @here or role pings");
  assert.deepEqual(await fs.readdir(path.join(dir, "outbox", "ready")), []);
});

test("paused: nothing is sent and the queue waits", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await fs.writeFile(path.join(dir, "speech.json"), JSON.stringify({ paused: true }));
  await queue(dir, "001.json", { channel: CH, text: "hi" });
  const d = fakeDiscord();
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.paused, true);
  assert.equal(r.waiting, 1);
  assert.equal(d.calls.length, 0);
});

test("the pause is re-read before every send: pausing mid-queue stops the next message", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH, text: "first" });
  await queue(dir, "002.json", { channel: CH, text: "second" });
  const d = fakeDiscord({ onPost: async (count) => { if (count === 1) await fs.writeFile(path.join(dir, "speech.json"), JSON.stringify({ paused: true })); return null; } });
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.sent.length, 1);
  assert.equal(r.paused, true);
  assert.deepEqual(await fs.readdir(path.join(dir, "outbox", "ready")), ["002.json"]);
});

test("a channel she is not assigned to is refused before anything is sent", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH2, text: "hi" });
  const d = fakeDiscord();
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.failed.length, 1);
  assert.equal(d.calls.length, 0);
  const f = JSON.parse(await fs.readFile(path.join(dir, "outbox", "failed", "001.json"), "utf8"));
  assert.match(f.reason, /not one she is assigned to/);
});

test("a 5xx after the send is never repeated: it may have landed", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH, text: "hi" });
  const d = fakeDiscord({ onPost: async () => res(502, { message: "Bad Gateway" }) });
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.failed.length, 1);
  assert.equal(d.calls.filter((c) => c.method === "POST").length, 1, "one send, no retry");
  const f = JSON.parse(await fs.readFile(path.join(dir, "outbox", "failed", "001.json"), "utf8"));
  assert.match(f.reason, /may have landed; not repeated/);
});

test("a 429 is Discord saying it did NOT process the send, so that one is retried", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH, text: "hi" });
  const d = fakeDiscord({ onPost: async (count) => (count === 1 ? res(429, { retry_after: 0.1 }) : null) });
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.sent.length, 1);
});

test("an over-length or empty message is refused with the reason", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH, text: "x".repeat(2001) });
  await queue(dir, "002.json", { channel: CH, text: "   " });
  const d = fakeDiscord();
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.failed.length, 2);
  assert.equal(d.calls.length, 0);
});

test("an unreadable pause file keeps her quiet rather than guessing she may speak", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await fs.writeFile(path.join(dir, "speech.json"), "{not json");
  await queue(dir, "001.json", { channel: CH, text: "hi" });
  const d = fakeDiscord();
  const r = await speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} });
  assert.equal(r.paused, true);
  assert.equal(d.calls.length, 0);
});

test("no outbox: the worker refuses rather than creating one", async (t) => {
  const dir = await tmp(t);
  await assert.rejects(speak.processOutbox({ http: http(fakeDiscord().fetchImpl), stateDir: dir, channels: [CH] }), /--init/);
});

test("a revoked token stops the worker", async (t) => {
  const dir = await tmp(t);
  await speak.initOutbox(dir);
  await queue(dir, "001.json", { channel: CH, text: "hi" });
  const d = fakeDiscord({ onPost: async () => res(401, {}) });
  await assert.rejects(speak.processOutbox({ http: http(d.fetchImpl), stateDir: dir, channels: [CH], log: () => {} }), acq.AuthFailed);
});

// ---- the index -------------------------------------------------------------

function guildDiscord(messages) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v10/, "");
    if (p === `/guilds/${GUILD}`) return res(200, { id: GUILD, name: "AIchan" });
    if (p === `/guilds/${GUILD}/channels`) return res(200, [
      { id: CH, type: 0, name: "art", position: 1 },
      { id: CH2, type: 0, name: "chat", position: 2 },
      { id: "1551446881308250999", type: 2, name: "voice" },
    ]);
    if (p === `/channels/${CH}/messages`) {
      const after = BigInt(u.searchParams.get("after"));
      const limit = Number(u.searchParams.get("limit"));
      return res(200, messages.filter((m) => BigInt(m.id) > after).slice(0, limit).reverse());
    }
    return res(404, {});
  };
  return fetchImpl;
}

const BASE = 1551459230517821000n;
const msg = (n, author, attachments) => ({ id: String(BASE + BigInt(n)), type: 0, content: "x", timestamp: "2026-09-21T05:00:00Z", author, attachments });
const att = (n, filename) => ({ id: `77${n}`, filename, size: 10 });
const PERSON = { id: "111", username: "selphdestruct", global_name: "Selph" };

test("the index lists every attachment in an assigned channel, each in scope or out with its reason", async (t) => {
  const dir = await tmp(t);
  const messages = [
    msg(1, PERSON, [att(1, "a.png"), att(2, "clip.mp4")]),
    msg(2, { id: "222", username: "a.b" }, [att(3, "b.png")]),
    msg(3, { id: "333", username: "hook", bot: true }, [att(4, "c.png")]),
    msg(4, { id: SELF, username: "tunnel", bot: true }, [att(5, "d.png")]),
    msg(5, PERSON, []),
  ];
  const r = await indexOnce({ http: http(guildDiscord(messages)), stateDir: dir, prefixes: { [GUILD]: "aichan" }, channels: [CH], selfId: SELF, log: () => {} });
  assert.equal(r.results[0].rows, 5);
  assert.equal(r.results[0].inScope, 1);
  const rows = (await fs.readFile(path.join(dir, "index", `${CH}.jsonl`), "utf8")).trim().split("\n").map(JSON.parse);
  const why = Object.fromEntries(rows.map((x) => [x.f, x.ok ? "ok" : x.why]));
  assert.equal(why["a.png"], "ok");
  assert.match(why["clip.mp4"], /not an image/);
  assert.match(why["b.png"], /cannot be carried exactly/);
  assert.match(why["c.png"], /bot or webhook/);
  assert.match(why["d.png"], /her own message/);
  const g = JSON.parse(await fs.readFile(path.join(dir, "guilds.json"), "utf8"));
  assert.deepEqual(g.guilds, [{ id: GUILD, name: "AIchan", prefix: "aichan" }]);
  assert.deepEqual(g.channels.map((c) => [c.name, c.assigned]), [["art", true], ["chat", false]], "voice channels are not listed");
});

test("a second index pass lists only what is new", async (t) => {
  const dir = await tmp(t);
  const messages = [msg(1, PERSON, [att(1, "a.png")])];
  const opts = { stateDir: dir, prefixes: { [GUILD]: "aichan" }, channels: [CH], selfId: SELF, log: () => {} };
  await indexOnce({ ...opts, http: http(guildDiscord(messages)) });
  messages.push(msg(2, PERSON, [att(2, "b.png")]));
  const r = await indexOnce({ ...opts, http: http(guildDiscord(messages)) });
  assert.equal(r.results[0].rows, 1);
  const rows = (await fs.readFile(path.join(dir, "index", `${CH}.jsonl`), "utf8")).trim().split("\n");
  assert.equal(rows.length, 2);
});
