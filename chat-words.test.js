"use strict";

// The words guard: what a room message may not carry, what it must keep, and
// that the guard is the one every intent in index.js comes through.
//
// The case that motivated it is the first test: an @tunnel event of
// 2026-09-11 carries a visitor's user-agent string verbatim, delivered inside
// foreign text that a call site interpolated. Each test here sends through
// the guard to a fake intent and reads what the fake was handed -- what the
// room would have received -- rather than calling scrub() and trusting that
// something calls it.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { scrub, scrubCounted, guard, ADDRESS, AGENT } = require("./chat-words");
const rooms = require("./rooms");
const { handleAvatarFlow } = require("./capabilities/avatar");

const ROOM = "!dm:41chan.net";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
// Documentation ranges (RFC 5737, RFC 3849): never anyone's real address.
const V4 = "203.0.113.42";
const V6 = "2001:db8:85a3::8a2e:370:7334";

// What a room would receive, and what the log was told.
function rig() {
  const sent = [];
  const warned = [];
  const intent = {
    sendText: async (room, text) => { sent.push({ method: "sendText", room, text }); return { event_id: "$t" }; },
    sendMessage: async (room, content) => { sent.push({ method: "sendMessage", room, content }); return { event_id: "$m" }; },
    sendEvent: async (room, type, content) => { sent.push({ method: "sendEvent", room, type, content }); return { event_id: "$e" }; },
    sendStateEvent: async (room, type, key, content) => { sent.push({ method: "sendStateEvent", room, type, key, content }); return {}; },
  };
  return { sent, warned, intent: guard(intent, { log: { warn: (s) => warned.push(s) } }) };
}

