#!/usr/bin/env node
"use strict";

// Build or extend the plan: every attachment in each assigned channel.
//
//   node --env-file=<file holding DISCORD_BOT_TOKEN> tools/discord-index.js \
//     --state-dir <dir> --prefix <guild id>=<prefix> [--prefix ...] \
//     --channel <id> [--channel <id> ...] [--ua-url <url>]
//
// Lists message pages only; downloads nothing. Re-running continues from where
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
    else if (a === "--prefix") {
      const m = /^(\d{17,20})=([a-z0-9]{1,16})$/.exec(v());
      if (!m) usage("--prefix takes <guild id>=<prefix>");
      o.prefixes[m[1]] = m[2];
    } else usage(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.stateDir) usage("--state-dir is required");
  if (!Object.keys(o.prefixes).length) usage("name each server with --prefix <guild id>=<prefix>");
  if (!o.channels.length) usage("name each assigned channel with --channel; there is no wildcard");
  const http = new acq.DiscordHttp({
    token: (process.env.DISCORD_BOT_TOKEN || "").trim(),
    ua: acq.userAgent(o.uaUrl || process.env.DISCORD_UA_URL || "https://github.com/fourier-channel/fourier-tunnel", pkg.version),
  });
  const me = await http.getJson("/users/@me", "the bot's own user");
  const r = await indexOnce({ http, stateDir: o.stateDir, prefixes: o.prefixes, channels: o.channels, selfId: me.id });
  let partial = false;
  for (const g of r.guilds) console.log(`server ${g.name} (${g.id}) prefix ${g.prefix}`);
  for (const x of r.results) {
    if (x.stopped) { partial = true; console.log(`  #${x.name}: STOPPED: ${x.stopped}`); continue; }
    console.log(`  #${x.name} (${x.channel}): ${x.messages} new messages, ${x.rows} attachments listed, ${x.inScope} in scope`);
  }
  for (const id of r.unseenAssigned) { partial = true; console.log(`  assigned channel ${id} is not in any configured server's channel list`); }
  process.exit(partial ? 3 : 0);
}

main().catch((err) => {
  console.error(`discord-index: STOPPED: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
