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
//
// HOW FAR IT GOT IS KEPT. Each room's progress -- the cursor to resume from,
// whether the start was reached, the pictures that failed -- is persisted by
// index.js in backfill-state.js, so a run continues where the last one stopped
// instead of starting at the live edge again. planWalk decides what a run does
// and nextState what it leaves behind; both are pure and tested here.

// Pictures per room, per run. Small on purpose: every image is a download, a
// hash, possibly an upload, and a state event, and a room with thousands would
// otherwise become one unbounded burst against Synapse and the booru.
const DEFAULT_CAP = 500;

// Pages of history to walk PER RUN, so a room that keeps handing back a
// pagination token can never spin forever. A run that spends this budget stops
// with a CURSOR, and the next run resumes from it (backfill-state.js): the
// budget bounds one run's burst, not how far back a room can ever be read.
// Until 2026-10-01 it did both -- every run started at the live edge, so a
// room deeper than 40 pages was unreachable past that line forever, and the
// summary read exactly like a finished room while 38 pictures in 8 rooms sat
// unposted beyond it.
const MAX_PAGES = 40;

// A picture that failed this many runs in a row stops being retried by the
// sweep. It is kept in the state file under `abandoned`, with its last error,
// rather than retried every ten minutes for ever; `!backfill restart` walks it
// again on purpose.
const MAX_ATTEMPTS = 5;

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
 * homeserver: `fetchPage(from, to)` resolves a /messages page
 * { chunk, start, end }, `fetchEvent(eventId)` resolves one event (only needed
 * when `retry` is non-empty), and `onImage(event)` does whatever the live path
 * does.
 *
 * WHERE IT STARTS AND WHERE IT STOPS ARE BOTH REPORTED. `from` resumes a walk
 * at a cursor an earlier run returned; omitted, the walk starts at the live
 * edge and `head` reports where that edge was (the first page's `start`).
 * `to` stops the walk at an earlier run's head -- the gap a rejoin leaves.
 * The result's `cursor` is where the NEXT run should resume, and `reachedStart`
 * is true ONLY when the homeserver said there was nothing older (no `end`):
 * the room's real beginning, or the history_visibility wall the bot may not
 * read past. Running out of pages, hitting the cap, a token that will not move
 * and an error are all reachedStart=false -- the room is NOT finished, and the
 * summary says so.
 *
 * `retry` is a list of { eventId, url, attempts } from earlier runs. Each is
 * re-read (so a picture deleted since is dropped, never posted) and replayed
 * before the walk.
 *
 * Never throws for one bad picture. A single undecodable image must not stop
 * the other seventy-one, so failures are counted, logged, and returned in
 * `failures` (with the event id that lets a later run retry them) and
 * `failedMediaIds`.
 *
 * Never throws for a homeserver error mid-walk either: the pages already
 * walked are progress worth keeping, so the error is returned in `error` with
 * the cursor of the page that failed.
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
async function backfillRoom({
  roomId, fetchPage, onImage, cap = DEFAULT_CAP, log,
  from: start, to, retry = [], fetchEvent, maxPages = MAX_PAGES,
}) {
  if (typeof log !== "function") {
    throw new TypeError("backfillRoom requires log(): a failure nobody can read is not a report");
  }
  if (retry.length && typeof fetchEvent !== "function") {
    throw new TypeError("backfillRoom was handed failures to retry but no fetchEvent() to re-read them with");
  }
  let from = start || undefined;
  let seen = 0, done = 0, blocked = 0, refused = 0, failed = 0, pages = 0, retried = 0;
  let reachedStart = false, stalled = false, head, error;
  const failures = [];
  const dropped = [];
  const started = Date.now();
  const handled = () => done + blocked + refused + failed;
  const full = () => handled() >= cap;

  const replay = async (ev, attempts) => {
    try {
      const outcome = await onImage(ev);
      if (outcome === "tags-blocked") blocked++;
      // Generation data that would not strip: the picture was NOT posted
      // (image-plan.js). Counting it as done would say it was.
      else if (outcome === "strip-refused") refused++;
      else done++;
    } catch (err) {
      failed++;
      failures.push({ eventId: ev.event_id, url: ev.content.url, attempts: attempts + 1, error: err.message });
      log(`[backfill] ${roomId} ${ev.content.url}: ${err.message}`);
    }
  };

  // Earlier failures first: they are the oldest debt.
  for (const f of retry) {
    if (full()) { failures.push(f); continue; }           // carried, not lost
    let ev;
    try {
      ev = await fetchEvent(f.eventId);
    } catch (err) {
      failures.push({ ...f, error: `could not re-read the event: ${err.message}` });
      log(`[backfill] ${roomId} ${f.url}: could not re-read ${f.eventId} to retry it: ${err.message}`);
      continue;
    }
    const [image] = imagesIn(ev ? [ev] : []);
    if (!image) {
      // Redacted, or no longer readable. Posting it from what we remembered
      // would publish a picture its sender took back.
      dropped.push(f);
      log(`[backfill] ${roomId} ${f.url}: ${f.eventId} is no longer an image event (redacted or gone); not retried`);
      continue;
    }
    retried++;
    await replay(image, f.attempts || 0);
  }

  while (pages < maxPages && !full()) {
    let page;
    try {
      page = await fetchPage(from, to);
    } catch (err) {
      error = err.message;
      log(`[backfill] ${roomId}: history page ${pages + 1} failed: ${err.message}; ${pages} page(s) were walked and are kept`);
      break;
    }
    pages++;
    if (pages === 1 && !start && page && page.start) head = page.start;
    const images = imagesIn(page && page.chunk);
    seen += images.length;

    let partial = false;
    for (let i = 0; i < images.length; i++) {
      if (full()) { partial = true; break; }
      await replay(images[i], 0);
    }
    // Stopped part-way through a page: the cursor stays at the page's own
    // start, so the next run re-reads it and picks up the rest. The part
    // already done is replayed as a no-op at the booru, which is the cheap
    // side of the trade; skipping to page.end would lose pictures.
    if (partial) break;

    // No token is the homeserver saying there is nothing older -- including
    // the case where history_visibility stops us early.
    if (!page || !page.end) { reachedStart = true; break; }
    // A token that does not move is NOT the start of the room; it is a
    // homeserver that will not page. Stop rather than spin, and say so.
    if (page.end === from) { stalled = true; break; }
    from = page.end;
  }

  return {
    roomId, seen, done, blocked, refused, failed, retried, pages,
    capped: full(),
    cursor: from, reachedStart, stalled, head, error,
    failedMediaIds: failures.map((f) => f.url),
    failures, dropped,
    ms: Date.now() - started,
  };
}

/**
 * What a run should do, given what earlier runs left behind. Pure.
 *
 *   saved    the room's record from backfill-state.js, or undefined
 *   trigger  "join"    the bot's membership event, a profile change included
 *            "rejoin"  a join whose previous membership was not join
 *            "command" an admin's !backfill
 *            "sweep"   the periodic sweep
 *   restart  walk again from the live edge whatever was done before
 *
 * Returns { kind, from, to }, kind one of initial | resume | gap | retry | skip.
 * A room whose walk reached its start is SKIPPED by the automatic triggers --
 * replaying it is a no-op at the booru but a download per picture -- unless a
 * failed picture is owed a retry.
 */
function planWalk(saved, { trigger, restart = false } = {}) {
  const initial = { kind: "initial", from: undefined, to: undefined };
  if (restart) return initial;
  const walked = saved && (saved.reachedStart || saved.cursor || saved.head);
  if (!walked) return initial;
  const owed = retryable(saved).length > 0;
  const resume = { kind: "resume", from: saved.cursor, to: undefined };
  const retry = { kind: "retry", from: undefined, to: undefined };
  const skip = { kind: "skip", from: undefined, to: undefined };

  if (trigger === "command") {
    // An explicit ask overrides "already done": a finished room is walked
    // again from the live edge, which is how a room whose tag writes were
    // blocked gets them written once the power level is granted.
    return saved.reachedStart ? initial : resume;
  }
  if (trigger === "rejoin" && saved.head) {
    // The bot was away. Walk from the live edge back to where the last walk
    // began, and no further; the older side keeps its own cursor.
    return { kind: "gap", from: undefined, to: saved.head };
  }
  if (!saved.reachedStart) return resume;
  return owed ? retry : skip;
}

/** The failures a later run should retry: re-readable, not yet given up on. */
function retryable(saved) {
  return ((saved && saved.failed) || []).filter((f) => f && f.eventId && (f.attempts || 0) < MAX_ATTEMPTS);
}

/**
 * The room's record after a run. Pure. Progress only moves forward: a gap walk
 * never touches the older side's cursor, a resume never touches the head, and
 * a run that failed before its first page leaves both where they were.
 */
function nextState(saved, plan, result, now = Date.now()) {
  const prev = saved || {};
  const rec = { ...prev, lastRunAt: now, lastKind: plan.kind };

  if (plan.kind === "initial") {
    if (result.pages > 0) {
      rec.head = result.head || prev.head;
      rec.cursor = result.cursor;
      rec.reachedStart = result.reachedStart;
    }
  } else if (plan.kind === "resume") {
    if (result.pages > 0) {
      rec.cursor = result.cursor;
      rec.reachedStart = result.reachedStart;
    }
  } else if (plan.kind === "gap") {
    if (result.reachedStart && result.head) rec.head = result.head;
  }
  if (rec.reachedStart === undefined) rec.reachedStart = false;

  // Every retried failure came back through result.failures (still failing),
  // result.dropped (gone) or the counters (now done). So the result's list
  // REPLACES the retryable part; the abandoned part is kept as it was.
  const byEvent = new Map();
  for (const f of result.failures || []) {
    const key = f.eventId || f.url;
    const had = byEvent.get(key);
    if (!had || (f.attempts || 0) > (had.attempts || 0)) byEvent.set(key, f);
  }
  const failed = [], abandoned = [...(prev.abandoned || [])];
  for (const f of byEvent.values()) {
    if (f.eventId && (f.attempts || 0) >= MAX_ATTEMPTS) abandoned.push(f);
    else failed.push(f);
  }
  rec.failed = failed;
  if (abandoned.length) rec.abandoned = abandoned;
  if (result.error) rec.lastError = result.error;
  else delete rec.lastError;
  return rec;
}

/** One line an operator can read without decoding it. */
function summarise(r) {
  const bits = [`${r.done} done`];
  if (r.retried) bits.push(`${r.retried} earlier failure(s) retried`);
  if (r.blocked) bits.push(`${r.blocked} posted but tag state blocked`);
  if (r.refused) bits.push(`${r.refused} NOT posted: generation data would not strip (see the [strip] lines)`);
  if (r.failed) bits.push(`${r.failed} failed (retried on the next run)`);
  if (r.capped) bits.push(`stopped at the cap`);
  let tail = "";
  if (r.kind === "gap") {
    tail = r.reachedStart
      ? "; caught up to where the last walk began"
      : "; the gap since the last walk is NOT fully walked (!backfill restart walks it)";
  } else if (r.kind === "retry") {
    tail = "";
  } else if (r.reachedStart === true) {
    tail = "; reached the start of the room (or the furthest back the bot may read)";
  } else if (r.reachedStart === false) {
    const why = r.error ? `stopped by an error: ${r.error}`
      : r.stalled ? "the homeserver's pagination token stopped moving"
        : r.capped ? "this run's picture cap was reached"
          : `this run's ${r.pages}-page budget was spent`;
    tail = `; OLDER HISTORY NOT YET WALKED (${why}) -- the sweep resumes it, or !backfill`;
  }
  return `[backfill] ${r.roomId}: ${r.seen} image(s) found, ${bits.join(", ")} in ${Math.round(r.ms / 1000)}s${tail}`;
}

module.exports = {
  backfillRoom, imagesIn, summarise, planWalk, nextState, retryable,
  DEFAULT_CAP, MAX_PAGES, MAX_ATTEMPTS,
};
