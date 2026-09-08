"use strict";

// Regression tests for the 2026-09-05 incident: Fourier-chan DMed 22 existing
// community members the new-user rules, twice.

const test = require("node:test");
const assert = require("node:assert/strict");
const { creationMs, POLL_DEFAULT_MS, POLL_FLOOR_MS, PAGE_SIZE } = require("./onboarding");

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

test("a new user waits seconds, not a minute, and a typo cannot make a busy loop", () => {
  // Operator 2026-09-06: the just-missed-the-bus user must not sit on a blank
  // screen for 59 seconds. One poll is ~15 ms, so this is a UX number.
  assert.ok(POLL_DEFAULT_MS <= 5_000, "default poll must be at most 5 s");
  assert.ok(POLL_FLOOR_MS >= 500 && POLL_FLOOR_MS <= POLL_DEFAULT_MS, "floor guards against a busy loop");
  assert.ok(PAGE_SIZE >= 50, "a launch burst must fit in one page");
});

test("dedupe is the greeted ledger, keyed by Matrix ID, not a per-tick cap", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./onboarding.js"), "utf8");
  assert.ok(!/MAX_GREETS_PER_TICK/.test(src), "the rate cap is gone");
  assert.ok(/this\.state\.greeted\[userId\]/.test(src), "greeted ledger consulted per user");
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

// ---- the Fibonacci engine's guardrails -----------------------------------
//
// Structural assertions rather than behavioural ones, in the same style as the
// createAsClient test above: these are properties of the WIRING that a unit
// test of a pure function cannot see, and the operator's instruction on
// 2026-09-08 was that the new system must not reach any other user until it is
// reviewed. If someone loosens the gate, this fails.

test("the new engine is gated on an explicit whitelist with no wildcard", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./onboarding.js"), "utf8");
  const fn = src.slice(src.indexOf("async observeFibonacci("));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));

  assert.match(body, /this\.fibWhitelist\.includes\(userId\)/,
    "must check the whitelist");
  // The gate has to come before any scoring, not after it.
  assert.ok(
    body.indexOf("fibWhitelist") < body.indexOf("tasksFor"),
    "the whitelist check must precede detection and scoring",
  );
  // No "everyone" escape hatch.
  assert.ok(!/whitelist.*\*|\*.*whitelist/.test(body), "no wildcard");
});

test("no engine runs unless one is named", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./onboarding.js"), "utf8");
  assert.match(src, /this\.engine = cfg\.engine \|\| "off"/,
    "the default must be off, so an upgrade never silently starts scoring");
});

test("the automatic privilege grant is off unless configured", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("./onboarding.js"), "utf8");
  assert.match(src, /if \(!this\.onPass\.enabled\)/,
    "applyPassPolicy must return early when disabled");
  assert.match(src, /on_pass\) \|\| \{ enabled: false \}/,
    "and the default must be disabled");
});

test("a client cannot report a task the server is meant to witness", () => {
  // The 55-pointer is client-asserted by design; a reaction is not, and a
  // client claiming one would be minting points for something unobserved.
  const { tasksFor, CLIENT_REPORT } = require("./taskDetect");
  const yaml = require("js-yaml");
  const fs = require("node:fs");
  const cat = yaml.load(fs.readFileSync(`${__dirname}/onboarding-tasks.example.yaml`, "utf8"));
  assert.deepEqual(tasksFor(cat, { type: CLIENT_REPORT, content: { activity: "emoji_reaction" } }), []);
});
