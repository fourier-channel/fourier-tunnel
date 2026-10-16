#!/usr/bin/env node
"use strict";

// RE-POINT ROOMS FROM A MERGED (RETIRED) BOORU POST TO ITS SURVIVOR.
//
//   node tools/repoint-merged.js --pair 1234:1200 --pair 1301:1299          plan only
//   node tools/repoint-merged.js --pairs-file merged.json --apply           writes
//   ... --homeserver http://localhost:8008     where Synapse answers from HERE
//
// merged.json is [{ "retired": 1234, "survivor": 1200 }, ...]. --pair and
// --pairs-file may be combined; the pairs are checked together before
// anything is read: positive integers, retired != survivor, no post retired
// twice, and no survivor that is itself retired in the list (a chain would
// point a room at a post that is going away -- name the final survivor).
//
// WHY (operator ruling 2026-10-16). Duplicate booru posts of one picture are
// MERGED on the booru: one post SURVIVES, the other is RETIRED, and the
// retired post's Matrix image becomes an mxc alias of the survivor -- "no
// copies and no visibility loss". The booru side is chanbooru's. Here, every
// room's tag state (net.41chan.media.tags, state_key = the picture's mxc)
// that still names a retired post is re-pointed at the survivor, exactly as
// the bridge points a room at an existing post for a duplicate image: through
// index.js pointRoomAtPost itself -- the survivor's PUBLIC-SAFE projection
// (getTagProjection), the quarantine-checked tag_string fallback when it has
// none (checkedFallback: a flagged or banished name is never written, and an
// unreadable list writes nothing), and no write when the room already says
// it (tagStateIsCurrent). aliased: true -- the booru already maps the mxc to
// the survivor, so no second alias report is sent.
//
// THE WALK is the quarantine re-projection's (tag-state-walk.js): the bridge's
// joined rooms read once, denied rooms never touched, one state read per room,
// paced writes, and per-room and per-event isolation -- one failure never
// stops the walk; every failure is counted, listed with its fix, and makes
// the exit code 1.
//
// DRY RUN IS THE DEFAULT, for the reason tools/catch-up-room.js gives: a flag
// that must be delivered to be safe will one day not be. A dry run reads the
// rooms only; it asks the booru nothing and writes nothing.
//
// --apply looks each survivor up on the booru first, as the tunnel's account
// sees it, and reads its public projection once -- a projection read that
// fails is a FAIL for the pair, never the raw tag_string written instead. A survivor that is missing or hidden from that account (deleted,
// jailed, flagged and uploaded by another bot) is NOT written for -- the room
// keeps naming the retired post -- and is reported loudly, with the fix.
// Every booru request carries the key in a Basic header, never in a URL
// (danbooru.js findVisiblePost, getTagProjection), and errors name paths.
//
// IDEMPOTENT: a re-pointed event names the survivor, so a re-run does not
// select it; a re-run after success writes nothing.
//
// Output, tab-separated, then a summary on lines starting "#":
//   REPOINT    <room> <mxc> <retired> -> <survivor>            (dry run)
//   REPOINTED  <room> <mxc> <retired> -> <survivor>            (written)
//   CURRENT    <room> <mxc> <retired> -> <survivor>            (already said it)
//   MISSING    <room> <mxc> <retired> -> <survivor>  <why; fix>
//   FAIL       <room> <mxc> <retired> -> <survivor>  <why; fix>
//   ROOM-FAIL  <room> <why; fix>
//   # room <n>/<N> <room>: ...                                 (progress)

const { walkTagState } = require("../tag-state-walk");
const { BooruRefusal } = require("../danbooru");

// Synapse rate-limits state events (quarantine.js QUARANTINE_PACE_MS).
const PACE_MS = Number(process.env.REPOINT_PACE_MS || 750);
// Each homeserver call, as the booru client's own axios timeout.
const HS_TIMEOUT_MS = 30000;

const PAIR_FORMAT = "fix: give each pair as --pair <retiredPostId>:<survivorPostId>, or a --pairs-file holding [{\"retired\": <id>, \"survivor\": <id>}]";

/**
 * The pairs, retired -> survivor, from --pair arguments and/or the text of a
 * --pairs-file. Throws, naming the fix, on anything that is not a clean set.
 */
