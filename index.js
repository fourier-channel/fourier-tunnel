const fs = require("fs");
const yaml = require("js-yaml");
const axios = require("axios");
const { Cli, AppServiceRegistration, Bridge } = require("matrix-appservice-bridge");
const { DanbooruClient, BooruDuplicate, BooruRefusal } = require("./danbooru");
const { autotag } = require("./autotagger");
const { extractCreatorTags, extractCreatorTagsFromFields } = require("./prompt-tags");
const { stripGeneration } = require("./strip-generation");
const imagePlan = require("./image-plan");
const invites = require("./invites");
const avatarCapability = require("./capabilities/avatar");
const rooms = require("./rooms");
const rescanCapability = require("./capabilities/rescan");
const listrooms = require("./listrooms");
const poster = require("./poster");
const backfill = require("./backfill");
const backfillState = require("./backfill-state");
const { resolveHomeserverUrl } = require("./homeserver");

// PACING BETWEEN BACKFILLED IMAGES.
//
// This was `await sleep(750)` and `sleep` was never defined -- not declared,
// not imported, not a Node global. It threw ReferenceError on EVERY image,
// after handleImageEvent had already done the whole job, so a run that
// uploaded and tagged 266 pictures reported "0 done, 266 failed" and the
// pacing this exists for never once ran. Synapse rate-limits state events and
// starts refusing them, which is why some images lost their tag state on runs
// that otherwise worked.
const BACKFILL_PACE_MS = 750;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// WHERE THE CONFIG AND THE REGISTRATION ARE READ FROM. Beside this file, as
// always, unless FOURIER_TUNNEL_CONFIG / FOURIER_TUNNEL_REGISTRATION name
// another path. That is for index.test.js, which loads this module against a
// throwaway config pointing at fake servers: nothing tested handleImageEvent
// itself while both files were only ever read from here, and so nothing
// noticed when the line that decides WHICH bytes reach the booru could be
// changed back to the raw ones. Unset in production.
const CONFIG_PATH = process.env.FOURIER_TUNNEL_CONFIG || require("path").join(__dirname, "config.yaml");
const REGISTRATION_PATH = process.env.FOURIER_TUNNEL_REGISTRATION || require("path").join(__dirname, "tunnel-registration.yaml");

const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf8"));

// ONE homeserver URL for the whole process, resolved once.
//
// config.yaml names Synapse by its compose-network hostname, which is correct
// inside the bridge container and unreachable from anywhere else. HOMESERVER_URL
// says where it answers from HERE. Resolved back INTO the config so that all
// call sites -- registration, canon's media lookup, history paging, joined_rooms
// and the Bridge itself -- agree by construction rather than by everyone
// remembering to check. tools/catch-up-room.js used to resolve its own URL for
// paging and leave downloadFromSynapse on the configured one; the run walked the
// room fine and then failed all 419 downloads with EAI_AGAIN synapse.
config.homeserver.url = resolveHomeserverUrl(process.env, config.homeserver.url);
const danbooru = new DanbooruClient(config.danbooru);

// ONE FILE PER IMAGE (canon.js). Every Matrix image the tunnel handles -- and
// every one the media gate is asked for, through the service below -- becomes
// the one stripped file in R2 before anything else touches it. Built on first
// use, so a process that never handles an image never needs R2 credentials.
const canonLib = require("./canon");
let canonInstance = null;
function getCanon() {
  if (!canonInstance) {
    canonInstance = canonLib.createCanon({
      store: canonLib.r2Store(canonLib.r2FromEnv()),
      mediaInfo: canonLib.synapseMediaInfo({
        axios,
        homeserverUrl: config.homeserver.url,
        domain: config.homeserver.domain,
        adminToken: config.homeserver.admin_token,
      }),
      booru: danbooru,
      log: (line) => console.warn(line),
    });
  }
  return canonInstance;
}
// Tests hand in a canon over an in-memory bucket.
function setCanon(c) {
  canonInstance = c;
}

// ONE SET OF RENDITIONS: every 15 minutes, move Synapse's renditions of images
// the booru now holds to superseded/ (canon.retireSweep; the booru's variants
// are the renditions -- fourier-auth mediar2.js serves them). Each sweep lists
// local_thumbnails/ once; a failure is logged and the next sweep tries again.
const RETIRE_SWEEP_MS = 15 * 60 * 1000;
function startThumbnailRetirement(intervalMs = RETIRE_SWEEP_MS) {
  // everyInterval (below) drops a tick that arrives while the last sweep is
  // still running, so two sweeps never list local_thumbnails/ at once.
  return everyInterval(async () => {
    // Booru records first: one the booru was too busy for is retried here, and
    // once its variants are old enough the retirement below moves Synapse's
    // renditions of it.
    try {
      const b = await getCanon().booruSweep();
      if (b.tried) console.log(`[canon] booru records retried: ${b.tried}; ${JSON.stringify(b.tally)}`);
    } catch (err) {
      console.error(`[canon] booru record sweep failed: ${err.message}; the next sweep tries again`);
    }
    try {
      const r = await getCanon().retireSweep();
      if (r.moved || r.failed) {
        console.log(`[canon] renditions: ${r.moved} of booru-held images moved to superseded/, ${r.failed} not (see above); ${JSON.stringify(r.tally)}`);
      }
    } catch (err) {
      console.error(`[canon] rendition sweep failed: ${err.message}; the next sweep tries again`);
    }
  }, intervalMs);
}

// The media gate (fourier-auth) asks here for any Matrix original it has no
// index entry for, so no link ever leads to a file that still has a prompt in
// it. Internal: the port is published to no host, only the docker networks
// this container shares with the gate. POST /canon/<mediaId> -> the index entry.
function startCanonService(port) {
  const http = require("http");
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const m = /^\/canon\/([A-Za-z0-9_-]{1,128})$/.exec((req.url || "").split("?")[0]);
    if (req.method !== "POST" || !m) return reply(404, { error: "no such route", fix: "POST /canon/<mediaId>" });
    getCanon().canonicalize(m[1]).then(
      (idx) => reply(200, idx),
      (err) => {
        console.error(`[canon] ${m[1]}: ${err.message}`);
        reply(err.status || 500, { error: err.message, retryable: err.retryable !== false });
      },
    );
  });
  server.listen(port, "0.0.0.0", () => console.log(`[canon] answering the media gate on ${port} (docker networks only)`));
  return server;
}

// Load the appservice token from the registration file for authenticated
// media downloads from Synapse.
/**
 * Register the bot user, on a homeserver that speaks OAuth2.
 *
 * NOT bridge.getIntent().ensureRegistered(). matrix-appservice-bridge posts a
 * plain appservice registration, and this homeserver runs MAS -- so it answers
 * IO.ELEMENT.MSC4190.M_APPSERVICE_LOGIN_UNSUPPORTED: "this server uses OAuth2,
 * so the inhibit_login parameter must be set to true for appservice
 * registrations". The bridge library has no way to pass it.
 *
 * That call has therefore been failing since MAS was introduced, and nobody
 * noticed for one reason: @bmb was registered BEFORE MAS, so the failure was
 * always a no-op on an account that already existed. It surfaced the moment the
 * bot was renamed and the user genuinely had to be created -- the bridge came
 * up, logged that it had ensured its user, and then 500'd setting a display
 * name on an account that did not exist.
 *
 * M_USER_IN_USE is success here: the account is what we wanted, and a restart
 * must not be an error.
 */