const LEAKS = [/Mozilla\/5\.0/, /AppleWebKit/, /Chrome\/128/, /203\.0\.113\.42/, /2001:db8/, /https?:\/\//, /:8008\b/, /:3000\b/];
function assertClean(text, what) {
  for (const re of LEAKS) assert.doesNotMatch(String(text), re, `${what} carries ${re}`);
}

test("a visitor's user agent in an error the bot relays never reaches the room (the 2026-09-11 event)", async () => {
  // A capability that interpolates a raw error, as avatar.js did until this
  // commit, handed an error the way an nginx or Cloudflare page body arrives.
  const r = rig();
  const err = `upload refused: 403 for ${V4} (User-Agent: ${UA})`;
  await r.intent.sendText(ROOM, "Failed to set avatar: " + err);
  assert.equal(r.sent.length, 1, "the message is still sent: the room is told something failed");
  assertClean(r.sent[0].text, "the room message");
  assert.match(r.sent[0].text, /^Failed to set avatar: upload refused: 403 for \[address removed\]/);
  assert.match(r.sent[0].text, /\[user agent removed\]/);
});

test("the log line says what was removed, never what it was", async () => {
  // The container log is docker json-file 50m x 3 on 41chan: bounded by size,
  // not age. An agent or address copied there could outlive the 7 days.
  const r = rig();
  await r.intent.sendText(ROOM, `seen from ${V4} and ${V6} as ${UA}`);
  assert.equal(r.warned.length, 1);
  assert.match(r.warned[0], /removed 2 address\(es\) and 1 user agent\(s\)/);
  assert.match(r.warned[0], new RegExp(ROOM.replace(/[.!]/g, "\\$&")), "names the room so the caller can be found");
  assertClean(r.warned[0], "the log line");
});

test("an agent with no product anybody listed is still caught by its platform comment", () => {
  for (const ua of [
    "SomeNewClient/0.3.1 (Linux; Android 14; Pixel 8)",
    "Element/1.11.80 (iPhone; iOS 18.0; Scale/3.00)",
    "curl/8.5.0",
    "python-requests/2.32.3",
    "user_agent=anything at all here",
  ]) {
    const r = scrubCounted(`before ${ua}`);
    assert.equal(r.removed.agent, 1, ua);
    assert.equal(r.text, `before ${AGENT}`, ua);
  }
});

test("addresses: URLs, IPv4, IPv6, host:port and container names go", () => {
  const cases = [
    ["fetch failed: connect ECONNREFUSED 172.18.0.5:3000", `fetch failed: connect ECONNREFUSED ${ADDRESS}`],
    ["Failed to parse URL from http://synapse:8008/_matrix/x?user_id=y", `Failed to parse URL from ${ADDRESS}`],
    [`from ${V6} and [::1]:8008 and fe80::1`, `from ${ADDRESS} and ${ADDRESS} and ${ADDRESS}`],
    ["booru.41chan.net:443 and danbooru-web-1:3000 and localhost:8009", `${ADDRESS} and ${ADDRESS} and ${ADDRESS}`],
  ];
  for (const [input, want] of cases) assert.equal(scrub(input), want, input);
});

test("words a room message is made of survive: clock times, Matrix ids, mxc urls, tags", () => {
  const keep = [
    "at 01:54, and 10:30:00",
    "Cleared 2 strikes for @saber:41chan.net.",
    "!rejoinroom !abcdef:41chan.net",
    "Usage: !rescan <mxc://server/media-id | md5>",
    "the original of mxc://41chan.net/AbC123 is gone",
    "hilda_(pokemon) fate/grand_order k/da_(league_of_legends) re:zero foo:bar",
    "Post #7 (jpeg): read 2 creator tag(s)",
    "deadbeef cafe:babe",
  ];
  for (const text of keep) {
    const r = scrubCounted(text);
    assert.equal(r.text, text, text);
    assert.deepEqual(r.removed, { address: 0, agent: 0 }, text);
  }
});

test("sendMessage: body and formatted_body are scrubbed, every other key is kept", async () => {
  const r = rig();
  await r.intent.sendMessage(ROOM, {
    msgtype: "m.notice",
    body: `filed from ${V4}`,
    format: "org.matrix.custom.html",
    formatted_body: `<b>filed</b> via <a href="https://booru.41chan.net/x">${UA}</a>`,
    "net.41chan.bur": { id: 12 },
  });
  const c = r.sent[0].content;
  assertClean(c.body, "body");
  assertClean(c.formatted_body, "formatted_body");
  assert.deepEqual(c["net.41chan.bur"], { id: 12 }, "the BUR pointer rides through");
  assert.equal(c.format, "org.matrix.custom.html");
});

test("sendEvent scrubs an m.room.message and leaves every other event type alone", async () => {
  const r = rig();
  await r.intent.sendEvent(ROOM, "m.room.message", { msgtype: "m.text", body: `at ${V4}` });
  await r.intent.sendEvent(ROOM, "m.reaction", { "m.relates_to": { key: "203.0.113.42" } });
  assert.equal(r.sent[0].content.body, `at ${ADDRESS}`);
  assert.equal(r.sent[1].content["m.relates_to"].key, "203.0.113.42", "not prose: untouched");
});

test("an image's body is its filename and is not rewritten", async () => {
  // Filenames are not private data (operator 2026-11-01); a dotted seed in
  // one ("16.07.30_1.2.3.4_x.png") is not an address to remove.
  const r = rig();
  const content = { msgtype: "m.image", body: "2026-02-07_16.07.30_1.2.3.4_abc.png", url: "mxc://41chan.net/x" };
  await r.intent.sendMessage(ROOM, content);
  assert.deepEqual(r.sent[0].content, content);
});

test("state events are never touched: tag state is data clients parse", async () => {
  const r = rig();
  const content = { post_id: 1, tags: ["ratio:16:9", "v1.2.3.4"], rating: "g" };
  await r.intent.sendStateEvent(ROOM, "net.41chan.media.tags", "mxc://41chan.net/x", content);
  assert.deepEqual(r.sent[0].content, content);
  assert.equal(r.warned.length, 0);
});

test("it stacks on the denied-room guard, and a #private getter still works through both", async () => {
  class Intent {
    #name = "tunnel";
    get name() { return this.#name; }
    async sendText(room, text) { return { room, text }; }
  }
  const both = guard(rooms.guard(new Intent(), { isDenied: (r) => r === "!gone:41chan.net" }), { log: { warn() {} } });
  assert.equal(both.name, "tunnel");
  assert.deepEqual(await both.sendText(ROOM, `at ${V4}`), { room: ROOM, text: `at ${ADDRESS}` });
  assert.throws(() => both.sendText("!gone:41chan.net", "hi"), rooms.RoomDeniedError, "the denied-room rule still applies");
});

test("end to end: a capability's raw error, through the guard, leaves the room clean", async () => {
  // The way the 2026-09-11 event was made, rebuilt from parts: a capability
  // whose dependency throws foreign text, sending through a guarded intent.
  const r = rig();
  const deps = {
    setAvatarUrl: async () => { throw new Error(`<html>blocked ${V4} ${UA}</html>`); },
    sendText: (room, text) => r.intent.sendText(room, text),
    joinedMemberCount: async () => 2,
    admins: ["@saber:41chan.net"],
    pending: new Map(),
    audit: () => {},
    log: { warn() {} },
  };
  const ev = (content) => ({ type: "m.room.message", sender: "@saber:41chan.net", room_id: ROOM, content });
  await handleAvatarFlow(ev({ msgtype: "m.text", body: "!setavatar" }), deps);
  await handleAvatarFlow(ev({ msgtype: "m.image", url: "mxc://41chan.net/x" }), deps);
  for (const s of r.sent) assertClean(s.text, "a message the avatar flow sent");
});

test("index.js puts the words guard on every intent, around the denied-room guard", () => {
  // The guard is worth nothing on an intent nobody gets. bridge.getIntent()
  // is the one place every room write in index.js starts, so the wrap is
  // checked there, on the source, because booting the bridge needs a
  // homeserver this suite does not have.
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(src, /bridge\.getIntent = \(\.\.\.args\) => chatWords\.guard\(rooms\.guard\(rawGetIntent\(\.\.\.args\)\)\);/);
  // And nothing reaches Synapse's send endpoint around it.
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, f), "utf8"), /\/rooms\/[^`'"]*\/send\//, `${f} sends a room event by fetch, around the guard`);
  }
});
