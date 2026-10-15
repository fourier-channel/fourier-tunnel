#!/usr/bin/env node
"use strict";

// GATE 3 BACKFILL: report every Matrix image canon has made canonical whose
// bytes are a booru post, as (post_id, mxc) -- what the live tunnel reports
// for every new post and every duplicate since gate 3 (gate3-aliases.js,
// fourier-basis docs/design/GATE3_CONTRACTS.md B). Images handled before that
// have no report; without one, the booru cannot show their post to the rooms
// they are in once gate 3 is on.
//
//   docker exec fourier-tunnel node tools/report-mxc-aliases.js                    report only
//   docker exec fourier-tunnel node tools/report-mxc-aliases.js --apply            send them
//   ... --start-after index/local/<mediaId>.json    resume after that key
//
// WHERE (mediaId -> md5) COMES FROM, checked in canon.js before this was
// written: canon writes index/local/<mediaId>.json for every Matrix original
// it is asked about, and a `kind: "canonical"` entry carries `md5` (the one
// stripped file, content-addressed as media/<md5>.<ext>) and `raw_md5` (the
// bytes Synapse holds). The post is found from those the same three ways the
// live duplicate check finds it (image-plan.js findPostForBytes: stripped md5,
// the booru's raw-md5 record, the raw md5). Bytes, not room state: a room's
// tag state is writable by its members, the md5 is not.
//
// WHAT IT COVERS THAT THE LIVE PATH DOES NOT, said so a reader decides with
// it in view: canon is asked about every Matrix original the media gate
// serves -- an avatar, a room icon, an emote, an image in a room the tunnel is
// not in -- so an mxc reported here may be one the tunnel never saw in a room.
// By the rule ("the post follows the image") the same bytes are the same
// image, and fourier-auth's answer for that mxc decides who sees it (a site
// asset counts for every verified viewer). It WIDENS relative to the live
// path, which reports only what it saw. Hence a dry run by default.
//
// And what it misses: a post the booru hides from the tunnel's account
// (deleted, jailed, another bot's flagged post) is not found by an md5 lookup,
// so its images are counted NOPOST here. Those posts are hidden anyway.
//
// Every request it makes to the booru -- both md5 lookups and the report --
// carries the key in a Basic header, never in a URL (booruLookups below,
// danbooru.js findGenerationByRawMd5 and reportMxcAlias): at one lookup per
// canonical image, a key in a query string would be in the access log once
// per image.
//
// Without --apply it SENDS NOTHING. With it, each report is the live path's
// own request (danbooru.js reportMxcAlias: a body carrying only mxc); the
// booru's record is UNIQUE(mxc) and
// idempotent, so a re-run has no second effect. Sent directly, NOT through
// the bridge's outbox: at a million images that file, re-read on every use,
// would be the wrong tool. A booru that is down, refuses the account, or
// predates gate 3 STOPS the run, naming the key to resume after.
//
// Output, tab-separated, then a summary:
//   ALIAS   <post_id>  <mxc>  <via>  [accepted]
//   DROP    <post_id>  <mxc>  <reason>          (no_such_post, mxc_mapped_elsewhere)
//   KEEP    <post_id>  <mxc>  <why>             (404: hidden from this account; re-run later)
//   ERR     <key>      <message>                (one index entry; the run goes on)
//   STOP    <key>      <message>                (the run stops; resume with --start-after)

const fs = require("fs");
const path = require("path");
const { findPostForBytes } = require("../image-plan");
const { BooruRefusal } = require("../danbooru");

const PREFIX = "index/local/";
// Gently, as tools/canon-backfill.js: one image's lookups every 500 ms.
const PACE_MS = 500;

/**
 * Walk canon's index from `startAfter` and report. Everything it touches is
 * passed in, so the test drives it against fakes.
 *   listPage(startAfter)   -> { keys: [...], more: bool }  (keys in order)
 *   readIndex(key)         -> Buffer | null
 *   findPostByMd5(md5)     -> post | null; THROWS when it could not find out
 *   findByRawMd5(rawMd5)   -> md5 | null; throws likewise
 *   reportMxcAlias(postId, mxc) -> { accepted, reason? } or throws
 * Resolves the summary; when `stopped`, `last` is the key to resume after.
 */
