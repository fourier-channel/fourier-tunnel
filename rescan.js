#!/usr/bin/env node
// Re-read one image's metadata and rewrite its creator provenance and its
// private generation record, from the command line:
// `node rescan.js <mxc://... | md5> [more...]`. The same capability the bot's
// !rescan runs, with the same real dependencies, for an operator at a shell
// rather than in a DM. Nothing here starts the bridge.
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { DanbooruClient } = require("./danbooru");
const { extractCreatorTags, extractCreatorTagsFromFields } = require("./prompt-tags");
const { stripGeneration } = require("./strip-generation");
const { rescan } = require("./capabilities/rescan");

const config = yaml.load(fs.readFileSync(path.join(__dirname, "config.yaml"), "utf8"));
const danbooru = new DanbooruClient(config.danbooru);

// The raw original through canon.js, as the bot's !rescan reads it (index.js
// canonRawForRescan): superseded/ holds it once the image is canonical, until
// the operator deletes it; otherwise the one file. Synapse's own copy is not
// asked for -- after canon it is not where Synapse would look.
const canonLib = require("./canon");
const canon = canonLib.createCanon({
  store: canonLib.r2Store(canonLib.r2FromEnv()),
  mediaInfo: canonLib.synapseMediaInfo({ axios, homeserverUrl: config.homeserver.url, domain: config.homeserver.domain, adminToken: config.homeserver.admin_token }),
  booru: danbooru,
  log: (line) => console.warn(line),
});
async function download(mxcUrl) {
  const m = mxcUrl.match(/^mxc:\/\/([^/]+)\/([^/?#]+)$/);
  if (!m) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
  if (m[1] !== config.homeserver.domain) throw new Error(`${mxcUrl} is not media on this homeserver`);
  const c = await canon.canonicalize(m[2], { withBytes: true });
  if (c.kind !== "canonical") throw new Error(`${mxcUrl} is ${c.kind}${c.reason ? `: ${c.reason}` : ""}`);
  // No raw original, no rescan: re-reading the STRIPPED file finds no prompt,
  // and a rescan that reads nothing replaces the post's creator tags with
  // nothing. Refused in words instead.
  if (!c.raw) {
    throw new Error(`the original of ${mxcUrl}, the only file that carried its generation data, is gone (superseded/ was cleared). There is nothing to re-read; the post's creator tags are left as they are.`);
  }
  return { buffer: c.raw, contentType: c.media_type };
}

async function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) { console.error("usage: node rescan.js <mxc://server/id | md5> [...]"); process.exit(2); }
  const deps = {
    download,
    findPostByMd5: (md5) => danbooru.findPostByMd5(md5),
    getTagProjection: (id) => danbooru.getTagProjection(id),
    recordTagSources: (id, partition) => danbooru.recordTagSources(id, partition),
    recordGenerationMetadata: (md5, body) => danbooru.recordGenerationMetadata(md5, body),
    findByRawMd5: (rawMd5) => danbooru.findGenerationByRawMd5(rawMd5),
    extract: extractCreatorTags,
    creatorTags: extractCreatorTagsFromFields,
    strip: stripGeneration,
    maxCreatorTags: config.autotagger && config.autotagger.max_creator_tags,
    audit: (record) => console.log("[audit]", JSON.stringify(record)),
  };
  let failed = 0;
  for (const t of targets) {
    const out = await rescan(t, deps);
    console.log(`${out.ok ? "ok  " : "FAIL"} ${t}: ${out.report}`);
    if (!out.ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
