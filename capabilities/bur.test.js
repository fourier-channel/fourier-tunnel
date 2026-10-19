"use strict";

// !bur: who may file, what is filed, and what the room is told -- against
// fakes for Matrix and the booru.

const test = require("node:test");
const assert = require("node:assert/strict");
const { handleBurCommand, parseBur, senderLevel, refusalReasons, scrub, CONTENT_KEY } = require("./bur");

const ROOM = "!bots:41chan.net";
const BOT = "@tunnel:41chan.net";

function harness({ users = {}, usersDefault = 0, create = { content: { room_version: "10" }, sender: "@saber:41chan.net" }, booru, settings, plThrows } = {}) {
  const sent = [];
  const filed = [];
  const audits = [];
  const logs = [];
  const deps = {
    settings: settings === undefined ? { room: ROOM } : settings,
    botUserId: BOT,
    readPowerLevels: async () => {
      if (plThrows) throw new Error("M_FORBIDDEN");
      return { users, users_default: usersDefault };
    },
    readCreate: async () => create,
    createBur: async (body) => {
      filed.push(body);
      if (typeof booru === "function") return booru(body);
      return booru || { status: 201, data: { id: 77, status: "pending" } };
    },
    sendMessage: async (room, content) => sent.push({ room, content }),
    audit: (r) => audits.push(r),
    log: (l) => logs.push(l),
    seen: new Set(),
  };
  return { deps, sent, filed, audits, logs };
}

let n = 0;
const ev = (body, extra = {}) => ({ event_id: `$e${++n}`, room_id: ROOM, sender: "@voice:41chan.net", type: "m.room.message", content: { msgtype: "m.text", body }, ...extra });
const SCRIPT = "!bur tidy the artist tags\nalias old_tag -> new_tag\n\nupdate a -> b";

test("parse: the first line is the command and the reason, the rest are script lines; blanks and fences dropped", () => {
  assert.deepEqual(parseBur("!bur why\r\n```\nalias a -> b\n  \n```\nimply c -> d"), { reason: "why", lines: ["alias a -> b", "imply c -> d"] });
  assert.equal(parseBur("!burger"), null);
  assert.equal(parseBur("hello !bur"), null);
  assert.deepEqual(parseBur("!bur"), { reason: "", lines: [] });
});

test("level: users entry, then users_default; a v12 creator is unlimited; a v10 create sender is not", () => {
  assert.equal(senderLevel({ users: { "@a:x": 25 } }, {}, null, "@a:x"), 25);
  assert.equal(senderLevel({ users_default: 10 }, {}, null, "@a:x"), 10);
  assert.equal(senderLevel({}, { room_version: "12" }, "@a:x", "@a:x"), Infinity);
  assert.equal(senderLevel({}, { room_version: "12", additional_creators: ["@b:x"] }, "@a:x", "@b:x"), Infinity);
  assert.equal(senderLevel({}, { room_version: "10" }, "@a:x", "@a:x"), 0);
});

