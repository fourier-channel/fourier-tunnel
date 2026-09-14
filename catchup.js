// Catch a room up on images its bridge bot was never allowed to see.
//
// WHY THIS EXISTS. A room created with history_visibility "invited" seals every
// event sent before a member's invite. Measured on !sGgpJmdKujiollvviD on
// 2026-09-13: the room ran "invited" from 21 June to 29 June, the bot was
// invited on 13 September, and so 154 of its 420 images -- including all 71 in
// threads -- are permanently unreadable to it. /messages omits them, /event
// answers 404, /relations answers 403. No power level fixes this and no bigger
// page cap reaches it: the bot is not refused a PERMISSION, it is refused a
// PAST.
//
// The server itself has no such horizon. Synapse's admin Room Messages API
// reads a room as the homeserver rather than as a member, so it returns all 420.
// This module walks with that reader and hands each image to the ordinary
// pipeline, which still writes the tag state AS THE BOT -- admin for discovery,
// the bot for the write, and the bot's own power level still governs what it may
// say in the room.
//
// It is deliberately POINTABLE rather than a one-off for that room: any room
// whose bot was invited after the fact has the same sealed window, and this is
// the catch-up for all of them.
//
// Dependencies are injected for the same reason backfill.js injects them: the
// paging and the accounting are testable without a homeserver, and the thing
// that talks to Synapse is the only part that needs one.

"use strict";

/** Images in a page, oldest first, exactly as the live walk orders them. */
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
    .reverse();
}

/**
 * Walk a room with the ADMIN reader and replay every image through `onImage`.
 *
 * `adminPage(from)` and `botPage(from)` both resolve { chunk, end }. The bot
 * reader is optional and is used for one thing only: counting how much of the
 * room it is refused, so the report can state the gap instead of implying the
 * room is now complete. That number is the whole reason anyone runs this.
 *
 * `log` is REQUIRED, for the reason backfill.js now requires it: a failure
 * counted and then discarded is not a report. 266 images once failed with no
 * reason recorded anywhere because that argument had a silent default.
 */
async function catchUpRoom({ roomId, adminPage, botPage = null, onImage, cap = 2000, maxPages = 200, log }) {
  if (typeof log !== "function") {
    throw new TypeError("catchUpRoom requires log(): a failure nobody can read is not a report");
  }
  if (typeof adminPage !== "function") {
    throw new TypeError("catchUpRoom requires adminPage(): without it this is just the walk that already failed");
  }

  const started = Date.now();
  const adminUrls = new Set();
  let seen = 0, done = 0, blocked = 0, failed = 0, skipped = 0, pages = 0;
  let unfetchable = 0;
  // Which homeservers hold bytes we are never allowed to fetch. Named, because
  // "59 failed" invites a rerun and "59 live on matrix.org, which federation
  // denies" tells the operator the only thing that would actually change it.
  const unfetchableFrom = new Set();
  let truncated = false;

  let from;
  while (pages < maxPages) {
    const page = await adminPage(from);
    pages++;
    const images = imagesIn(page && page.chunk);
    for (const ev of images) {
      const url = ev.content.url;
      // One picture, once, however many times it was posted. The state key is
      // the mxc url, so a repeat would rewrite the same key with the same body.
      if (adminUrls.has(url)) { skipped++; continue; }
      adminUrls.add(url);
      seen++;
      if (done + blocked + failed >= cap) { truncated = true; break; }
      try {
        const outcome = await onImage(ev);
        if (outcome === "tags-blocked") blocked++;
        // A PERMANENT REFUSAL IS NOT A FAILURE. Its bytes are on a homeserver
        // we are not allowed to talk to, so every future run fails identically.
        // Counting it as "failed" says try again, which is false.
        else if (outcome === "unfetchable") {
          unfetchable++;
          const m = /^mxc:\/\/([^/]+)\//.exec(url);
          if (m) unfetchableFrom.add(m[1]);
        } else done++;
      } catch (err) {
        failed++;
        log(`[catchup] ${roomId} ${url}: ${err.message}`);
      }
    }
    if (truncated) break;
    if (!page || !page.end || page.end === from) break;
    from = page.end;
  }
  // A page cap reached is NOT the end of the room, and saying "found N" without
  // saying so reads as completeness. backfill.js could not distinguish these
  // and under-reported a large room silently.
  if (pages >= maxPages) truncated = true;

  // What the BOT can see, for contrast. Counted, never acted on.
  let botVisible = null;
  if (botPage) {
    botVisible = 0;
    const seenByBot = new Set();
    let f;
    for (let p = 0; p < maxPages; p++) {
      let page;
      try {
        page = await botPage(f);
      } catch (err) {
        log(`[catchup] ${roomId}: bot reader failed, gap unknown: ${err.message}`);
        botVisible = null;
        break;
      }
      for (const ev of imagesIn(page && page.chunk)) seenByBot.add(ev.content.url);
      if (!page || !page.end || page.end === f) break;
      f = page.end;
    }
    if (botVisible !== null) botVisible = seenByBot.size;
  }

  return {
    roomId, seen, done, blocked, failed, skipped, pages, truncated,
    unfetchable, unfetchableFrom: [...unfetchableFrom].sort(),
    botVisible,
    sealed: botVisible === null ? null : seen - botVisible,
    ms: Date.now() - started,
  };
}

/**
 * One line an operator can read without decoding it.
 *
 * `dryRun` changes the WORD, not the number: a planned image and a posted one
 * are not the same fact and must not print the same way. Saying "419 done"
 * about a run that did nothing is the same lie as saying "0 done" about a run
 * that posted 266, which is what sent this tool to be written in the first
 * place.
 */
function summarise(r, { dryRun = false } = {}) {
  const bits = [`${r.done} ${dryRun ? "to process" : "done"}`];
  if (r.blocked) bits.push(`${r.blocked} posted but tag state blocked`);
  if (r.unfetchable) bits.push(`${r.unfetchable} unfetchable`);
  if (r.failed) bits.push(`${r.failed} failed`);
  if (r.skipped) bits.push(`${r.skipped} repeat(s) of the same picture`);
  if (r.truncated) bits.push(`STOPPED EARLY -- there is more room than this run walked`);
  let line = `[catchup] ${r.roomId}: ${r.seen} image(s) the server can see, ${bits.join(", ")} in ${Math.round(r.ms / 1000)}s`;
  if (r.sealed === null) {
    line += "\n  the bot's own view could not be read, so the sealed count is unknown";
  } else if (r.sealed > 0) {
    line += `\n  ${r.sealed} of them are sealed to the bot by history_visibility -- it can see ${r.botVisible}. ` +
            `Those are the ones no amount of power level or paging would ever have reached.`;
  } else {
    line += "\n  the bot could see all of these itself; nothing here was sealed to it";
  }
  if (r.unfetchable) {
    line += `\n  ${r.unfetchable} cannot be fetched at all: their bytes live on ` +
            `${(r.unfetchableFrom || []).join(", ") || "another homeserver"} and federation is denied. ` +
            "Rerunning will never reach these -- only allowing federation with that server would.";
  }
  return line;
}

module.exports = { catchUpRoom, imagesIn, summarise };
