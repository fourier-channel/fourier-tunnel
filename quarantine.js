"use strict";

// THE BOORU'S QUARANTINE LIST, AND KEEPING ITS NAMES OUT OF EVERY ROOM.
//
// Operator rulings 2026-10-12 (memory flagged-tags-are-a-review-quarantine):
// an admin can FLAG any tag for review, and a flagged tag's name disappears
// everywhere at once, like a banished one; turning the flag off restores
// everything at once. For the tunnel that means: it never writes a flagged or
// banished name into a room's tag state, and on a flag or a release it
// rewrites the CURRENT state of every picture affected. Room timeline history
// keeps the earlier state events; the ruling asks for current state.
//
// WHERE THE LIST COMES FROM. One document, chanbooru GET
// /fourier_jail/release.json?quarantine=1, read as the tunnel's own account
// (danbooru.js getQuarantine): the names, and every post carrying one. Polled
// every 60 s; the last good read is kept in the state directory
// (quarantine.json) with the time it was read, what was last projected into
// the rooms, and any tag-state write held back while the list was unread.
//
// WHAT USES IT.
//  - index.js's two FALLBACK writes -- the booru's tag_string, or the tags the
//    tunnel posted with, used when the booru's stripped projection could not
//    be had -- drop every quarantined name. A list that is not fresh (read in
//    the last 30 minutes, the grace below) is read once on demand; if that fails NOTHING is
//    written: in the bridge the write is held here and made, stripped, on the
//    next good read. The booru's own projection needs no strip there
//    (chanbooru FourierTagSource.matrix_projection strips for every caller).
//  - reprojectQuarantine, when the generation moves: every post in the
//    previous list or the new one, found in every joined room by its mxc (the
//    room's state key) OR its post id (a re-post in another room has its own
//    mxc and the same post), rewritten from the booru's projection (for a
//    legacy post with no recorded provenance, its tag string) -- or, for a
//    post the booru hides from the tunnel (404: flagged, uploaded by another
//    bot), from the room's own state minus the names. The whole union, not
//    only the membership changes, so a post carrying two flagged names is
//    rewritten when one of them is released. Idempotent: a state that already
//    says it is not rewritten. LEAN (review 2026-10-12): when the NAMES did not
//    change, a post that stays in the list already has its stripped state, so
//    only the posts that joined or left are asked about -- otherwise a common
//    tag flagged made every new upload carrying it re-ask the booru for the
//    whole flagged set, every minute.
//  - parked pictures (index.js heldByTheBooru): a picture posted in a room
//    while the booru held its bytes under ANOTHER bot's FLAGGED post is
//    held-hidden -- no post, no state -- and nothing revisits a held-hidden
//    picture. A flag is a review, not a removal ("Turning the flag off
//    restores everything at once"), so such a picture is parked here and its
//    tag state written, stripped, once the post has left the list.
//
// FAIL CLOSED, AFTER A GRACE. An unreadable list is never an empty one:
// danbooru.js throws for every way of not finding out. STALE GRACE (operator
// ruling 2026-10-12): while the booru cannot be read, the LAST GOOD list keeps
// governing for 30 minutes -- logged at error level from the first failed
// read, and again when the grace runs out -- and a list older than that is not
// fresh, which blocks the fallbacks rather than letting them through. A tag
// flagged during an outage takes effect when the booru returns: the
// generation moves and the re-projection rewrites the rooms.

const fs = require("fs");
const { walkTagState } = require("./tag-state-walk");

const QUARANTINE_POLL_MS = 60 * 1000;
const QUARANTINE_FRESH_MS = 30 * 60 * 1000;
// An incomplete re-projection of the SAME generation is retried after this,
// not on every poll; a new generation is re-projected at once.
const QUARANTINE_RETRY_MS = 5 * 60 * 1000;
// Repeat an unchanged unreadable reason at most this often.
const QUARANTINE_NAG_MS = 10 * 60 * 1000;
// Synapse rate-limits state events (index.js BACKFILL_PACE_MS).
const QUARANTINE_PACE_MS = 750;
const HELD_MAX = 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every flagged and banished name in `doc`, as one Set. */
function quarantinedNames(doc) {
  return new Set([...((doc && doc.flagged) || []), ...((doc && doc.banished) || [])]);
}

/** Whether `doc` was read (or confirmed by a 304) within the 30-minute grace. */
function fresh(doc, now = Date.now()) {
  return Boolean(doc) && Number.isFinite(doc.checked_at) && now - doc.checked_at < QUARANTINE_FRESH_MS;
}

