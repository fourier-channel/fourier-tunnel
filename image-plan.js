"use strict";

// WHAT ONE IMAGE MEANS, decided before the booru is touched.
//
// handleImageEvent (index.js) follows the plan this returns; the decisions are
// here, with every dependency injected, so they can be tested one by one
// (index.test.js drives the real handler end to end). The order is the point
// of the module (operator ruling 2026-09-28, strip generation data on ingest):
//
//   1. STRIP (strip-generation.js). If generation text survives, or the format
//      cannot be verified and carries metadata, NOTHING is posted: the image
//      is refused and says why.
//   2. CREATOR TAGS FROM WHAT THE STRIP TOOK, never from the raw bytes: the
//      tags are private and the stripped file is public, so they must come
//      from private text only (prompt-tags extractCreatorTagsFromFields).
//   3. DUPLICATE CHECK, three ways: the stripped md5 (a post made by this
//      stripper), then the booru's record of the RAW md5 (a post made by an
//      earlier version of the strip rules -- md5(strip(raw)) moves when the
//      rules do, md5(raw) never does), then the raw md5 itself (a post made
//      before the strip existed, which holds the raw bytes).
//   4. The upload carries the STRIPPED bytes, and "ai-generated" when what was
//      stripped was a generator's own signal -- not when it only had the shape
//      of a prompt, which a human caption can have.
//   5. After the post exists: its CREATOR is recorded (the authenticated
//      sender of the Matrix event, once), and the removed text goes to the
//      booru's private store with the raw md5 beside it.
//
// WHO THE CREATOR IS is never read from a post's 41chan_ tags. Any member can
// edit any post's tags (chanbooru PostPolicy#update?), so a tag proves nothing
// about who made the picture; the booru's recorded creator does, and only the
// tunnel, at creation, writes it (operator ruling 2026-09-29).

const crypto = require("crypto");

// The distinct outcome of a refused strip. backfill.js and catchup.js count it
// apart from "done": a picture that was never posted is not a success.
const STRIP_REFUSED = "strip-refused";
// The booru already holds these bytes under a post this account may not see
// (deleted or jailed): nothing was posted, and nothing will be on a retry.
// Counted apart from "done" and from "failed" (index.js heldByTheBooru).
const HELD_HIDDEN = "held-hidden";
const AI_GENERATED_TAG = "ai-generated";
const NO_SCRAPE = Object.freeze({ tags: [], meta: [], characters: [] });

function md5hex(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex");
}

/**
 * Find the booru post for these bytes. Returns { post, md5, via } -- `md5` the
 * booru's own md5 for the post (the one its generation record is keyed by) --
 * or null. `via` is "stripped", "raw-record" or "raw".
 *
 * @param {{rawMd5: string, strippedMd5: string}} md5s
 * @param {(md5: string) => Promise<object|null>} findPostByMd5
 * @param {(rawMd5: string) => Promise<string|null>} findByRawMd5  the booru md5 its
 *   generation record names for these raw bytes. A failure THROWS: a lookup that
 *   could not be made is not "no such post", and treating it as one posts the
 *   picture twice.
 */
async function findPostForBytes({ rawMd5, strippedMd5 }, findPostByMd5, findByRawMd5) {
  let post = await findPostByMd5(strippedMd5);
  if (post) return { post, md5: post.md5 || strippedMd5, via: "stripped" };
  if (typeof findByRawMd5 !== "function") throw new TypeError("findPostForBytes requires findByRawMd5: without it a re-post after a strip-rule change is posted twice");
  const recorded = await findByRawMd5(rawMd5);
  if (recorded && recorded !== strippedMd5) {
    post = await findPostByMd5(recorded);
    if (post) return { post, md5: post.md5 || recorded, via: "raw-record" };
  }
  if (rawMd5 === strippedMd5) return null;
  post = await findPostByMd5(rawMd5);
  if (post) return { post, md5: post.md5 || rawMd5, via: "raw" };
  return null;
}

/**
 * The body for danbooru.recordGenerationMetadata, or null when nothing was
 * removed. NUL is scrubbed here as well as in the strip: this is the one
 * builder every sender goes through, and Postgres refuses U+0000 in jsonb.
 */
