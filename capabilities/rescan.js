// "!rescan <mxc:// url | md5>": read an image's own metadata again and rewrite
// its creator provenance on the booru.
//
// WHY. The live path reads a prompt once, at upload. Everything the tunnel
// posted before 2026-09-19 was read by an extractor that knew only PNG text
// chunks and a normaliser that stripped every parenthesis -- so a JPEG's
// prompt was never read at all, and a PNG's "hilda \(pokemon\)" was recorded
// as hilda_pokemon. The bytes are still on Synapse, under the mxc the booru
// keeps as the post's source. This reads them again.
//
// WHERE THE MD5 DEDUP WOULD STOP IT, and why it does not stop this. The live
// handler downloads, hashes, and asks the booru for the md5; when the post
// exists it rewrites the room's tag state and RETURNS -- the scrape and the
// provenance write are below that return and never run again for a known
// image (operator's question, 2026-09-19). A rescan needs the post to exist:
// it uses the same md5 lookup to FIND the post, then does the two steps the
// live path skips. What it never does is upload, so the fork's 500 on a
// duplicate md5 is not reachable from here.
//
// METADATA ONLY. The autotagger is not re-run: its rows stay as they are and
// are read back from the booru's public projection so the creator/auto/both
// split is rebuilt against them. replace_creator tells the booru to drop the
// previous read's creator rows before writing this one.
//
// EVERY DEPENDENCY IS INJECTED (see avatar.js for why): the DM command and
// the rescan CLI hand this the same functions, and the tests hand it fakes.
"use strict";

const MD5 = /^[0-9a-f]{32}$/i;
const USAGE = "Usage: !rescan <mxc://server/media-id | md5>";

/**
 * Re-read one image. Returns a one-line report; throws nothing a caller
 * would want to catch -- every failure is a sentence in the report.
 *
 * @param {string} target  an mxc:// url or a 32-hex md5
 * @param {object} deps
 * @param {(mxc: string) => Promise<{buffer: Buffer, contentType: string}>} deps.download
 * @param {(md5: string) => Promise<object|null>} deps.findPostByMd5
 * @param {(postId: number) => Promise<{tags: string[], sources: object}|null>} deps.getTagProjection
 * @param {(postId: number, partition: object) => Promise<object>} deps.recordTagSources
 * @param {(buffer: Buffer, contentType: string, opts?: object) => {tags: string[], meta: string[]}} deps.extract
 * @param {number} [deps.maxCreatorTags]
 * @param {(record: object) => void} deps.audit
 * @returns {Promise<{ok: boolean, report: string, postId?: number, partition?: object}>}
 */
async function rescan(target, deps) {
  const { download, findPostByMd5, getTagProjection, recordTagSources, extract, audit } = deps;
  if (typeof audit !== "function") throw new TypeError("rescan requires an audit sink");
  const t = String(target || "").trim();
  if (!t) return { ok: false, report: USAGE };

  let post, buffer, contentType, md5;
  try {
    if (MD5.test(t)) {
      md5 = t.toLowerCase();
      post = await findPostByMd5(md5);
      if (!post) return { ok: false, report: `No post on the booru has md5 ${md5} (or it is deleted and hidden from me).` };
      const source = String(post.source || "");
      if (!source.startsWith("mxc://")) return { ok: false, report: `Post #${post.id} was not posted by me: its source is ${source || "empty"}, not an mxc url, so I have nowhere to fetch its bytes from.` };
      ({ buffer, contentType } = await download(source));
    } else if (t.startsWith("mxc://")) {
      ({ buffer, contentType } = await download(t));
      md5 = require("crypto").createHash("md5").update(buffer).digest("hex");
      post = await findPostByMd5(md5);
      if (!post) return { ok: false, report: `That image (md5 ${md5}) is not on the booru. Post it in a room I watch first; a rescan only re-reads a picture I already posted.` };
    } else {
      return { ok: false, report: USAGE };
    }
  } catch (err) {
    audit({ kind: "rescan_fetch_failed", target: t, error: String(err && err.message).slice(0, 300) });
    return { ok: false, report: `Could not fetch the bytes: ${err && err.message}` };
  }

  // The prompt, read with the extractor as it is TODAY.
  const scraped = extract(buffer, contentType, { max: deps.maxCreatorTags });
  const creatorTags = scraped.tags || [];
  const scrapedMeta = scraped.meta || [];

  // The autotagger's rows, from the booru's public projection: auto and both
  // are both the autotagger's, and both is where a creator name meets one.
  let projection = null;
  try { projection = await getTagProjection(post.id); } catch { projection = null; }
  const src = (projection && projection.sources) || {};
  const autoTags = [...new Set([...(src.auto || []), ...(src.both || [])])];
  const metaTags = [...new Set([...(src.meta || []), ...scrapedMeta])];

  const creatorSet = new Set(creatorTags);
  const autoSet = new Set(autoTags);
  const both = autoTags.filter((x) => creatorSet.has(x));
  const partition = {
    creator: creatorTags.filter((x) => !autoSet.has(x)),
    auto: autoTags.filter((x) => !creatorSet.has(x)),
    both,
    meta: metaTags,
    replace_creator: true,
  };

  let recorded;
  try {
    recorded = await recordTagSources(post.id, partition);
  } catch (err) {
    audit({ kind: "rescan_write_failed", post_id: post.id, error: String(err && err.message).slice(0, 300) });
    return { ok: false, report: `Read ${creatorTags.length} creator tag(s) from post #${post.id}, but the booru refused the write: ${err && err.message}`, postId: post.id, partition };
  }

  const kind = (contentType || "").replace(/^image\//, "") || "?";
  audit({ kind: "rescan", post_id: post.id, md5, content_type: contentType, creator: creatorTags.length, both: both.length, rows: recorded && recorded.recorded });
  const report = creatorTags.length
    ? `Post #${post.id} (${kind}): read ${creatorTags.length} creator tag(s) from its metadata, ${both.length} of them also the autotagger's; ${recorded && recorded.recorded != null ? recorded.recorded : "?"} provenance rows now on the post.`
    : `Post #${post.id} (${kind}): no prompt in these bytes. Its old creator rows, if any, are cleared; ${recorded && recorded.recorded != null ? recorded.recorded : "?"} rows remain.`;
  return { ok: true, report, postId: post.id, partition };
}

/**
 * The DM command. Admin-only and DM-only, like the other admin commands; a
 * rescan rewrites provenance on the booru and is not for everyone.
 *
 * @returns {Promise<boolean>} true when the event was consumed
 */
async function handleRescanCommand(event, deps) {
  const body = event && event.content && event.content.body;
  if (typeof body !== "string" || !body.startsWith("!rescan")) return false;
  const { sendText, admins, isDm, audit } = deps;
  const sender = event.sender;
  if (!admins.includes(sender)) {
    audit({ kind: "rescan_denied_not_admin", sender });
    return true;
  }
  if (!(await isDm(event.room_id))) {
    audit({ kind: "rescan_denied_not_dm", sender, room: event.room_id });
    return true;
  }
  const target = body.split(/\s+/)[1];
  if (!target) {
    await sendText(event.room_id, USAGE);
    return true;
  }
  const result = await rescan(target, deps);
  await sendText(event.room_id, result.report);
  return true;
}

module.exports = { rescan, handleRescanCommand, USAGE };
