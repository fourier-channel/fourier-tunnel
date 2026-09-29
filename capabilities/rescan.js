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
// GENERATION DATA (operator ruling 2026-09-28). The booru's file is the
// STRIPPED one, and the text that came out of it lives in the booru's private
// store. A rescan re-reads the raw bytes from Synapse, strips them the way the
// live path does, and re-sends that record -- so an image whose record was
// lost (the booru was down, or the post predates the strip) can be given one.
// The post is found the way the live path finds it: by the stripped md5, by
// the booru's record of the raw md5, then by the raw md5 itself, which is what
// every post made before the strip is keyed on.
//
// A RESCAN SAYS NOTHING ABOUT WHO MADE THE PICTURE (operator ruling
// 2026-09-29). The record goes with poster null -- "an admin's re-read", which
// the booru lets replace the fields -- and no creator is ever recorded from
// here. Who may read the record is the booru's rule: the post's creator,
// recorded once when the tunnel made the post, and whoever they allow. The
// post's 41chan_ tags are not consulted: any member can edit them.
//
// EVERY DEPENDENCY IS INJECTED (see avatar.js for why): the DM command and
// the rescan CLI hand this the same functions, and the tests hand it fakes.
"use strict";

const { findPostForBytes, generationRecord, generationRefusal, md5hex } = require("../image-plan");

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
 * @param {(md5: string, body: {rawMd5: string, source: string, poster: null, fields: object}) => Promise<object>} deps.recordGenerationMetadata
 * @param {(rawMd5: string) => Promise<string|null>} deps.findByRawMd5  the booru md5 its record names for raw bytes
 * @param {(buffer: Buffer, contentType: string, opts?: object) => {tags: string[], meta: string[]}} deps.extract
 *   creator tags from BYTES: used only when the strip refuses, so a post's
 *   provenance can still be rewritten
 * @param {(removed: object, opts?: object) => {tags: string[], meta: string[]}} deps.creatorTags
 *   creator tags from what the strip took out -- the live path's source
 * @param {(buffer: Buffer, contentType: string) => {buffer: Buffer, removed: object, changed: boolean}} deps.strip
 * @param {number} [deps.maxCreatorTags]
 * @param {(record: object) => void} deps.audit
 * @returns {Promise<{ok: boolean, report: string, postId?: number, partition?: object, generation?: string}>}
 */