function generationRecord({ md5, rawMd5, poster, removed, source = "matrix" }) {
  if (!removed || Object.keys(removed).length === 0) return null;
  const fields = {};
  for (const [k, v] of Object.entries(removed)) fields[k] = String(v).replace(/\0/g, "");
  return { md5, rawMd5, source, poster: poster || null, fields };
}

/** The booru's PUBLIC tag string, as a list. Creator-only tags never enter it. */
function publicTagsFor({ autoTags = [], metaTags = [], ocTags = [], posterTag = null, aiGenerated = false }) {
  return [...new Set([
    ...autoTags, ...metaTags, ...ocTags,
    ...(posterTag ? [posterTag] : []),
    ...(aiGenerated ? [AI_GENERATED_TAG] : []),
  ])];
}

/**
 * Decide what to do with one downloaded image.
 *
 * @param {{buffer: Buffer, contentType: string, sender: string}} input
 * @param {object} deps
 * @param {(buffer: Buffer, contentType: string) => {buffer: Buffer, removed: object, changed: boolean, confident: boolean}} deps.strip
 * @param {(removed: object, opts: object) => object} deps.creatorTags  prompt-tags extractCreatorTagsFromFields
 * @param {(md5: string) => Promise<object|null>} deps.findPostByMd5
 * @param {(rawMd5: string) => Promise<string|null>} deps.findByRawMd5
 * @param {number} [deps.maxCreatorTags]
 * @param {(line: string) => void} deps.log
 * @returns {Promise<object>} one of
 *   { action: "refuse", status: "strip-refused", reason }
 *   { action: "duplicate", post, md5, via, scraped, record }
 *   { action: "upload", upload: {buffer, md5}, rawMd5, scraped, removed, aiGenerated, record }
 *   `record` is the generation-metadata body to send, or null. Its poster is
 *   always the SENDER of these bytes: on "duplicate" the booru keeps an
 *   existing record from anyone else (409) rather than this code guessing
 *   whose it is. On "upload" its md5 is the stripped md5 and the caller swaps
 *   in the booru's if the created post reports a different one.
 */
async function planImage({ buffer, contentType, sender, rawMd5: knownRawMd5 }, deps) {
  const { strip, creatorTags, findPostByMd5, findByRawMd5, log } = deps;
  if (typeof log !== "function") throw new TypeError("planImage requires log(): a failure nobody can read is not a report");

  // 1. The strip. A throw here is a refusal, never a post.
  let stripped;
  try {
    stripped = strip(buffer, contentType);
  } catch (err) {
    return { action: "refuse", status: STRIP_REFUSED, reason: err && err.message ? err.message : String(err) };
  }
  // canon.js knows the raw md5 even when the raw bytes are no longer at hand
  // (an image made canonical earlier, its original since reviewed and deleted).
  const rawMd5 = knownRawMd5 || md5hex(buffer);
  const upload = { buffer: stripped.buffer, md5: stripped.changed ? md5hex(stripped.buffer) : rawMd5 };
  const removed = stripped.removed || {};

  // 2. The prompt, from the text the strip took out.
  let scraped = NO_SCRAPE;
  try {
    scraped = creatorTags(removed, { max: deps.maxCreatorTags }) || NO_SCRAPE;
  } catch (err) {
    log(`[creator-tags] prompt scrape failed: ${err.message}`);
  }

  // 3. Is it already on the booru?
  const found = await findPostForBytes({ rawMd5, strippedMd5: upload.md5 }, findPostByMd5, findByRawMd5);
  if (found) {
    return {
      action: "duplicate", post: found.post, md5: found.md5, via: found.via, scraped,
      record: generationRecord({ md5: found.md5, rawMd5, poster: sender, removed }),
    };
  }

  return {
    action: "upload",
    upload,
    rawMd5,
    scraped,
    removed,
    aiGenerated: stripped.confident === true,
    record: generationRecord({ md5: upload.md5, rawMd5, poster: sender, removed }),
  };
}

/**
 * What a refused generation record means, told by the booru's 409 `reason`
 * (danbooru.js BooruRefusal). { state, kept, why, fix }: `kept` is true ONLY
 * for poster_mismatch -- a record from a different poster exists and stood,
 * which is the rule working (a stranger's re-post never replaces the
 * creator's record). Every other answer, a 409 with no reason this knows
 * among them, means this record was NOT written, and says why and what to do.
 */
