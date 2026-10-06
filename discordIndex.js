"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const poster = require("./poster");
const { POSTABLE } = require("./discordPost");
const { snowflakeCompare, isSnowflake, ChannelRefused, Transient } = require("./discordAcquire");
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
function nameFits(author, prefix) {
  return poster.discordPosterTagFor(poster.discordCreatorName(author.username, author.id), prefix) !== null;
}

/**
 * Is this attachment one the booru path would post? The name ground is kept
 * apart from the rest because a merge can change it: a sub-account whose own
 * username cannot be tagged is posted under its master's name.
 */
function scopeOf(msg, att, prefix, selfId) {
  const author = msg.author || {};
  const nameOk = nameFits(author, prefix);
  let why = null;
  if (selfId && author.id === selfId) why = "her own message";
  else if (author.bot) why = "posted by a bot or webhook";
  else if (!POSTABLE.has(extOf(att.filename))) why = `not an image (${extOf(att.filename) || "no extension"})`;
  const xok = why === null;
  if (xok && !nameOk) why = "the author has no usable account id, so no creator tag can name them";
  return { xok, nameOk, ok: xok && nameOk, why };
}

/** The scrape targets the panel chose. Re-read on every call. */
async function readTargets(stateDir) {
  const t = await readJson(path.join(stateDir, "targets.json"), { targets: [] });
  return new Set(Array.isArray(t.targets) ? t.targets.map(String) : []);
}

/**
 * THE SERVERS SHE WORKS IN: servers.json, written by the panel (operator,
 * 2026-10-05: "adding/changing a server isn't a code change, it's a config
 * change"). Each entry is { guild_id, name, prefix } -- the prefix without its
 * underscore, as tunnel builds tags (aichan -> aichan_<username>). Re-read on
 * every pass. Null when the file does not exist yet (seedServers fills it).
 */
const SERVERS_FILE = "servers.json";
const legalPrefix = (p) => /^[a-z0-9]{1,16}$/.test(p) && p !== "41chan" && p !== "4chan";

async function readServers(stateDir) {
  const doc = await readJson(path.join(stateDir, SERVERS_FILE), null);
  if (!doc) return null;
  return (Array.isArray(doc.servers) ? doc.servers : []).map((s) => {
    const id = String((s && s.guild_id) || "");
    const prefix = String((s && s.prefix) || "");
    const why = !isSnowflake(id) ? `${JSON.stringify(id)} is not a Discord server id`
      : !legalPrefix(prefix) ? `prefix ${JSON.stringify(prefix)} is not a legal creator prefix (lowercase letters and digits; never 41chan or 4chan)`
        : null;
    return { guild_id: id, name: s && s.name ? String(s.name) : null, prefix, why };
  });
}

/**
 * The one-time move from config.yaml's discord.guilds to servers.json, so a
 * deployment that configured servers there keeps them. Written only when
 * servers.json does not exist; after that the panel owns the list and the
 * config key is ignored. Returns whether it wrote.
 */
async function seedServers(stateDir, guilds) {
  if (!guilds || !Object.keys(guilds).length) return false;
  if ((await readServers(stateDir)) !== null) return false;
  const at = new Date().toISOString();
  const servers = Object.entries(guilds).map(([guild_id, prefix]) => ({ guild_id: String(guild_id), name: null, prefix: String(prefix), added_at: at }));
  await writeJsonAtomic(path.join(stateDir, SERVERS_FILE), { servers, at, seeded_from: "config.yaml discord.guilds" });
  return true;
}

/**
 * What an acquisition pass may collect: the targets on servers the last index
 * pass accepted (guilds.json's guilds -- configured, prefix on the booru's
 * list, and she is a member). A server removed on the panel, refused, or not
 * yet joined collects nothing, whatever targets.json still names.
 */
