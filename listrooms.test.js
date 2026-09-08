"use strict";

// Tests for !listrooms' decisions. The Synapse calls are in index.js; what is
// worth guarding is who gets listed, and what the answer looks like at the
// edges -- a bot in no rooms, a bot in ninety, and a lookup that failed.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  botIdentities,
  formatBotSection,
  formatRoomList,
  sortRooms,
  LIST_CAP,
} = require("./listrooms");

const DOMAIN = "41chan.net";

test("both bot identities are listed, bridge first", () => {
  const ids = botIdentities({
    domain: DOMAIN,
    senderLocalpart: "tunnel",
    onboarding: { enabled: true, localpart: "fourier" },
  });
  assert.deepEqual(ids.map((i) => i.userId), ["@tunnel:41chan.net", "@fourier:41chan.net"]);
});

test("Fourier-chan is omitted when onboarding is off", () => {
  // Listing her anyway would report an empty set for a user that was never
  // registered, which reads as "in no rooms" rather than "does not exist".
  const ids = botIdentities({
    domain: DOMAIN,
    senderLocalpart: "tunnel",
    onboarding: { enabled: false, localpart: "fourier" },
  });
  assert.deepEqual(ids.map((i) => i.userId), ["@tunnel:41chan.net"]);
});

test("an identity is never listed twice", () => {
  const ids = botIdentities({
    domain: DOMAIN,
    senderLocalpart: "fourier",
    onboarding: { enabled: true, localpart: "fourier" },
  });
  assert.equal(ids.length, 1);
});

test("no rooms and a failed lookup do not read the same", () => {
  // The whole point of carrying the error through: "she is in nothing" and
  // "we could not ask" are different answers.
  const empty = formatBotSection("@fourier:41chan.net", []);
  const failed = formatBotSection("@fourier:41chan.net", [], "joined_rooms 502");
  assert.match(empty, /\(no rooms\)/);
  assert.match(failed, /could not read: joined_rooms 502/);
  assert.notEqual(empty, failed);
});

test("a long list is capped and says how many it held back", () => {
  const rooms = Array.from({ length: LIST_CAP + 7 }, (_, i) => ({
    roomId: `!r${i}:41chan.net`,
    name: `room ${String(i).padStart(3, "0")}`,
  }));
  const out = formatBotSection("@fourier:41chan.net", rooms);
  assert.match(out, new RegExp(`-- ${LIST_CAP + 7} rooms`));
  assert.match(out, /\.\.\.and 7 more/);
  // Capped, plus the header and the "and N more" line.
  assert.equal(out.split("\n").length, LIST_CAP + 2);
});

test("one room is not pluralised", () => {
  const out = formatBotSection("@tunnel:41chan.net", [{ roomId: "!a:41chan.net", name: "cake" }]);
  assert.match(out, /-- 1 room$/m);
});

test("named rooms sort by name, unnamed ones sink to the bottom", () => {
  const sorted = sortRooms([
    { roomId: "!c:41chan.net", name: null },
    { roomId: "!b:41chan.net", name: "zebra" },
    { roomId: "!a:41chan.net", name: "apple" },
    { roomId: "!d:41chan.net", name: null },
  ]);
  assert.deepEqual(sorted.map((r) => r.name), ["apple", "zebra", null, null]);
  // Unnamed rooms still have a stable order among themselves.
  assert.deepEqual(sorted.slice(2).map((r) => r.roomId), ["!c:41chan.net", "!d:41chan.net"]);
});

test("an unnamed room is labelled, not blank", () => {
  const out = formatBotSection("@tunnel:41chan.net", [{ roomId: "!x:41chan.net", name: null }]);
  assert.match(out, /\(unnamed\)\s+!x:41chan\.net/);
});

test("with nothing configured it says so rather than returning nothing", () => {
  assert.match(formatRoomList([]), /No bot identities are configured/);
});