async function walk({ listPage, readIndex, findPostByMd5, findByRawMd5, reportMxcAlias, domain, apply, startAfter = null, paceMs = PACE_MS, sleep, out }) {
  const s = { listed: 0, canonical: 0, otherKinds: {}, nopost: 0, aliases: 0, accepted: 0, dropped: 0, kept: 0, errors: 0, last: startAfter, stopped: false };
  let after = startAfter;
  for (;;) {
    const page = await listPage(after);
    for (const key of page.keys) {
      s.listed += 1;
      const m = /^index\/local\/([A-Za-z0-9_-]{1,128})\.json$/.exec(key);
      if (!m) {
        s.errors += 1;
        out(["ERR", key, "not an index entry name"].join("\t"));
        s.last = key;
        continue;
      }
      const mxc = `mxc://${domain}/${m[1]}`;
      let found;
      try {
        const raw = await readIndex(key);
        const idx = raw ? JSON.parse(raw.toString("utf8")) : null;
        if (!idx || idx.kind !== "canonical") {
          const kind = (idx && idx.kind) || "missing";
          s.otherKinds[kind] = (s.otherKinds[kind] || 0) + 1;
          s.last = key;
          continue;
        }
        if (!/^[0-9a-f]{32}$/.test(idx.md5 || "") || !/^[0-9a-f]{32}$/.test(idx.raw_md5 || "")) throw new Error("a canonical entry without md5 and raw_md5");
        s.canonical += 1;
        found = await findPostForBytes({ rawMd5: idx.raw_md5, strippedMd5: idx.md5 }, findPostByMd5, findByRawMd5);
        await sleep(paceMs);
      } catch (err) {
        if (err && err.lookup) {
          // The booru could not say whether a post exists: not "no post".
          s.stopped = true;
          out(["STOP", key, `${err.message}; nothing after ${s.last || "the start"} was reported -- resume with --start-after ${s.last || "(omit)"} once the booru answers`].join("\t"));
          return s;
        }
        s.errors += 1;
        out(["ERR", key, String(err.message).replace(/\s+/g, " ")].join("\t"));
        s.last = key;
        continue;
      }
      if (!found) {
        s.nopost += 1;
        s.last = key;
        continue;
      }
      const postId = found.post.id;
      s.aliases += 1;
      if (!apply) {
        out(["ALIAS", postId, mxc, found.via].join("\t"));
        s.last = key;
        continue;
      }
      let verdict;
      try {
        verdict = await reportMxcAlias(postId, mxc);
      } catch (err) {
        const status = err instanceof BooruRefusal ? err.status : null;
        if (status === 404) {
          s.kept += 1;
          out(["KEEP", postId, mxc, `${err.message}: hidden from this account, or chanbooru predates gate 3 -- a re-run sends it again`].join("\t"));
          s.last = key;
          continue;
        }
        s.stopped = true;
        const fix = status === 403 || status === 401
          ? "the tunnel's booru account needs Builder or above and a valid api key"
          : status === 200 || (status && status < 500)
            ? "chanbooru predates gate 3's mxc receiver -- deploy chanbooru (GATE3_CONTRACTS B/D)"
            : "the booru did not answer, or answered 5xx -- wait for it";
        out(["STOP", key, `${err.message}; ${fix}; resume with --start-after ${s.last || "(omit)"}`].join("\t"));
        return s;
      }
      if (verdict.accepted) {
        s.accepted += 1;
        out(["ALIAS", postId, mxc, found.via, "accepted"].join("\t"));
      } else {
        s.dropped += 1;
        out(["DROP", postId, mxc, verdict.reason].join("\t"));
      }
      s.last = key;
    }
    if (!page.more || !page.keys.length) return s;
    after = page.keys[page.keys.length - 1];
  }
}

