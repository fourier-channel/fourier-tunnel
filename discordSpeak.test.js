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
const { indexOnce, creatorNameFor, readServers, seedServers, acquirable } = require("./discordIndex");
const perms = require("./discordPerms");

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
  assert.match(f.reason, /not one she can speak in/);
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

const ROLE_BOT = "1551446880385245999";
const VIEW = String(1 << 10);
const HISTORY = String(1 << 16);
const SEND = String(1 << 11);
const EVERYONE_PERMS = String((1 << 10) | (1 << 11) | (1 << 16));

function guildDiscord(messages, { memberOf = [{ id: GUILD, name: "AIchan" }], broken = [] } = {}) {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/v10/, "");
    if (p === "/users/@me/guilds") return res(200, memberOf);
    if (broken.some((g) => p.startsWith(`/guilds/${g}`))) return res(403, {});
    if (p === `/guilds/${GUILD}`) return res(200, { id: GUILD, name: "AIchan", owner_id: "1", roles: [{ id: GUILD, permissions: EVERYONE_PERMS }, { id: ROLE_BOT, permissions: "0" }] });
    if (p === `/guilds/${GUILD}/members/${SELF}`) return res(200, { user: { id: SELF }, roles: [ROLE_BOT] });
    if (p === `/guilds/${GUILD}/channels`) return res(200, [
      { id: "1551446881308250500", type: 4, name: "Text Channels", position: 0 },
      { id: CH, type: 0, name: "art", position: 1, parent_id: "1551446881308250500", permission_overwrites: [] },
      { id: CH2, type: 0, name: "chat", position: 2, parent_id: "1551446881308250500", permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: HISTORY }] },
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
  assert.equal(r.results.length, 1, "only the channel whose history she can read is walked");
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
  assert.deepEqual(g.guilds, [{ id: GUILD, name: "AIchan", label: null, prefix: "aichan" }]);
  assert.deepEqual(g.channels.map((c) => [c.name, c.target, c.presence.history, c.parent_id]), [
    ["art", true, true, "1551446881308250500"],
    ["chat", false, false, "1551446881308250500"],
  ], "voice channels are not listed; chat hides its history from @everyone");
  assert.deepEqual(g.categories.map((c) => c.name), ["Text Channels"]);
  const nameRow = rows.find((x) => x.f === "b.png");
  assert.equal(nameRow.xok, true, "only the name ground fails, so a merge can bring it back");
  assert.equal(nameRow.nameOk, false);
});

test("targets come from the panel's targets.json", async (t) => {
  const dir = await tmp(t);
  await fs.writeFile(path.join(dir, "targets.json"), JSON.stringify({ targets: [CH2] }));
  await indexOnce({ http: http(guildDiscord([])), stateDir: dir, prefixes: { [GUILD]: "aichan" }, channels: [], selfId: SELF, log: () => {} });
  const g = JSON.parse(await fs.readFile(path.join(dir, "guilds.json"), "utf8"));
  assert.deepEqual(g.channels.map((c) => [c.name, c.target]), [["art", false], ["chat", true]]);
});

const OTHER = "1551446880385245111";
const servers = async (dir, list) => fs.writeFile(path.join(dir, "servers.json"), JSON.stringify({ servers: list }));

test("servers come from the panel's servers.json: an uninvited one waits, an invited one nobody added is offered", async (t) => {
  const dir = await tmp(t);
  await servers(dir, [{ guild_id: GUILD, name: "AIchan (ours)", prefix: "aichan" }, { guild_id: OTHER, name: "Later", prefix: "later" }]);
  const memberOf = [{ id: GUILD, name: "AIchan" }, { id: "1551446880385245222", name: "Somewhere new" }];
  const r = await indexOnce({ http: http(guildDiscord([], { memberOf })), stateDir: dir, allowedPrefixes: new Set(["aichan_", "later_"]), selfId: SELF, log: () => {} });
  assert.deepEqual(r.servers.map((x) => [x.guild_id, x.state]), [[GUILD, "indexed"], [OTHER, "awaiting_invite"]]);
  const g = JSON.parse(await fs.readFile(path.join(dir, "guilds.json"), "utf8"));
  assert.deepEqual(g.guilds.map((x) => [x.id, x.label, x.prefix]), [[GUILD, "AIchan (ours)", "aichan"]]);
  assert.deepEqual(g.member_guilds.map((x) => x.name), ["AIchan", "Somewhere new"], "the panel offers the server she was invited to");
});

