"use strict";

// ONE FILE PER IMAGE. The operator's decree, from day one and restated
// 2026-09-30: "Every image exists once and once only, for every single
// surface." "One file, always. One file, one source of metadata. Multiple
// surfaces." "All media links lead to the stripped metadata file."
//
// What was true before this module, and why it had to go:
//
//   - A Matrix image lived in R2 at Synapse's key, local_content/<AA>/<BB>/<rest>,
//     with its AI generation data (prompt, settings, workflow) still inside.
//     Every surface -- Element, Technetium, the booru's Matrix posts -- was
//     handed that file by the media gate.
//   - The tunnel stripped its OWN upload to the booru, so the booru stored a
//     second, different file at media/<md5>.<ext> that nobody was ever served.
//     A check that read the booru's copy reported "stripped" while every reader
//     downloaded the prompt.
//
// What this module makes true, for one Matrix media id at a time:
//
//   1. THE ONE FILE is media/<md5>.<ext>: the image with its generation data
//      removed (strip-generation.js, the same code the tunnel posts with), keyed
//      by the md5 of exactly those bytes -- the org's one layout, the one
//      fourier-sampling and the booru already write. The same picture uploaded
//      twice is one file.
//   2. index/local/<mediaId>.json says where that file is. The media gate reads
//      it for every Matrix original, so every link -- chat, Technetium, the
//      booru's Matrix posts -- leads to the stripped file.
//   3. What was removed goes to the booru's private store (one source of
//      metadata), with the uploader as poster: readable by the post's creator
//      alone (operator ruling 2026-09-29).
//   4. Synapse's original is MOVED to superseded/<its key>, for the operator
//      to review and delete. Nothing here deletes anything: a move is a copy,
//      a check that the copy is whole, and only then removal of the source key.
//
// Not images (encrypted attachments, video, HTML): nothing to strip, so the
// index names the file where it already is and nothing moves.
//
// An image the stripper REFUSES (a format it cannot verify that carries a
// metadata carrier) gets an index that says so, the gate serves nothing for it,
// and its original stays where it is. Fail closed: a link must never lead to a
// file that still has a prompt in it.
//
// Idempotent and resumable: every step checks before it writes, the canonical
// key is content-addressed (an object already there IS those bytes), and a run
// that died between the move's copy and its delete finishes the move next time.

const crypto = require("crypto");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { stripGeneration } = require("./strip-generation");

// Media types the stripper handles, and the extension the booru gives them.
// Danbooru names a JPEG ".jpg", and the canonical key must match the key the
// booru writes for the same bytes, or the booru stores a second copy.
const IMAGE_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

function shard(mediaId) {
  return `${mediaId.slice(0, 2)}/${mediaId.slice(2, 4)}/${mediaId.slice(4)}`;
}
const keys = {
  source: (mediaId) => `local_content/${shard(mediaId)}`,
  superseded: (mediaId) => `superseded/local_content/${shard(mediaId)}`,
  thumbnails: (mediaId) => `local_thumbnails/${shard(mediaId)}/`,
  index: (mediaId) => `index/local/${mediaId}.json`,
  byMd5: (md5) => `index/md5/${md5}.json`,
  byRaw: (rawMd5) => `index/raw/${rawMd5}.json`,
  canonical: (md5, ext) => `media/${md5}.${ext}`,
};

// A Synapse media id is URL-safe base64-ish; refuse anything else before it
// becomes part of an object key or a URL.
const MEDIA_ID = /^[A-Za-z0-9_-]{5,128}$/;

const md5hex = (buf) => crypto.createHash("md5").update(buf).digest("hex");
const md5b64 = (buf) => crypto.createHash("md5").update(buf).digest("base64");

// What an object IS, from its first bytes. The upload's declared type is the
// client's claim, and it decides nothing here: an image sent as
// application/octet-stream still carries its prompt, and a PNG labelled
// image/jpeg would otherwise get a .jpg key the booru never writes for those
// bytes -- a second file. Null: not an image (an encrypted attachment, a video,
// a page), so there is nothing to strip.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return { ext: "png", type: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  const six = buf.toString("latin1", 0, 6);
  if (six === "GIF87a" || six === "GIF89a") return { ext: "gif", type: "image/gif" };
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return { ext: "webp", type: "image/webp" };
  if (buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12);
    if (brand === "avif" || brand === "avis") return { ext: "avif", type: "image/avif" };
    if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return { ext: "heic", type: "image/heic" };
    return null; // mp4, mov and friends
  }
  const four = buf.toString("latin1", 0, 4);
  if (four === "II*\0" || four === "MM\0*") return { ext: "tiff", type: "image/tiff" };
  if (buf.toString("latin1", 0, 2) === "BM") return { ext: "bmp", type: "image/bmp" };
  return null;
}

