"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const poster = require("./poster");
const { POSTABLE } = require("./discordPost");
const { snowflakeCompare, ChannelRefused, Transient } = require("./discordAcquire");

// THE PLAN: every attachment we intend to acquire, listed before we acquire it.
//
// Operator, 2026-10-04: "a discreet index of channels/servers with a map of the
// resources we plan to acquire, that is built and checked off against as we do
// acquire." fourier-sampling's archive ledger is the same idea for 4chan
// threads, and the operator's own words for it apply here unchanged: "we
// specify what we want to save, we make a list of it, and then we record on
// that list as we get things."
//
// So this walks each ASSIGNED channel's whole history (message lists only, no
// downloads) and writes one row per attachment. Acquisition, separately,
// records what became of each one (acquired.jsonl, written by
// discordAcquire.js). The panel in fourier-sampling divides the second by the
// first: per server, per channel, per creator. A percentage nobody listed the
// denominator for is a guess, and that is the thing this file exists to stop.
//
// EVERY ATTACHMENT IS LISTED, INCLUDING ONES WE WILL NOT POST, each with a
// reason (`ok: false, why`). A video, a bot's upload or a username the creator
// tag cannot carry exactly is out of scope -- and the panel shows it as out of
// scope, the way the archive ledger shows a junked thread, rather than letting
// it vanish from the count where nobody can question the rule that dropped it.
//
// Files, all under the Discord state directory, all written ONLY by this repo:
//
//   guilds.json            the servers and channels: names, which are assigned
//   index/<channel>.jsonl  one row per attachment, appended as the walk goes
//   index-state.json       per channel, the last message indexed
//
// A row is short-keyed because a server's history is long:
//   a attachment id   m message id   c channel id   g guild id
//   u author id       un username    dn display name
//   f filename        x extension    s size         t posted at
//   ok in scope       why the reason when it is not
//
// Rows may repeat after a crash between the append and the state write; a
// reader keys on `a` and the duplicate is the same row.

const INDEX_DIR = "index";

function extOf(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  return dot < 0 ? "" : String(filename).slice(dot).toLowerCase();
}