function parsePairs({ pairArgs = [], pairsJson } = {}) {
  const raw = [];
  for (const a of pairArgs) {
    const m = /^(\d+):(\d+)$/.exec(String(a));
    if (!m) throw new Error(`--pair "${a}" is not <retiredPostId>:<survivorPostId>; ${PAIR_FORMAT}`);
    raw.push({ retired: Number(m[1]), survivor: Number(m[2]), from: `--pair ${a}` });
  }
  if (pairsJson !== undefined) {
    let list;
    try {
      list = JSON.parse(pairsJson);
    } catch (err) {
      throw new Error(`the pairs file is not JSON (${err.message}); ${PAIR_FORMAT}`);
    }
    if (!Array.isArray(list)) throw new Error(`the pairs file must hold a JSON array; ${PAIR_FORMAT}`);
    list.forEach((e, i) => raw.push({ retired: e && e.retired, survivor: e && e.survivor, from: `pairs file entry ${i}` }));
  }
  if (!raw.length) throw new Error(`no pairs given; ${PAIR_FORMAT}`);
  const pairs = new Map();
  for (const p of raw) {
    if (![p.retired, p.survivor].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error(`${p.from}: post ids must be positive integers (got ${JSON.stringify(p.retired)} and ${JSON.stringify(p.survivor)}); ${PAIR_FORMAT}`);
    }
    if (p.retired === p.survivor) throw new Error(`${p.from}: #${p.retired} is both retired and survivor; fix: name the post it was merged INTO as the survivor`);
    if (pairs.has(p.retired)) throw new Error(`${p.from}: #${p.retired} is retired twice (into #${pairs.get(p.retired)} and #${p.survivor}); fix: a post is merged into one survivor -- keep the right pair and drop the other`);
    pairs.set(p.retired, p.survivor);
  }
  for (const [retired, survivor] of pairs) {
    if (pairs.has(survivor)) {
      throw new Error(`survivor #${survivor} (of #${retired}) is itself retired, into #${pairs.get(survivor)}; fix: name the final survivor for both -- --pair ${retired}:${pairs.get(survivor)}`);
    }
  }
  return pairs;
}

/**
 * Walk every room and re-point tag state naming a retired post. Everything it
 * touches is passed in, so the test drives it with index.js's real
 * pointRoomAtPost against a stand-in booru and homeserver.
 *   pairs              Map retired -> survivor (parsePairs)
 *   bridge             getIntent() -> { roomState, getStateEvent, sendStateEvent }
 *   stateType, roomIds, skipRoom   as tag-state-walk.js
 *   findSurvivor(id)   -> post | null (hidden); throws when the booru could not say
 *   readProjection(id) -> the post's public projection | null (none recorded);
 *                         throws when the booru could not say
 *   pointRoomAtPost    index.js's
 * Resolves the tally; exitCodeFor(tally) is the run's exit code.
 */
