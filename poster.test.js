"use strict";

// Tests for Matrix poster attribution.
//
// The property that matters is EXACTNESS: 41chan_<localpart> must correspond to
// exactly one MXID and back again, because the operator's ruling makes that tag
// the statement "this post belongs to that account". A tag that merely
// resembles a localpart would attribute someone's picture to someone else.

const test = require("node:test");
const assert = require("node:assert/strict");
const { posterTagFor, mxidForPosterTag, localpartIfLocal } = require("./poster");

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

test("the tag round-trips back to the exact MXID", () => {
  for (const mxid of ["@saber:41chan.net", "@a-b_c:41chan.net", "@x9:41chan.net"]) {
    assert.equal(mxidForPosterTag(posterTagFor(mxid, D), D), mxid);
  }
});

test("an unsafe localpart is REFUSED, not folded", () => {
  // Folding would break exactness and, worse, collide: a.b and a_b would both
  // become 41chan_a_b, silently attributing one person's posts to another.
  assert.equal(posterTagFor("@a.b:41chan.net", D), null);
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

test("a tag that is not ours parses to nothing", () => {
  assert.equal(mxidForPosterTag("4chan_anonymous", D), null);
  assert.equal(mxidForPosterTag("1girl", D), null);
  assert.equal(mxidForPosterTag("41chan_", D), null);
});