async function ensureBotUser(config, reg) {
  const localpart = reg.sender_localpart;
  const url = `${config.homeserver.url.replace(/\/+$/, "")}/_matrix/client/v3/register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${reg.as_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.application_service",
      username: localpart,
      // The whole point. Without it, MAS refuses the registration outright.
      inhibit_login: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`[startup] bot user @${localpart} registered`);
    return;
  }
  if (body.errcode === "M_USER_IN_USE") {
    console.log(`[startup] bot user @${localpart} already exists`);
    return;
  }
  throw new Error(`${body.errcode || res.status}: ${body.error || "register failed"}`);
}

const _reg = yaml.load(fs.readFileSync(REGISTRATION_PATH, "utf8"));
const AS_TOKEN = _reg.as_token;

const TAG_STATE_TYPE = "net.41chan.media.tags";

// Per-admin pending avatar requests: userId -> expiry epoch ms.
const avatarPending = new Map();

// Count joined members in a room (used to detect DMs = 2 members).
async function joinedMemberCount(bridge, roomId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch {
    return -1; // unknown
  }
}

// True only if the bot user is currently joined to the room. Used to skip
// events from rooms the bot isn't in (e.g. backlog from a previously over-broad
// appservice namespace), so the appservice transaction is ACKed and the stream
// drains instead of wedging on an un-actionable foreign-room event.
async function botIsJoined(bridge, roomId, botUserId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.some(
      (e) =>
        e.type === "m.room.member" &&
        e.state_key === botUserId &&
        e.content.membership === "join"
    );
  } catch {
    return false; // can't read state => not a member
  }
}

function isRoomDisabled(roomId) {
  return (config.bridge.disabled_rooms || []).includes(roomId);
}


// Artist tags already put in their category this process. The poster tag
// repeats on every image the same person posts, and without this that is two
// extra API calls per upload to re-assert something already true.
const categorisedArtists = new Set();

// Make the poster's tag an ARTIST tag.
//
// Order matters and is not obvious: the post has already been created carrying
// this tag, so the booru minted it as a GENERAL tag. Artist entries refuse to
// attach to a non-empty general tag ("'x' is a general tag; artist entries can
// only be created for artist tags"), so the category has to be corrected FIRST
// and the entry created second. Setting the category is also what retroactively
// fixes every post already carrying the tag, since category belongs to the tag
// rather than to the post. Learned from fourier-sampling's poster, which pays
// for this on the 4chan side.
//
// Fail-soft throughout: a picture that is posted but whose tag is still
// general is a cosmetic problem, and wedging the bridge over it would not be.
async function categoriseArtist(tag) {
  if (!tag || categorisedArtists.has(tag)) return;
  categorisedArtists.add(tag);
  try {
    await danbooru.setTagCategory(tag, 1);
    await danbooru.ensureArtist(tag);
  } catch (err) {
    categorisedArtists.delete(tag); // let the next post try again
    console.warn(`[poster] could not categorise ${tag}: ${err.message}`);
  }
}

// ONE WALK AT A TIME, across every room and every trigger. A restart can make
// the bot's membership event fire in every room within seconds (2026-09-26:
// fifteen rooms at once), and fifteen parallel walks are fifteen bursts of
// downloads, booru lookups and state events against Synapse and the booru.
// Queued, they are one. `backfillInFlight` is the rooms queued or running, so
// a second trigger for the same room is not queued behind the first.
const backfillInFlight = new Set();
let backfillQueue = Promise.resolve();

// Read one page of a room's history as the bot, oldest-going-backwards.
// `to` stops the page at an earlier walk's head (a rejoin's gap walk).
async function historyPage(roomId, botUserId, from, to) {
  const base = config.homeserver.url.replace(/\/+$/, "");
  const params = new URLSearchParams({ dir: "b", limit: "100", user_id: botUserId });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const res = await fetch(
    `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
    { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
  );
  if (!res.ok) throw new Error(`messages ${res.status}`);
  return res.json();
}

// Re-read one event as the bot, to retry a picture that failed on an earlier
// run. A 404 is "gone" (resolves null), so a deleted picture is dropped
// rather than posted from memory.
async function roomEvent(roomId, botUserId, eventId) {
  const base = config.homeserver.url.replace(/\/+$/, "");
  const params = new URLSearchParams({ user_id: botUserId });
  const res = await fetch(
    `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}?${params}`,
    { headers: { Authorization: `Bearer ${AS_TOKEN}` } },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`event ${res.status}`);
  return res.json();
}

// Can the bot write the tag state event in this room?
//
// Asked BEFORE a backfill because of an ordering trap that is easy to walk
// into: the power-level grant only covers rooms the bot is already in, so a
// room it has just been invited to has neither the grant nor a level. The
// backfill then uploads every image happily and fails every tag write, which
// looks like success in the booru and silence in the room. Better to say so
// once, at the top, with the fix.
async function canWriteTags(bridge, roomId, botUserId) {
  try {
    const pl = await bridge.getIntent().getStateEvent(roomId, "m.room.power_levels", "");
    const need = Number(
      (pl.events || {})[TAG_STATE_TYPE] !== undefined
        ? pl.events[TAG_STATE_TYPE]
        : pl.state_default !== undefined ? pl.state_default : 50,
    );
    const have = Number(
      (pl.users || {})[botUserId] !== undefined
        ? pl.users[botUserId]
        : pl.users_default !== undefined ? pl.users_default : 0,
    );
    return { ok: have >= need, have, need };
  } catch (e) {
    // Unknown is not the same as refused; proceed and let the write speak.
    return { ok: true, have: null, need: null, unknown: e.message };
  }
}

// Walk a room the bot is in and replay its images through the live handler.
// Safe to repeat: that handler skips an upload whose md5 the booru already has
// and just writes the room's tag state.
//
// WHAT A RUN DOES is decided from the room's persisted record
// (backfill-state.js, read now -- never a copy held in memory) by
// backfill.planWalk: the first walk of a room starts at the live edge; a room
// not yet walked to its start RESUMES from its cursor; a finished room is
// skipped by the automatic triggers unless a failed picture is owed a retry;
// an admin's !backfill walks a finished room again; a rejoin walks the gap
// since the last walk began. The record is written back after every run,
// including one that failed part-way, so pages walked are never walked twice
// for nothing.
//
// How far back this can see is the ROOM's business, not ours: under
// history_visibility "invited" the bot's own invite is the earliest event it
// may read, and two rooms on this server are set that way.
//
// Resolves { skipped } when there was nothing to do, { error } when the run
// could not start, otherwise the walk's result. Never rejects.
async function backfillRoomNow(bridge, roomId, botUserId, { trigger = "join", restart = false } = {}) {
  if (isRoomDisabled(roomId)) return { roomId, skipped: "tagging is disabled for this room" };
  // Belt and braces: the event loop already drops a denied room's events, and
  // the guarded intent would refuse the writes, but the sweep and the history
  // reads reach Synapse by fetch, around the guard.
  if (rooms.isDenied(roomId)) return { roomId, skipped: "the room is on the denied list" };
  if (backfillInFlight.has(roomId)) return { roomId, skipped: "a walk of this room is already queued or running" };
  backfillInFlight.add(roomId);
  const run = backfillQueue.then(() => walkRoom(bridge, roomId, botUserId, { trigger, restart }));
  backfillQueue = run.catch(() => {});
  try {
    return await run;
  } catch (err) {
    console.warn(`[backfill] ${roomId} failed: ${err.message}`);
    return { roomId, error: err.message };
  } finally {
    backfillInFlight.delete(roomId);
  }
}