async function repointMerged({ pairs, apply, bridge, stateType, roomIds, skipRoom, findSurvivor, readProjection, pointRoomAtPost, paceMs = PACE_MS, sleep, out }) {
  const s = { pairs: pairs.size, rooms: 0, unreadable: 0, events: 0, written: 0, current: 0, missing: 0, failed: 0, failures: [] };
  const pause = sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));

  // One lookup per survivor per run: { post, projection } | { hidden } |
  // { error }. The projection is read HERE, not left to pointRoomAtPost:
  // that one, serving a live upload, takes a failed read as "none recorded"
  // and writes the post's raw tag_string -- which can carry a private
  // creator tag the projection exists to keep out of rooms -- and a re-run
  // would never revisit it, since the event then names the survivor. Here a
  // read that fails is a FAIL for the pair, and only a clean "none recorded"
  // (null) reaches the quarantine-checked fallback.
  const survivors = new Map();
  const didNotAnswer = (err, path) => (err instanceof BooruRefusal ? err.message : `${path}: the booru did not answer (${err.code || "no response"})`);
  const survivorFor = async (id) => {
    if (!survivors.has(id)) {
      let got;
      try {
        const post = await findSurvivor(id);
        got = post ? { post } : { hidden: true };
      } catch (err) {
        got = { error: didNotAnswer(err, `GET /posts/${id}.json`) };
      }
      if (got.post) {
        try {
          got.projection = await readProjection(id);
        } catch (err) {
          got = { error: didNotAnswer(err, `GET /posts/${id}/tag_sources.json`) };
        }
      }
      survivors.set(id, got);
    }
    return survivors.get(id);
  };

  // pointRoomAtPost says "posted" whether it wrote or found the room already
  // current, and "tags-blocked" whether the room refused the write or the
  // fallback could not be checked. The intent it is handed tells them apart.
  let sent = 0;
  let sendError = null;
  const counted = {
    getIntent: () => {
      const intent = bridge.getIntent();
      return {
        getStateEvent: (...a) => intent.getStateEvent(...a),
        sendStateEvent: async (...a) => {
          try {
            const r = await intent.sendStateEvent(...a);
            sent += 1;
            return r;
          } catch (err) {
            sendError = err;
            throw err;
          }
        },
      };
    },
  };

  const said = (kind, cols, why) => {
    out([kind, ...cols, ...(why ? [why] : [])].join("\t"));
    if (why) s.failures.push(`${cols.join(" ")}: ${why}`);
  };

  s.rooms = await walkTagState({
    bridge, stateType, roomIds, skipRoom,
    select: (e) => pairs.has(e.content.post_id),
    onUnreadable: (roomId, err, i, n) => {
      s.unreadable += 1;
      s.failed += 1;
      said("ROOM-FAIL", [roomId], `its state could not be read (${err.message}); fix: check the tunnel is joined there and the homeserver answers, then run this again`);
      out(`# room ${i + 1}/${n} ${roomId}: UNREADABLE`);
    },
    onRoom: async (roomId, events, i, n) => {
      let roomWritten = 0;
      for (const ev of events) {
        s.events += 1;
        const retired = ev.content.post_id;
        const survivor = pairs.get(retired);
        const cols = [roomId, ev.state_key, `${retired} -> ${survivor}`];
        if (!apply) {
          said("REPOINT", cols);
          continue;
        }
        try {
          const got = await survivorFor(survivor);
          if (got.hidden) {
            s.missing += 1;
            said("MISSING", cols, `survivor #${survivor} is missing or hidden from the tunnel's booru account (deleted, jailed, or flagged and uploaded by another account), so the room still names #${retired}; ` +
              `fix: on the booru, make #${survivor} the live survivor of the merge of #${retired} and visible to the tunnel's account (undelete or release it) -- or correct the pair -- then run this again with --apply`);
            continue;
          }
          if (got.error) {
            s.failed += 1;
            said("FAIL", cols, `the survivor or its public projection could not be read (${got.error}), so nothing was written; fix: wait for the booru to answer, then run this again with --apply`);
            continue;
          }
          // Paced from the second write on, as the quarantine walk is.
          if (sent && paceMs) await pause(paceMs);
          const before = sent;
          sendError = null;
          const outcome = await pointRoomAtPost(counted, {
            roomId, mxcUrl: ev.state_key, existing: got.post, md5: got.post.md5,
            via: `merge: retired post #${retired}`, aliased: true, projection: got.projection,
          });
          if (sent > before) {
            s.written += 1;
            roomWritten += 1;
            said("REPOINTED", cols);
          } else if (outcome === "posted") {
            s.current += 1;
            said("CURRENT", cols);
          } else if (sendError) {
            s.failed += 1;
            const forbidden = (sendError.errcode || (sendError.body && sendError.body.errcode)) === "M_FORBIDDEN";
            said("FAIL", cols, `the room refused the tag-state write (${sendError.message}); fix: ` +
              (forbidden ? `run tools/grant-tag-write.sh for ${roomId}, then run this again with --apply` : "run this again with --apply"));
          } else {
            s.failed += 1;
            said("FAIL", cols, `survivor #${survivor} has no recorded projection and the booru's quarantine list could not be read to check its tag_string, so nothing was written; ` +
              "fix: wait for the booru's /fourier_jail/release.json to answer the tunnel's account, then run this again with --apply");
          }
        } catch (err) {
          s.failed += 1;
          said("FAIL", cols, `${String(err.message).replace(/\s+/g, " ")}; fix: run this again with --apply`);
        }
      }
      out(`# room ${i + 1}/${n} ${roomId}: ${events.length} tag-state event(s) naming a retired post` + (apply ? `, ${roomWritten} re-pointed` : ""));
    },
  });

  out(`# ${s.pairs} pair(s); rooms walked ${s.rooms} (unreadable ${s.unreadable}); tag-state events naming a retired post ${s.events}` +
    (apply
      ? `; re-pointed ${s.written}, already current ${s.current}, survivor missing ${s.missing}, failed ${s.failed}`
      : `; dry run -- nothing written, the booru not asked; failed ${s.failed}`));
  for (const f of s.failures) out(`# FAILED ${f}`);
  return s;
}