function stripNames(tags, names) {
  return (tags || []).filter((t) => !names.has(t));
}

function stripSources(sources, names) {
  if (!sources || typeof sources !== "object") return sources;
  return Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, Array.isArray(v) ? stripNames(v, names) : v]));
}

function carriesAny(content, names) {
  const inSources = Object.values((content && content.sources) || {}).some((v) => Array.isArray(v) && v.some((t) => names.has(t)));
  return inSources || ((content && content.tags) || []).some((t) => names.has(t));
}

const errcodeOf = (err) => (err && (err.errcode || (err.body && err.body.errcode))) || null;
const heldKey = (e) => `${e.roomId}\n${e.mxcUrl}`;

/**
 * The tunnel's copy of the list. `file()` names quarantine.json in the state
 * directory (state-dir.js statePath); it is read once, on first use.
 *
 * `service` is true in the bridge process, which polls: it alone writes the
 * file and holds fallback writes for the next good read. A tool driving the
 * pipeline in its own process (tools/catch-up-room.js) starts from the
 * service's saved list, reads the booru itself, and neither writes the file
 * nor holds -- two writers of one file would lose each other's holds.
 */
function createQuarantineWatch({ danbooru, file, now = Date.now, log = console, service = true }) {
  let loaded = false;
  let doc = null;        // the last good read, with etag and checked_at
  let projected = null;  // { generation, posts: [{ id, mxc }] } last projected into the rooms
  let held = [];         // tag-state writes held back while the list was unread
  let parked = [];       // pictures held hidden by a FLAGGED post, written on its release
  let lastError = null;
  let lastNag = { reason: null, at: 0, fresh: true };
  let deferred = null;   // { generation, until }: an incomplete re-projection, not retried before `until`
  let reading = null;    // the refresh in flight, shared by an overlapping caller

  function load() {
    if (loaded) return;
    loaded = true;
    let path;
    try {
      path = file();
      const saved = JSON.parse(fs.readFileSync(path, "utf8"));
      doc = saved.doc && typeof saved.doc.generation === "string" && Array.isArray(saved.doc.posts) ? saved.doc : null;
      projected = saved.projected && typeof saved.projected.generation === "string" ? saved.projected : null;
      held = Array.isArray(saved.held) ? saved.held : [];
      parked = Array.isArray(saved.parked) ? saved.parked : [];
    } catch (err) {
      if (err.code === "ENOENT") return;
      // Never an empty list: treated as never read, which blocks the
      // fallbacks until the booru answers, and re-projects the next list whole.
      log.warn(`[quarantine] the saved list ${path || "quarantine.json"} is unreadable (${err.message}); treating it as never read until the booru answers -- the next good read replaces it`);
    }
  }

  // The one place a read replaces the list. Reads never overlap (refresh()
  // shares the one in flight), so the newest answer is always the last kept.
  function keep(d) {
    doc = d;
    persist();
  }

  function persist() {
    if (!service) return;
    let path;
    try {
      path = file();
      const tmp = `${path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ doc, projected, held, parked }));
      fs.renameSync(tmp, path);
    } catch (err) {
      log.warn(`[quarantine] could not save the list to ${path || "the state directory"} (${err.message}); it is kept in memory, and a restart reads the booru again`);
    }
  }

  return {
    current() { load(); return doc; },
    isFresh() { load(); return fresh(doc, now()); },
    projected() { load(); return projected; },
    held() { load(); return held.slice(); },
    parked() { load(); return parked.slice(); },

    /** Why the list is not fresh, in words for a log line. */
    reason() {
      load();
      if (!doc) return lastError ? `never read since it was first needed: ${lastError}` : "never read since it was first needed";
      const age = Math.round((now() - doc.checked_at) / 1000);
      return `last read ${age}s ago${lastError ? `: ${lastError}` : ""}`;
    },

    /** One read of the booru. Resolves "ok", "not-modified" or "unreadable"; never throws. */
    refresh() {
      if (!reading) reading = readOnce().finally(() => { reading = null; });
      return reading;
    },

    markProjected(d) {
      load();
      // The names too: the next run re-asks only what joined or left when they
      // have not changed (affectedPosts).
      projected = { generation: d.generation, flagged: [...(d.flagged || [])], banished: [...(d.banished || [])], posts: d.posts.map((p) => ({ id: p.id, mxc: p.mxc })) };
      deferred = null;
      persist();
    },

    /** Whether the current list still needs projecting into the rooms. */
    owed() {
      load();
      if (!fresh(doc, now())) return false;
      if (projected && projected.generation === doc.generation) return false;
      return !(deferred && deferred.generation === doc.generation && now() < deferred.until);
    },
    deferRetry(generation) {
      deferred = { generation, until: now() + QUARANTINE_RETRY_MS };
    },

    /** Hold a fallback tag-state write until the list is fresh. false: not held (not the service). */
    hold(entry) {
      load();
      if (!service) return false;
      held = held.filter((e) => heldKey(e) !== heldKey(entry));
      held.push({ ...entry, at: now() });
      if (held.length > HELD_MAX) {
        const dropped = held.splice(0, held.length - HELD_MAX);
        log.error(`[quarantine] ${dropped.length} held tag-state write(s) dropped (over ${HELD_MAX} held while the list is unread); !backfill restart in their rooms writes them`);
      }
      persist();
      return true;
    },
    unhold(entry) {
      held = held.filter((e) => heldKey(e) !== heldKey(entry));
      persist();
    },

    /** Park a picture held hidden by a FLAGGED post until the post leaves the list. false: not parked (not the service). */
    park(entry) {
      load();
      if (!service) return false;
      parked = parked.filter((e) => heldKey(e) !== heldKey(entry));
      parked.push({ ...entry, at: now() });
      if (parked.length > HELD_MAX) {
        const dropped = parked.splice(0, parked.length - HELD_MAX);
        log.error(`[quarantine] ${dropped.length} parked picture(s) dropped (over ${HELD_MAX} held hidden by flagged posts); !backfill restart in their rooms writes them once the flag is released`);
      }
      persist();
      return true;
    },
    unpark(entry) {
      parked = parked.filter((e) => heldKey(e) !== heldKey(entry));
      persist();
    },
  };

  async function readOnce() {
    load();
    // The list this read asks after: a 304 confirms exactly it.
    const asked = doc;
    let r;
    try {
      r = await danbooru.getQuarantine({ ifNoneMatch: asked && asked.etag ? asked.etag : undefined });
    } catch (err) {
      lastError = err.message;
      const t = now();
      const isFresh = fresh(doc, t);
      // Loud from the first failure, and at once when the grace runs out.
      if (lastNag.reason !== err.message || lastNag.fresh !== isFresh || t - lastNag.at >= QUARANTINE_NAG_MS) {
        lastNag = { reason: err.message, at: t, fresh: isFresh };
        log.error(`[quarantine] the booru's quarantine list is UNREADABLE: ${err.message}. ` +
          (isFresh
            ? `Working on the last good list, read ${Math.round((t - doc.checked_at) / 1000)}s ago: a tag flagged since then is not stripped until the booru answers; fallback tag writes are held in ${Math.max(1, Math.round((doc.checked_at + QUARANTINE_FRESH_MS - t) / 60000))} min.`
            : doc
              ? `The last good list was read ${Math.round((t - doc.checked_at) / 1000)}s ago and the 30-minute grace is over: fallback tag writes are held until it is read.`
              : "It has never been read: fallback tag writes are held until it is read."));
      }
      return "unreadable";
    }
    if (lastError) log.log(`[quarantine] the booru's quarantine list is readable again`);
    lastError = null;
    lastNag = { reason: null, at: 0, fresh: true };
    if (r.status === "not-modified" && asked) {
      keep({ ...asked, checked_at: now() });
      return "not-modified";
    }
    if (r.status !== "ok") {
      lastError = `the booru answered not-modified to a list this tunnel does not hold`;
      return "unreadable";
    }
    keep({ ...r.doc, etag: r.etag || null, checked_at: now() });
    return "ok";
  }
}

