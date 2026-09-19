#!/usr/bin/env node
// Re-read one image's metadata and rewrite its creator provenance, from the
// command line: `node rescan.js <mxc://... | md5> [more...]`. The same
// capability the bot's !rescan runs, with the same real dependencies, for an
// operator at a shell rather than in a DM. Nothing here starts the bridge.
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const axios = require("axios");
const { DanbooruClient } = require("./danbooru");
const { extractCreatorTags } = require("./prompt-tags");
const { rescan } = require("./capabilities/rescan");

const config = yaml.load(fs.readFileSync(path.join(__dirname, "config.yaml"), "utf8"));
const reg = yaml.load(fs.readFileSync(path.join(__dirname, "tunnel-registration.yaml"), "utf8"));
const danbooru = new DanbooruClient(config.danbooru);

async function download(mxcUrl) {
  const m = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
  const url = `${config.homeserver.url}/_matrix/client/v1/media/download/${m[1]}/${m[2]}`;
  const resp = await axios.get(url, { headers: { Authorization: `Bearer ${reg.as_token}` }, responseType: "arraybuffer", timeout: 30000 });
  return { buffer: Buffer.from(resp.data), contentType: resp.headers["content-type"] || "application/octet-stream" };
}

async function main() {
  const targets = process.argv.slice(2);
  if (!targets.length) { console.error("usage: node rescan.js <mxc://server/id | md5> [...]"); process.exit(2); }
  const deps = {
    download,
    findPostByMd5: (md5) => danbooru.findPostByMd5(md5),
    getTagProjection: (id) => danbooru.getTagProjection(id),
    recordTagSources: (id, partition) => danbooru.recordTagSources(id, partition),
    extract: extractCreatorTags,
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
