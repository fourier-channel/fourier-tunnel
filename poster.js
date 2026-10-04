"use strict";

// WHO POSTED IT: the creator tag, and with it the post's provenance.
//
// Operator ruling 2026-10-04. Every post carries a creator tag whose PREFIX
// names where the post came from. With one user, selphdestruct, as the example:
//
//   4chan_selphdestruct    scraped from 4chan (fourier-sampling mints these)
//   41chan_selphdestruct   posted from Matrix on this homeserver
//   aichan_selphdestruct   posted from the AIchan Discord
//
// 41chan_<localpart> is the MASTER creator: it is minted from the sender of a
// Matrix event this homeserver authenticated, so it matches an MXID exactly.
// The other two are CLAIMABLE by that account only when they are identical to
// it once the prefix is stripped. Since every post must have a creator -- a
// post without a poster cannot exist -- the prefix establishes provenance by
// itself; no other flag is set, and Discord posts are segregated from Matrix
// ones by the tag alone. (This replaces the 2026-09-08 rule that the prefix
// named the SITE.)
//
// Exactness is load-bearing. A claim compares names with the prefix removed,
// so anything that made a tag disagree with the name it was minted from --
// folding "a.b" into "a_b", say -- could hand one person's posts to another
// account. Every slug below is therefore a CHECK, never a transformation: a
// name outside the safe charset gets no tag, and a post that cannot be
// attributed is not made from Discord.
//
// What ENFORCES a Matrix creator's control is the creator record the tunnel
// writes when it makes the post, not this tag, which anyone can edit on the
// booru: see the end of this file.

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

/** The master prefix: a Matrix sender on this homeserver. */
const MATRIX_PREFIX = "41chan";
/** fourier-sampling's prefix for posts scraped from 4chan. */
const FOURCHAN_PREFIX = "4chan";
/** A source prefix as config may name one: short, lowercase, no separator. */
const PREFIX = /^[a-z0-9]{1,16}$/;

function posterTagFor(mxid, domain) {
  const local = localpartIfLocal(mxid, domain);
  if (!local) return null;
  if (!SAFE.test(local)) return null;
  return `${MATRIX_PREFIX}_${local}`;
}

/**
 * A Discord author's creator tag: <prefix>_<username>, the prefix being the one
 * configured for the guild the message came from ("aichan" for the AIchan
 * Discord).
 *
 * The USERNAME, never the display name: Discord usernames are unique and
 * lowercase, display names are neither, and a claim needs a name that means
 * one person. Null when the username is outside the safe charset (Discord
 * allows "." in usernames; it is refused here, not folded), or when the prefix
 * is not a legal one -- including the master and 4chan prefixes, which a
 * Discord guild must never mint, since a guild configured as "41chan" would
 * forge Matrix identities.
 */
function discordPosterTagFor(username, prefix) {
  if (typeof prefix !== "string" || !PREFIX.test(prefix)) return null;
  if (prefix === MATRIX_PREFIX || prefix === FOURCHAN_PREFIX) return null;
  if (typeof username !== "string" || !SAFE.test(username)) return null;
  return `${prefix}_${username}`;
}

// THERE IS NO INVERSE HERE, ON PURPOSE. There was one (mxidForPosterTag), and
// the generation-data work used it to decide who a post's creator was by
// reading the post's 41chan_ tags -- which any member can edit (chanbooru
// PostPolicy#update?), so a member could add their own tag to someone's post
// and take over its private record. The tag is a public label. Who created a
// post is the record the tunnel writes once, when it creates the post
// (danbooru.js recordPostCreator; operator ruling 2026-09-29), and nothing
// derived from tags may stand in for it.

module.exports = { posterTagFor, discordPosterTagFor, localpartIfLocal, SAFE, MATRIX_PREFIX, FOURCHAN_PREFIX };
