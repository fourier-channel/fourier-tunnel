"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// DELIVERING TO THE ARCHIVE, instead of going around it.
//
// Tonneru-chan -- tonneru, the Japanese rendering of "tunnel" -- is the transport
// between disparate systems. Operator, 2026-09-21: "Her job is to get the data
// back and forth between disparate systems." Matrix is simply the first system
// she was pointed at.
//
// Until now her path went Matrix event -> autotagger -> danbooru.js
// createUploadFromBytes -> the booru owns it. That path works, and it goes
// AROUND the archive: every Matrix-sourced object has no manifest row, no
// sighting, no R2 confirmation record, no jail check at post time, no custody
// bucket and no purge path, because fourier-sampling's sweeps are all rooted on
// a manifest she never writes to.
//
// This module is the other end of that. It publishes an entry into a drop
// directory that fourier-sampling's drain reads. D-cac078's ruled shape: "The
// queue itself is a DIRECTORY, not a protocol, with bytes copied in and the
// original path kept only as provenance -- transport-agnostic."
//
// A tunnel delivers to a boundary; it does not own what is past it. That is
// exactly why this works despite her being a node:20-slim container that cannot
// import a line of fourier-sampling's TypeScript: writing a file into a
// bind-mounted directory needs one mount and a uid, not a package boundary.
//
// WHAT THIS DELIBERATELY DOES NOT SEND. No md5, no file size, no board, no
// tim, no width or height. The drain derives every one of those from the bytes
// it is holding. fourier-sampling's ingestObject takes THREE independent md5
// values and cross-checks none of them, so a digest sent from here would be
// trusted for all three -- and a stale or truncated one would decouple the
// bytes from every record that describes them, surfacing only much later when
// the uploader re-digested the file and disagreed with R2. Sending nothing it
// can compute makes that class of bug unwritable rather than merely unlikely.
//
// THE SCHEMA VERSION IS LOAD-BEARING. This repo is a container and the drain is
// a host process; they ship separately and WILL be at different versions. The
// drain parks an entry whose version it does not know, with that as the reason,
// rather than guessing at the shape or skipping it quietly -- a skipped entry
// and an empty queue look identical. Bump this only when a field's MEANING
// changes; adding an optional field does not.
//
// Canon for the schema is fourier-sampling/src/drop/types.ts. If the two ever
// disagree, that file wins and this one is the copy that drifted.
const DROP_SCHEMA_VERSION = 1;

// Mirrors fourier-sampling's ALLOWED_EXT. A set that drifts wider here than
// there would produce entries the drain parks, one per image, forever -- so the
// check happens on THIS side too, where it can refuse before writing bytes.
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webm", ".webp", ".mp4", ".pdf", ".swf"]);

/**
 * The one place an untrusted filename's extension becomes a canonical one.
 *
 * Case only. fourier-sampling learned this the hard way on 2026-09-21: its
 * content check lowercased while its path guard did not, so ".JPG" passed one
 * and threw out of the other. 4chan never exposed it because its API emits
 * lowercase; a Matrix upload or a Discord attachment is named by whatever
 * device wrote it, and ".JPG" is entirely ordinary.
 */
function normalizeExt(ext) {
  return String(ext || "").toLowerCase();
}

/** The extension for a filename, canonical, or null if it is not one we carry. */
function extFor(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  if (dot < 0) return null;
  const ext = normalizeExt(filename.slice(dot));
  return ALLOWED_EXT.has(ext) ? ext : null;
}

/**
 * Where a source's queue lives, derived the SAME WAY the drain derives it.
 *
 * `spoolRoot` is the spool, and the "_drop" segment is added here rather than
 * baked into a mount path. The first version took the queue root directly and
 * joined only the source, so this side built <root>/<source> while
 * fourier-sampling built <spool>/_drop/<source>. Both are correct in isolation;
 * together they are an undocumented convention that a mount can satisfy while
 * pointing somewhere else entirely -- tunnel writing happily, the drain
 * reporting "waiting 0", and nothing archived. An adversarial review found it,
 * and dropPathsAgree() below is the test that keeps the two in step.
 */