function generationRefusal(err, rec) {
  const why = err && err.message ? err.message : String(err);
  const reason = err && err.status === 409 ? err.reason : undefined;
  if (reason === "poster_mismatch") {
    return { state: "kept", kept: true, why: `keeps the record it already has; ${rec.poster || "this re-read"}'s copy was not written (${why})` };
  }
  if (reason === "raw_md5_conflict") {
    return {
      state: "raw-md5-conflict", kept: false,
      why: `its original (raw md5 ${rec.rawMd5}) is already filed under a DIFFERENT md5 -- a post that may since have been deleted -- ` +
        `so nothing was written for this one (${why})`,
      fix: `GET /fourier/generation_metadata/raw/${rec.rawMd5}.json names the md5 holding it; resolve that record on the booru`,
    };
  }
  if (reason === "raw_md5_mismatch") {
    return {
      state: "raw-md5-mismatch", kept: false,
      why: `the booru's record for this md5 was filed from a DIFFERENT original than raw md5 ${rec.rawMd5}, so its fields were NOT replaced (${why})`,
      fix: "find which original the post was made from and, if it is this one, correct the record on the booru",
    };
  }
  const unknown409 = err && err.status === 409 ? " -- a 409 with no reason the tunnel knows, so not taken as \"kept\"" : "";
  return { state: "failed", kept: false, why: `${why}${unknown409}` };
}

/**
 * Send a generation record, fail-soft and LOUD. The served file is stripped
 * whether or not this lands; what a failure loses is the private copy, which
 * then exists only in the Matrix original -- so the warning says where that
 * is and how to put it back.
 *
 * A 409 for poster_mismatch is NOT a failure (generationRefusal) and is
 * logged plainly. Each other refusal is logged as NOT RECORDED, in words of
 * its own.
 *
 * @returns {Promise<"recorded"|"kept"|"skipped"|"raw-md5-conflict"|"raw-md5-mismatch"|"failed">}
 */
async function recordGeneration(send, rec, { log, info, postId, mxc }) {
  if (!rec) return "skipped";
  try {
    await send(rec.md5, { rawMd5: rec.rawMd5, source: rec.source, poster: rec.poster, fields: rec.fields });
    return "recorded";
  } catch (err) {
    const r = generationRefusal(err, rec);
    if (r.kept) {
      (info || log)(`[generation] post #${postId} ${r.why}`);
      return r.state;
    }
    log(
      `[generation] NOT RECORDED for post #${postId} (md5 ${rec.md5}, ${Object.keys(rec.fields).length} field(s)): ` +
      `${r.why}. The file on the booru is stripped either way; the text now ` +
      `exists only in the Matrix original ${mxc}. Fix: ${r.fix ? `${r.fix}, then` : "once the booru accepts it,"} run !rescan ${mxc} in a DM with the bot.`,
    );
    return r.state;
  }
}

/**
 * Record a new post's CREATOR: the sender of the Matrix event that made it,
 * which this homeserver authenticated. Fail-soft and LOUD. A post with no
 * recorded creator shows its private data -- creator-only tags, generation
 * data -- to NOBODY, which is the safe direction to fail in; the warning says
 * so and how to put it right.
 *
 * @returns {Promise<"recorded"|"failed">}
 */
async function recordCreator(send, { postId, mxid, log }) {
  try {
    await send(postId, mxid);
    return "recorded";
  } catch (err) {
    log(
      `[creator] NOT RECORDED for post #${postId} (${mxid}): ${err && err.message ? err.message : String(err)}. ` +
      "Until it is, the post's private data -- its creator-only tags and any generation data -- is visible to nobody, " +
      `not even its creator. Fix: as the tunnel's booru account, POST /fourier/posts/${postId}/creator.json ` +
      `{"mxid":"${mxid}"} once the booru answers (a 409 means a different creator is already recorded: check which is right).`,
    );
    return "failed";
  }
}

module.exports = {
  planImage,
  findPostForBytes,
  generationRecord,
  publicTagsFor,
  recordGeneration,
  generationRefusal,
  recordCreator,
  md5hex,
  STRIP_REFUSED,
  HELD_HIDDEN,
  AI_GENERATED_TAG,
};