async function walkRoom(bridge, roomId, botUserId, { trigger, restart }) {
  // Re-checked at the head of the queue: a room can be denied while it waits.
  if (rooms.isDenied(roomId)) return { roomId, skipped: "the room is on the denied list" };
  const saved = backfillState.get(roomId);
  const plan = backfill.planWalk(saved, { trigger, restart });
  if (plan.kind === "skip") return { roomId, skipped: "its history has been walked to the start" };

  const perm = await canWriteTags(bridge, roomId, botUserId);
  if (!perm.ok) {
    console.warn(
      `[backfill] ${roomId}: cannot write ${TAG_STATE_TYPE} here ` +
      `(bot has ${perm.have}, needs ${perm.need}). Images will still reach the ` +
      `booru, but NO tags will be written back to this room. Fix with: run ` +
      `tools/grant-tag-write.sh (it picks up this room now the bot is in it), then ` +
      `send !backfill restart here to write the tag state that this run will miss.`
    );
  }
  if (plan.kind !== "initial" || saved) {
    console.log(`[backfill] ${roomId}: ${plan.kind}${plan.from ? " from the saved cursor" : ""} (${trigger})`);
  }
  const result = await backfill.backfillRoom({
    roomId,
    from: plan.from,
    to: plan.to,
    // A retry-only run walks no pages.
    maxPages: plan.kind === "retry" ? 0 : backfill.MAX_PAGES,
    retry: backfill.retryable(saved),
    fetchPage: (from, to) => historyPage(roomId, botUserId, from, to),
    fetchEvent: (eventId) => roomEvent(roomId, botUserId, eventId),
    onImage: async (ev) => {
      const outcome = await handleImageEvent(bridge, { ...ev, room_id: roomId });
      // Paced: each image is a download, a hash, maybe an upload and a state
      // event. Synapse rate-limits state events and will start refusing.
      await sleep(BACKFILL_PACE_MS);
      return outcome;
    },
    // Named, not swallowed. Passing this is now mandatory; see backfillRoom.
    log: (line) => console.warn(line),
  });
  const full = { ...result, kind: plan.kind, tagsBlocked: !perm.ok };
  backfillState.put(roomId, backfill.nextState(saved, plan, full));
  const note = perm.ok ? "" : "  (tag write-back BLOCKED: see the warning above)";
  console.log(backfill.summarise(full) + note);
  return full;
}

// THE SWEEP: every room the bot sits in whose history is not yet walked to its
// start -- or that never had a walk at all, or owes a failed picture a retry --
// is resumed, ONE ROOM AT A TIME, through the same queue as everything else.
// Without it a room only progressed when somebody noticed and typed !backfill,
// which is what left one room at 0 of 9 for over a month.
//
// Skipped: denied and disabled rooms; a room walked in the last few minutes
// (so a sweep does not chase an admin's !backfill or a join's walk); and a DM
// unless tag_in_dms is on, the same rule the live path keeps -- an admin's DM
// with the bot is where avatar pictures are sent, and they are not for the
// booru.
const BACKFILL_SWEEP_MS = 10 * 60 * 1000;
const BACKFILL_SWEEP_FIRST_MS = 2 * 60 * 1000;
const BACKFILL_RECENT_MS = 5 * 60 * 1000;

async function joinedRoomIds(userId) {
  const base = config.homeserver.url.replace(/\/+$/, "");
  const q = `user_id=${encodeURIComponent(userId)}`;
  const res = await fetch(`${base}/_matrix/client/v3/joined_rooms?${q}`, { headers: { Authorization: `Bearer ${AS_TOKEN}` } });
  if (!res.ok) throw new Error(`joined_rooms ${res.status}`);
  return (await res.json()).joined_rooms || [];
}

async function backfillSweep(bridge, botUserId, { now = Date.now } = {}) {
  const ids = await joinedRoomIds(botUserId);
  const walked = [];
  for (const roomId of ids) {
    if (isRoomDisabled(roomId) || rooms.isDenied(roomId)) continue;
    const saved = backfillState.get(roomId);
    if (saved && saved.lastRunAt && now() - saved.lastRunAt < BACKFILL_RECENT_MS) continue;
    if (backfill.planWalk(saved, { trigger: "sweep" }).kind === "skip") continue;
    if (!config.bridge.tag_in_dms && (await joinedMemberCount(bridge, roomId)) === 2) continue;
    const r = await backfillRoomNow(bridge, roomId, botUserId, { trigger: "sweep" });
    walked.push(r);
  }
  return walked;
}

// A periodic job that never overlaps itself: a tick that arrives while the
// last one is still running is dropped, not queued.
function everyInterval(job, intervalMs, firstMs = intervalMs) {
  let current = null;
  const tick = () => {
    if (current) return;
    current = Promise.resolve().then(job).finally(() => { current = null; });
  };
  const first = setTimeout(tick, firstMs);
  const timer = setInterval(tick, intervalMs);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return timer;
}

function startBackfillSweep(bridge, botUserId) {
  return everyInterval(async () => {
    try {
      const walked = await backfillSweep(bridge, botUserId);
      const ran = walked.filter((r) => r && !r.skipped);
      if (ran.length) console.log(`[backfill] sweep: ${ran.length} room(s) walked`);
    } catch (err) {
      console.error(`[backfill] sweep failed: ${err.message}; the next sweep tries again`);
    }
  }, BACKFILL_SWEEP_MS, BACKFILL_SWEEP_FIRST_MS);
}