function dropPaths(spoolRoot, source) {
  if (!/^[a-z0-9-]{1,32}$/.test(source)) {
    throw new Error(
      `refusing a drop source named ${JSON.stringify(source)}: it must match /^[a-z0-9-]{1,32}$/. ` +
      "A source name becomes a path segment and free text must never build a path.",
    );
  }
  const base = path.join(spoolRoot, "_drop", source);
  return {
    root: base,
    staging: path.join(base, "staging"),
    ready: path.join(base, "ready"),
    failed: path.join(base, "failed"),
  };
}

/**
 * Build the sidecar for one attachment.
 *
 * Returns { ok: true, sidecar } or { ok: false, reason } -- never throws for
 * bad input, because one unusable image must not abort a room's backfill. The
 * reason is meant to be logged and is written to name what the caller should
 * fix.
 */
function buildSidecar(input) {
  const {
    source, namespace, containerRef, messageRef, attachmentRef,
    filename, author, authorRef, postedAt, permalink,
  } = input || {};

  for (const [k, v] of Object.entries({ source, namespace, containerRef, messageRef, filename })) {
    if (typeof v !== "string" || v.length === 0) return { ok: false, reason: `${k} is missing or not a non-empty string` };
  }
  if (!/^[a-z0-9]{1,10}$/.test(namespace)) {
    return { ok: false, reason: `namespace ${JSON.stringify(namespace)} must match /^[a-z0-9]{1,10}$/ -- the drain builds a directory from it` };
  }
  const ext = extFor(filename);
  if (ext === null) {
    return {
      ok: false,
      reason:
        `${JSON.stringify(filename)} has no extension this pipeline carries. Allowed: ` +
        `${[...ALLOWED_EXT].join(" ")}. Widening that set is a deliberate change on BOTH sides -- ` +
        "every member becomes an end-to-end obligation in fourier-sampling's tools/custody.ts.",
    };
  }
  const when = postedAt === undefined || postedAt === null ? null : new Date(postedAt);
  if (when === null || Number.isNaN(when.getTime())) {
    return { ok: false, reason: `postedAt ${JSON.stringify(postedAt)} is not a date. It drives tim and the archive's calendar, so it cannot be guessed here.` };
  }

  const sidecar = {
    v: DROP_SCHEMA_VERSION,
    source,
    namespace,
    container_ref: containerRef,
    message_ref: messageRef,
    filename,
    ext,
    posted_at: when.toISOString(),
  };
  // Optional, and OMITTED rather than sent empty: the drain checks required
  // fields for a non-empty string, so an empty one would be a validation
  // failure dressed as data.
  if (attachmentRef) sidecar.attachment_ref = String(attachmentRef);
  if (author) sidecar.author = String(author);
  if (authorRef) sidecar.author_ref = String(authorRef);
  if (permalink) sidecar.permalink = String(permalink);
  return { ok: true, sidecar };
}

/**
 * An entry id that is stable for one attachment.
 *
 * Stable so that re-delivering the same attachment -- a backfill re-run, a
 * restart mid-room -- replaces its own staged entry rather than queueing a
 * second copy. The drain is idempotent on replay, but a queue that grows a
 * duplicate per restart is still a queue filling a tmpfs.
 */
function entryId(messageRef, attachmentRef) {
  const raw = attachmentRef ? `${messageRef}-${attachmentRef}` : String(messageRef);
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_");
  return safe.slice(0, 64);
}

/**
 * PUBLISH one entry, atomically.
 *
 * Builds the whole entry under staging/ where nothing scans, then moves it into
 * ready/ with ONE rename. rename(2) within a filesystem is atomic, so the drain
 * sees the entry whole or not at all -- there is no half-built state for a scan
 * to trip over, and no suffix convention for a reader to remember.
 *
 * Returns { ok: true, id, dir } or { ok: false, reason }.
 */