test("a prefix off the booru's list, or 41chan, is refused by name; an unread list indexes nothing", async (t) => {
  const dir = await tmp(t);
  await servers(dir, [{ guild_id: GUILD, prefix: "aichan" }, { guild_id: OTHER, prefix: "41chan" }]);
  const memberOf = [{ id: GUILD, name: "AIchan" }, { id: OTHER, name: "Other" }];
  let r = await indexOnce({ http: http(guildDiscord([], { memberOf })), stateDir: dir, allowedPrefixes: new Set(["4chan_", "41chan_"]), selfId: SELF, log: () => {} });
  assert.equal(r.servers[0].state, "refused");
  assert.match(r.servers[0].why, /aichan_ is not on the booru's creator-prefix list/);
  assert.match(r.servers[1].why, /never 41chan or 4chan/);
  assert.deepEqual(r.guilds, []);
  r = await indexOnce({ http: http(guildDiscord([], { memberOf })), stateDir: dir, allowedPrefixes: null, selfId: SELF, log: () => {} });
  assert.equal(r.servers[0].state, "waiting");
  assert.deepEqual(r.guilds, [], "nothing is indexed under a prefix that cannot be confirmed");
});

test("one server that cannot be read does not cost the others their pass", async (t) => {
  const dir = await tmp(t);
  await servers(dir, [{ guild_id: OTHER, prefix: "other" }, { guild_id: GUILD, prefix: "aichan" }]);
  const memberOf = [{ id: GUILD, name: "AIchan" }, { id: OTHER, name: "Other" }];
  const r = await indexOnce({ http: http(guildDiscord([], { memberOf, broken: [OTHER] })), stateDir: dir, allowedPrefixes: new Set(["aichan_", "other_"]), selfId: SELF, log: () => {} });
  assert.deepEqual(r.servers.map((x) => [x.guild_id, x.state]), [[OTHER, "error"], [GUILD, "indexed"]]);
  assert.deepEqual(r.guilds.map((x) => x.id), [GUILD]);
});

test("config.yaml's guilds seed servers.json once, and never overwrite the panel's list", async (t) => {
  const dir = await tmp(t);
  assert.equal(await seedServers(dir, { [GUILD]: "aichan" }), true);
  assert.deepEqual((await readServers(dir)).map((x) => [x.guild_id, x.prefix, x.why]), [[GUILD, "aichan", null]]);
  await servers(dir, [{ guild_id: OTHER, prefix: "other" }]);
  assert.equal(await seedServers(dir, { [GUILD]: "aichan" }), false);
  assert.deepEqual((await readServers(dir)).map((x) => x.guild_id), [OTHER]);
});

test("acquisition takes only targets on servers the index accepted", () => {
  const doc = { guilds: [{ id: GUILD, prefix: "aichan" }], channels: [{ id: CH, guild_id: GUILD }, { id: CH2, guild_id: OTHER }] };
  const r = acquirable(doc, new Set([CH, CH2, "1551446881308259999"]));
  assert.deepEqual(r.channels, [CH], "a target on a removed or unjoined server, or no longer listed, is not read");
  assert.equal(r.prefixMap.get(GUILD), "aichan");
  assert.deepEqual(acquirable(null, new Set([CH])).channels, []);
});

test("a merged account is posted under its master's name", () => {
  const masters = [{ user_id: "111", username: "selphdestruct", subs: [{ user_id: "222", username: "a.b" }] }];
  assert.equal(creatorNameFor(masters, { id: "222", username: "a.b" }), "selphdestruct");
  assert.equal(creatorNameFor(masters, { id: "111", username: "selphdestruct" }), "selphdestruct");
  assert.equal(creatorNameFor(masters, { id: "333", username: "other" }), "other");
});

test("permissions follow Discord's order: @everyone, then roles, then the member, with ADMINISTRATOR over all", () => {
  const guild = { id: "g", owner_id: "owner", roles: [{ id: "g", permissions: EVERYONE_PERMS }, { id: "r1", permissions: "0" }, { id: "adm", permissions: String(1 << 3) }] };
  const me = { user: { id: "me" }, roles: ["r1"] };
  const deniedForEveryone = { permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: VIEW }] };
  assert.equal(perms.presenceIn(guild, me, deniedForEveryone).view, false);
  const roleAllows = { permission_overwrites: [{ id: "g", type: 0, allow: "0", deny: VIEW }, { id: "r1", type: 0, allow: VIEW, deny: "0" }] };
  assert.equal(perms.presenceIn(guild, me, roleAllows).view, true, "a role allow beats an @everyone deny");
  const memberDenies = { permission_overwrites: [{ id: "r1", type: 0, allow: SEND, deny: "0" }, { id: "me", type: 1, allow: "0", deny: SEND }] };
  assert.equal(perms.presenceIn(guild, me, memberDenies).send, false, "the member's own deny comes last");
  assert.equal(perms.presenceIn(guild, { user: { id: "me" }, roles: ["adm"] }, deniedForEveryone).view, true, "ADMINISTRATOR overrides every overwrite");
  assert.equal(perms.presenceIn(guild, { user: { id: "owner" }, roles: [] }, deniedForEveryone).history, true, "the owner has everything");
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

test("a refresh request is taken once, before the pass it asks for", async (t) => {
  const { takeIndexRequest } = require("./discordIndex");
  const dir = await tmp(t);
  assert.equal(await takeIndexRequest(dir), false);
  await fs.writeFile(path.join(dir, "index-request.json"), JSON.stringify({ at: "now" }));
  assert.equal(await takeIndexRequest(dir), true);
  assert.equal(await takeIndexRequest(dir), false, "taken: the next pass is not asked for twice");
});
