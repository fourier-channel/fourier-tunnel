#!/usr/bin/env node
// Catch a room up on images its bot was never allowed to see.
//
//   node tools/catch-up-room.js --room '!id:41chan.net'            # plan only
//   node tools/catch-up-room.js --room '!id:41chan.net' --apply    # writes
//
// DRY RUN IS THE DEFAULT, and applying takes an explicit argument, for the
// reason tools/grant-tag-write.sh records: a flag that must be DELIVERED to be
// safe will one day not be delivered. `DRY=1 ssh host ...` once set the variable
// on the wrong machine and wrote to fourteen rooms for real.
//
// THE ADMIN TOKEN IS READ FROM THE ENVIRONMENT, never from a flag -- a secret on
// a command line is in the shell history and in every ps listing:
//
//   read -s SYNAPSE_ADMIN_TOKEN && export SYNAPSE_ADMIN_TOKEN
//   node tools/catch-up-room.js --room '!id:41chan.net' --apply
//
// WHAT IT IS FOR. A room created history_visibility "invited" seals every event
// sent before a member's invite. A bot invited later can never read that window
// -- /messages omits it, /event 404s, /relations 403s -- so its backfill reports
// a number that looks complete and is not. The server has no such horizon, so
// this reads with Synapse's admin Room Messages API and writes the tag state as
// the bot, which still needs the bot's own power level in that room.
//
// Pointable on purpose: this is the catch-up for ANY room whose bot arrived
// after the pictures did.

"use strict";

const path = require("path");
const { catchUpRoom, summarise } = require(path.join(__dirname, "..", "catchup"));
const { handleImageEvent, AS_TOKEN, config } = require(path.join(__dirname, "..", "index"));

const PACE_MS = Number(process.env.CATCHUP_PACE_MS || 750);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function main() {
  const roomId = arg("room");
  if (!roomId || !roomId.startsWith("!")) {
    console.error("usage: node tools/catch-up-room.js --room '!id:server' [--apply] [--cap N]");
    console.error("  --room is required and must be a room ID (!...), not an alias.");
    return 2;
  }
  const apply = has("apply");
  const cap = Number(arg("cap") || 2000);

  const adminToken = process.env.SYNAPSE_ADMIN_TOKEN;
  if (!adminToken) {
    console.error("SYNAPSE_ADMIN_TOKEN is not set. This tool reads the room as the SERVER,");
    console.error("which is the entire reason it can see what the bot cannot. Set it with:");
    console.error("  read -s SYNAPSE_ADMIN_TOKEN && export SYNAPSE_ADMIN_TOKEN");
    return 2;
  }

  const base = String(config.homeserver.url).replace(/\/+$/, "");
  const enc = encodeURIComponent(roomId);

  async function page(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${url.replace(/\?.*/, "")} -> HTTP ${res.status}`);
    return res.json();
  }
  // The server's view. No user_id: this is not being read as anybody.
  const adminPage = (from) =>
    page(`${base}/_synapse/admin/v1/rooms/${enc}/messages?dir=b&limit=100${from ? `&from=${encodeURIComponent(from)}` : ""}`, adminToken);
  // The bot's view, for the gap only. Never acted on.
  const botUserId = `@${config.bridge.bot_localpart || "tunnel"}:${config.homeserver.domain}`;
  const botPage = (from) =>
    page(`${base}/_matrix/client/v3/rooms/${enc}/messages?dir=b&limit=100&user_id=${encodeURIComponent(botUserId)}${from ? `&from=${encodeURIComponent(from)}` : ""}`, AS_TOKEN);

  // The only thing handleImageEvent asks of a bridge is
  // getIntent().sendStateEvent, so a tool supplies exactly that rather than
  // standing up a whole appservice. In a dry run it writes nothing and says so.
  const intent = {
    sendStateEvent: async (room, type, stateKey, body) => {
      if (!apply) {
        console.log(`  WOULD WRITE ${type} for ${stateKey}`);
        return {};
      }
      const url = `${base}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}?user_id=${encodeURIComponent(botUserId)}`;
      const res = await fetch(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${AS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`state ${type} -> HTTP ${res.status}`);
      return res.json();
    },
  };
  const bridge = { getIntent: () => intent };

  console.log(`room        : ${roomId}`);
  console.log(`reader      : admin (the server's view, no history horizon)`);
  console.log(`writer      : ${botUserId} (its power level still governs the tag state)`);
  console.log(`mode        : ${apply ? "APPLY -- this writes" : "dry run, nothing will be written"}`);
  console.log("");

  const result = await catchUpRoom({
    roomId,
    adminPage,
    botPage,
    cap,
    log: (line) => console.warn(line),
    onImage: async (ev) => {
      const outcome = await handleImageEvent(bridge, { ...ev, room_id: roomId });
      // Same pacing as the live walk, and for the same reason: Synapse rate
      // limits state events and starts refusing them. In a dry run nothing is
      // sent, so nothing needs pacing.
      if (apply) await sleep(PACE_MS);
      return outcome;
    },
  });

  console.log("");
  console.log(summarise(result));
  if (!apply) console.log("\n  Dry run. Re-run with --apply.");
  // A run that could not finish is not a success, whatever it managed.
  return result.failed > 0 || result.truncated ? 1 : 0;
}

// The exit code is set in ONE place, off main's return, rather than assigned to
// process from inside an async function -- which is a real race and which this
// repo's own linter flags.
main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`catch-up-room failed: ${err.message}`);
    process.exitCode = 1;
  },
);