/** Is this attachment one the booru path would post, and if not, why not? */
function scopeOf(msg, att, prefix, selfId) {
  const author = msg.author || {};
  if (selfId && author.id === selfId) return { ok: false, why: "her own message" };
  if (author.bot) return { ok: false, why: "posted by a bot or webhook" };
  if (!POSTABLE.has(extOf(att.filename))) return { ok: false, why: `not an image (${extOf(att.filename) || "no extension"})` };
  if (!poster.discordPosterTagFor(author.username, prefix)) return { ok: false, why: "username cannot be carried exactly in a creator tag" };
  return { ok: true };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    throw new Error(`cannot read ${file}: ${err.message}. Fix or remove it; it is never guessed.`);
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(value, null, 2) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

/**
 * Refresh guilds.json: the servers configured, their channels, which are
 * assigned. Channel names change and channels appear; this is re-read each pass.
 */
async function refreshGuilds(ctx) {
  const guilds = [];
  const channels = [];
  for (const [guildId, prefix] of Object.entries(ctx.prefixes)) {
    const g = await ctx.http.getJson(`/guilds/${guildId}`, `server ${guildId}`);
    guilds.push({ id: guildId, name: g.name, prefix });
    const list = await ctx.http.getJson(`/guilds/${guildId}/channels`, `the channel list of server ${guildId}`);
    for (const ch of list) {
      if (ch.type !== 0 && ch.type !== 5) continue;
      channels.push({ id: ch.id, guild_id: guildId, name: ch.name, position: ch.position ?? 0, assigned: ctx.channels.includes(ch.id) });
    }
  }
  const missing = ctx.channels.filter((id) => !channels.some((c) => c.id === id));
  const doc = { at: new Date(ctx.now()).toISOString(), guilds, channels, unseenAssigned: missing };
  await writeJsonAtomic(path.join(ctx.stateDir, "guilds.json"), doc);
  return doc;
}

/** Walk one channel forward from where the index last stopped. */
async function indexChannel(ctx, channel, guild) {
  const statePath = path.join(ctx.stateDir, "index-state.json");
  const states = await readJson(statePath, {});
  const st = states[channel.id] || { after: "0", messages: 0, rows: 0 };
  const file = path.join(ctx.stateDir, INDEX_DIR, `${channel.id}.jsonl`);
  const out = { channel: channel.id, name: channel.name, messages: 0, rows: 0, inScope: 0 };
  for (;;) {
    const page = await ctx.http.getJson(`/channels/${channel.id}/messages?after=${st.after}&limit=100`, `channel ${channel.id}`);
    if (!Array.isArray(page) || page.length === 0) break;
    const ordered = [...page].sort((a, b) => snowflakeCompare(a.id, b.id));
    if (snowflakeCompare(ordered[0].id, st.after) <= 0) {
      throw new Transient(`channel ${channel.id}: a page after ${st.after} began at ${ordered[0].id}; stopping rather than re-walking`);
    }
    const lines = [];
    for (const msg of ordered) {
      out.messages++;
      for (const att of msg.attachments || []) {
        const scope = scopeOf(msg, att, guild.prefix, ctx.selfId);
        const author = msg.author || {};
        const row = {
          a: att.id, m: msg.id, c: channel.id, g: guild.id,
          u: author.id || null, un: author.username || null, dn: author.global_name || null,
          f: att.filename, x: extOf(att.filename), s: att.size, t: msg.timestamp, ok: scope.ok,
        };
        if (!scope.ok) row.why = scope.why;
        lines.push(JSON.stringify(row));
        out.rows++;
        if (scope.ok) out.inScope++;
      }
    }
    if (lines.length) await fs.appendFile(file, lines.join("\n") + "\n");
    st.after = ordered[ordered.length - 1].id;
    st.messages += ordered.length;
    st.rows += lines.length;
    st.indexed_at = new Date(ctx.now()).toISOString();
    // Re-read before writing: another channel's walk in this same pass wrote
    // its own entry, and a stale map would put it back.
    const fresh = await readJson(statePath, {});
    fresh[channel.id] = st;
    await writeJsonAtomic(statePath, fresh);
    if (page.length < 100) break;
  }
  // A channel with nothing new still gets its check stamped: "indexed through
  // now" is the claim the panel's freshness lamp reads.
  const fresh = await readJson(statePath, {});
  fresh[channel.id] = { ...st, checked_at: new Date(ctx.now()).toISOString() };
  await writeJsonAtomic(statePath, fresh);
  return out;
}

/**
 * One indexing pass: refresh the server/channel list, then walk every assigned
 * channel. A channel that cannot be read is reported and the rest carry on.
 */
async function indexOnce(opts) {
  const ctx = {
    http: opts.http, stateDir: opts.stateDir, prefixes: opts.prefixes || {}, channels: opts.channels || [],
    selfId: opts.selfId || null, now: opts.now || (() => Date.now()), log: opts.log || ((m) => console.log(m)),
  };
  if (!Object.keys(ctx.prefixes).length) throw new Error("no servers configured: give each a creator prefix (guild id -> prefix)");
  await fs.mkdir(path.join(ctx.stateDir, INDEX_DIR), { recursive: true });
  const doc = await refreshGuilds(ctx);
  const results = [];
  for (const ch of doc.channels.filter((c) => c.assigned)) {
    const guild = doc.guilds.find((g) => g.id === ch.guild_id);
    try {
      results.push(await indexChannel(ctx, ch, guild));
    } catch (err) {
      if (err instanceof ChannelRefused || err instanceof Transient) {
        results.push({ channel: ch.id, name: ch.name, stopped: err.message });
        ctx.log(`#${ch.name}: ${err.message}`);
        continue;
      }
      throw err;
    }
  }
  return { guilds: doc.guilds, results, unseenAssigned: doc.unseenAssigned };
}

module.exports = { indexOnce, refreshGuilds, indexChannel, scopeOf, INDEX_DIR };
