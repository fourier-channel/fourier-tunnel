"use strict";

// Tests for Matrix poster attribution.
//
// The property that matters is EXACTNESS: 41chan_<localpart> must correspond to
// exactly one MXID, because the operator's ruling makes that tag the public
// label "this post is that account's". A tag that merely resembles a localpart
// would attribute someone's picture to someone else. The label is not the
// proof: who created a post is the record the tunnel writes at creation, and
// there is deliberately no tag-to-MXID inverse to tempt anyone into reading
// creatorship back off a tag any member can edit.

const test = require("node:test");
const assert = require("node:assert/strict");
const poster = require("./poster");
const { posterTagFor, localpartIfLocal } = poster;

const D = "41chan.net";

test("a local sender becomes 41chan_<localpart>", () => {
  assert.equal(posterTagFor("@saber:41chan.net", D), "41chan_saber");
  assert.equal(posterTagFor("@eeveeboi:41chan.net", D), "41chan_eeveeboi");
});

test("a REMOTE sender gets no tag", () => {
  // Minting one would claim a local identity for an account this server never
  // authenticated, which is the whole basis of the ownership property.
  assert.equal(posterTagFor("@glorpodorpo:matrix.org", D), null);
  assert.equal(posterTagFor("@sir_toot:cutefunny.art", D), null);
});

test("the tag is exactly 41chan_ and the localpart, nothing folded", () => {
  for (const mxid of ["@saber:41chan.net", "@a-b_c:41chan.net", "@x9:41chan.net"]) {
    assert.equal(posterTagFor(mxid, D), `41chan_${localpartIfLocal(mxid, D)}`);
  }
});

test("a period is carried exactly; anything the booru cannot hold exactly is REFUSED, not folded", () => {
  // A period is kept (2026-10-06): the booru allows it, so 41chan_a.b is exact.
  // Folding would break exactness and, worse, collide: a+b and a_b would both
  // become 41chan_a_b, silently attributing one person's posts to another.
  assert.equal(posterTagFor("@a.b:41chan.net", D), "41chan_a.b");
  assert.equal(posterTagFor("@a+b:41chan.net", D), null);
  assert.equal(posterTagFor("@a/b:41chan.net", D), null);
  assert.notEqual(posterTagFor("@a_b:41chan.net", D), null);
});

test("two distinct users never share a tag", () => {
  const tags = ["@ab:41chan.net", "@a_b:41chan.net", "@a-b:41chan.net"]
    .map((m) => posterTagFor(m, D));
  assert.equal(new Set(tags).size, tags.length);
});

test("malformed and non-string senders do not throw", () => {
  for (const bad of [null, undefined, 42, "", "saber", "@nodomain", "@:41chan.net"]) {
    assert.equal(posterTagFor(bad, D), null);
  }
});

test("localpartIfLocal only accepts this homeserver", () => {
  assert.equal(localpartIfLocal("@saber:41chan.net", D), "saber");
  assert.equal(localpartIfLocal("@saber:41chan.net.evil.com", D), null);
  assert.equal(localpartIfLocal("@saber:evil.com", D), null);
});

test("there is no way back from a tag to an MXID: a tag is a label anyone can edit, not proof of a creator", () => {
  // It existed once, and was used to decide who could read a post's private
  // generation record from the post's member-editable tags.
  assert.equal(poster.mxidForPosterTag, undefined);
  assert.deepEqual(Object.keys(poster).sort(), ["FOURCHAN_PREFIX", "MATRIX_PREFIX", "SAFE", "discordCreatorName", "discordPosterTagFor", "localpartIfLocal", "posterTagFor"]);
});

// Operator ruling 2026-10-04: 4chan_ / 41chan_ / aichan_, 41chan_ the master,
// the others claimable only when identical once the prefix is stripped.
test("a Discord author's creator tag is <guild prefix>_<username>, and strips back to the same name", () => {
  assert.equal(poster.discordPosterTagFor("selphdestruct", "aichan"), "aichan_selphdestruct");
  assert.equal(poster.posterTagFor("@selphdestruct:41chan.net", "41chan.net"), "41chan_selphdestruct");
  const strip = (t) => t.slice(t.indexOf("_") + 1);
  assert.equal(strip(poster.discordPosterTagFor("selphdestruct", "aichan")), strip(poster.posterTagFor("@selphdestruct:41chan.net", "41chan.net")));
});

// Operator, 2026-10-06: "we should be sanitizing them so they can be
// acquired". The same vectors are in fourier-sampling tests/discordPanel.test.ts.
const ID = "136983939662348288";
const NAME_VECTORS = [
  ["selphdestruct", ID, "selphdestruct"],
  ["a.b", ID, "a.b"],
  [".name", ID, ".name"],
  ["name.", ID, "name."],
  ["Deleted User", ID, `deleted_user_${ID}`],
  ["Deleted User", "136983939662348289", "deleted_user_136983939662348289"],
  ["_lead", ID, `lead_${ID}`],
  ["trail_", ID, `trail_${ID}`],
  ["a__b", ID, `a_b_${ID}`],
  ["Alice", ID, `alice_${ID}`],
  ["\u00fcn\u00efcode n\u00e4me", ID, `n_code_n_me_${ID}`],
  ["\u2728", ID, `user_${ID}`],
  [undefined, ID, `user_${ID}`],
  ["a.b", undefined, "a.b"],
  ["Deleted User", undefined, null],
];

test("a Discord name is kept exactly when the booru can hold it, periods included, and folded with its account id when not", () => {
  for (const [username, id, want] of NAME_VECTORS) assert.equal(poster.discordCreatorName(username, id), want, JSON.stringify([username, id]));
});

test("a folded name can never be another person's exact name, and every one is a legal creator tag", () => {
  assert.notEqual(poster.discordCreatorName("Alice", ID), poster.discordCreatorName("alice", ID), "the fold carries the id; the exact name does not");
  for (const [username, id, want] of NAME_VECTORS) {
    if (want === null) continue;
    const tag = poster.discordPosterTagFor(poster.discordCreatorName(username, id), "aichan");
    assert.ok(tag && !tag.includes("__") && !tag.endsWith("_") && /^[\x21-\x7e]+$/.test(tag), tag);
  }
  assert.equal(poster.discordPosterTagFor("a.b", "aichan"), "aichan_a.b");
  assert.equal(poster.discordPosterTagFor("Deleted User", "aichan"), null, "a raw, unfolded name is not a tag");
  assert.equal(poster.discordPosterTagFor("", "aichan"), null);
});

test("a period survives on both sides, so the claim rule still matches exactly", () => {
  const strip = (t) => t.replace(/^[a-z0-9]+_/, "");
  assert.equal(strip(poster.discordPosterTagFor("a.b", "aichan")), strip(poster.posterTagFor("@a.b:41chan.net", "41chan.net")));
});

test("a Discord guild can never mint the master or the 4chan prefix", () => {
  assert.equal(poster.discordPosterTagFor("selphdestruct", "41chan"), null, "that would forge a Matrix identity");
  assert.equal(poster.discordPosterTagFor("selphdestruct", "4chan"), null);
  assert.equal(poster.discordPosterTagFor("selphdestruct", "ai_chan"), null, "a separator in the prefix would make the strip ambiguous");
  assert.equal(poster.discordPosterTagFor("selphdestruct", ""), null);
});