const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The posts a change from prevDoc to nextDoc can have touched. The NAMES
 * unchanged (and known: a projected record saved before names were kept has
 * none): only the posts that joined or left, since one that stayed already
 * carries its stripped state. Otherwise every post in either list.
 */
function affectedPosts(prevDoc, nextDoc) {
  const prevPosts = (prevDoc && prevDoc.posts) || [];
  const known = prevDoc && Array.isArray(prevDoc.flagged) && Array.isArray(prevDoc.banished);
  const before = known ? quarantinedNames(prevDoc) : null;
  const after = quarantinedNames(nextDoc);
  const sameNames = before !== null && before.size === after.size && [...after].every((n) => before.has(n));
  if (!sameNames) return [...prevPosts, ...nextDoc.posts];
  const prevIds = new Set(prevPosts.map((p) => p.id));
  const nextIds = new Set(nextDoc.posts.map((p) => p.id));
  return [...prevPosts.filter((p) => !nextIds.has(p.id)), ...nextDoc.posts.filter((p) => !prevIds.has(p.id))];
}

/**
 * Rewrite the current tag state of every picture the quarantine change could
 * have touched. prevDoc is what was last projected (null: nothing yet, so the
 * whole of nextDoc). Resolves a tally; `complete` is false when anything
 * failed that a later run could fix.
 *
 * deps: { stateType, roomIds: async () => [roomId], skipRoom(roomId), now,
 *         paceMs, log, sleep }
 *
 * The room walk itself (room list once, denied rooms unread, one state read
 * per room, an unreadable room counted and passed) is tag-state-walk.js,
 * shared with tools/repoint-merged.js.
 */