// Does the room's tag state for this picture already say exactly this?
async function tagStateIsCurrent(bridge, roomId, key, post, projection) {
  let current;
  try {
    current = await bridge.getIntent().getStateEvent(roomId, TAG_STATE_TYPE, key);
  } catch {
    return false; // absent (404) or unreadable: write it
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return Boolean(current) &&
    current.post_id === post.id &&
    current.rating === (post.rating || config.bridge.default_rating) &&
    same(current.tags, projection.tags) &&
    same(current.sources, projection.sources);
}

// THE BOORU ALREADY HAS A POST FOR THESE BYTES: point this room's tag state
// for this picture at it, and upload nothing. `via` says how it was found, for
// the log line. Resolves "posted", or "tags-blocked" when the room refused
// the state write.
async function pointRoomAtPost(bridge, { roomId, mxcUrl, existing, md5, via }) {
  // Before the state write, which can return early: the private record does
  // not depend on this room's power levels. The poster is THIS sender, and no
  // creator is recorded from here: the booru keeps an existing record from
  // anyone else (a 409 poster_mismatch, logged as "keeps", not as a failure;
  // its other 409s are failures in words of their own), and a post's
  // creator is written once, by the event that created it.
  // The generation record is canon.js's to file, once per image, with the
  // uploader as poster -- not this handler's, so there is one writer of it.
  // Provenance was already recorded when this post was first created. Pull the
  // PUBLIC-SAFE projection so the new room's state matches and never carries
  // private creator tags. Fall back to tag_string for legacy posts with no
  // recorded provenance.
  let projection = null;
  try {
    projection = await danbooru.getTagProjection(existing.id);
  } catch (err) {
    console.warn(`[tag-hub] getTagProjection failed for post #${existing.id}: ${err.message}`);
  }
  if (!projection || projection.tags.length === 0) {
    const tagString = existing.tag_string || "";
    projection = {
      tags: tagString.split(/\s+/).filter(Boolean),
      sources: { creator: [], auto: [], both: [], meta: [] },
    };
  }
  // A REPLAY (backfill, the sweep, !backfill restart) meets every picture it
  // already handled, and each write is a new state event in the room even
  // when nothing changed -- updated_at alone makes it differ. The state is
  // keyed by this picture's mxc, so if it already names this post with these
  // tags there is nothing to say. A read that fails writes, as before.
  if (await tagStateIsCurrent(bridge, roomId, mxcUrl, existing, projection)) {
    console.log(`[skip] duplicate md5 ${md5} -> existing post #${existing.id}; the room already carries its tags`);
    return "posted";
  }
  try {
    await bridge.getIntent().sendStateEvent(roomId, TAG_STATE_TYPE, mxcUrl, {
      post_id: existing.id,
      tags: projection.tags,
      rating: existing.rating || config.bridge.default_rating,
      sources: projection.sources,
      updated_by: "tunnel",
      updated_at: Date.now(),
    });
  } catch (err) {
    // The picture IS on the booru. Only the room's copy of its tags is
    // missing, and a re-run writes it once the power level allows.
    console.warn(`[tag-state] post #${existing.id} is on the booru but its state was refused in ${roomId}: ${err.message}`);
    return "tags-blocked";
  }
  console.log(`[skip] duplicate md5 ${md5} (${via}) -> existing post #${existing.id}`);
  return "posted";
}

// THE BOORU REFUSED TO MAKE A POST because one already holds these bytes
// (danbooru.js BooruDuplicate). The md5 lookups found nothing, so either that
// post appeared in the moment between (then it is visible, and this is an
// ordinary duplicate) or it is a post this account may not see: deleted or
// jailed, which the booru withholds from every lookup on purpose (chanbooru
// Post#hidden_as_deleted?). The second is not a failure and never succeeds on
// a retry -- the picture was removed from the booru by someone entitled to --
// so it resolves "held-hidden": nothing posted, no tag state written, counted
// apart by the backfill and not retried. Until 2026-10-02 the redirect that
// says this was followed, the post's page answered 404, and three such
// pictures failed every sweep as "Request failed with status code 404".
async function heldByTheBooru(bridge, { roomId, mxcUrl, md5, postId }) {
  const visible = await danbooru.findVisiblePost(postId);
  if (visible) {
    return pointRoomAtPost(bridge, { roomId, mxcUrl, existing: visible, md5, via: "the booru's own md5 check at post time" });
  }
  console.log(
    `[skip] ${mxcUrl}: the booru already holds these bytes (md5 ${md5}) under post #${postId}, which this account ` +
    `cannot see -- deleted or jailed. Not reposted and no tag state written; nothing to retry. If it should be ` +
    `live, release it on the booru, then !backfill restart in ${roomId} writes the room's tags.`,
  );
  return imagePlan.HELD_HIDDEN;
}

async function handleImageEvent(bridge, event) {
  const roomId = event.room_id;
  const mxcUrl = event.content && event.content.url;
  if (!mxcUrl) return;
  if (isRoomDisabled(roomId)) {
    console.log(`[skip] tagging disabled for room ${roomId}`);
    return;
  }
  console.log(`[image] ${mxcUrl} in ${roomId}`);

  // THE ONE FILE (canon.js): the image made canonical -- stripped, stored once
  // as media/<md5>.<ext>, its generation data filed privately, Synapse's
  // original moved aside -- BEFORE anything is posted. The bytes the booru gets
  // are those same bytes, so the booru's upload lands on that same key and is
  // not a second copy. Nothing is downloaded from Synapse any more: its copy is
  // not the file.
  const mxc = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxcUrl);
  if (!mxc || mxc[1] !== config.homeserver.domain) {
    console.warn(`[canon] ${mxcUrl} is not media on this homeserver; not posted`);
    return "not-local";
  }
  const canonical = await getCanon().canonicalize(mxc[2], { withBytes: true, poster: event.sender });
  if (canonical.kind === "refused") {
    console.error(`[strip] refusing to post ${mxcUrl}: ${canonical.reason}`);
    return imagePlan.STRIP_REFUSED;
  }
  if (canonical.kind !== "canonical") {
    console.warn(`[canon] ${mxcUrl} is ${canonical.media_type}, not an image the booru takes; not posted`);
    return "not-image";
  }
  const contentType = canonical.media_type;
  const buffer = canonical.raw || canonical.bytes;
  const filename =
    (event.content && event.content.body) || mxcUrl.split("/").pop() || "image";

  // WHAT THIS IMAGE MEANS, decided in image-plan.js where it can be tested:
  // the generation data stripped out (operator ruling 2026-09-28: it must never
  // be served from the booru's originals), creator tags from what the strip
  // took, then the duplicate check -- stripped md5, the booru's record of the
  // raw md5, then the raw md5 itself for posts made before the strip existed.
  const plan = await imagePlan.planImage({ buffer, contentType, sender: event.sender, rawMd5: canonical.raw_md5 }, {
    // Canon already stripped it; the plan must post EXACTLY those bytes, never a
    // re-strip that newer rules could make into a different file.
    strip: () => ({ buffer: canonical.bytes, removed: canonical.removed || {}, changed: canonical.stripped, confident: canonical.confident }),
    creatorTags: extractCreatorTagsFromFields,
    findPostByMd5: (md5) => danbooru.findPostByMd5(md5),
    findByRawMd5: (rawMd5) => danbooru.findGenerationByRawMd5(rawMd5),
    maxCreatorTags: config.autotagger && config.autotagger.max_creator_tags,
    log: (line) => console.warn(line),
  });
  if (plan.action === "refuse") {
    // NOTHING is uploaded. A file that may still carry a prompt is not posted
    // on the strength of a stripper that thinks it did its job; the image
    // stays in Matrix and a later !backfill picks it up once the stripper
    // knows the embedding.
    console.error(`[strip] refusing to post ${mxcUrl}: ${plan.reason}`);
    return plan.status;
  }

  // Duplicate check: if Danbooru already has a post for these bytes, skip the
  // (re-)upload and just point the room's tag state at the existing post. This
  // makes a re-posted image an intended [skip], and still tags the new room
  // correctly. A post this account cannot see (deleted, jailed) is NOT found
  // here -- the booru withholds it from every lookup -- and is caught at
  // createPost instead (heldByTheBooru).
  if (plan.action === "duplicate") {
    return pointRoomAtPost(bridge, { roomId, mxcUrl, existing: plan.post, md5: plan.md5, via: `${plan.via} bytes` });
  }

  // THE STRIPPED BYTES are what the booru gets, and so what R2 and Cloudflare
  // serve. Pixels identical to the raw file; only generation text is gone.
  // Canon has normally uploaded them already -- every Matrix image gets a booru
  // record (canon.js ensureBooruRecord) -- and the post is made from THAT
  // upload, so one image is one upload row. Only when canon's record is not
  // complete (the booru was busy) does the post path upload for itself.
  const fromCanon = canonical.booru && canonical.booru.status === "completed" && canonical.booru.upload_media_asset_id;
  let uploadMediaAssetId = fromCanon || null;
  if (!uploadMediaAssetId) {
    const upload = await danbooru.createUploadFromBytes(plan.upload.buffer, filename, contentType);
    const completed = await danbooru.waitForUpload(upload.id);
    const uma = completed.upload_media_assets && completed.upload_media_assets[0];
    uploadMediaAssetId = uma && uma.id;
    if (!uploadMediaAssetId) throw new Error(`No upload media asset produced for upload ${upload.id}`);
  }

  // Two tag sources, both fail-soft:
  //   AUTO    -- fourier-spectrum (WD ViT v3), on the bytes the booru holds.
  //   CREATOR -- the generation prompt embedded in the image, already read by
  //              planImage from the text the strip took out of it: private
  //              tags from private text, never from anything left public.
  // A tagger/scrape outage posts with whatever it got rather than wedging the bridge.
  let derived = null;
  try {
    derived = await autotag(plan.upload.buffer, config);
  } catch (err) {
    console.warn(`[autotag] fourier-spectrum unavailable, posting untagged: ${err.message}`);
  }
  const autoTags = (derived && derived.tags) || [];
  const creatorTags = plan.scraped.tags || [];
  const metaTags = plan.scraped.meta || [];
  // Original characters (oc_<name>): the creator naming a character. PUBLIC,
  // unlike the rest of the prompt -- a name is the point of a name -- so
  // they go into tag_string below and the booru files them as characters.
  const ocTags = plan.scraped.characters || [];
  // Provenance partition (UI: creator=green, auto=orange, both=gradient; meta =
  // de-emphasised quality/meta section). Creator-only display is privacy-gated
  // chanbooru-side (hidden by default); the bridge still records it.
  const creatorSet = new Set(creatorTags);
  const autoSet = new Set(autoTags);
  const both = autoTags.filter((t) => creatorSet.has(t));
  const autoOnly = autoTags.filter((t) => !creatorSet.has(t));
  const creatorOnly = creatorTags.filter((t) => !autoSet.has(t));
  // The booru's tag_string carries only PUBLIC tags. Creator-ONLY tags (prompt-
  // derived, may leak model names / private notes) never enter it; they travel
  // solely in the provenance partition below, where the booru stores them
  // private-by-default and withholds them from every public projection.
  // WHO POSTED IT, as a public label. Minted from the sender of this event,
  // which this homeserver authenticated, so the tag matches the MXID exactly.
  // It is a LABEL, not proof: any member can edit a post's tags, so what the
  // booru trusts for "who is the creator" is the record written just after
  // createPost below, never this tag. Null for a remote sender or a localpart
  // that is not tag-safe; see poster.js.
  const posterTag = poster.posterTagFor(event.sender, config.homeserver.domain);
  if (!posterTag) {
    console.warn(`[poster] no artist tag for sender ${event.sender}; posting unattributed`);
  }
  // "ai-generated" when the strip removed a generator's own signal: the booru
  // used to derive it from the file's metadata, and the file it reads no longer
  // has any. Not when it removed only something shaped like a prompt, which a
  // photo's caption can be.
  const publicTags = imagePlan.publicTagsFor({ autoTags, metaTags, ocTags, posterTag, aiGenerated: plan.aiGenerated });
  const rating = (derived && derived.rating) || config.bridge.default_rating;

  let post;
  try {
    post = await danbooru.createPost(uploadMediaAssetId, {
      rating,
      tagString: publicTags.join(" "),
      source: mxcUrl,
    });
  } catch (err) {
    // The booru's own word for a hidden duplicate since chanbooru's fix of
    // 2026-10-02: 422, reason "unpostable", no post named. Final, like the
    // redirect form above it.
    if (err instanceof BooruRefusal && !(err instanceof BooruDuplicate) && err.status === 422 && err.reason === "unpostable") {
      console.log(
        `[skip] ${mxcUrl}: the booru refuses these bytes (md5 ${plan.upload.md5}) as unpostable -- it holds them under ` +
        `a post this account cannot see, deleted or jailed. Not reposted and no tag state written; nothing to retry. ` +
        `If it should be live, release it on the booru, then !backfill restart in ${roomId} writes the room's tags.`,
      );
      return imagePlan.HELD_HIDDEN;
    }
    if (!(err instanceof BooruDuplicate)) throw err;
    return heldByTheBooru(bridge, { roomId, mxcUrl, md5: plan.upload.md5, postId: err.duplicateOf });
  }

  // WHO MADE IT, recorded once, now, from the event this homeserver
  // authenticated (operator ruling 2026-09-29: the creator decides who sees a
  // post's private data). First after the post exists, before anything private
  // is hung on it. Fail-soft and loud: without it the private data is visible
  // to nobody, which is the safe way to be wrong.
  //
  // Fail-soft from here down: the post is CREATED. Anything after it that
  // throws must not report the picture as lost, or a run reads as a total
  // failure while the booru fills up correctly.
  await imagePlan.recordCreator(
    (postId, mxid) => danbooru.recordPostCreator(postId, mxid),
    { postId: post.id, mxid: event.sender, log: (line) => console.warn(line) },
  );

  // Now that the post exists, the tag exists too -- as a general tag. Promote
  // it. Deliberately after createPost for that reason.
  try {
    await categoriseArtist(posterTag);
  } catch (err) {
    console.warn(`[poster] artist tag not categorised for post #${post.id}: ${err.message}`);
  }

  // The generation data went to the booru's private store already, from canon.js,
  // keyed by the md5 of the one file -- the same bytes this post holds.

  // Single write path (the tag hub): hand the FULL partition to the booru. It
  // records it, keeps creator-only tags private, fans out to consumers, and hands
  // back the PUBLIC-SAFE projection we write into the room-public Matrix state.
  // THE LAMP (operator ruling 2026-09-20): the booru records which MODEL
  // reported each tag and draws a dot per tag from it. The tunnel has only
  // ever called spectrum, so everything the autotagger returned -- the
  // auto-only tags AND the ones the prompt also named -- is spectrum's.
  const partition = { creator: creatorOnly, auto: autoOnly, both, meta: metaTags, oc: ocTags, spectrum: [...autoOnly, ...both, ...metaTags] };
  let projection = null;
  try {
    const recorded = await danbooru.recordTagSources(post.id, partition);
    projection = recorded && recorded.projection;
  } catch (err) {
    console.warn(`[tag-hub] recordTagSources failed for post #${post.id}: ${err.message}`);
  }
  // If the hub is unreachable, fall back to the booru's tag_string -- still
  // public-safe, since creator-only tags were never written to it.
  if (!projection) {
    try {
      const fullPost = await danbooru.getPost(post.id);
      projection = {
        tags: (fullPost.tag_string || "").split(/\s+/).filter(Boolean),
        sources: { creator: [], auto: autoOnly, both, meta: metaTags },
      };
    } catch (err) {
      console.warn(`[tag-hub] could not read back post #${post.id}: ${err.message}`);
      projection = { tags: publicTags, sources: { creator: [], auto: autoOnly, both, meta: metaTags } };
    }
  }

  const intent = bridge.getIntent();
  try {
    await intent.sendStateEvent(roomId, TAG_STATE_TYPE, mxcUrl, {
      post_id: post.id,
      tags: projection.tags,
      rating,
      // PUBLIC-SAFE provenance for the redesigned tag buckets. Creator-only tags are
      // withheld by the booru and surface only via its identity-gated read.
      sources: projection.sources,
      updated_by: "tunnel",
      updated_at: Date.now(),
    });
  } catch (err) {
    console.warn(`[tag-state] post #${post.id} was created but its state was refused in ${roomId}: ${err.message}`);
    return "tags-blocked";
  }
  const stripped = Object.keys(plan.removed).length;
  console.log(`[done] post #${post.id} tagged (${creatorOnly.length} creator[private] / ${autoOnly.length} auto / ${both.length} both / ${metaTags.length} meta / ${ocTags.length} oc)` +
    (stripped ? `, ${stripped} generation field(s) stripped from the file` : ""));
  return "posted";
}

