"use strict";

// Regression tests for the 2026-09-05 incident: Fourier-chan DMed 22 existing
// community members the new-user rules, twice.

const test = require("node:test");
const assert = require("node:assert/strict");
const { creationMs, MAX_GREETS_PER_TICK } = require("./onboarding");

test("creation_ts in MILLISECONDS (the list endpoint) is not multiplied again", () => {
  // What GET /_synapse/admin/v2/users?... actually returns: 13 digits.
  // The old code did `ts * 1000`, yielding microseconds -- a value ~1000x the
  // millisecond watermark, so every account ever created read as "newer than
  // now" and got greeted.
  const ms = 1788620885000;
  assert.equal(creationMs({ creation_ts: ms }), ms);
  assert.ok(creationMs({ creation_ts: ms }) < Date.now() + 60000);
});

test("creation_ts in SECONDS (the single-user endpoint) is scaled up", () => {
  // The same field, 10 digits, from GET /_synapse/admin/v2/users/<id>.
  assert.equal(creationMs({ creation_ts: 1788579842 }), 1788579842000);
});

test("a watermark seeded at now() excludes every pre-existing account", () => {
  const watermark = Date.now();
  const existing = [
    { creation_ts: 1788620885000 }, // ms form
    { creation_ts: 1788579842 },    // seconds form
  ];
  for (const u of existing) {
    assert.ok(creationMs(u) <= watermark, "a pre-existing user must not clear the watermark");
  }
});

test("missing or junk creation_ts never clears the watermark", () => {
  for (const u of [{}, { creation_ts: null }, { creation_ts: "x" }, { creation_ts: -1 }]) {
    assert.equal(creationMs(u), 0);
  }
});

test("the batch cap is small enough to be a circuit breaker", () => {
  // Real signups arrive one at a time. If this is ever raised to something
  // like 50, the breaker stops breaking and the incident can recur.
  assert.ok(MAX_GREETS_PER_TICK > 0 && MAX_GREETS_PER_TICK <= 5);
});

test("onboarding DMs are created BY Fourier-chan, not by the appservice bot", () => {
  // Regression for 2026-09-05: createAsClient:false makes
  // matrix-appservice-bridge build the room with the BOT client, which put
  // @tunnel -- the image scraper -- into every onboarding DM as its creator.
  // The tunnel's only room relationship is "a user invites ME" (invites.js);
  // it has no business in a welcome conversation.
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./onboarding.js"), "utf8");
  const call = src.slice(src.indexOf("intent.createRoom("));
  const flag = /createAsClient:\s*(true|false)/.exec(call);
  assert.ok(flag, "the createRoom call must state createAsClient explicitly");
  assert.equal(flag[1], "true", "createAsClient:false puts @tunnel in every DM");
});