async function reprojectQuarantine(bridge, danbooru, prevDoc, nextDoc, deps) {
  const { stateType, roomIds, skipRoom = () => false, now = Date.now, paceMs = QUARANTINE_PACE_MS, log = console } = deps;
  const pause = deps.sleep || sleep;
  if (!stateType) throw new TypeError("reprojectQuarantine needs deps.stateType, the tag state event type");
  const names = quarantinedNames(nextDoc);
  const posts = affectedPosts(prevDoc, nextDoc);
  const ids = new Set(posts.map((p) => p.id));
  const postByMxc = new Map(posts.filter((p) => p.mxc).map((p) => [p.mxc, p.id]));
  const tally = { rooms: 0, events: 0, written: 0, current: 0, refused: 0, failed: 0, complete: false };
  if (!ids.size) { tally.complete = true; return tally; }

  const projections = new Map(); // post id -> { projection } | { hidden } | { error }
  const projectionFor = async (postId) => {
    if (!projections.has(postId)) {
      try {
        const p = await danbooru.getTagProjection(postId);
        if (!p) {
          projections.set(postId, { hidden: true });
        } else if (p.tags.length) {
          projections.set(postId, { projection: p });
        } else {
          // A legacy post with no recorded provenance: its tag string, as
          // pointRoomAtPost falls back to, so a release restores the name.
          const post = await danbooru.findVisiblePost(postId);
          projections.set(postId, post ? { legacy: (post.tag_string || "").split(/\s+/).filter(Boolean) } : { hidden: true });
        }
      } catch (err) {
        projections.set(postId, { error: err });
      }
    }
    return projections.get(postId);
  };

  let wrote = false;
  tally.rooms = await walkTagState({
    bridge, stateType, roomIds, skipRoom,
    select: (e) => postByMxc.has(e.state_key) || ids.has(e.content.post_id),
    onUnreadable: (roomId, err, i, n) => {
      tally.failed += 1;
      log.warn(`[quarantine] room ${i + 1}/${n} ${roomId}: its state could not be read (${err.message}); retried on a later run`);
    },
    onRoom: async (roomId, events, i, n) => {
      let roomWritten = 0;
      for (const ev of events) {
        tally.events += 1;
        const current = ev.content;
        const postId = Number.isInteger(current.post_id) ? current.post_id : postByMxc.get(ev.state_key);
        const got = await projectionFor(postId);
        let tags, sources;
        if (got.projection) {
          tags = stripNames(got.projection.tags, names);
          sources = stripSources(got.projection.sources, names);
        } else if (got.legacy) {
          tags = stripNames(got.legacy, names);
          sources = stripSources(current.sources, names);
        } else if (got.hidden) {
          // Hidden from the tunnel (flagged, uploaded by another bot): what
          // the room already says, minus the names.
          tags = stripNames(current.tags, names);
          sources = stripSources(current.sources, names);
        } else {
          tally.failed += 1;
          if (!carriesAny(current, names)) {
            log.warn(`[quarantine] post #${postId} in ${roomId}: the booru did not answer for it (${got.error.message}); left as it is, retried on a later run`);
            continue;
          }
          // The name goes NOW; whatever a release owes it waits for the booru.
          log.warn(`[quarantine] post #${postId} in ${roomId}: the booru did not answer for it (${got.error.message}); its quarantined names are stripped from the room's own state, and the rest is retried on a later run`);
          tags = stripNames(current.tags, names);
          sources = stripSources(current.sources, names);
        }
        const next = { post_id: postId, tags, rating: current.rating, sources };
        if (sameState({ post_id: current.post_id, tags: current.tags, rating: current.rating, sources: current.sources }, next)) {
          tally.current += 1;
          continue;
        }
        // Set before the pause, not after it: the flag is read across rooms
        // from inside this callback, and an assignment after an await is the
        // race the linter names.
        const due = wrote && paceMs;
        wrote = true;
        if (due) await pause(paceMs);
        try {
          await bridge.getIntent().sendStateEvent(roomId, stateType, ev.state_key, { ...next, updated_by: "tunnel", updated_at: now() });
          tally.written += 1;
          roomWritten += 1;
        } catch (err) {
          if (errcodeOf(err) === "M_FORBIDDEN") {
            tally.refused += 1;
            log.error(`[quarantine] post #${postId} in ${roomId}: the room refused the tag-state rewrite (${err.message}), so its state may still carry a quarantined name; fix: run tools/grant-tag-write.sh for ${roomId}, then the next change of the list rewrites it (or !backfill restart there)`);
          } else {
            tally.failed += 1;
            log.warn(`[quarantine] post #${postId} in ${roomId}: the tag-state rewrite failed (${err.message}); retried on a later run`);
          }
        }
      }
      log.log(`[quarantine] room ${i + 1}/${n} ${roomId}: ${events.length} affected picture(s), ${roomWritten} rewritten`);
    },
  });
  tally.complete = tally.failed === 0;
  return tally;
}