function r2FromEnv(env = process.env) {
  const need = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `canon: ${missing.join(", ")} not set. Fix: add them to the tunnel's .env ` +
        "(the same bucket and credentials fourier-sampling writes media/ with).",
    );
  }
  return {
    bucket: env.R2_BUCKET,
    s3: new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
      // The SDK adds a CRC32 checksum to every upload by default (since 3.729)
      // and then refuses a request that also carries the Content-MD5 this
      // module sends for integrity: "You can only specify one non-default
      // checksum at a time" -- measured on the first live canonical write,
      // 2026-09-30. Checksums only when an operation requires one, which is
      // also what R2 documents for these defaults; Content-MD5 stays.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  };
}

// Thin, injectable storage over the S3 client, so tests drive it with a Map.
function r2Store({ s3, bucket }) {
  const missing = (err) =>
    err && (err.name === "NotFound" || err.name === "NoSuchKey" || (err.$metadata && err.$metadata.httpStatusCode === 404));
  return {
    async head(key) {
      try {
        const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: h.ContentLength, etag: String(h.ETag || "").replace(/"/g, ""), type: h.ContentType };
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async get(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (err) {
        if (missing(err)) return null;
        throw err;
      }
    },
    async put(key, body, contentType) {
      const out = await s3.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ContentMD5: md5b64(body) }),
      );
      return String(out.ETag || "").replace(/"/g, "");
    },
    async copy(from, to) {
      await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${encodeURI(from)}` }));
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix) {
      const out = [];
      let token;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents || []) out.push(o.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
  };
}

class CanonError extends Error {
  constructor(message, { status = 500, retryable = true } = {}) {
    super(message);
    this.name = "CanonError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * deps:
 *   store       r2Store(...) or a fake with head/get/put/copy/remove
 *   mediaInfo   async (mediaId) -> { media_type, user_id, quarantined_by } | null
 *   booru       { recordGenerationMetadata(md5, {rawMd5, source, poster, fields}) }
 *   log         (line) => void
 */
function createCanon({ store, mediaInfo, booru, log = () => {} }) {
  async function readIndex(mediaId) {
    const raw = await store.get(keys.index(mediaId));
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new CanonError(`index for ${mediaId} is not JSON. Fix: inspect ${keys.index(mediaId)} in the bucket.`, { retryable: false });
    }
  }
  async function writeIndex(mediaId, idx) {
    await store.put(keys.index(mediaId), Buffer.from(JSON.stringify(idx)), "application/json");
  }

  // Finish moving Synapse's original out of the way. Safe to call any number of
  // times: copy only if the destination is not already whole, delete only once
  // the destination is verified.
  //
  // A MULTIPART source (Synapse's storage provider uploads files above ~8MB in
  // parts) has an ETag of "<hash>-<parts>" that no single-part copy can equal:
  // the copy's ETag is the plain md5 of its bytes. So such a copy is verified
  // against the raw md5 canon recorded for that original instead, and without
  // one the source stays -- measured 2026-09-30, 52 originals refused this way
  // by the first backfill, every copy whole and the same size.
  async function moveSource(mediaId, rawMd5) {
    const from = keys.source(mediaId);
    const to = keys.superseded(mediaId);
    const src = await store.head(from);
    if (!src) return "absent"; // already moved (or never there)
    let dst = await store.head(to);
    if (!dst) {
      await store.copy(from, to);
      dst = await store.head(to);
    }
    const multipart = typeof src.etag === "string" && src.etag.includes("-");
    const sameBytes = multipart ? !!rawMd5 && dst && dst.etag === rawMd5 : !(src.etag && dst && dst.etag && src.etag !== dst.etag);
    if (!dst || dst.size !== src.size || !sameBytes) {
      throw new CanonError(
        `move of ${from} not verified: ${to} is ${dst ? `${dst.size} bytes, etag ${dst.etag}` : "missing"}, source is ${src.size} bytes, etag ${src.etag}. ` +
          "The source was NOT removed. Fix: compare the two objects in the bucket and rerun.",
      );
    }
    await store.remove(from);
    return "moved";
  }

  // The raw original, wherever it is now: at Synapse's key, or already moved.
  async function readRaw(mediaId) {
    return (await store.get(keys.source(mediaId))) || (await store.get(keys.superseded(mediaId)));
  }

  async function readJson(key) {
    const raw = await store.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new CanonError(`${key} is not JSON. Fix: inspect it in the bucket.`, { retryable: false });
    }
  }

  // Move the original aside -- but only once what was stripped from it is safe
  // in the private store (or there was nothing to strip). A failure here is
  // housekeeping, never a reason to stop serving or posting the image: it is
  // logged, and the next touch of this media id tries again.
  async function settleMove(mediaId, idx) {
    if (!(idx.fields === 0 || idx.record === "filed")) return "kept: generation data not filed";
    try {
      return await moveSource(mediaId, idx.raw_md5);
    } catch (err) {
      log(`[canon] ${mediaId}: move NOT done (${err.message}); retried on the next touch`);
      return "move failed";
    }
  }

  // SYNAPSE'S THUMBNAILS are the one set of renditions every surface uses, and
  // Synapse renders them with Pillow, which carries a JPEG's COMMENT segment
  // into the thumbnail (Image.resize keeps .info, and the JPEG writer saves
  // info["comment"]). EXIF, ICC and PNG text are not carried. So a rendition can
  // still hold a prompt; each is stripped where it stands, the stripped bytes
  // replace it under the same key -- the gate finds renditions by name -- and
  // what it replaced is moved to superseded/ first. Never a second file.
  async function stripThumbnails(mediaId) {
    if (typeof store.list !== "function") return { checked: 0, replaced: 0 };
    let checked = 0;
    let replaced = 0;
    for (const key of await store.list(keys.thumbnails(mediaId))) {
      checked += 1;
      const body = await store.get(key);
      const format = sniff(body);
      if (!format) continue;
      let clean;
      try {
        clean = stripGeneration(body, format.type);
      } catch (err) {
        log(`[canon] ${mediaId}: thumbnail ${key} not checked (${err.message}); left as it is`);
        continue;
      }
      if (!clean.changed) continue;
      const aside = `superseded/${key}`;
      if (!(await store.head(aside))) await store.copy(key, aside);
      const kept = await store.head(aside);
      if (!kept || kept.size !== body.length) {
        log(`[canon] ${mediaId}: thumbnail ${key} NOT replaced -- its copy in superseded/ did not verify`);
        continue;
      }
      await store.put(key, clean.buffer, format.type);
      replaced += 1;
    }
    return { checked, replaced };
  }

  // File what was stripped. "filed" is the only outcome that lets the original
  // move; every 409 means THIS text is not on record under this md5, so the
  // original -- the only other place it exists -- stays where it is.
  async function file(mediaId, md5, rawMd5, poster, fields) {
    try {
      await booru.recordGenerationMetadata(md5, { rawMd5, source: "matrix", poster, fields });
      return "filed";
    } catch (err) {
      if (err && err.status === 409) {
        const reason = err.reason || "409";
        if (reason === "raw_md5_conflict") {
          log(`[canon] ${mediaId}: NOT filed under ${md5} -- these raw bytes are already filed under a DIFFERENT md5. Fix: GET /fourier/generation_metadata/raw/${rawMd5}.json names it; reconcile the two on the booru.`);
        } else if (reason === "raw_md5_mismatch") {
          log(`[canon] ${mediaId}: the record for ${md5} names a different raw md5; its fields were NOT replaced. Fix: compare the two originals.`);
        } else {
          log(`[canon] ${mediaId}: the booru keeps the record it already has for ${md5} (${reason}); this upload's text stays in its original, which is not moved`);
        }
        return `conflict (${reason})`;
      }
      log(`[canon] ${mediaId}: generation data NOT filed (${err && err.message}); the original stays in place and it is retried on the next touch`);
      return "pending";
    }
  }

  // The raw original (while it exists) and what a strip takes from it now --
  // for creator tags and for a record still owed.
  async function rawAndRemoved(mediaId, mediaType) {
    const raw = await readRaw(mediaId);
    if (!raw) return { raw: null, removed: {}, confident: null };
    try {
      const again = stripGeneration(raw, mediaType);
      return { raw, removed: again.removed || {}, confident: again.confident === true };
    } catch {
      return { raw, removed: {}, confident: false };
    }
  }

  // An image already canonical. THE INDEX IS FINAL: it is never made canonical
  // again, because re-stripping under changed rules would give a different md5
  // and so a SECOND file for one image. What is still owed is settled -- a
  // pending record retried, an unfinished move finished -- and the caller gets
  // what it asked for.
  async function settleExisting(mediaId, existing, opts) {
    const dry = !!opts.dryRun;
    let read = null;
    let record = existing.record;
    if (!dry && existing.kind === "canonical" && existing.record === "pending") {
      read = await rawAndRemoved(mediaId, existing.media_type);
      if (read.raw && Object.keys(read.removed).length) {
        const outcome = await file(mediaId, existing.md5, existing.raw_md5, opts.poster || existing.uploader || null, read.removed);
        if (outcome !== "pending") {
          record = outcome;
          await writeIndex(mediaId, { ...existing, record });
        }
      }
    }
    const settledRecord = record;
    const moved = !dry && existing.kind === "canonical" ? await settleMove(mediaId, { ...existing, record: settledRecord }) : undefined;
    const idx = moved === undefined ? { ...existing, record: settledRecord } : { ...existing, record: settledRecord, moved };
    if (!opts.withBytes || idx.kind !== "canonical") return idx;
    const bytes = await store.get(idx.key);
    if (!bytes) {
      throw new CanonError(`the index for ${mediaId} names ${idx.key}, which is not in the bucket. Fix: inspect the bucket.`, { retryable: false });
    }
    // The removed text, for creator tags, comes from the raw original while it
    // still exists (superseded/ until the operator deletes it).
    const r = read || (await rawAndRemoved(mediaId, idx.media_type));
    return { ...idx, bytes, removed: r.removed, raw: r.raw, confident: r.confident === null ? idx.confident === true : r.confident };
  }

  /**
   * Make mediaId canonical. Returns the index entry, plus -- when asked with
   * {withBytes: true} -- the one file's bytes, the removed fields and the raw
   * original (when it still exists), which the tunnel needs to post the image
   * and derive creator tags.
   *
   * opts.dryRun: compute everything, write NOTHING (no put, no index, no
   * record, no move). opts.poster: who sent it, when the caller knows better
   * than the media record (the tunnel's event sender).
   */
  async function canonicalize(mediaId, opts = {}) {
    if (!MEDIA_ID.test(mediaId || "")) {
      throw new CanonError(`"${mediaId}" is not a media id. Fix: pass the id part of mxc://<server>/<id>.`, { status: 400, retryable: false });
    }
    const dry = !!opts.dryRun;

    const existing = await readIndex(mediaId);
    // A REFUSED image is not final: it is withheld until the stripper can
    // handle it, and every touch asks again, so it is served the day it can be.
    if (existing && existing.kind !== "refused") return settleExisting(mediaId, existing, opts);

    const info = await mediaInfo(mediaId);
    if (!info) throw new CanonError(`no local media ${mediaId} on this homeserver`, { status: 404, retryable: false });
    if (info.quarantined_by) throw new CanonError(`media ${mediaId} is quarantined; it is not served`, { status: 404, retryable: false });

    const raw = await readRaw(mediaId);
    if (!raw) {
      throw new CanonError(
        `the original of ${mediaId} is in neither ${keys.source(mediaId)} nor ${keys.superseded(mediaId)}. ` +
          "Fix: check the bucket; if the object is gone the image cannot be served.",
        { status: 404, retryable: false },
      );
    }
    const now = new Date().toISOString();

    // WHAT THE BYTES ARE decides, not what the upload claimed: an image sent as
    // application/octet-stream still has its prompt in it, and a PNG labelled
    // image/jpeg must not get a .jpg key the booru never writes.
    const format = sniff(raw);
    if (!format) {
      const idx = { kind: "source", key: keys.source(mediaId), media_type: info.media_type, at: now };
      if (!dry) await writeIndex(mediaId, idx);
      return idx;
    }

    const rawMd5 = md5hex(raw);
    let stripped;
    try {
      stripped = stripGeneration(raw, format.type);
    } catch (err) {
      const idx = { kind: "refused", reason: err.message, media_type: format.type, at: now };
      if (!dry) await writeIndex(mediaId, idx);
      log(`[canon] REFUSED ${mediaId}: ${err.message}`);
      return idx;
    }
    const fields = stripped.removed || {};
    const nFields = Object.keys(fields).length;

    // THE SAME RAW BYTES ALREADY HAVE A FILE -- uploaded before under another
    // media id, perhaps stripped under older rules. That file is this file.
    const prior = await readJson(keys.byRaw(rawMd5));
    let bytes;
    let md5;
    let key;
    if (prior && prior.key && prior.md5) {
      bytes = await store.get(prior.key);
      if (!bytes) throw new CanonError(`${keys.byRaw(rawMd5)} names ${prior.key}, which is not in the bucket. Fix: inspect the bucket.`, { retryable: false });
      ({ md5, key } = prior);
    } else {
      bytes = stripped.buffer;
      md5 = md5hex(bytes);
      key = keys.canonical(md5, format.ext);
    }

    const result = {
      kind: "canonical",
      key,
      md5,
      raw_md5: rawMd5,
      media_type: format.type,
      declared_type: info.media_type,
      stripped: md5 !== rawMd5,
      // A generator's own signal was among what was removed -- what earns the
      // public "ai-generated" tag, which a caption-shaped text alone does not.
      confident: stripped.confident === true,
      fields: nFields,
      uploader: info.user_id || null,
      at: now,
    };

    if (!dry) {
      if (!prior) {
        // The one file. Content-addressed: an object already at this key IS
        // these bytes (the booru's own upload of the same stripped image lands
        // here too).
        const there = await store.head(key);
        if (!there) {
          const etag = await store.put(key, bytes, format.type);
          if (etag && etag !== md5) {
            throw new CanonError(`R2 stored ${key} with etag ${etag}, not its md5 ${md5}. Nothing else was written. Fix: rerun; if it repeats, inspect the object.`);
          }
        } else if (there.size !== bytes.length) {
          throw new CanonError(
            `${key} already holds ${there.size} bytes, but these bytes are ${bytes.length}: a content-addressed key with the wrong content. ` +
              "Nothing was written. Fix: inspect the object -- something wrote to this key that is not its md5.",
            { retryable: false },
          );
        }
      }
      if (!(await store.head(keys.byMd5(md5)))) {
        await store.put(keys.byMd5(md5), Buffer.from(JSON.stringify({ mxc_media_id: mediaId, key })), "application/json");
      }
      if (!(await store.head(keys.byRaw(rawMd5)))) {
        await store.put(keys.byRaw(rawMd5), Buffer.from(JSON.stringify({ key, md5 })), "application/json");
      }

      // One source of metadata: the private store, BEFORE the raw original moves.
      if (nFields > 0) result.record = await file(mediaId, md5, rawMd5, opts.poster || info.user_id || null, fields);

      await writeIndex(mediaId, result);
      result.moved = await settleMove(mediaId, result);
      try {
        result.thumbnails = await stripThumbnails(mediaId);
      } catch (err) {
        log(`[canon] ${mediaId}: thumbnails not checked (${err.message})`);
      }
    }

    if (opts.withBytes) return { ...result, bytes, removed: fields, raw };
    return result;
  }

  // The media gate and the tunnel's own handler can ask about the same image at
  // the same moment, in this one process. One run per media id at a time; a
  // caller that arrives mid-run waits for it and then reads what it wrote.
  const inflight = new Map();
  async function canonicalizeOnce(mediaId, opts = {}) {
    const running = inflight.get(mediaId);
    if (running) {
      await running.catch(() => {});
      return canonicalize(mediaId, opts);
    }
    const p = canonicalize(mediaId, opts).finally(() => inflight.delete(mediaId));
    inflight.set(mediaId, p);
    return p;
  }

  return { canonicalize: canonicalizeOnce, readIndex, moveSource, keys };
}

// The uploader and type of a local media id, from Synapse's admin API
// (QueryMediaById). Null for an id Synapse does not know.
function synapseMediaInfo({ axios, homeserverUrl, domain, adminToken }) {
  if (!adminToken) {
    throw new Error("canon: homeserver.admin_token is not set in config.yaml. Fix: add it -- canon asks Synapse who uploaded each image.");
  }
  return async (mediaId) => {
    const url = `${homeserverUrl}/_synapse/admin/v1/media/${encodeURIComponent(domain)}/${encodeURIComponent(mediaId)}`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status === 404) return null;
    // QueryMediaById answers { media_info: {...} } -- measured against this
    // homeserver 2026-09-30 (Synapse 1.152.1). A reply without it is refused
    // loudly: read as "no media type", every image would pass as not-an-image.
    const info = resp.status === 200 && resp.data && resp.data.media_info;
    if (!info || typeof info !== "object" || typeof info.media_type !== "string") {
      throw new CanonError(`Synapse media info for ${mediaId} answered ${resp.status} without media_info.media_type`);
    }
    return info;
  };
}

module.exports = { createCanon, r2FromEnv, r2Store, synapseMediaInfo, CanonError, IMAGE_EXT, shard, keys, md5hex, sniff };