// An md5 lookup that THROWS when the booru could not answer. danbooru.js
// findPostByMd5 answers null for an outage, which the live path tolerates (a
// duplicate posted twice is refused by the booru); here null would be counted
// "no post" and never reported. Basic auth: no key in the URL (danbooru.js
// findPostByMd5 still puts it there, so it is not used here).
function strictFindPostByMd5(danbooru) {
  return async (md5) => {
    let resp;
    try {
      resp = await danbooru._raw().get("/posts.json", { params: { tags: `md5:${md5}`, limit: 1 }, validateStatus: () => true });
    } catch (err) {
      throw Object.assign(new Error(`GET /posts.json (md5 lookup): the booru did not answer (${err.code || "no response"})`), { lookup: true });
    }
    if (resp.status !== 200 || !Array.isArray(resp.data)) {
      throw Object.assign(new Error(`GET /posts.json (md5 lookup) -> ${resp.status}`), { lookup: true });
    }
    return resp.data[0] || null;
  };
}

// The two lookups findPostForBytes makes, as this tool makes them: each
// throws { lookup: true } when the booru could not answer, so the walk STOPS
// rather than counting "no post"; both carry the key in a Basic header only.
function booruLookups(danbooru) {
  return {
    findPostByMd5: strictFindPostByMd5(danbooru),
    findByRawMd5: async (rawMd5) => {
      try {
        return await danbooru.findGenerationByRawMd5(rawMd5);
      } catch (err) {
        throw Object.assign(new Error(`GET /fourier/generation_metadata/raw (raw-md5 lookup): ${err.code ? `the booru did not answer (${err.code})` : err.message}`), { lookup: true });
      }
    },
  };
}

async function main() {
  const yaml = require("js-yaml");
  const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
  const { DanbooruClient } = require("../danbooru");
  const canonLib = require("../canon");

  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const at = args.indexOf("--start-after");
  const startAfter = at >= 0 ? args[at + 1] : null;
  const known = new Set(["--apply", "--start-after", startAfter].filter(Boolean));
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length || (at >= 0 && !(startAfter && startAfter.startsWith(PREFIX)))) {
    console.error(`FAIL: unknown or incomplete option(s) ${unknown.join(" ") || "--start-after"}. fix: the options are --apply and --start-after ${PREFIX}<mediaId>.json, spelled out in full.`);
    process.exit(2);
  }

  const config = yaml.load(fs.readFileSync(process.env.FOURIER_TUNNEL_CONFIG || path.join(__dirname, "..", "config.yaml"), "utf8"));
  const danbooru = new DanbooruClient(config.danbooru);
  const r2 = canonLib.r2FromEnv();
  const listPage = async (after) => {
    const resp = await r2.s3.send(new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: PREFIX, ...(after ? { StartAfter: after } : {}) }));
    return { keys: (resp.Contents || []).map((o) => o.Key), more: Boolean(resp.IsTruncated) };
  };
  const readIndex = async (key) => {
    try {
      const resp = await r2.s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
      return Buffer.from(await resp.Body.transformToByteArray());
    } catch (err) {
      if (err && (err.name === "NoSuchKey" || (err.$metadata && err.$metadata.httpStatusCode === 404))) return null;
      throw err;
    }
  };

  console.log(`# ${apply ? "APPLYING -- each alias is sent to the booru" : "DRY RUN -- nothing is sent"}${startAfter ? `, after ${startAfter}` : ""}`);
  const s = await walk({
    listPage, readIndex, ...booruLookups(danbooru),
    reportMxcAlias: (postId, mxc) => danbooru.reportMxcAlias(postId, mxc),
    domain: config.homeserver.domain, apply, startAfter,
    sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
    out: (line) => console.log(line),
  });
  const kinds = Object.entries(s.otherKinds).map(([k, n]) => `${k}=${n}`).join(" ") || "none";
  console.log(`# listed ${s.listed}; canonical ${s.canonical}; other kinds ${kinds}; no visible post ${s.nopost}; aliases ${s.aliases}` +
    (apply ? ` (accepted ${s.accepted}, dropped ${s.dropped}, kept ${s.kept})` : "") + `; errors ${s.errors}; last key ${s.last || "none"}`);
  return s.stopped || s.errors ? 1 : 0;
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

module.exports = { walk, strictFindPostByMd5, booruLookups };