async function rescan(target, deps) {
  const { download, findPostByMd5, findByRawMd5, getTagProjection, recordTagSources, recordGenerationMetadata, extract, strip, audit } = deps;
  const tagsFromRemoved = deps.creatorTags;
  if (typeof audit !== "function") throw new TypeError("rescan requires an audit sink");
  if (typeof strip !== "function") throw new TypeError("rescan requires strip(): the post is found by its stripped md5");
  if (typeof recordGenerationMetadata !== "function") throw new TypeError("rescan requires recordGenerationMetadata()");
  if (typeof findByRawMd5 !== "function") throw new TypeError("rescan requires findByRawMd5(): a post made under older strip rules is found by its raw md5's record");
  if (typeof tagsFromRemoved !== "function") throw new TypeError("rescan requires creatorTags(): creator tags come from what the strip took out");
  const t = String(target || "").trim();
  if (!t) return { ok: false, report: USAGE };

  let post, buffer, contentType, md5;
  // The strip of the raw bytes: { buffer, removed, changed }, or the reason it
  // refused. A refusal does not stop the creator-tag rewrite; it only means no
  // generation record is sent from bytes that could not be cleanly read.
  let stripped = null, stripError = null;
  const stripRaw = () => {
    try { stripped = strip(buffer, contentType); } catch (err) { stripError = String(err && err.message); }
  };
  try {
    if (MD5.test(t)) {
      md5 = t.toLowerCase();
      post = await findPostByMd5(md5);
      // The booru keys an image by the bytes IT holds, which since 2026-09-28
      // are the stripped ones. The md5 of a Matrix original is found through
      // the booru's record of raw md5s, when one was filed.
      if (!post) {
        const recorded = await findByRawMd5(md5);
        if (recorded) post = await findPostByMd5(recorded);
      }
      if (!post) return { ok: false, report: `No post on the booru has md5 ${md5}, and no generation record names it as a Matrix original (or the post is deleted and hidden from me). Rescan by the image's mxc url instead: that finds a post under every md5 it could have.` };
      const source = String(post.source || "");
      if (!source.startsWith("mxc://")) return { ok: false, report: `Post #${post.id} was not posted by me: its source is ${source || "empty"}, not an mxc url, so I have nowhere to fetch its bytes from.` };
      ({ buffer, contentType } = await download(source));
      stripRaw();
      md5 = post.md5 || md5;
    } else if (t.startsWith("mxc://")) {
      ({ buffer, contentType } = await download(t));
      stripRaw();
      const rawMd5 = md5hex(buffer);
      const strippedMd5 = stripped && stripped.changed ? md5hex(stripped.buffer) : rawMd5;
      const found = await findPostForBytes({ rawMd5, strippedMd5 }, findPostByMd5, findByRawMd5);
      if (!found) return { ok: false, report: `That image (md5 ${strippedMd5}) is not on the booru. Post it in a room I watch first; a rescan only re-reads a picture I already posted.` };
      ({ post, md5 } = found);
    } else {
      return { ok: false, report: USAGE };
    }
  } catch (err) {
    audit({ kind: "rescan_fetch_failed", target: t, error: String(err && err.message).slice(0, 300) });
    return { ok: false, report: `Could not fetch the bytes: ${err && err.message}` };
  }

  // The prompt, read with the extractor as it is TODAY, from what the strip
  // took out -- or, when the strip refused, from the bytes, so the post's
  // provenance is still rewritten.
  const scraped = (stripped ? tagsFromRemoved(stripped.removed, { max: deps.maxCreatorTags }) : extract(buffer, contentType, { max: deps.maxCreatorTags })) || {};
  const creatorTags = scraped.tags || [];
  const scrapedMeta = scraped.meta || [];
  const ocTags = scraped.characters || [];

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
    oc: ocTags,
    replace_creator: true,
  };

  let recorded;
  try {
    recorded = await recordTagSources(post.id, partition);
  } catch (err) {
    audit({ kind: "rescan_write_failed", post_id: post.id, error: String(err && err.message).slice(0, 300) });
    return { ok: false, report: `Read ${creatorTags.length} creator tag(s) from post #${post.id}, but the booru refused the write: ${err && err.message}`, postId: post.id, partition };
  }

  const generation = await resendGeneration({ post, md5, rawMd5: md5hex(buffer), stripped, stripError, deps });

  const kind = (contentType || "").replace(/^image\//, "") || "?";
  audit({ kind: "rescan", post_id: post.id, md5, content_type: contentType, creator: creatorTags.length, both: both.length, oc: ocTags.length, rows: recorded && recorded.recorded, generation: generation.state });
  const ocNote = ocTags.length ? ` Original characters: ${ocTags.join(", ")}.` : "";
  const report = (creatorTags.length || ocTags.length
    ? `Post #${post.id} (${kind}): read ${creatorTags.length} creator tag(s) from its metadata, ${both.length} of them also the autotagger's; ${recorded && recorded.recorded != null ? recorded.recorded : "?"} provenance rows now on the post.${ocNote}`
    : `Post #${post.id} (${kind}): no prompt in these bytes. Its old creator rows, if any, are cleared; ${recorded && recorded.recorded != null ? recorded.recorded : "?"} rows remain.`) +
    ` ${generation.sentence}`;
  return { ok: true, report, postId: post.id, partition, generation: generation.state };
}

// Re-send the private generation record for one post. Never throws: every
// outcome is a state for the audit line and a sentence for the report.
async function resendGeneration({ post, md5, rawMd5, stripped, stripError, deps }) {
  if (stripError) {
    return { state: "strip-refused", sentence: `Generation metadata NOT re-recorded: ${stripError}` };
  }
  // poster null: an admin's re-read. Never a creator derived from anything.
  const rec = generationRecord({ md5, rawMd5, poster: null, removed: stripped.removed });
  if (!rec) return { state: "none", sentence: "No generation metadata in these bytes." };
  const n = Object.keys(rec.fields).length;
  try {
    await deps.recordGenerationMetadata(rec.md5, { rawMd5: rec.rawMd5, source: rec.source, poster: null, fields: rec.fields });
  } catch (err) {
    // Told apart by the booru's reason, as on the live path: only a record
    // that stood against a different poster is "kept", and a re-read sends no
    // poster, so here every refusal is a record NOT written.
    const r = generationRefusal(err, rec);
    deps.audit({ kind: "rescan_generation_failed", post_id: post.id, md5: rec.md5, state: r.state, error: String(err && err.message).slice(0, 300) });
    if (r.kept) return { state: r.state, sentence: `Generation metadata: the post ${r.why}.` };
    return { state: r.state, sentence: `Generation metadata (${n} field(s)) NOT re-recorded -- the booru refused it: ${r.why}.${r.fix ? ` Fix: ${r.fix}.` : ""}` };
  }
  return { state: "recorded", sentence: `Generation metadata: ${n} field(s) recorded privately, readable by the post's recorded creator and whoever they allow.` };
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