test("Voice (25) files; the reply carries the BUR id under net.41chan.bur and names nobody's address", async () => {
  const h = harness({ users: { "@voice:41chan.net": 25 } });
  assert.equal(await handleBurCommand(ev(SCRIPT), h.deps), true);
  assert.equal(h.filed.length, 1);
  assert.equal(h.filed[0].script, "alias old_tag -> new_tag\nupdate a -> b");
  assert.match(h.filed[0].reason, /^tidy the artist tags\n\nRequested by @voice:41chan\.net in #botsbotsbots/);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].content[CONTENT_KEY], { id: 77 });
  assert.equal(h.sent[0].content.msgtype, "m.notice");
  assert.match(h.sent[0].content.body, /Filed BUR #77 for voice: 2 lines/);
  assert.equal(h.audits.at(-1).kind, "bur_filed");
});

test("below Voice: refused in words, nothing filed, the refusal audited with both levels", async () => {
  const h = harness({ users: { "@voice:41chan.net": 24 } });
  await handleBurCommand(ev(SCRIPT), h.deps);
  assert.equal(h.filed.length, 0);
  assert.match(h.sent[0].content.body, /needs Voice \(\+\) or higher/);
  assert.deepEqual(h.audits[0], { kind: "bur_denied_level", sender: "@voice:41chan.net", room: ROOM, have: 24, need: 25 });
});

test("the level is configurable and read fresh: the same sender is refused once the room's levels change", async () => {
  const users = { "@voice:41chan.net": 50 };
  const h = harness({ users, settings: { room: ROOM, power_level: 50 } });
  await handleBurCommand(ev(SCRIPT), h.deps);
  assert.equal(h.filed.length, 1);
  users["@voice:41chan.net"] = 25;
  await handleBurCommand(ev(SCRIPT), h.deps);
  assert.equal(h.filed.length, 1);
});

test("unreadable power levels refuse rather than guess", async () => {
  const h = harness({ plThrows: true });
  await handleBurCommand(ev(SCRIPT), h.deps);
  assert.equal(h.filed.length, 0);
  assert.match(h.sent[0].content.body, /could not read this room's power levels/);
});

test("other rooms are pointed at #botsbotsbots; an unset room switches the command off, loudly in the log", async () => {
  const h = harness({ users: { "@voice:41chan.net": 100 } });
  await handleBurCommand(ev(SCRIPT, { room_id: "!other:41chan.net" }), h.deps);
  assert.equal(h.filed.length, 0);
  assert.match(h.sent[0].content.body, /#botsbotsbots only/);

  const off = harness({ users: { "@voice:41chan.net": 100 }, settings: null });
  await handleBurCommand(ev(SCRIPT), off.deps);
  assert.equal(off.filed.length, 0);
  assert.match(off.sent[0].content.body, /not switched on/);
  assert.match(off.logs[0], /bridge\.bur\.room/);
});

test("no reason or no lines: usage, nothing filed", async () => {
  const h = harness({ users: { "@voice:41chan.net": 25 } });
  await handleBurCommand(ev("!bur\nalias a -> b"), h.deps);
  await handleBurCommand(ev("!bur a reason only"), h.deps);
  assert.equal(h.filed.length, 0);
  assert.match(h.sent[0].content.body, /^Usage: !bur/);
  assert.match(h.sent[1].content.body, /^Usage: !bur/);
});

test("an edit, her own message, and a redelivered event never file", async () => {
  const h = harness({ users: { "@voice:41chan.net": 25, [BOT]: 25 } });
  await handleBurCommand(ev(SCRIPT, { content: { body: SCRIPT, "m.relates_to": { rel_type: "m.replace", event_id: "$x" } } }), h.deps);
  await handleBurCommand(ev(SCRIPT, { sender: BOT }), h.deps);
  const once = ev(SCRIPT);
  await handleBurCommand(once, h.deps);
  await handleBurCommand(once, h.deps);
  assert.equal(h.filed.length, 1);
  assert.equal(h.sent.length, 1);
});

test("not a !bur: not consumed", async () => {
  const h = harness();
  assert.equal(await handleBurCommand(ev("hello"), h.deps), false);
  assert.equal(h.sent.length, 0);
});

test("a 422 relays the booru's reasons, per line when it names lines, with addresses scrubbed", async () => {
  const h = harness({
    users: { "@voice:41chan.net": 25 },
    booru: { status: 422, data: { errors: [{ line: 2, text: "update a -> b", reason: "see http://10.0.0.5:3000/x for why" }] } },
  });
  await handleBurCommand(ev(SCRIPT), h.deps);
  const body = h.sent[0].content.body;
  assert.match(body, /refused that BUR/);
  assert.match(body, /line 2: see \[address removed\] for why/);
  assert.equal(h.sent[0].content[CONTENT_KEY], undefined);
});

test("the Rails errors hash and a bare message are read too", () => {
  assert.deepEqual(refusalReasons({ errors: { script: ["Unknown line: frob a"], reason: ["can't be blank"] } }), ["Unknown line: frob a", "reason can't be blank"]);
  assert.deepEqual(refusalReasons({ message: "Script is invalid" }), ["Script is invalid"]);
  assert.deepEqual(refusalReasons(null), []);
});

test("429, 403, an unreachable booru and a 500: words only, no raw error, no address", async () => {
  for (const [booru, want] of [
    [{ status: 429, data: {} }, /limiting how fast/],
    [{ status: 403, data: { message: "denied from 172.18.0.4" } }, /would not let my account/],
    [() => { throw new Error("connect ECONNREFUSED 172.18.0.4:3000"); }, /did not answer/],
    [{ status: 500, data: { message: "boom at booru:3000" } }, /cannot say whether it was filed/],
  ]) {
    const h = harness({ users: { "@voice:41chan.net": 25 }, booru });
    await handleBurCommand(ev(SCRIPT), h.deps);
    const body = h.sent[0].content.body;
    assert.match(body, want);
    assert.doesNotMatch(body, /\d+\.\d+\.\d+\.\d+|https?:\/\/|[a-z0-9-]+:\d{2,5}\b/i);
  }
});

test("scrub: urls, IPv4, host:port gone; clock times and tag names kept", () => {
  assert.equal(scrub("at 01:54 tag foo:bar"), "at 01:54 tag foo:bar");
  assert.equal(scrub("https://booru.41chan.net/x"), "[address removed]");
  assert.equal(scrub("10.1.2.3:8080 and 10.1.2.3"), "[address removed] and [address removed]");
  assert.equal(scrub("booru.41chan.net:443"), "[address removed]");
  assert.equal(scrub("danbooru-web-1:3000"), "[address removed]");
});

test("the live contract: no title is sent; a 422's sentence and its per-line reasons are both relayed", async () => {
  const h = harness({
    users: { "@voice:41chan.net": 25 },
    booru: { status: 422, data: { success: false, error: "BulkUpdateRequest::Processor::Error", message: "This request names a tag only an admin may change. Ask an admin to make it", errors: [{ line: 2, text: "update a -> b", reason: "This line names a tag only an admin may change" }] } },
  });
  await handleBurCommand(ev(SCRIPT), h.deps);
  assert.equal(h.filed[0].title, undefined);
  assert.equal(h.filed[0].forum_topic_id, undefined);
  const body = h.sent[0].content.body;
  assert.match(body, /nothing was filed\. This request names a tag only an admin may change\. Ask an admin to make it/);
  assert.match(body, /- line 2: This line names a tag only an admin may change/);
});
