"use strict";

// HER MARK ON WHAT SHE SAVED (operator, 2026-10-06): "Can we have her use an
// emoji on images she's saved?" -- with her own application emojis ("Discord
// bots have their own emojis don't they?"), on new saves only.
//
// One reaction per MESSAGE, because that is what Discord has: she reacts once
// any of its images is on the booru. The emoji is the panel's choice
// (reaction.json in the shared directory): a standard emoji, or "name:id" for
// one of her application emojis, which she may use in any server without Use
// External Emojis. Absent or null: no reactions.
//
// A reaction is a courtesy and never stops collection. It is also an easy way
// to spend Discord's invalid-request budget (10,000 per 10 minutes per IP, then
// a ban): a wrong emoji or a missing permission would fail on every message of
// a backlog. So she reacts only where the index says she holds Add Reactions,
// and after one failure in a server she stops trying there until the next pass.
// Every attempt is a line in reactions.jsonl, which the panel reads.

const fs = require("node:fs/promises");
const path = require("node:path");
const { readJson } = require("./discordIndex");

const REACTION_FILE = "reaction.json";
const LOG_FILE = "reactions.jsonl";
const APP_EMOJIS_FILE = "app-emojis.json";

/** The panel's choice: an emoji string, or null for none. */
async function readReaction(stateDir) {
  const r = await readJson(path.join(stateDir, REACTION_FILE), null);
  const e = r && typeof r.emoji === "string" ? r.emoji.trim() : "";
  return e || null;
}

/**
 * A reactor for one acquisition pass: (channel, msg) => Promise<void>.
 * `guildsDoc` is guilds.json as the pass found it (her permissions per channel).
 */
function makeReactor({ http, stateDir, guildsDoc, emoji, log = () => {}, now = () => Date.now() }) {
  if (!emoji) return null;
  const presence = new Map(((guildsDoc && guildsDoc.channels) || []).map((c) => [c.id, c.presence || {}]));
  const stopped = new Map(); // guild id -> why, for the rest of this pass
  const record = (row) => fs.appendFile(path.join(stateDir, LOG_FILE), JSON.stringify({ ...row, e: emoji, at: new Date(now()).toISOString() }) + "\n");
  return async (channel, msg) => {
    const g = channel.guild_id || null;
    if (stopped.has(g)) return;
    if (!(presence.get(channel.id) || {}).react) {
      const why = `she lacks Add Reactions in #${channel.name || channel.id}: grant it there, or turn reactions off on the panel`;
      stopped.set(g, why);
      await record({ m: msg.id, c: channel.id, g, ok: false, why });
      log(`reactions paused in this server for the pass: ${why}`);
      return;
    }
    const r = await http.putReaction(channel.id, msg.id, emoji);
    await record({ m: msg.id, c: channel.id, g, ok: r.ok, ...(r.ok ? {} : { why: r.why }) });
    // A deleted message is that message's problem, not the server's.
    if (!r.ok && r.code !== 10008) {
      stopped.set(g, r.why);
      log(`reactions paused in this server for the pass: ${r.why}`);
    }
  };
}

/**
 * Her application emojis, for the panel's picker: app-emojis.json. A failure
 * leaves the last list in place and is reported; it never stops a pass.
 */
async function refreshAppEmojis({ http, stateDir, now = () => Date.now() }) {
  const app = await http.getJson("/applications/@me", "her application");
  const list = await http.getJson(`/applications/${app.id}/emojis`, "her application emojis");
  const items = (list && Array.isArray(list.items) ? list.items : []).map((e) => ({ id: String(e.id), name: String(e.name), animated: Boolean(e.animated) }));
  const file = path.join(stateDir, APP_EMOJIS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ items, at: new Date(now()).toISOString() }, null, 2) + "\n");
  await fs.rename(tmp, file);
  return items;
}

module.exports = { readReaction, makeReactor, refreshAppEmojis, REACTION_FILE, LOG_FILE, APP_EMOJIS_FILE };