// Build the deps object handleInvite needs, backed by a bot Intent.
function inviteDeps(bridge) {
  const intent = bridge.getIntent();
  return {
    join: (roomId) => intent.join(roomId),
    leave: (roomId) => intent.leave(roomId),
    isRoomDenied: (roomId) => rooms.isDenied(roomId),
    readPowerLevels: (roomId) =>
      intent.getStateEvent(roomId, "m.room.power_levels", ""),
    sendDM: async (userId, text) => {
      // Create (or reuse) a direct room with the user, then send.
      const room = await intent.createRoom({
        createAsClient: true,
        options: {
          preset: "trusted_private_chat",
          invite: [userId],
          is_direct: true,
        },
      });
      const roomId = room.room_id || room.roomId;
      await intent.sendText(roomId, text);
    },
  };
}

// The bot admin list. `admins` is the name going forward; strike_reset_admins
// is what deployments already have on disk, and reading both means this command
// works today without anyone editing a config file on the server first.
function botAdmins() {
  return config.bridge.admins || config.bridge.strike_reset_admins || [];
}

// Ask Synapse which rooms one bot identity is joined to, then name them.
// Masquerades through the appservice token.
async function joinedRoomsFor(userId) {
  const base = config.homeserver.url.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${AS_TOKEN}` };
  const q = `user_id=${encodeURIComponent(userId)}`;

  const res = await fetch(`${base}/_matrix/client/v3/joined_rooms?${q}`, { headers: auth });
  if (!res.ok) throw new Error(`joined_rooms ${res.status}`);
  const ids = (await res.json()).joined_rooms || [];

  // Names are a nicety, so a room that will not answer is listed by id rather
  // than failing the whole command. Sequential on purpose: this is an admin
  // typing a command, not a hot path, and a burst of ninety parallel requests
  // against Synapse to answer it would be rude.
  const rooms = [];
  for (const roomId of ids) {
    let name = null;
    try {
      const r = await fetch(
        `${base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/?${q}`,
        { headers: auth },
      );
      if (r.ok) name = (await r.json()).name || null;
    } catch {
      name = null;
    }
    rooms.push({ roomId, name });
  }
  return listrooms.sortRooms(rooms);
}

// Handle the !listrooms admin command. DM-only, like the others: a bot's full
// room list is not something to print into a room full of people.
// "!leaveroom <id>", "!rejoinroom <id>", "!deniedrooms" -- admin, DM only.
//
// The everyday way to remove the bot is to remove it in a client, which the
// membership handler above turns into a denial by itself. These exist for
// doing it from somewhere else, for lifting it again, and for reading the
// list back -- which nothing else can show, since the list is the only record
// of a room the bot is deliberately not in.
async function handleRoomDenyCommands(bridge, event) {
  const body = event.content && event.content.body;
  if (!body) return false;
  const [cmd, arg] = body.trim().split(/\s+/);
  if (!["!leaveroom", "!rejoinroom", "!deniedrooms"].includes(cmd)) return false;

  const sender = event.sender;
  const intent = bridge.getIntent();
  if (!botAdmins().includes(sender)) {
    invites.audit({ kind: "roomdeny_denied_not_admin", sender, cmd });
    return true;
  }
  if ((await joinedMemberCount(bridge, event.room_id)) !== 2) {
    invites.audit({ kind: "roomdeny_denied_not_dm", sender, cmd, room: event.room_id });
    return true;
  }

  if (cmd === "!deniedrooms") {
    const list = rooms.listDenied();
    const text = list.length
      ? list.map((r) => `${r.room} -- ${r.reason}, by ${r.by}, ${new Date(r.at).toISOString()}`).join("\n")
      : "No rooms are denied. Removing the bot from a room in your client adds it here.";
    await intent.sendText(event.room_id, text);
    return true;
  }

  if (!rooms.looksLikeRoomId(arg)) {
    await intent.sendText(event.room_id,
      `${cmd} needs a room id, like ${cmd} !abcdef:41chan.net. An alias will not do: the list is ` +
      "kept by id, because that is what an alias can be repointed away from.");
    return true;
  }

  if (cmd === "!rejoinroom") {
    const lifted = rooms.allow(arg);
    invites.audit({ kind: "room_allowed", room: arg, by: sender, lifted });
    await intent.sendText(event.room_id, lifted
      ? `${arg} is no longer denied. It is not joined either -- invite the bot from somebody with ` +
        "at least the invite power level and it will accept, which is the ordinary door."
      : `${arg} was not on the list, so nothing changed.`);
    return true;
  }

  // !leaveroom: deny FIRST, then leave. The other order leaves a window in
  // which the leave has happened and the denial has not, and anything that
  // touched the room in that window would put it straight back.
  const added = rooms.deny(arg, { by: sender, reason: "!leaveroom" });
  let left = "already out";
  try {
    await intent.leave(arg);
    left = "left";
  } catch (e) {
    left = `could not leave (${e.message.slice(0, 120)})`;
  }
  invites.audit({ kind: "room_denied_by_command", room: arg, by: sender, added, left });
  await intent.sendText(event.room_id,
    `${arg}: ${left}, and it is now denied${added ? "" : " (it already was)"}. ` +
    `It will refuse invites there until "!rejoinroom ${arg}".`);
  return true;
}

async function handleListRoomsCommand(bridge, event) {
  const body = event.content && event.content.body;
  if (!body || body.trim().split(/\s+/)[0] !== "!listrooms") return false;

  const sender = event.sender;
  if (!botAdmins().includes(sender)) {
    invites.audit({ kind: "listrooms_denied_not_admin", sender });
    return true;
  }

  const intent = bridge.getIntent();
  if ((await joinedMemberCount(bridge, event.room_id)) !== 2) {
    invites.audit({ kind: "listrooms_denied_not_dm", sender, room: event.room_id });
    return true;
  }

  const identities = listrooms.botIdentities({
    domain: config.homeserver.domain,
    senderLocalpart: _reg.sender_localpart,
  });

  const sections = [];
  for (const id of identities) {
    try {
      sections.push({ userId: id.userId, rooms: await joinedRoomsFor(id.userId) });
    } catch (e) {
      // Reported in the reply rather than swallowed: "no rooms" and "we could
      // not ask" are different answers and must not look the same.
      sections.push({ userId: id.userId, rooms: [], error: e.message });
    }
  }

  invites.audit({
    kind: "listrooms",
    admin: sender,
    counts: sections.map((s) => `${s.userId}=${s.error ? "error" : s.rooms.length}`).join(","),
  });
  await intent.sendText(event.room_id, listrooms.formatRoomList(sections));
  return true;
}

// Handle the !backfill admin command. Runs in the room it is sent in, which is
// the room being caught up -- unlike the other admin commands, this one is
// ABOUT a room, so requiring a DM would mean naming the room by id.
//
//   !backfill           resume this room's walk where the last run stopped; a
//                       room already walked to its start is walked again from
//                       the live edge (an explicit ask overrides "done")
//   !backfill restart   walk again from the live edge whatever was done --
//                       how tag state blocked on an earlier run gets written
async function handleBackfillCommand(bridge, event) {
  const body = event.content && event.content.body;
  const words = body ? body.trim().split(/\s+/) : [];
  if (words[0] !== "!backfill") return false;

  const sender = event.sender;
  if (!botAdmins().includes(sender)) {
    invites.audit({ kind: "backfill_denied_not_admin", sender, room: event.room_id });
    return true;
  }

  const intent = bridge.getIntent();
  const botUserId = `@${_reg.sender_localpart}:${config.homeserver.domain}`;
  const restart = words[1] === "restart";
  await intent.sendText(event.room_id, restart
    ? "Walking this room's history for images again, from the newest..."
    : "Walking this room's history for images...");
  const result = await backfillRoomNow(bridge, event.room_id, botUserId, { trigger: "command", restart });
  const outcome = result.error ? "failed" : result.skipped ? `skipped: ${result.skipped}` : `${result.done}/${result.seen}`;
  invites.audit({ kind: "backfill", admin: sender, room: event.room_id, restart, result: outcome });
  let reply;
  if (result.error) reply = `Backfill failed: ${result.error}. The next sweep tries again; see the bridge log.`;
  else if (result.skipped) reply = `Backfill not run: ${result.skipped}.`;
  else reply = backfill.summarise(result);
  if (result.tagsBlocked) {
    reply +=
      "\n\nTags were NOT written back to this room: I do not have permission to " +
      "send " + TAG_STATE_TYPE + " here. Run tools/grant-tag-write.sh, then send " +
      "!backfill restart.";
  }
  await intent.sendText(event.room_id, reply);
  return true;
}

// Handle the !resetstrikes admin command. DM-only: requires sender in the
// admin list AND a two-member room (bot + admin).
async function handleResetCommand(bridge, event) {
  const body = event.content && event.content.body;
  if (!body || !body.startsWith("!resetstrikes")) return false;

  const sender = event.sender;
  if (!botAdmins().includes(sender)) {
    invites.audit({ kind: "reset_denied_not_admin", sender });
    return true;
  }

  const intent = bridge.getIntent();
  // Confirm this is a DM: exactly two members.
  let memberCount = 0;
  try {
    const state = await intent.roomState(event.room_id);
    memberCount = state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch (err) {
    // NOT zero. Zero is a claim about the room; this is a failure to look, and
    // the two must not share a value when the next line branches on it.
    console.warn(`[dm] could not read membership, treating as unknown: ${err.message}`);
    memberCount = -1;
  }
  if (memberCount !== 2) {
    invites.audit({ kind: "reset_denied_not_dm", sender, room: event.room_id });
    return true;
  }

  const target = body.split(/\s+/)[1];
  if (!target) {
    await intent.sendText(event.room_id, "Usage: !resetstrikes @user:domain");
    return true;
  }

  const state = invites.loadStrikes();
  const had = state[target] ? state[target].strikes : 0;
  delete state[target];
  invites.saveStrikes(state);
  invites.audit({ kind: "strikes_reset", admin: sender, target, cleared: had });
  await intent.sendText(
    event.room_id,
    `Cleared ${had} strike${had === 1 ? "" : "s"} for ${target}.`
  );
  return true;
}

// What !rescan reads: the RAW original through canon.js (superseded/ holds it
// once the image is canonical, until the operator deletes it), else the one
// file itself -- which still finds the post, with no generation text to re-read.
// Synapse's own copy is not asked for: after canon it is not where Synapse
// would look.
async function canonRawForRescan(mxcUrl) {
  const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxcUrl);
  if (!m || m[1] !== config.homeserver.domain) throw new Error(`${mxcUrl} is not media on this homeserver`);
  const c = await getCanon().canonicalize(m[2], { withBytes: true });
  if (c.kind !== "canonical") throw new Error(`${mxcUrl} is ${c.kind}${c.reason ? `: ${c.reason}` : ""}`);
  // No raw original, no rescan: re-reading the STRIPPED file finds no prompt,
  // and a rescan that reads nothing replaces the post's creator tags with
  // nothing. Refused in words instead.
  if (!c.raw) {
    throw new Error(`the original of ${mxcUrl}, the only file that carried its generation data, is gone (superseded/ was cleared). There is nothing to re-read; the post's creator tags are left as they are.`);
  }
  return { buffer: c.raw, contentType: c.media_type };
}