function acquirable(guildsDoc, targets) {
  const prefixMap = new Map(((guildsDoc && guildsDoc.guilds) || []).map((g) => [g.id, g.prefix]));
  const live = new Set(((guildsDoc && guildsDoc.channels) || []).filter((c) => prefixMap.has(c.guild_id)).map((c) => c.id));
  return { prefixMap, channels: [...targets].filter((id) => live.has(id)) };
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
    if (m.user_id === id) return poster.discordCreatorName(m.username, m.user_id);
    if ((m.subs || []).some((x) => x.user_id === id)) return poster.discordCreatorName(m.username, m.user_id);
  }
  return author ? poster.discordCreatorName(author.username, author.id) : undefined;
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
  // Every server she is a member of, configured or not: an invitation shows
  // up here, which is how the panel offers a server nobody has typed in yet.
  const mine = await ctx.http.getJson("/users/@me/guilds", "the servers she is in");
  const memberGuilds = (Array.isArray(mine) ? mine : []).map((g) => ({ id: String(g.id), name: g.name }));
  const memberIds = new Set(memberGuilds.map((g) => g.id));
  // What became of each configured server this pass, for the panel.
  const servers = [];
  for (const s of ctx.servers) {
    const row = { guild_id: s.guild_id, name: s.name, prefix: s.prefix, state: "indexed", why: null };
    servers.push(row);
    if (s.why) { Object.assign(row, { state: "refused", why: s.why }); continue; }
    if (ctx.allowedPrefixes === null) {
      Object.assign(row, { state: "waiting", why: "the booru's creator-prefix list could not be read, so no prefix can be confirmed; tried again next pass" });
      continue;
    }
    if (!ctx.allowedPrefixes.has(`${s.prefix}_`)) {
      Object.assign(row, { state: "refused", why: `${s.prefix}_ is not on the booru's creator-prefix list, so its tags would be neither locked nor a known provenance. Fix: add it to the list (/creator_prefixes) or choose a listed prefix` });
      continue;
    }
    if (!memberIds.has(s.guild_id)) {
      Object.assign(row, { state: "awaiting_invite", why: "she is not a member of this server yet; invite her and it fills in on the next pass" });
      continue;
    }
    // One server failing to read never costs the others their pass.
    try {
      const g = await ctx.http.getJson(`/guilds/${s.guild_id}`, `server ${s.guild_id}`);
      const member = await ctx.http.getJson(`/guilds/${s.guild_id}/members/${ctx.selfId}`, `her membership of server ${s.guild_id}`);
      const list = await ctx.http.getJson(`/guilds/${s.guild_id}/channels`, `the channel list of server ${s.guild_id}`);
      // The server's own custom emojis, which she may use in its messages:
      // the panel turns :name: in what she is to say into Discord's <:name:id>.
      const emojis = (Array.isArray(g.emojis) ? g.emojis : [])
        .filter((e) => e && e.id && e.name && e.available !== false)
        .map((e) => ({ id: String(e.id), name: String(e.name), animated: Boolean(e.animated) }));
      // And its stickers: a bot may send only the server's own (up to three).
      const stickers = (Array.isArray(g.stickers) ? g.stickers : [])
        .filter((x) => x && x.id && x.name && x.available !== false)
        .map((x) => ({ id: String(x.id), name: String(x.name), format: Number(x.format_type) || 1 }));
      guilds.push({ id: s.guild_id, name: g.name, label: s.name, prefix: s.prefix, emojis, stickers });
      for (const ch of list) {
        if (ch.type === 4) {
          categories.push({ id: ch.id, guild_id: s.guild_id, name: ch.name, position: ch.position ?? 0 });
          continue;
        }
        if (ch.type !== 0 && ch.type !== 5) continue;
        channels.push({
          id: ch.id, guild_id: s.guild_id, name: ch.name, position: ch.position ?? 0, parent_id: ch.parent_id || null,
          presence: presenceIn(g, member, ch), target: targets.has(ch.id),
        });
      }
    } catch (err) {
      if (!(err instanceof ChannelRefused || err instanceof Transient)) throw err;
      Object.assign(row, { state: "error", why: err.message });
      ctx.log(`server ${s.guild_id}: ${err.message}`);
    }
  }
  const unseenTargets = [...targets].filter((id) => !channels.some((c) => c.id === id));
  const doc = { at: new Date(ctx.now()).toISOString(), guilds, categories, channels, unseenTargets, servers, member_guilds: memberGuilds };
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
  // The servers: given (opts.servers), or read from servers.json, or -- for
  // the hand-run tool -- built from a guild id -> prefix map.
  let servers = opts.servers || (await readServers(opts.stateDir));
  if (!servers && opts.prefixes) servers = Object.entries(opts.prefixes).map(([guild_id, prefix]) => ({ guild_id, name: null, prefix, why: legalPrefix(prefix) ? null : `prefix ${JSON.stringify(prefix)} is not legal` }));
  const ctx = {
    http: opts.http, stateDir: opts.stateDir, servers: servers || [], channels: opts.channels || [],
    // A Set of listed prefixes ("aichan_"), or null when the list could not
    // be read; undefined (a caller that does not check) allows every legal one.
    allowedPrefixes: opts.allowedPrefixes === undefined ? new Set((servers || []).map((x) => `${x.prefix}_`)) : opts.allowedPrefixes,
    selfId: opts.selfId || null, now: opts.now || (() => Date.now()), log: opts.log || ((m) => console.log(m)),
  };
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
  return { guilds: doc.guilds, channels: doc.channels, results, unseenTargets: doc.unseenTargets, servers: doc.servers };
}

/**
 * "Refresh now", asked for on the panel: index-request.json, written by the
 * panel, taken (removed) here before the pass it asks for runs. Taken first, so
 * a request made DURING the pass survives for the next one rather than being
 * swallowed by a pass that started before it.
 */
async function takeIndexRequest(stateDir) {
  const file = path.join(stateDir, "index-request.json");
  try {
    await fs.rm(file);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

module.exports = { indexOnce, refreshGuilds, indexChannel, scopeOf, nameFits, readTargets, readCreators, creatorNameFor, takeIndexRequest, readServers, seedServers, readJson, legalPrefix, acquirable, INDEX_DIR, SERVERS_FILE };
