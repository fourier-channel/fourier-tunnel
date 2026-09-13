"use strict";

// Catch up a room the bot has just entered.
//
// The bot only ever saw images posted while it was watching. A room it is
// invited into today has a history it never processed, so those pictures are in
// no booru and their rooms carry no tag state. This walks the timeline
// backwards and replays each image event through the SAME handler the live path
// uses, which is what makes it safe to run more than once: that handler already
// checks the booru by md5, skips the upload when the image is known, and just
// points the room's tag state at the existing post. A second backfill is
// therefore wasted work rather than duplicate posts.
//
// What it CANNOT do is see further back than the room lets it. Two of this
// server's rooms are history_visibility "invited", where the bot's own invite
// is the earliest thing it may read. That is a room setting and not something
// to work around; the caller is told how far it got.

// Pictures per room, per run. Small on purpose: every image is a download, a
// hash, possibly an upload, and a state event, and a room with thousands would
// otherwise become one unbounded burst against Synapse and the booru.
const DEFAULT_CAP = 500;

// Pages of history to walk before giving up, so a room that keeps handing back
// a pagination token can never spin forever.
const MAX_PAGES = 40;

/** The image events in one /messages chunk, oldest first. */
function imagesIn(chunk) {
  return (chunk || [])
    .filter(
      (e) =>
        e &&
        e.type === "m.room.message" &&
        e.content &&
        e.content.msgtype === "m.image" &&
        typeof e.content.url === "string" &&
        e.content.url.startsWith("mxc://"),
    )
    .reverse(); // dir=b hands back newest-first; post them in the order they were sent
}

/**
 * Walk a room's history and replay its images.
 *
 * Dependencies are injected so the paging logic can be tested without a
 * homeserver: `fetchPage(from)` resolves { chunk, end }, and `onImage(event)`
 * does whatever the live path does.
 *
 * Never throws for one bad picture. A single undecodable image must not stop
 * the other seventy-one, so failures are counted and reported.
 *
 * THREE OUTCOMES, NOT TWO. `onImage` may resolve with "tags-blocked" to say the
 * picture reached the booru but the room's tag state could not be written --
 * recoverable by re-running once the power level is granted, and not the same
 * fact as a failure. Counting it as failed is what made a working run of 266
 * images report "0 done, 266 failed" on 2026-09-13.
 *
 * `log` IS REQUIRED. It defaulted to a no-op and the only caller never passed
 * one, so every per-image error was counted and then discarded -- 266 failures
 * with no reason recorded anywhere. A silent default is the shape the operator
 * ruled against the same day: a fallback that hides the issue is worse than the
 * issue. Omitting it is now a TypeError at the call site.
 */
async function backfillRoom({ roomId, fetchPage, onImage, cap = DEFAULT_CAP, log }) {
  if (typeof log !== "function") {
    throw new TypeError("backfillRoom requires log(): a failure nobody can read is not a report");
  }
  let from;
  let seen = 0, done = 0, blocked = 0, failed = 0, pages = 0;
  const started = Date.now();

  while (pages < MAX_PAGES && done + blocked + failed < cap) {
    const page = await fetchPage(from);
    pages++;
    const images = imagesIn(page && page.chunk);
    seen += images.length;

    for (const ev of images) {
      if (done + blocked + failed >= cap) break;
      try {
        const outcome = await onImage(ev);
        if (outcome === "tags-blocked") blocked++;
        else done++;
      } catch (err) {
        failed++;
        log(`[backfill] ${roomId} ${ev.content.url}: ${err.message}`);
      }
    }

    // No token, or a token that does not move, means the room has no more to
    // give -- including the case where history_visibility stops us early.
    if (!page || !page.end || page.end === from) break;
    from = page.end;
  }

  return { roomId, seen, done, blocked, failed, pages, capped: done + blocked + failed >= cap, ms: Date.now() - started };
}

/** One line an operator can read without decoding it. */
function summarise(r) {
  const bits = [`${r.done} done`];
  if (r.blocked) bits.push(`${r.blocked} posted but tag state blocked`);
  if (r.failed) bits.push(`${r.failed} failed`);
  if (r.capped) bits.push(`stopped at the cap`);
  return `[backfill] ${r.roomId}: ${r.seen} image(s) found, ${bits.join(", ")} in ${Math.round(r.ms / 1000)}s`;
}

module.exports = { backfillRoom, imagesIn, summarise, DEFAULT_CAP, MAX_PAGES };
