"use strict";

// WHO POSTED IT, on the Matrix side.
//
// Operator ruling 2026-09-08, superseding the 2026-08-12 one recorded in
// fourier-sampling's src/poster.ts (which says the prefix names the SOURCE, so
// Matrix posts would be `matrix_<localpart>`). The prefix is now the SITE:
//
//   archived 4chan posts   4chan_<handle>
//   live 41chan posts      41chan_<localpart>
//
// The operator's reasoning, which is why the older rule does not apply here: a
// 4chan handle is a text field anyone can type, so a 4chan tag asserts nothing
// about identity and the claim process exists precisely to let someone take
// ownership of posts under a handle that is not theirs. A 41chan tag is
// different in kind. It is minted from the sender of a Matrix event on this
// homeserver, so it EXACTLY matches an MXID the server already authenticated.
// Posting as @saber:41chan.net makes 41chan_saber the creator, and that post is
// thereafter explicitly under that account's control.
//
// That exactness is the load-bearing property. Anything that made the tag
// disagree with the localpart would break the identity mapping, so the slug
// below is deliberately a CHECK rather than a transformation.

// Local users only. A remote MXID would mint a tag claiming a local identity
// for someone this server never authenticated.
function localpartIfLocal(mxid, domain) {
  if (typeof mxid !== "string") return null;
  const m = /^@([^:]+):(.+)$/.exec(mxid);
  if (!m) return null;
  if (m[2] !== domain) return null;
  return m[1];
}

// A tag must survive a space-delimited tag_string and chanbooru's
// RESTRICTED_TAGS_REGEX, which interpolates tag names unescaped. Rather than
// FOLD an awkward localpart into something tag-safe -- which would silently
// break the exact-match property, and could collide two distinct users onto one
// tag (a.b and a_b both becoming a_b) -- anything outside the safe charset is
// refused. Measured 2026-09-08: every localpart on this homeserver is already
// within it, so this rejects nothing today and stays honest if that changes.
const SAFE = /^[a-z0-9_-]+$/;

function posterTagFor(mxid, domain) {
  const local = localpartIfLocal(mxid, domain);
  if (!local) return null;
  if (!SAFE.test(local)) return null;
  return `41chan_${local}`;
}

// The inverse, so a claim or an ownership check can go from tag back to MXID
// without re-deriving the rule in a second place.
function mxidForPosterTag(tag, domain) {
  if (typeof tag !== "string") return null;
  const m = /^41chan_(.+)$/.exec(tag);
  if (!m || !SAFE.test(m[1])) return null;
  return `@${m[1]}:${domain}`;
}

module.exports = { posterTagFor, mxidForPosterTag, localpartIfLocal, SAFE };
