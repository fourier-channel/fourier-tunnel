"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const poster = require("./poster");
const { POSTABLE } = require("./discordPost");
const { snowflakeCompare, ChannelRefused, Transient } = require("./discordAcquire");
const { presenceIn } = require("./discordPerms");

// THE PLAN: every attachment we intend to acquire, listed before we acquire it.
//
// Operator, 2026-10-04: "a discreet index of channels/servers with a map of the
// resources we plan to acquire, that is built and checked off against as we do
// acquire." fourier-sampling's archive ledger is the same idea for 4chan
// threads, and the operator's own words for it apply here unchanged: "we
// specify what we want to save, we make a list of it, and then we record on
// that list as we get things."
//
// So this walks the whole history of every channel she can READ (message lists
// only, no downloads) and writes one row per attachment -- targets and
// non-targets alike, because the operator chooses scrape targets AFTER seeing
// what each channel holds (2026-10-04: "AFTER indexing but BEFORE scraping, I
// will merge the usernames and declare which is to be the master name"). Acquisition, separately,
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
// Files under the Discord state directory written ONLY by this repo:
//
//   guilds.json            the servers, their categories and channels, her
//                          presence in each (computed from her permissions,
//                          discordPerms.js) and which are scrape targets
//   index/<channel>.jsonl  one row per attachment, appended as the walk goes
//   index-state.json       per channel, the last message indexed
//
// and read here, written ONLY by the panel (fourier-sampling):
//
//   targets.json           { targets: [channel ids] } -- the scrape targets
//   creators.json          { masters: [{ user_id, username, subs: [...] }] }
//
// A row is short-keyed because a server's history is long:
//   a attachment id   m message id   c channel id   g guild id
//   u author id       un username    dn display name
//   f filename        x extension    s size         t posted at
//   xok in scope on every ground but the name     why the reason when not
//   nameOk the author's own username fits a creator tag exactly
//   ok  xok and nameOk, before any merge -- the panel recomputes the name
//       ground against the master name once usernames are merged
//
// Rows may repeat after a crash between the append and the state write; a
// reader keys on `a` and the duplicate is the same row.

const INDEX_DIR = "index";

function extOf(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  return dot < 0 ? "" : String(filename).slice(dot).toLowerCase();
}

/** The username ground alone: does this name fit a creator tag exactly? */
function nameFits(username, prefix) {
  return poster.discordPosterTagFor(username, prefix) !== null;
}

/**
 * Is this attachment one the booru path would post? The name ground is kept
 * apart from the rest because a merge can change it: a sub-account whose own
 * username cannot be tagged is posted under its master's name.
 */
function scopeOf(msg, att, prefix, selfId) {
  const author = msg.author || {};
  const nameOk = nameFits(author.username, prefix);
  let why = null;
  if (selfId && author.id === selfId) why = "her own message";
  else if (author.bot) why = "posted by a bot or webhook";
  else if (!POSTABLE.has(extOf(att.filename))) why = `not an image (${extOf(att.filename) || "no extension"})`;
  const xok = why === null;
  if (xok && !nameOk) why = "username cannot be carried exactly in a creator tag";
  return { xok, nameOk, ok: xok && nameOk, why };
}

/** The scrape targets the panel chose. Re-read on every call. */
async function readTargets(stateDir) {
  const t = await readJson(path.join(stateDir, "targets.json"), { targets: [] });
  return new Set(Array.isArray(t.targets) ? t.targets.map(String) : []);
}

/** The panel's merges. Re-read on every call. */
async function readCreators(stateDir) {
  const c = await readJson(path.join(stateDir, "creators.json"), { masters: [] });
  return Array.isArray(c.masters) ? c.masters : [];
}

/**
 * The name a Discord author is POSTED under: their master's, when the operator
 * has merged them under one, else their own. Operator, 2026-10-04: merges are
 * declared after indexing and before scraping, with one master name and the
 * other names as its sub-names.
 */
function creatorNameFor(masters, author) {
  const id = author && author.id;
  for (const m of masters) {
    if (m.user_id === id) return m.username;
    if ((m.subs || []).some((x) => x.user_id === id)) return m.username;
  }
  return author ? author.username : undefined;
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
 * Refresh guilds.json: the servers configured, their categories and channels,
 * her presence in each, and which are scrape targets. Names change, channels
 * appear and permissions move, so this is redone every pass.
 */
async function refreshGuilds(ctx) {
  const targets = await readTargets(ctx.stateDir);
  for (const id of ctx.channels) targets.add(id);
  const guilds = [];
  const categories = [];
  const channels = [];
  for (const [guildId, prefix] of Object.entries(ctx.prefixes)) {
    const g = await ctx.http.getJson(`/guilds/${guildId}`, `server ${guildId}`);
    const member = await ctx.http.getJson(`/guilds/${guildId}/members/${ctx.selfId}`, `her membership of server ${guildId}`);
    guilds.push({ id: guildId, name: g.name, prefix });
    const list = await ctx.http.getJson(`/guilds/${guildId}/channels`, `the channel list of server ${guildId}`);
    for (const ch of list) {
      if (ch.type === 4) {
        categories.push({ id: ch.id, guild_id: guildId, name: ch.name, position: ch.position ?? 0 });
        continue;
      }
      if (ch.type !== 0 && ch.type !== 5) continue;
      channels.push({
        id: ch.id, guild_id: guildId, name: ch.name, position: ch.position ?? 0, parent_id: ch.parent_id || null,
        presence: presenceIn(g, member, ch), target: targets.has(ch.id),
      });
    }
  }
  const unseenTargets = [...targets].filter((id) => !channels.some((c) => c.id === id));
  const doc = { at: new Date(ctx.now()).toISOString(), guilds, categories, channels, unseenTargets };
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
          f: att.filename, x: extOf(att.filename), s: att.size, t: msg.timestamp,
          xok: scope.xok, nameOk: scope.nameOk, ok: scope.ok,
        };
        if (scope.why) row.why = scope.why;
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
 * One indexing pass: refresh the server/channel list, then walk every channel
 * she can read. A channel that cannot be read is reported and the rest carry on.
 */
async function indexOnce(opts) {
  const ctx = {
    http: opts.http, stateDir: opts.stateDir, prefixes: opts.prefixes || {}, channels: opts.channels || [],
    selfId: opts.selfId || null, now: opts.now || (() => Date.now()), log: opts.log || ((m) => console.log(m)),
  };
  if (!Object.keys(ctx.prefixes).length) throw new Error("no servers configured: give each a creator prefix (guild id -> prefix)");
  if (!ctx.selfId) throw new Error("indexOnce needs selfId (the bot's user id) to read its own permissions");
  await fs.mkdir(path.join(ctx.stateDir, INDEX_DIR), { recursive: true });
  const doc = await refreshGuilds(ctx);
  const results = [];
  for (const ch of doc.channels.filter((c) => c.presence.history)) {
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
  return { guilds: doc.guilds, channels: doc.channels, results, unseenTargets: doc.unseenTargets };
}

module.exports = { indexOnce, refreshGuilds, indexChannel, scopeOf, nameFits, readTargets, readCreators, creatorNameFor, INDEX_DIR };