async function publish(spoolRoot, sidecar, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, reason: "refusing to publish an entry with no bytes" };
  }
  const p = dropPaths(spoolRoot, sidecar.source);
  const id = entryId(sidecar.message_ref, sidecar.attachment_ref);
  const staged = path.join(p.staging, id);
  const live = path.join(p.ready, id);

  // IT DOES NOT CREATE THE QUEUE IT DELIVERS INTO.
  //
  // mkdir -p made a wrong root succeed perfectly: a queue appears, every
  // publish returns ok, and the drain -- looking at the real path -- reports
  // "waiting 0" and exits 0. Both halves green, zero objects archived. The
  // drain refuses to create what it drains for exactly this reason; the writer
  // has the same duty on its side, and its failure is worse because it looks
  // like success per image rather than once per pass.
  try {
    const st = await fs.stat(p.ready);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch {
    return {
      ok: false,
      reason:
        `no drop queue at ${p.ready}. This writer does NOT create it, because creating it on demand makes a ` +
        "wrong root indistinguishable from a working one -- entries land inside the container and vanish with " +
        "it while every publish reports success. Check the bind mount, and have fourier-sampling create the " +
        "queue with: node tools/drop-drain.ts --source " + sidecar.source + " --init",
    };
  }

  try {
    await fs.mkdir(p.staging, { recursive: true });
    await fs.rm(staged, { recursive: true, force: true });
    await fs.mkdir(staged, { recursive: true });
    await fs.writeFile(path.join(staged, "bytes"), bytes);
    await fs.writeFile(path.join(staged, "entry.json"), JSON.stringify(sidecar) + "\n");
    // THE PUBLISH. One operation.
    try {
      await fs.rename(staged, live);
    } catch (err) {
      // rename(2) refuses to replace a non-empty directory (ENOTEMPTY, or
      // EEXIST on some filesystems), so a re-delivery of an attachment already
      // queued lands here. That is not a failure: the entry is present and the
      // drain will take it. Removing the live one to make room would be worse
      // -- the drain may be reading it this instant, and an entry that vanishes
      // mid-read is the one state the atomic publish exists to prevent.
      //
      // Same message and same attachment means the same bytes, so "already
      // there" and "just written" are the same outcome.
      if (err && (err.code === "ENOTEMPTY" || err.code === "EEXIST")) {
        await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
        return { ok: true, id, dir: live, alreadyQueued: true };
      }
      throw err;
    }
    return { ok: true, id, dir: live, alreadyQueued: false };
  } catch (err) {
    // Clean up a half-built staging directory so it does not accumulate on a
    // tmpfs. Failing to clean up must not mask the original error.
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: `could not publish the entry: ${err && err.message ? err.message : String(err)}` };
  }
}

/**
 * Is the drop directory actually there?
 *
 * Called at startup rather than per image. The failure this exists for is a
 * bind mount that did not come up: without it, every publish would create a
 * fresh directory inside the CONTAINER, succeed, and deliver into a filesystem
 * that disappears when the container does -- entries written, nothing draining
 * them, and no error anywhere. fourier-sampling's drain refuses to create the
 * queue it drains for the same reason, from the same incident.
 */
async function mountLooksReal(spoolRoot) {
  const root = spoolRoot;
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return { ok: false, reason: `${root} exists but is not a directory` };
  } catch {
    return {
      ok: false,
      reason:
        `${root} does not exist. This is where entries are delivered for fourier-sampling to drain; ` +
        "if it is missing, the bind mount did not come up and every delivery would land inside the " +
        "container and vanish with it. Check the compose mount before enabling drop delivery.",
    };
  }
  const probe = path.join(root, ".writable-probe");
  try {
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
  } catch (err) {
    return { ok: false, reason: `${root} is not writable by this container's uid: ${err && err.code ? err.code : String(err)}` };
  }
  return { ok: true };
}

/**
 * The path construction, exported so a test can compare it with the drain's.
 *
 * Two repositories that must agree about a directory, shipped independently:
 * the same shape of problem the schema version guards, and it needs the same
 * kind of check rather than a comment on each side saying what it assumed.
 */
function relativeQueuePath(source) {
  return path.join("_drop", source, "ready");
}

module.exports = {
  relativeQueuePath,
  DROP_SCHEMA_VERSION,
  ALLOWED_EXT,
  normalizeExt,
  extFor,
  dropPaths,
  buildSidecar,
  entryId,
  publish,
  mountLooksReal,
};
