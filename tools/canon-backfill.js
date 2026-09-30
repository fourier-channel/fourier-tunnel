#!/usr/bin/env node
"use strict";

// Make EVERY existing Matrix image into its one stripped file (canon.js), and
// move the copies that are no longer needed into superseded/ for the operator
// to review. Nothing is deleted -- a move is a verified copy, then removal of
// the source key only.
//
//   docker exec fourier-tunnel node tools/canon-backfill.js                  report only
//   docker exec fourier-tunnel node tools/canon-backfill.js --apply          do it
//   ... --booru-duplicates                                                    also the booru's copies
//
// Without --apply it WRITES NOTHING: every image is read and stripped in memory
// and the line it would produce is printed. Flags are matched exactly; an
// unknown one is refused, never guessed at.
//
// Output is tab-separated, one line per object, then a summary:
//   CANON  <mediaId>  <kind>  <media_type>  stripped=<y|n>  fields=<n>  <key or reason>
//   DUP    <post_id>  <md5.ext>  <why>        (a booru copy that is not the one file)
//   KEEP   <post_id>  <md5.ext>  <why>        (a booru copy that IS some image's one file)
//   ERR    <id>       <message>

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { DanbooruClient } = require("../danbooru");
const canonLib = require("../canon");
const { resolveHomeserverUrl } = require("../homeserver");

const FLAGS = new Set(["--apply", "--booru-duplicates"]);
const args = process.argv.slice(2);
const unknown = args.filter((a) => !FLAGS.has(a));
if (unknown.length) {
  console.error(`FAIL: unknown option(s) ${unknown.join(" ")}. fix: the options are --apply and --booru-duplicates, spelled out in full.`);
  process.exit(2);
}
const APPLY = args.includes("--apply");
const BOORU = args.includes("--booru-duplicates");

const config = yaml.load(fs.readFileSync(process.env.FOURIER_TUNNEL_CONFIG || path.join(__dirname, "..", "config.yaml"), "utf8"));
config.homeserver.url = resolveHomeserverUrl(process.env, config.homeserver.url);
const danbooru = new DanbooruClient(config.danbooru);
const r2 = canonLib.r2FromEnv();
const store = canonLib.r2Store(r2);
const canon = canonLib.createCanon({
  store,
  mediaInfo: canonLib.synapseMediaInfo({ axios, homeserverUrl: config.homeserver.url, domain: config.homeserver.domain, adminToken: config.homeserver.admin_token }),
  booru: danbooru,
  log: (line) => console.error(line),
});

// Every local original still at Synapse's key: local_content/<AA>/<BB>/<rest>.
async function listSourceMediaIds() {
  const ids = [];
  let token;
  do {
    const out = await r2.s3.send(new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: "local_content/", ContinuationToken: token }));
    for (const o of out.Contents || []) {
      const m = /^local_content\/([^/]{2})\/([^/]{2})\/([^/]+)$/.exec(o.Key);
      if (m) ids.push(`${m[1]}${m[2]}${m[3]}`);
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return ids;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function canonAll(summary) {
  const ids = await listSourceMediaIds();
  console.log(`# ${ids.length} original(s) still at Synapse's key; ${APPLY ? "APPLYING" : "DRY RUN -- nothing is written"}`);
  await pool(ids, 3, async (id) => {
    try {
      const r = await canon.canonicalize(id, { dryRun: !APPLY });
      summary[r.kind] = (summary[r.kind] || 0) + 1;
      if (r.kind === "canonical" && r.stripped) summary.stripped += 1;
      if (r.fields) summary.withFields += 1;
      if (r.record === "pending") summary.recordPending += 1;
      const tail = r.kind === "refused" ? r.reason : r.key;
      console.log(["CANON", id, r.kind, r.media_type, `stripped=${r.stripped ? "y" : "n"}`, `fields=${r.fields || 0}`, tail].join("\t"));
    } catch (err) {
      summary.errors += 1;
      console.log(["ERR", id, String(err.message).replace(/\s+/g, " ")].join("\t"));
    }
  });
}

// The booru's copies of tunnel posts. A post whose md5 is its image's one file
// is that file; any other is an unneeded copy -- unstripped (posted before the
// strip existed) or stripped under older rules -- and is moved aside. Only
// objects that are NOT some image's one file are ever moved.
async function booruDuplicates(summary) {
  const dups = [];
  for (let page = 1; ; page++) {
    const resp = await danbooru._client().get("/posts.json", { params: { tags: `user:${config.danbooru.username}`, limit: 200, page } });
    const posts = Array.isArray(resp.data) ? resp.data : [];
    if (!posts.length) break;
    for (const p of posts) {
      const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(p.source || "");
      if (!m || m[1] !== config.homeserver.domain || !p.md5 || !p.file_ext) continue;
      const name = `${p.md5}.${p.file_ext}`;
      // Its image's one file. A dry run has no index yet, so it asks canon for
      // the same answer in memory -- the preview then lists exactly what
      // --apply would move.
      let idx = await canon.readIndex(m[2]);
      if (!idx && !APPLY) {
        try {
          idx = await canon.canonicalize(m[2], { dryRun: true });
        } catch (err) {
          console.log(["KEEP", p.id, name, `its image could not be read (${String(err.message).slice(0, 120)})`].join("\t"));
          summary.keep += 1;
          continue;
        }
      }
      if (!idx) {
        console.log(["KEEP", p.id, name, "its image has no index"].join("\t"));
        summary.keep += 1;
        continue;
      }
      if (idx.kind === "canonical" && idx.md5 === p.md5) { summary.isOne += 1; continue; }
      // Never move an object that is some image's one file.
      if (await store.head(canonLib.keys.byMd5(p.md5))) {
        console.log(["KEEP", p.id, name, "it is some image's one file"].join("\t"));
        summary.keep += 1;
        continue;
      }
      if (!(await store.head(`media/${name}`))) { summary.absent += 1; continue; }
      // A refused image is withheld by the gate; the booru's copy of it is the
      // unstripped bytes and is moved aside with the rest.
      const why = idx.kind === "canonical" ? `the one file for mxc ${m[2]} is ${idx.key}` : `its image is ${idx.kind}${idx.reason ? ` (${String(idx.reason).slice(0, 80)})` : ""}`;
      dups.push({ id: p.id, name, why });
    }
  }
  for (const d of dups) {
    console.log(["DUP", d.id, d.name, d.why].join("\t"));
    summary.dups += 1;
    if (!APPLY) continue;
    const from = `media/${d.name}`;
    const to = `superseded/media/${d.name}`;
    try {
      const src = await store.head(from);
      let dst = await store.head(to);
      if (!dst) { await store.copy(from, to); dst = await store.head(to); }
      if (!dst || dst.size !== src.size || dst.etag !== src.etag) throw new Error(`copy to ${to} not verified; ${from} kept`);
      await store.remove(from);
      summary.moved += 1;
    } catch (err) {
      summary.errors += 1;
      console.log(["ERR", d.id, String(err.message)].join("\t"));
    }
  }
}

(async () => {
  const summary = { canonical: 0, source: 0, refused: 0, stripped: 0, withFields: 0, recordPending: 0, errors: 0, dups: 0, moved: 0, keep: 0, isOne: 0, absent: 0 };
  await canonAll(summary);
  if (BOORU) await booruDuplicates(summary);
  console.log(`# ${APPLY ? "APPLIED" : "DRY RUN"}: ${JSON.stringify(summary)}`);
  process.exit(summary.errors ? 1 : 0);
})().catch((err) => {
  console.error(`FAIL: ${err.stack || err.message}`);
  process.exit(1);
});
