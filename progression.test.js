"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("./progression");

const catalog = {
  activities: {
    join_room: { values: { any: 2 }, max_points: 2 },
    send_message: { values: { text: 1, long: 3 }, max_points: 6 },
    post_image: { values: { image: 4 } },
    use_emoji: { values: { reaction: 1 }, max_points: 2 },
    enter_domain: { points: 5 },
  },
  tiers: [
    { id: 1, threshold: 2, message: "Nice, you joined a room. Try saying hello." },
    { id: 2, threshold: 5, requires: ["send_message"], message: "Try posting an image." },
    { id: 3, threshold: 12, requires: ["post_image", "enter_domain"], message: "Welcome to the domain." },
  ],
};

test("values score differently within one activity", () => {
  const r0 = P.emptyRecord("@a:x", 0);
  const r1 = P.observe(catalog, r0, { activity: "send_message", value: "text" }).record;
  const r2 = P.observe(catalog, r1, { activity: "send_message", value: "long" }).record;
  assert.equal(r1.activities.send_message.points, 1);
  assert.equal(r2.activities.send_message.points, 4);
  assert.deepEqual(r2.activities.send_message.values, { text: 1, long: 1 });
});

test("an activity's points are capped, so spamming one thing cannot carry a user", () => {
  let r = P.emptyRecord("@a:x", 0);
  for (let i = 0; i < 20; i++) r = P.observe(catalog, r, { activity: "use_emoji", value: "reaction" }).record;
  assert.equal(r.activities.use_emoji.count, 20);
  assert.equal(r.activities.use_emoji.points, 2);
  assert.equal(r.points, 2);
});

test("a tier needs BOTH the threshold and its required activities", () => {
  let r = P.emptyRecord("@a:x", 0);
  // 5 points from the domain alone: threshold for tier 2 met, requirement not.
  const out = P.observe(catalog, r, { activity: "enter_domain" });
  assert.equal(out.tier, 1, "tier 1 (threshold 2, no requirement) is what 5 points earns");
  r = out.record;
  const out2 = P.observe(catalog, r, { activity: "send_message", value: "text" });
  assert.equal(out2.tier, 2);
  assert.equal(out2.message, "Try posting an image.");
});

test("each tier message is sent once, ever; a burst lands on the highest tier", () => {
  let r = P.emptyRecord("@a:x", 0);
  r = P.observe(catalog, r, { activity: "send_message", value: "long" }).record; // 3 -> tier 1
  r = P.observe(catalog, r, { activity: "post_image", value: "image" }).record;  // 7 -> tier 2
  const big = P.observe(catalog, r, { activity: "enter_domain" });               // 12 -> tier 3
  assert.equal(big.tier, 3);
  assert.equal(big.message, "Welcome to the domain.");
  const again = P.observe(catalog, big.record, { activity: "send_message", value: "text" });
  assert.equal(again.advanced, false);
  assert.equal(again.message, null);
  assert.deepEqual(big.record.sentTiers, [1, 2, 3]);
});

test("unknown activities cannot mint points", () => {
  const r = P.emptyRecord("@a:x", 0);
  const out = P.observe(catalog, r, { activity: "hack_the_planet", value: "x" });
  assert.equal(out.ignored, true);
  assert.equal(out.record.points, 0);
});

test("remaining() lists what is yet to come", () => {
  let r = P.emptyRecord("@a:x", 0);
  r = P.observe(catalog, r, { activity: "join_room", value: "any" }).record;
  assert.deepEqual(P.remaining(catalog, r), ["send_message", "post_image", "use_emoji", "enter_domain"]);
});

test("Matrix events map to observations; client reports pass through", () => {
  assert.deepEqual(P.observationFromEvent({ type: "m.room.member", content: { membership: "join" } }), { activity: "join_room", value: "any" });
  assert.deepEqual(P.observationFromEvent({ type: "m.room.message", content: { msgtype: "m.image", url: "mxc://x/y" } }), { activity: "post_image", value: "image" });
  assert.deepEqual(P.observationFromEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "hi" } }), { activity: "send_message", value: "text" });
  assert.deepEqual(P.observationFromEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "x".repeat(300) } }), { activity: "send_message", value: "long" });
  assert.deepEqual(P.observationFromEvent({ type: "m.room.message", content: { msgtype: "m.text", body: "re", "m.relates_to": { rel_type: "m.thread", event_id: "$e" } } }), { activity: "use_thread", value: "reply" });
  assert.deepEqual(P.observationFromEvent({ type: "m.reaction", content: {} }), { activity: "use_emoji", value: "reaction" });
  assert.deepEqual(P.observationFromEvent({ type: P.CLIENT_REPORT_EVENT, content: { activity: "enter_domain", value: "first" } }), { activity: "enter_domain", value: "first" });
  assert.equal(P.observationFromEvent({ type: "m.room.member", content: { membership: "leave" } }), null);
  assert.equal(P.observationFromEvent({ type: P.CLIENT_REPORT_EVENT, content: {} }), null);
});

test("a bad catalog fails loudly at validation", () => {
  assert.throws(() => P.validateCatalog({ activities: {}, tiers: [] }), /no activities/);
  assert.throws(() => P.validateCatalog({ activities: { a: {} }, tiers: [{ id: 1, requires: ["nope"] }] }), /unknown activity/);
  assert.throws(() => P.validateCatalog({ activities: { a: {} }, tiers: [{ id: 2 }, { id: 1 }] }), /ascending/);
  assert.equal(P.validateCatalog(catalog), true);
});
