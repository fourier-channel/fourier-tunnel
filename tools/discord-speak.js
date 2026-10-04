#!/usr/bin/env node
"use strict";

// Send what the panel has queued for her to say.
//
//   node tools/discord-speak.js --state-dir <dir> --init        (once)
//   node --env-file=<file holding DISCORD_BOT_TOKEN> tools/discord-speak.js \
//     --state-dir <dir> [--channel <id> ...] [--every <seconds>]
//
// Without --every it sends what is waiting and exits. Without --channel she may
// speak wherever her permissions include Send Messages (guilds.json). Exit 0 all sent or none waiting, 3 a
// message failed or she is paused with messages waiting, 1 a fatal stop, 2 usage.

const path = require("node:path");
const acq = require("../discordAcquire.js");
const speak = require("../discordSpeak.js");
const pkg = require("../package.json");

function usage(msg) {
  console.error(`discord-speak: ${msg}`);
  console.error("usage: tools/discord-speak.js --state-dir <dir> (--init | --channel <id> [...] [--every <s>])");
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const o = { channels: [], every: 0, init: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) usage(`${a} needs a value`); return x; };
    if (a === "--state-dir") o.stateDir = path.resolve(v());
    else if (a === "--channel") o.channels.push(v());
    else if (a === "--every") o.every = Number(v());
    else if (a === "--init") o.init = true;
    else usage(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!o.stateDir) usage("--state-dir is required");
  if (o.init) {
    const d = await speak.initOutbox(o.stateDir);
    console.log(`created ${d.root} (staging/ ready/ sent/ failed/)`);
    return;
  }
  // No --channel: every channel her permissions let her post in, re-read each pass.
  const http = new acq.DiscordHttp({
    token: (process.env.DISCORD_BOT_TOKEN || "").trim(),
    ua: acq.userAgent(process.env.DISCORD_UA_URL || "https://github.com/fourier-channel/fourier-tunnel", pkg.version),
    spacingMs: 250,
  });
  const once = async () => {
    const channels = o.channels.length ? o.channels : await speak.speakableChannels(o.stateDir);
    const r = await speak.processOutbox({ http, stateDir: o.stateDir, channels });
    if (r.paused && r.waiting) console.log(`paused, ${r.waiting} waiting`);
    return r.failed.length > 0 || (r.paused && r.waiting > 0);
  };
  if (!o.every) process.exit((await once()) ? 3 : 0);
  for (;;) {
    await once();
    await new Promise((r) => { setTimeout(r, o.every * 1000); });
  }
}

main().catch((err) => {
  console.error(`discord-speak: STOPPED: ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