// The bridge bot's !rescan, through the shared capability: an admin, in a
// DM, names an mxc url or an md5, and the image's own metadata is read again
// and its creator provenance rewritten on the booru. The same deps the CLI
// (rescan.js) hands it, so the two cannot drift.
function rescanDeps(bridge) {
  return {
    download: (mxc) => canonRawForRescan(mxc),
    findPostByMd5: (md5) => danbooru.findPostByMd5(md5),
    getTagProjection: (id) => danbooru.getTagProjection(id),
    recordTagSources: (id, partition) => danbooru.recordTagSources(id, partition),
    recordGenerationMetadata: (md5, body) => danbooru.recordGenerationMetadata(md5, body),
    findByRawMd5: (rawMd5) => danbooru.findGenerationByRawMd5(rawMd5),
    extract: extractCreatorTags,
    creatorTags: extractCreatorTagsFromFields,
    strip: stripGeneration,
    maxCreatorTags: config.autotagger && config.autotagger.max_creator_tags,
    sendText: (room, text) => bridge.getIntent().sendText(room, text),
    admins: botAdmins(),
    isDm: async (room) => (await joinedMemberCount(bridge, room)) === 2,
    audit: (record) => invites.audit(record),
  };
}
async function handleRescanCommand(bridge, event) {
  return rescanCapability.handleRescanCommand(event, rescanDeps(bridge));
}

