#!/usr/bin/env node
"use strict";

// Run Discord acquisition by hand: one pass, or a pass every N seconds.
//
//   node --env-file=<file holding DISCORD_BOT_TOKEN> tools/discord-acquire.js \
//     --channel <id> [--channel <id> ...] --drop-root <spool> --state-dir <dir> \
//     [--namespace discord] [--start-from now|beginning] [--every <seconds>] \
//     [--page-size 100] [--max-mb 100] [--ua-url <url>]
//
// --drop-root is the SPOOL root; the queue is <spool>/_drop/discord/ready and
// is created once, deliberately, by fourier-sampling (tools/drop-drain.ts
// --source discord --init). This tool never creates it.
//
// --start-from now (the default) enrols a channel at its newest message and
// collects only what is posted afterwards. "beginning" walks the whole history;
// whether to backfill a real guild's history is the operator's decision.
//
// Exit codes: 0 every channel read cleanly; 3 PARTIAL (a channel stopped or an
// attachment was refused, each named above); 1 a fatal stop (token, drop
// directory); 2 a usage error. The token is never printed.

const path = require("node:path");
const acq = require("../discordAcquire.js");
const pkg = require("../package.json");

function usage(msg) {
  console.error(`discord-acquire: ${msg}`);
  console.error("usage: tools/discord-acquire.js --channel <id> --drop-root <spool> --state-dir <dir> [--namespace discord] [--start-from now|beginning] [--every <s>]");
  process.exit(2);
}

function parse(argv) {
  const o = { channels: [], namespace: "discord", startFrom: "now", pageSize: 100, maxMb: 100, every: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) usage(`${a} needs a value`); return x; };
    if (a === "--channel") o.channels.push(v());
    else if (a === "--drop-root") o.dropRoot = path.resolve(v());
    else if (a === "--state-dir") o.stateDir = path.resolve(v());
    else if (a === "--namespace") o.namespace = v();
    else if (a === "--start-from") o.startFrom = v();
    else if (a === "--every") o.every = Number(v());
    else if (a === "--page-size") o.pageSize = Number(v());
    else if (a === "--max-mb") o.maxMb = Number(v());
    else if (a === "--ua-url") o.uaUrl = v();
    else usage(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.channels.length) usage("name at least one --channel; there is no wildcard");
  if (!o.dropRoot) usage("--drop-root is required (the spool root that holds _drop/)");
  if (!o.stateDir) usage("--state-dir is required (where watermarks and status are kept)");
  if (!["now", "beginning"].includes(o.startFrom)) usage("--start-from must be now or beginning");
  if (!(o.pageSize >= 1 && o.pageSize <= 100)) usage("--page-size must be 1-100");
  if (!(o.every >= 0)) usage("--every must be a number of seconds");
  return o;
}

function report(results) {
  let partial = false;
  for (const r of results) {
    const label = r.name ? `#${r.name} (${r.channel})` : `channel ${r.channel}`;
    if (r.enrolled) { console.log(`${label}: enrolled at ${r.watermark}`); continue; }
    console.log(`${label}: ${r.messages || 0} messages read, ${r.delivered} delivered, ${r.alreadyQueued} already queued, ` +
      `${r.stripped || 0} stripped of generation data, ${(r.refused || []).length} refused; watermark ${r.watermark || "unchanged"}`);
    for (const x of r.refused || []) { partial = true; console.log(`  REFUSED message ${x.message} attachment ${x.attachment}: ${x.reason}`); }
    if (r.stopped) { partial = true; console.log(`  STOPPED: ${r.stopped}`); }
  }
  return partial;
}

async function main() {
  const o = parse(process.argv.slice(2));
  const http = new acq.DiscordHttp({
    token: (process.env.DISCORD_BOT_TOKEN || "").trim(),
    ua: acq.userAgent(o.uaUrl || process.env.DISCORD_UA_URL || "https://github.com/fourier-channel/fourier-tunnel", pkg.version),
  });
  const me = await http.getJson("/users/@me", "the bot's own user");
  const run = async () => {
    const { results } = await acq.acquireOnce({
      http, channels: o.channels, namespace: o.namespace, dropRoot: o.dropRoot, stateDir: o.stateDir,
      startFrom: o.startFrom, pageSize: o.pageSize, maxBytes: o.maxMb * 1024 * 1024, selfId: me.id,
    });
    return report(results);
  };
  if (!o.every) process.exit((await run()) ? 3 : 0);
  for (;;) {
    await run();
    await new Promise((r) => { setTimeout(r, o.every * 1000); });
  }
}

main().catch((err) => {
  console.error(`discord-acquire: STOPPED: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
