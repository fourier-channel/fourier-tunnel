#!/usr/bin/env node
"use strict";

// Build or extend the plan: every attachment in every channel she can read.
//
//   node --env-file=<file holding DISCORD_BOT_TOKEN> tools/discord-index.js \
//     --state-dir <dir> --prefix <guild id>=<prefix> [--prefix ...] \
//     [--channel <id> ...] [--every <minutes>] [--ua-url <url>]
//
// --every keeps it running: a pass every N minutes, and one within seconds of
// the panel's "refresh now" button.
//
// Indexes every channel she can read, target or not, so targets can be chosen
// from the counts. Lists message pages only; downloads nothing. Re-running continues from where
// each channel's index stopped. Exit 0 every channel indexed, 3 a channel
// stopped (named above), 1 a fatal stop, 2 usage.

const path = require("node:path");
const acq = require("../discordAcquire.js");
const { indexOnce } = require("../discordIndex.js");
const pkg = require("../package.json");

function usage(msg) {
  console.error(`discord-index: ${msg}`);
  console.error("usage: tools/discord-index.js --state-dir <dir> --prefix <guild id>=<prefix> --channel <id> [...]");
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const o = { channels: [], prefixes: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) usage(`${a} needs a value`); return x; };
    if (a === "--state-dir") o.stateDir = path.resolve(v());
    else if (a === "--channel") o.channels.push(v());
    else if (a === "--ua-url") o.uaUrl = v();
    else if (a === "--every") o.every = Number(v());
    else if (a === "--prefix") {
      const m = /^(\d{17,20})=([a-z0-9]{1,16})$/.exec(v());
      if (!m) usage("--prefix takes <guild id>=<prefix>");
      o.prefixes[m[1]] = m[2];
    } else usage(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.stateDir) usage("--state-dir is required");
  if (!Object.keys(o.prefixes).length) usage("name each server with --prefix <guild id>=<prefix>");
  // --channel adds scrape targets; the panel's targets.json is the usual source.
  const http = new acq.DiscordHttp({
    token: (process.env.DISCORD_BOT_TOKEN || "").trim(),
    ua: acq.userAgent(o.uaUrl || process.env.DISCORD_UA_URL || "https://github.com/fourier-channel/fourier-tunnel", pkg.version),
  });
  const me = await http.getJson("/users/@me", "the bot's own user");
  if (o.every > 0) {
    // A pass every --every minutes, and one within seconds of the panel's
    // "refresh now" (index-request.json). Runs until stopped.
    const { takeIndexRequest } = require("../discordIndex.js");
    let next = 0;
    for (;;) {
      const asked = await takeIndexRequest(o.stateDir);
      if (asked || Date.now() >= next) {
        try {
          const r = await indexOnce({ http, stateDir: o.stateDir, prefixes: o.prefixes, channels: o.channels, selfId: me.id });
          const rows = r.results.reduce((s, x) => s + (x.rows || 0), 0);
          console.log(`${new Date().toISOString()} ${asked ? "requested" : "scheduled"} pass: ${r.channels.length} channel(s), ${rows} new attachment(s)`);
        } catch (err) {
          if (err instanceof acq.AuthFailed) throw err;
          console.log(`${new Date().toISOString()} pass failed: ${err.message}`);
        }
        next = Date.now() + o.every * 60_000;
      }
      await new Promise((res) => { setTimeout(res, 3000); });
    }
  }
  const r = await indexOnce({ http, stateDir: o.stateDir, prefixes: o.prefixes, channels: o.channels, selfId: me.id });
  let partial = false;
  for (const g of r.guilds) console.log(`server ${g.name} (${g.id}) prefix ${g.prefix}`);
  for (const x of r.results) {
    if (x.stopped) { partial = true; console.log(`  #${x.name}: STOPPED: ${x.stopped}`); continue; }
    console.log(`  #${x.name} (${x.channel}): ${x.messages} new messages, ${x.rows} attachments listed, ${x.inScope} in scope`);
  }
  for (const c of r.channels.filter((x) => !x.presence.history)) console.log(`  #${c.name} (${c.id}): not indexed -- she can see it but cannot read its history`);
  for (const id of r.unseenTargets) { partial = true; console.log(`  scrape target ${id} is not in any configured server's channel list (deleted, or she cannot view it)`); }
  process.exit(partial ? 3 : 0);
}

main().catch((err) => {
  console.error(`discord-index: STOPPED: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