// The bridge bot's !setavatar, through the shared capability.
//
// The body used to live here AND again in onboarding.js, and the two had
// drifted: the greeter recorded an avatar change in the audit log and this one
// did not. One implementation now, so a fix reaches both and neither can
// quietly stop leaving evidence. See capabilities/avatar.js.
async function handleAvatarFlow(bridge, event) {
  const intent = bridge.getIntent();
  return avatarCapability.handleAvatarFlow(event, {
    setAvatarUrl: (mxc) => intent.setAvatarUrl(mxc),
    sendText: (room, text) => intent.sendText(room, text),
    joinedMemberCount: (room) => joinedMemberCount(bridge, room),
    admins: botAdmins(),
    pending: avatarPending,
    audit: invites.audit,
  });
}

// BOOT ONLY WHEN RUN AS THE ENTRYPOINT.
//
// Everything above is the image pipeline, and a catch-up tool needs to reuse it
// exactly rather than reimplement it -- a second copy of "what a picture means"
// is how two paths drift and only one gets fixed. Requiring this file used to
// start a whole bridge as a side effect, so reuse was impossible and copying was
// the only option. `node index.js` is unaffected: require.main is this module.
if (require.main === module) {
new Cli({
  registrationPath: "tunnel-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId("fourier-tunnel");
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("tunnel");
    reg.addRegexPattern("users", "@.*", false);
    callback(reg);
  },
  run: function (port) {
    const bridge = new Bridge({
      homeserverUrl: config.homeserver.url,
      domain: config.homeserver.domain,
      registration: "tunnel-registration.yaml",
      controller: {
        onUserQuery: function () {
          return {};
        },
        onEvent: async function (request) {
          const event = request.getData();
          // The robot wanted me to erase this, but I think it's funny, so I'm leaving it here
          // Derived from the registration, not spelled out: the rename to
          // @fourier is a sender_localpart change and nothing else.
          const botUserId = `@${_reg.sender_localpart}:${config.homeserver.domain}`;

          try {
            // Invite directed at the bot
            if (
              event.type === "m.room.member" &&
              event.content &&
              event.content.membership === "invite" &&
              event.state_key === botUserId
            ) {
              const verdict = await invites.handleInvite(event, inviteDeps(bridge), config);
              console.log(`[invite] ${event.sender} -> ${event.room_id}: ${verdict}`);
              return;
            }

            // The bot has been REMOVED from a room: it stays out.
            //
            // Being kicked or banned is the natural way to say "get out and
            // do not come back", so it is the gesture that records the
            // denial -- an involuntary removal gets the same teardown as the
            // voluntary one. Without this the removal does not stick at all:
            // the library re-joins before the next send OR READ (see
            // rooms.js), so the bot reappears without anyone asking it to.
            if (
              event.type === "m.room.member" &&
              event.content &&
              (event.content.membership === "leave" || event.content.membership === "ban") &&
              event.state_key === botUserId &&
              event.sender !== botUserId          // it leaving on its own is not a denial
            ) {
              const added = rooms.deny(event.room_id, {
                by: event.sender,
                reason: event.content.membership === "ban" ? "banned" : "removed",
              });
              invites.audit({ kind: "room_denied_on_removal", room: event.room_id,
                              by: event.sender, membership: event.content.membership, added });
              console.log(`[rooms] ${event.sender} removed the bot from ${event.room_id}; ` +
                          `it will not go back (lift with !rejoinroom ${event.room_id})`);
              return;
            }

            // Nothing else happens in a denied room. The guard in rooms.js is
            // what makes that true even for code paths nobody has thought of;
            // this just avoids doing the work to reach one.
            if (event.room_id && rooms.isDenied(event.room_id)) return;

            // The bot has ENTERED a room: catch it up on what it missed.
            // Fires on the actual join, so it runs once per entry rather than
            // on every restart. Not awaited -- a room with a long history would
            // otherwise hold up the appservice transaction this event arrived
            // in, and Synapse would start retrying it.
            if (
              event.type === "m.room.member" &&
              event.content &&
              event.content.membership === "join" &&
              event.state_key === botUserId
            ) {
              // A membership event whose PREVIOUS membership was also join is
              // a profile change (the display name is set at every startup),
              // not an entry. Both reach backfillRoomNow, which skips a room
              // already walked to its start; a real re-entry walks the gap
              // the bot was away for.
              const prev = event.unsigned && event.unsigned.prev_content && event.unsigned.prev_content.membership;
              const trigger = prev && prev !== "join" ? "rejoin" : "join";
              console.log(`[backfill] ${trigger === "rejoin" ? "re-entered" : "membership event in"} ${event.room_id}; checking its history walk`);
              void backfillRoomNow(bridge, event.room_id, botUserId, { trigger });
              // Deliberately no return: a join is not consumed by this.
            }

            // Skip any non-invite event from a room the bot isn't joined to.
            // This ACKs (drains) backlog left over from a previously over-broad
            // appservice namespace, and is correct defense-in-depth: the bridge
            // only ever acts in rooms it was invited into and joined.
            if (!(await botIsJoined(bridge, event.room_id, botUserId))) {
              return;
            }

            if (event.type === "m.room.message" && event.content) {
              // Admin reset command (DM only)
              if (await handleResetCommand(bridge, event)) return;
              if (await handleRoomDenyCommands(bridge, event)) return;
              if (await handleListRoomsCommand(bridge, event)) return;
              if (await handleBackfillCommand(bridge, event)) return;
              if (await handleRescanCommand(bridge, event)) return;
              // Avatar-setting flow (admin DM) -- checked before tagging
              if (await handleAvatarFlow(bridge, event)) return;
              // Image tagging
              if (event.content.msgtype === "m.image") {
                // DM policy: skip tagging in 2-member rooms unless tag_in_dms is on
                if (!config.bridge.tag_in_dms) {
                  const members = await joinedMemberCount(bridge, event.room_id);
                  if (members === 2) {
                    console.log(`[skip] DM tagging disabled, room ${event.room_id}`);
                    return;
                  }
                }
                await handleImageEvent(bridge, event);
              }
            }
          } catch (err) {
            // Named by its request (backfill.describeFailure), like the backfill's.
            console.error(`[error] onEvent: ${backfill.describeFailure(err)}`);
          }
        },
      },
    });
    // FOURIER-CHAN IS NOT HERE. Since 2026-09-25 she is her own service on the
    // bot hub (fourier-basis ops/hetzner/guide) with her own registration:
    // onboarding, the !join on-ramp and !bugreport moved with her. Operator:
    // Fourier-chan "shouldn't need to run anything through Tunnel. We have a bot
    // hub explicitly so they are separate entities." Her code ran first for every
    // event this process heard, and the library's join-before-read made the
    // courier invite her into an admin's DM (bug-20260925-7434f348).
    console.log(`fourier-tunnel listening on port ${port}`);
    // EVERY intent comes through here -- index.js calls bridge.getIntent()
    // throughout -- so this is the one place
    // the denied-room guard has to be. Wrapping it here rather than at each
    // call site means a call site added tomorrow is covered today, which
    // matters because the thing being guarded (an automatic re-join inside
    // the library, before reads as well as writes) is invisible at the call
    // site and always will be.
    const rawGetIntent = bridge.getIntent.bind(bridge);
    bridge.getIntent = (...args) => rooms.guard(rawGetIntent(...args));

    // The media gate's way to ask for any Matrix original not yet canonical.
    // Built now, not on first image: a tunnel that cannot reach R2 must say so
    // at startup, not the first time somebody opens a picture.
    getCanon();
    startCanonService((config.canon && config.canon.port) || 8011);
    startThumbnailRetirement();
    // Resume every room whose history is not yet walked to its start.
    startBackfillSweep(bridge, `@${_reg.sender_localpart}:${config.homeserver.domain}`);

    bridge.run(port).then(async () => {
      try {
        await ensureBotUser(config, _reg);
        const displayName = (config.bridge && config.bridge.display_name) || "Fourier";
        await bridge.getIntent().setDisplayName(displayName);
        console.log(`[startup] display name set to ${displayName}`);
      } catch (e) {
        console.error("[startup] failed to register bot user:", e.message);
      }
    });
  },
}).run();
}

// The pipeline, for tools that drive it with their own reader and their own
// writer. handleImageEvent takes anything with getIntent().sendStateEvent --
// the real Bridge in the service, a thin stand-in in a tool -- because that is
// the only thing it asks of it.
module.exports = { handleImageEvent, TAG_STATE_TYPE, AS_TOKEN, config, setCanon, startCanonService, backfillRoomNow, backfillSweep };