/** Write held fallback writes, stripped, once the list is fresh. Resolves the number written. */
async function drainHeld(watch, { bridge, danbooru, stateType, now = Date.now, log = console }) {
  const doc = watch.current();
  if (!fresh(doc, now())) return 0;
  const names = quarantinedNames(doc);
  let written = 0;
  for (const e of watch.held()) {
    let p = null;
    try { p = await danbooru.getTagProjection(e.postId); } catch { p = null; }
    const base = p && p.tags.length ? p : e;
    const content = { post_id: e.postId, tags: stripNames(base.tags, names), rating: e.rating, sources: stripSources(base.sources, names), updated_by: "tunnel", updated_at: now() };
    try {
      await bridge.getIntent().sendStateEvent(e.roomId, stateType, e.mxcUrl, content);
      written += 1;
      watch.unhold(e);
    } catch (err) {
      if (errcodeOf(err) === "M_FORBIDDEN") {
        watch.unhold(e);
        log.error(`[quarantine] held tag state for post #${e.postId} in ${e.roomId} was refused by the room (${err.message}); fix: run tools/grant-tag-write.sh for ${e.roomId}, then !backfill restart there`);
      } else {
        log.warn(`[quarantine] held tag state for post #${e.postId} in ${e.roomId} not written yet (${err.message}); tried again on the next poll`);
      }
    }
  }
  if (written) log.log(`[quarantine] ${written} held tag-state write(s) made, quarantined names stripped`);
  return written;
}

/**
 * Write the tag state of every parked picture whose post has left the list
 * (released), as the tunnel's account now sees the post: the booru's
 * projection, or its tag string for a legacy post, every quarantined name
 * stripped. A post still hidden (deleted or jailed meanwhile) lets the
 * picture go, held-hidden as any other. Resolves the number written.
 */
