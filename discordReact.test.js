"use strict";

// Her reaction on what she saved (operator, 2026-10-06): never stops
// collection, never spends Discord's invalid-request budget on a backlog.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const acq = require("./discordAcquire");
const { presenceIn } = require("./discordPerms");
const { readReaction, makeReactor, refreshAppEmojis } = require("./discordReact");

const CH = "1551446881308250114";
const GUILD = "1551446880385245275";

function res(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { status, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) }, json: async () => body };
}
function http(fetchImpl) {
  return new acq.DiscordHttp({ token: "TOKEN", ua: "DiscordBot (x, 1)", fetchImpl, sleep: async () => {}, now: () => 0, spacingMs: 0 });
}
async function tmp(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "tunnel-react-"));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
}
const lines = async (dir) => (await fs.readFile(path.join(dir, "reactions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

test("a reaction is a PUT with the emoji encoded, and every failure is a value, not a throw", async () => {
  const calls = [];
  let answer = res(204, null);
  const h = http(async (url, init) => { calls.push([init.method, url]); return answer; });
  assert.deepEqual(await h.putReaction(CH, "9", "neru:1556000000000000001"), { ok: true });
  assert.deepEqual(calls[0], ["PUT", `https://discord.com/api/v10/channels/${CH}/messages/9/reactions/neru%3A1556000000000000001/@me`]);
  answer = res(403, { code: 50013, message: "Missing Permissions" });
  assert.match((await h.putReaction(CH, "9", "x:1")).why, /lacks Add Reactions/);
  answer = res(400, { code: 10014, message: "Unknown Emoji" });
  assert.match((await h.putReaction(CH, "9", "x:1")).why, /does not know that emoji/);
  answer = res(401, {});
  await assert.rejects(h.putReaction(CH, "9", "x:1"), acq.AuthFailed, "a dead token still stops everything");
});

test("a 429 waits and tries again", async () => {
  const answers = [res(429, { retry_after: 0.01 }), res(204, null)];
  const h = http(async () => answers.shift());
  assert.deepEqual(await h.putReaction(CH, "9", "x:1"), { ok: true });
});

test("Add Reactions is read from her permissions, with history", () => {
  const guild = { id: GUILD, owner_id: "1", roles: [{ id: GUILD, permissions: String((1 << 10) | (1 << 16) | (1 << 6)) }] };
  const member = { user: { id: "2" }, roles: [] };
  assert.equal(presenceIn(guild, member, { id: CH, permission_overwrites: [] }).react, true);
  const noReact = { ...guild, roles: [{ id: GUILD, permissions: String((1 << 10) | (1 << 16)) }] };
  assert.equal(presenceIn(noReact, member, { id: CH, permission_overwrites: [] }).react, false);
});

test("no permission: one line saying so, then silence for the pass -- no request is made", async (t) => {
  const dir = await tmp(t);
  let requests = 0;
  const react = makeReactor({ http: { putReaction: async () => { requests++; return { ok: true }; } }, stateDir: dir, emoji: "x:1",
    guildsDoc: { channels: [{ id: CH, presence: { react: false } }] } });
  for (const id of ["1", "2", "3"]) await react({ id: CH, guild_id: GUILD, name: "art" }, { id });
  assert.equal(requests, 0);
  const l = await lines(dir);
  assert.equal(l.length, 1);
  assert.match(l[0].why, /lacks Add Reactions in #art/);
});

test("after one failure in a server she stops trying there for the pass; a deleted message does not count", async (t) => {
  const dir = await tmp(t);
  const answers = [{ ok: true }, { ok: false, code: 10008, why: "deleted" }, { ok: false, code: 10014, why: "unknown emoji" }, { ok: true }];
  let requests = 0;
  const react = makeReactor({ http: { putReaction: async () => { requests++; return answers.shift(); } }, stateDir: dir, emoji: "x:1",
    guildsDoc: { channels: [{ id: CH, presence: { react: true } }] } });
  for (const id of ["1", "2", "3", "4", "5"]) await react({ id: CH, guild_id: GUILD }, { id });
  assert.equal(requests, 3, "the unknown emoji stopped messages 4 and 5 being tried");
  assert.deepEqual((await lines(dir)).map((x) => [x.m, x.ok]), [["1", true], ["2", false], ["3", false]]);
});

test("no emoji chosen, no reactor; the choice and her emoji list are files", async (t) => {
  const dir = await tmp(t);
  assert.equal(await readReaction(dir), null);
  assert.equal(makeReactor({ http: {}, stateDir: dir, emoji: null, guildsDoc: {} }), null);
  await fs.writeFile(path.join(dir, "reaction.json"), JSON.stringify({ emoji: "neru:1556000000000000001" }));
  assert.equal(await readReaction(dir), "neru:1556000000000000001");
  const h = http(async (url) => (url.endsWith("/applications/@me") ? res(200, { id: "77" }) : res(200, { items: [{ id: "1556000000000000001", name: "neru", animated: false }] })));
  await refreshAppEmojis({ http: h, stateDir: dir });
  const file = JSON.parse(await fs.readFile(path.join(dir, "app-emojis.json"), "utf8"));
  assert.deepEqual(file.items, [{ id: "1556000000000000001", name: "neru", animated: false }]);
});