/** 0 when every room was read and every selected event re-pointed (or would be). */
function exitCodeFor(s) {
  return s.failed || s.missing ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const pairArgs = [];
  let pairsFile;
  let apply = false;
  let hsFlag;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--apply") apply = true;
    else if (a === "--pair" && i + 1 < args.length) pairArgs.push(args[++i]);
    else if (a === "--pairs-file" && i + 1 < args.length) pairsFile = args[++i];
    else if (a === "--homeserver" && i + 1 < args.length) hsFlag = args[++i];
    else {
      console.error(`FAIL: unknown or incomplete option ${a}. fix: the options are --pair <retired>:<survivor> (repeatable), --pairs-file <path>, --apply and --homeserver <url>, each spelled out in full.`);
      return 2;
    }
  }

  let pairs;
  try {
    const fs = require("fs");
    pairs = parsePairs({ pairArgs, pairsJson: pairsFile === undefined ? undefined : fs.readFileSync(pairsFile, "utf8") });
  } catch (err) {
    console.error(`FAIL: ${err.code === "ENOENT" ? `the pairs file ${pairsFile} does not exist; fix: give its path` : err.message}`);
    return 2;
  }

  // Before index is required: it resolves the homeserver URL once, at module
  // scope (tools/catch-up-room.js says why this ordering is the fix). An
  // exported HOMESERVER_URL wins over the flag.
  if (hsFlag && !process.env.HOMESERVER_URL) process.env.HOMESERVER_URL = hsFlag;
  const { pointRoomAtPost, joinedRoomIds, BOT_USER_ID, TAG_STATE_TYPE, AS_TOKEN, config } = require("../index");
  const { DanbooruClient } = require("../danbooru");
  const rooms = require("../rooms");
  const danbooru = new DanbooruClient(config.danbooru);
  const base = config.homeserver.url;

  // The three things pointRoomAtPost and the walk ask of a bridge, as the
  // bridge's own user. The token rides in a header; errors name the path.
  async function hs(method, path, body) {
    const sep = path.includes("?") ? "&" : "?";
    let res;
    try {
      res = await fetch(`${base}${path}${sep}user_id=${encodeURIComponent(BOT_USER_ID)}`, {
        method,
        headers: { Authorization: `Bearer ${AS_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        // One hung connection must not stall a walk of every room with no
        // output: it fails that room or event, as the booru client's 30 s does.
        signal: AbortSignal.timeout(HS_TIMEOUT_MS),
      });
    } catch (err) {
      if (err.name === "TimeoutError") throw new Error(`${method} ${path.replace(/\?.*/, "")}: the homeserver did not answer within ${HS_TIMEOUT_MS / 1000} s`);
      throw new Error(`${method} ${path.replace(/\?.*/, "")}: the homeserver did not answer (${err.cause ? err.cause.code || err.cause.message : err.message}); if this is the container's own hostname, pass --homeserver http://localhost:8008`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${method} ${path.replace(/\?.*/, "")} -> HTTP ${res.status}${data.errcode ? ` ${data.errcode}` : ""}`), { errcode: data.errcode, status: res.status });
    return data;
  }
  const state = (roomId) => `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`;
  const intent = {
    roomState: (roomId) => hs("GET", state(roomId)),
    getStateEvent: (roomId, type, key) => hs("GET", `${state(roomId)}/${encodeURIComponent(type)}/${encodeURIComponent(key)}`),
    sendStateEvent: (roomId, type, key, content) => {
      // Never reached in a dry run (repointMerged calls nothing that writes);
      // refused here too, so the flag is not the only thing between a dry
      // run and a write.
      if (!apply) throw new Error("a dry run never writes");
      return hs("PUT", `${state(roomId)}/${encodeURIComponent(type)}/${encodeURIComponent(key)}`, content);
    },
  };

  console.log(`# ${apply ? "APPLYING -- tag state naming a retired post is re-pointed at its survivor" : "DRY RUN -- nothing is written and the booru is not asked"}`);
  console.log(`# homeserver ${base}; writer ${BOT_USER_ID}; ${pairs.size} pair(s): ${[...pairs].map(([r, v]) => `${r}->${v}`).join(" ")}`);
  const s = await repointMerged({
    pairs, apply, bridge: { getIntent: () => intent }, stateType: TAG_STATE_TYPE,
    roomIds: () => joinedRoomIds(BOT_USER_ID),
    skipRoom: (roomId) => rooms.isDenied(roomId),
    findSurvivor: (id) => danbooru.findVisiblePost(id),
    readProjection: (id) => danbooru.getTagProjection(id),
    pointRoomAtPost,
    out: (line) => console.log(line),
  });
  if (!apply && s.events) console.log("# re-run with --apply to re-point them");
  return exitCodeFor(s);
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`FAIL: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { parsePairs, repointMerged, exitCodeFor };