async function drainParked(watch, { bridge, danbooru, stateType, now = Date.now, log = console }) {
  const doc = watch.current();
  if (!fresh(doc, now())) return 0;
  const flaggedMd5s = new Set(doc.posts.filter((p) => p.flagged).map((p) => p.md5));
  const banishedMd5s = new Set(doc.posts.filter((p) => p.banished).map((p) => p.md5));
  const names = quarantinedNames(doc);
  let written = 0;
  for (const e of watch.parked()) {
    if (flaggedMd5s.has(e.md5)) continue;
    if (banishedMd5s.has(e.md5)) {
      // The review ended in Banish: nothing comes back, so the picture is the
      // ordinary held-hidden it would have been for a jailed post.
      watch.unpark(e);
      log.log(`[quarantine] parked picture ${e.mxcUrl} in ${e.roomId}: post #${e.postId} was BANISHED from the review queue, so it stays held-hidden with no tag state`);
      continue;
    }
    let post;
    let projection;
    try {
      post = await danbooru.findVisiblePost(e.postId);
      projection = post ? await danbooru.getTagProjection(post.id) : null;
    } catch (err) {
      log.warn(`[quarantine] parked picture ${e.mxcUrl} in ${e.roomId}: post #${e.postId} left the flagged list, but the booru did not answer for it (${err.message}); tried again on the next poll`);
      continue;
    }
    if (!post) {
      watch.unpark(e);
      log.log(`[quarantine] parked picture ${e.mxcUrl} in ${e.roomId}: post #${e.postId} left the flagged list but is still hidden from this account (deleted or jailed), so it stays held-hidden -- if it should be live, release it on the booru, then !backfill restart in ${e.roomId}`);
      continue;
    }
    const base = projection && projection.tags.length
      ? projection
      : { tags: (post.tag_string || "").split(/\s+/).filter(Boolean), sources: { creator: [], auto: [], both: [], meta: [] } };
    const content = { post_id: post.id, tags: stripNames(base.tags, names), rating: post.rating || e.rating, sources: stripSources(base.sources, names), updated_by: "tunnel", updated_at: now() };
    try {
      await bridge.getIntent().sendStateEvent(e.roomId, stateType, e.mxcUrl, content);
      written += 1;
      watch.unpark(e);
    } catch (err) {
      if (errcodeOf(err) === "M_FORBIDDEN") {
        watch.unpark(e);
        log.error(`[quarantine] parked picture ${e.mxcUrl} in ${e.roomId}: the room refused its tag state (${err.message}); fix: run tools/grant-tag-write.sh for ${e.roomId}, then !backfill restart there`);
      } else {
        log.warn(`[quarantine] parked picture ${e.mxcUrl} in ${e.roomId}: tag state not written yet (${err.message}); tried again on the next poll`);
      }
    }
  }
  if (written) log.log(`[quarantine] ${written} parked picture(s) given their tag state: their posts' flags were released`);
  return written;
}

/**
 * One poll: read the list, write what was held and what was parked, and
 * re-project if the list moved since it was last projected. Resolves { read,
 * heldWritten, parkedWritten, reprojected } (reprojected: the tally, or null
 * when none was owed).
 *
 * deps: reprojectQuarantine's, plus bridge and danbooru.
 */
async function quarantineTick(watch, deps) {
  const read = await watch.refresh();
  const heldWritten = await drainHeld(watch, deps);
  const parkedWritten = await drainParked(watch, deps);
  let reprojected = null;
  if (watch.owed()) {
    const next = watch.current();
    const prev = watch.projected();
    const log = deps.log || console;
    log.log(`[quarantine] the list moved (${prev ? prev.generation : "never projected"} -> ${next.generation}); rewriting the tag state of ${new Set(affectedPosts(prev, next).map((p) => p.id)).size} post(s) in every joined room`);
    try {
      reprojected = await reprojectQuarantine(deps.bridge, deps.danbooru, prev, next, deps);
    } catch (err) {
      reprojected = { complete: false, error: err.message };
      log.warn(`[quarantine] the re-projection could not start (${err.message}); retried on a later run`);
    }
    if (reprojected.complete) {
      watch.markProjected(next);
      log.log(`[quarantine] re-projected ${next.generation}: ${reprojected.written} rewritten, ${reprojected.current} already current, ${reprojected.refused} refused, across ${reprojected.rooms} room(s)`);
    } else {
      watch.deferRetry(next.generation);
      log.warn(`[quarantine] re-projection of ${next.generation} incomplete (${reprojected.failed || 0} failed); retried in ${QUARANTINE_RETRY_MS / 60000} minutes or on the next change of the list`);
    }
  }
  return { read, heldWritten, parkedWritten, reprojected };
}

/**
 * The poller, started beside the backfill sweep. A tick that arrives while
 * the last one runs (a long re-projection) is dropped, not queued; the list's
 * freshness is then carried by the read at the start of the next tick.
 */
function startQuarantine(watch, deps, { intervalMs = QUARANTINE_POLL_MS, firstMs = 5 * 1000 } = {}) {
  let running = null;
  const tick = () => {
    if (running) {
      // The re-projection is long; keep the list itself fresh meanwhile.
      void watch.refresh();
      return;
    }
    running = quarantineTick(watch, deps)
      .catch((err) => (deps.log || console).error(`[quarantine] poll failed: ${err.message}; the next poll tries again`))
      .finally(() => { running = null; });
  };
  const first = setTimeout(tick, firstMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  QUARANTINE_POLL_MS, QUARANTINE_FRESH_MS,
  quarantinedNames, fresh, stripNames, stripSources,
  createQuarantineWatch, affectedPosts, reprojectQuarantine, drainHeld, drainParked, quarantineTick, startQuarantine,
};
