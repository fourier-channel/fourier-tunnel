"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const drop = require("./drop.js");
const { stripGeneration } = require("./strip-generation.js");

// DISCORD ACQUISITION: Tonneru-chan's second endpoint.
//
// Operator, 2026-09-21: "This is tunnel. tonneru-chan. Her job is to get the
// data back and forth between disparate systems." Matrix was the first system
// she was pointed at; this is the second. She reads an allowlisted channel over
// REST and hands each attachment to a DELIVERER. By operator ruling 2026-10-04
// that is the booru, posted exactly the way the Matrix path posts
// (discordPost.js), with the guild's creator-tag prefix keeping Discord posts
// apart from Matrix ones. The other deliverer, dropDeliverer below, publishes
// into fourier-sampling's drop directory for its archive instead.
//
// Design: fourier-basis/docs/design/DISCORD_INGEST.md, milestone M4. Every
// platform behaviour this file depends on was measured against a live token on
// 2026-09-21 (fourier-sampling tools/discord-probe.ts), not assumed:
//
//   - `?after=<id>` returns the block ADJACENT to the cursor, ordered
//     DESCENDING within the page. So a page is sorted ascending here and the
//     watermark only ever advances one processed message at a time, which
//     makes the order Discord happens to send irrelevant.
//   - Signed attachment URLs are valid for 24 hours, and a fresh fetch of the
//     message always returns a valid one (Discord's documented recovery). So a
//     URL is used in the cycle that listed it and NEVER persisted or logged:
//     a download that fails leaves the watermark behind its message, and the
//     next cycle re-lists it and gets a new URL.
//   - MESSAGE CONTENT gates the HTTP API, not only the gateway. Without it a
//     human's message arrives with empty content AND empty attachments, which
//     looks exactly like a channel with nothing in it. Discord never stores an
//     empty message, so a human message carrying nothing at all is that
//     symptom, and acquisition stops there rather than walking past it.
//
// WHAT CAN COST THE MOST, and the rules that answer it:
//
//   - Discord temporarily bans an IP that makes 10,000 invalid requests (401,
//     403, 429) in 10 minutes. A loop retrying a revoked token would get the
//     whole box blocked. So a 401 stops EVERYTHING at once, a 403 or 404
//     stops that channel at once, and neither is ever retried.
//   - The bot token is an Authorization HEADER and goes only to discord.com.
//     The CDN needs no credential and is sent none.
//   - The API version is pinned (v10): the unversioned default is v6.
//   - The User-Agent has Discord's mandatory form, or Cloudflare may refuse
//     the request: "DiscordBot ($url, $versionNumber)".
//
// WHY NOT THE EGRESS BROKER. fourier-sampling's broker exists because 4chan
// counts requests per IP across every process on the box. Discord limits a BOT
// TOKEN, publishes its buckets in response headers, and asks for sub-second
// waits -- and exactly one process holds this token. So this client honours
// Discord's own headers directly; routed through the broker, one routine 429
// would pause the host for its 30-second minimum.

const API = "https://discord.com/api/v10";
const SOURCE = "discord";
const DEFAULT_PAGE = 100;
const DEFAULT_SPACING_MS = 1000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const MAX_RETRIES = 5;
/** Text channel, announcement, announcement thread, public thread, private thread. */
const READABLE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);
/** The formats strip-generation.js can strip losslessly. Video and documents carry no prompt it can read. */
const STRIPPABLE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** The token is wrong or was reset. Nothing may be retried; a person must act. */
class AuthFailed extends Error {}
/** This channel cannot be read (permission removed, channel deleted). Others carry on. */
class ChannelRefused extends Error {}
/** The drop directory is not there. Delivering anywhere else would lose every entry. */
class DeliveryUnavailable extends Error {}
/** Worth trying again next cycle: a network error, a 5xx, a truncated download. */
class Transient extends Error {}

function userAgent(url, version) {
  return `DiscordBot (${url}, ${version})`;
}

/** Snowflakes are 64-bit. Number() silently rounds them; BigInt does not. */
function snowflakeCompare(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function isSnowflake(s) {
  return typeof s === "string" && /^\d{1,20}$/.test(s);
}

/** A URL with its query removed: a signed CDN URL's query IS the credential. */
function redactUrl(u) {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return "<unparseable url>";
  }
}

/**
 * A human message that came back with nothing in it.
 *
 * Discord refuses to store an empty message: there is always content, an
 * attachment, an embed, a sticker, a poll, components or a forwarded snapshot.
 * Every one of them empty, on a message a person sent, is what the API returns
 * when this app does not hold MESSAGE CONTENT -- and an attachment it hid would
 * be lost for good if the watermark walked past it.
 */
function contentWithheld(m) {
  if (!m || (m.type !== 0 && m.type !== 19)) return false;
  if (m.author && m.author.bot) return false;
  const none = (v) => !v || (Array.isArray(v) && v.length === 0);
  return none(m.content) && none(m.attachments) && none(m.embeds) && none(m.sticker_items) &&
    none(m.poll) && none(m.components) && none(m.message_snapshots);
}

/**
 * The HTTP side: spacing, Discord's rate-limit headers, and the stop rules.
 * fetch, sleep and now are injected so every branch can be driven in a test.
 */
class DiscordHttp {
  constructor({ token, ua, fetchImpl, sleep, now, spacingMs } = {}) {
    if (!token) throw new AuthFailed("no bot token. Set DISCORD_BOT_TOKEN to the bot token of the Discord application this archive owns (never a user token).");
    this.token = token;
    this.ua = ua;
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
    this.now = now || (() => Date.now());
    this.spacingMs = spacingMs ?? DEFAULT_SPACING_MS;
    this.nextAt = 0;
    this.requests = 0;
  }

  async #wait() {
    const t = this.now();
    if (this.nextAt > t) await this.sleep(this.nextAt - t);
    this.nextAt = Math.max(this.now(), this.nextAt) + this.spacingMs;
  }

  #noteBucket(res) {
    const h = (k) => res.headers.get(k);
    if (h("x-ratelimit-remaining") === "0") {
      const after = Number(h("x-ratelimit-reset-after"));
      if (Number.isFinite(after) && after > 0) this.nextAt = Math.max(this.nextAt, this.now() + Math.ceil(after * 1000));
    }
  }

  /** GET a JSON resource under the API. `scope` names what a 403/404 refuses. */
  async getJson(apiPath, scope) {
    for (let attempt = 0; ; attempt++) {
      await this.#wait();
      this.requests++;
      let res;
      try {
        res = await this.fetch(API + apiPath, {
          headers: { Authorization: `Bot ${this.token}`, "User-Agent": this.ua, Accept: "application/json" },
        });
      } catch (err) {
        throw new Transient(`GET ${apiPath} did not complete: ${err && err.message ? err.message : String(err)}`);
      }
      this.#noteBucket(res);
      if (res.status === 200) return res.json();
      if (res.status === 401) {
        throw new AuthFailed(
          `Discord answered 401 to GET ${apiPath}: the bot token is wrong or has been reset. Nothing was retried, ` +
          "because repeated invalid requests get the whole IP banned. Fix: reset the token in the Discord developer " +
          "portal, update DISCORD_BOT_TOKEN where secrets.declaration.yaml says it lives, then restart.",
        );
      }
      if (res.status === 403 || res.status === 404) {
        throw new ChannelRefused(
          `Discord answered ${res.status} to GET ${apiPath}: ${scope || "this resource"} cannot be read by the bot. ` +
          "Fix: give the bot View Channel and Read Message History on it (server settings > roles or the channel's " +
          "permissions), or take the channel off the allowlist.",
        );
      }
      if (res.status === 429) {
        let retry = Number(res.headers.get("retry-after"));
        try {
          const body = await res.json();
          if (body && Number.isFinite(Number(body.retry_after))) retry = Number(body.retry_after);
        } catch { /* the header stands */ }
        if (attempt >= MAX_RETRIES) throw new Transient(`GET ${apiPath} was rate limited ${attempt + 1} times in a row; stopping this cycle`);
        await this.sleep(Math.ceil((Number.isFinite(retry) && retry > 0 ? retry : 1) * 1000) + 50);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Transient(`GET ${apiPath} answered ${res.status}`);
    }
  }

  /**
   * POST a JSON body. Retried ONLY on 429, which Discord documents as "not
   * processed"; a 5xx or a network error may have landed, so it is reported as
   * Transient with that said, never repeated here -- a repeated send is a
   * duplicate message in somebody's channel.
   */
  async postJson(apiPath, body, scope) {
    for (let attempt = 0; ; attempt++) {
      await this.#wait();
      this.requests++;
      let res;
      try {
        res = await this.fetch(API + apiPath, {
          method: "POST",
          headers: { Authorization: `Bot ${this.token}`, "User-Agent": this.ua, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw new Transient(`POST ${apiPath} did not complete and may or may not have landed: ${err && err.message ? err.message : String(err)}`);
      }
      this.#noteBucket(res);
      if (res.status === 200 || res.status === 201) return res.json();
      if (res.status === 401) throw new AuthFailed(`Discord answered 401 to POST ${apiPath}: the bot token is wrong or has been reset. Nothing was retried. Fix: reset the token in the Discord developer portal and update DISCORD_BOT_TOKEN.`);
      if (res.status === 403 || res.status === 404) {
        throw new ChannelRefused(`Discord answered ${res.status} to POST ${apiPath}: the bot cannot post in ${scope || "this channel"}. Fix: give it Send Messages (and View Channel) there.`);
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        let retry = Number(res.headers.get("retry-after"));
        try {
          const b = await res.json();
          if (b && Number.isFinite(Number(b.retry_after))) retry = Number(b.retry_after);
        } catch { /* the header stands */ }
        await this.sleep(Math.ceil((Number.isFinite(retry) && retry > 0 ? retry : 1) * 1000) + 50);
        continue;
      }
      let detail = "";
      try { const b = await res.json(); detail = b && b.message ? `: ${b.message}` : ""; } catch { /* none */ }
      throw new Transient(`POST ${apiPath} answered ${res.status}${detail}${res.status >= 500 ? " (it may have landed; not repeated)" : ""}`);
    }
  }

  /** Download an attachment from its signed URL. No credential is sent to the CDN. */
  async download(url, expectedSize, maxBytes) {
    await this.#wait();
    this.requests++;
    let res;
    try {
      res = await this.fetch(url, { headers: { "User-Agent": this.ua } });
    } catch (err) {
      throw new Transient(`download of ${redactUrl(url)} did not complete: ${err && err.message ? err.message : String(err)}`);
    }
    if (res.status !== 200) throw new Transient(`download of ${redactUrl(url)} answered ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Transient(`download of ${redactUrl(url)} was ${buf.length} bytes, over the ${maxBytes}-byte cap`);
    if (Number.isFinite(expectedSize) && expectedSize > 0 && buf.length !== expectedSize) {
      throw new Transient(`download of ${redactUrl(url)} was ${buf.length} bytes; Discord said ${expectedSize}. Treated as truncated.`);
    }
    return buf;
  }
}

// ---- durable state ---------------------------------------------------------

function statePathFor(stateDir, channelId) {
  return path.join(stateDir, `discord-channel-${channelId}.json`);
}

/** Re-read every cycle: anything long-lived must re-read what it decides from. */
async function readChannelState(stateDir, channelId) {
  try {
    const s = JSON.parse(await fs.readFile(statePathFor(stateDir, channelId), "utf8"));
    if (s && s.after !== undefined && !isSnowflake(s.after)) throw new Error(`watermark ${JSON.stringify(s.after)} is not a snowflake`);
    return s || {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw new Error(`cannot read the watermark for channel ${channelId} (${statePathFor(stateDir, channelId)}): ${err.message}. Fix or remove the file; it is never guessed.`);
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

async function writeChannelState(stateDir, channelId, state) {
  await writeJsonAtomic(statePathFor(stateDir, channelId), state);
}

// ---- one attachment --------------------------------------------------------

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

/**
 * The DROP deliverer: strip the bytes and publish them, with a sidecar, into
 * fourier-sampling's drop directory for its drain.
 *
 * A deliverer is { name, prepare(), accepts(att) -> refusal|null,
 * deliver({channel, msg, att, bytes}) }. deliver returns {delivered, postId?, md5?} |
 * {alreadyQueued} | {refused: reason}, throws Transient when the message must
 * be retried next cycle, and DeliveryUnavailable when nothing can be. The other
 * deliverer is discordPost.js, which posts to the booru the way the Matrix path
 * does (operator ruling 2026-10-04).
 */
function dropDeliverer({ dropRoot, stateDir, namespace, now }) {
  const clock = now || (() => Date.now());
  return {
    name: "drop",
    async prepare() {
      const mount = await drop.mountLooksReal(dropRoot);
      if (!mount.ok) throw new DeliveryUnavailable(mount.reason);
    },
    accepts(att) {
      if (drop.extFor(att.filename) !== null) return null;
      return `${JSON.stringify(att.filename)} (${att.content_type || "no declared type"}) is not a type this archive carries. Allowed: ${[...drop.ALLOWED_EXT].join(" ")}`;
    },
    async deliver({ channel, msg, att, bytes }) {
      const ext = drop.extFor(att.filename);
      let generation = null;
      if (STRIPPABLE.has(ext)) {
        try {
          const s = stripGeneration(bytes, att.content_type);
          if (s.changed) {
            generation = { raw_md5: md5(bytes), removed: s.removed, confident: s.confident };
            bytes = s.buffer;
          }
        } catch (err) {
          return { refused: `${JSON.stringify(att.filename)} could not be cleared of generation data, so it was not delivered: ${err.message}` };
        }
      }
      const built = drop.buildSidecar({
        source: SOURCE,
        namespace,
        containerRef: channel.id,
        messageRef: msg.id,
        attachmentRef: att.id,
        filename: att.filename,
        author: msg.author ? (msg.author.global_name || msg.author.username) : undefined,
        authorRef: msg.author ? msg.author.id : undefined,
        postedAt: msg.timestamp,
        permalink: channel.guild_id ? `https://discord.com/channels/${channel.guild_id}/${channel.id}/${msg.id}` : undefined,
      });
      if (!built.ok) return { refused: built.reason };
      const r = await drop.publish(dropRoot, built.sidecar, bytes);
      if (!r.ok) {
        if (/no drop queue/.test(r.reason)) throw new DeliveryUnavailable(r.reason);
        throw new Transient(`delivering ${JSON.stringify(att.filename)} failed: ${r.reason}`);
      }
      if (generation && !r.alreadyQueued) {
        // Generation data never travels with the bytes (operator ruling
        // 2026-09-28): what the drop holds ends up served. The text is kept in
        // this bot's private state, keyed by the stripped md5 the archive files
        // the object under. Written after the delivery, so a retried
        // attachment is recorded once.
        const row = { md5: md5(bytes), ...generation, message_ref: msg.id, attachment_ref: att.id, container_ref: channel.id, at: new Date(clock()).toISOString() };
        await fs.appendFile(path.join(stateDir, "discord-generation.jsonl"), JSON.stringify(row) + "\n");
      }
      return { delivered: !r.alreadyQueued, alreadyQueued: r.alreadyQueued, stripped: Boolean(generation) };
    },
  };
}

/** Check, fetch and hand one attachment to the deliverer. */
async function deliverAttachment(ctx, channel, msg, att) {
  const refusal = ctx.deliver.accepts(att);
  if (refusal) return { refused: refusal };
  if (Number(att.size) > ctx.maxBytes) {
    return { refused: `${JSON.stringify(att.filename)} is ${att.size} bytes, over the ${ctx.maxBytes}-byte cap` };
  }
  const bytes = await ctx.http.download(att.url, Number(att.size), ctx.maxBytes);
  return ctx.deliver.deliver({ channel, msg, att, bytes });
}

// ---- one channel -----------------------------------------------------------

/**
 * One acquisition pass over one channel.
 *
 * The watermark is the id of the last message whose attachments were all
 * delivered or deliberately refused, and it advances one message at a time,
 * written to disk after each. A crash anywhere therefore replays at most one
 * message, and replay is free: the drop entry id is a pure function of the
 * message and attachment ids.
 */
async function acquireChannel(ctx, channelId) {
  const out = {
    channel: channelId, pages: 0, messages: 0, delivered: 0, alreadyQueued: 0, stripped: 0,
    refused: [], watermark: null, stopped: null, enrolled: false,
  };
  const channel = await ctx.http.getJson(`/channels/${channelId}`, `channel ${channelId}`);
  if (!READABLE_CHANNEL_TYPES.has(channel.type)) {
    throw new ChannelRefused(`channel ${channelId} is type ${channel.type}, which holds no messages to read. Fix: allowlist a text channel instead.`);
  }
  out.name = channel.name;
  const state = await readChannelState(ctx.stateDir, channelId);

  if (!state.after) {
    if (ctx.startFrom === "now") {
      // ENROLMENT. History from before the bot was pointed at the channel is
      // not taken unless asked for: whether to backfill pre-enrolment history
      // is the operator's call, recorded in the design doc as open.
      const latest = await ctx.http.getJson(`/channels/${channelId}/messages?limit=1`, `channel ${channelId}`);
      const at = latest.length ? latest[0].id : "0";
      await writeChannelState(ctx.stateDir, channelId, { after: at, enrolledAt: new Date(ctx.now()).toISOString(), startFrom: "now" });
      out.enrolled = true;
      out.watermark = at;
      ctx.log(`#${channel.name} (${channelId}): enrolled at message ${at}; earlier history is not collected (start-from now)`);
      return out;
    }
    state.after = "0";
    state.startFrom = "beginning";
  }

  for (;;) {
    const page = await ctx.http.getJson(`/channels/${channelId}/messages?after=${state.after}&limit=${ctx.pageSize}`, `channel ${channelId}`);
    out.pages++;
    if (!Array.isArray(page) || page.length === 0) break;
    const ordered = [...page].sort((a, b) => snowflakeCompare(a.id, b.id));
    if (snowflakeCompare(ordered[0].id, state.after) <= 0) {
      throw new Transient(`channel ${channelId}: a page after ${state.after} began at ${ordered[0].id}, which is not after the cursor. Stopping rather than re-walking.`);
    }
    for (const msg of ordered) {
      if (contentWithheld(msg)) {
        out.stopped =
          `message ${msg.id} from a person arrived with no content, attachments or embeds at all. That is what Discord sends ` +
          "when this app lacks the MESSAGE CONTENT intent, and walking past it would lose whatever it hid. The watermark " +
          `stays at ${state.after}. Fix: enable Message Content Intent for the application in the Discord developer portal (Bot tab).`;
        out.watermark = state.after;
        return out;
      }
      out.messages++;
      if (!(ctx.selfId && msg.author && msg.author.id === ctx.selfId)) {
        for (const att of msg.attachments || []) {
          let r;
          try {
            r = await deliverAttachment(ctx, channel, msg, att);
          } catch (err) {
            if (err instanceof Transient) {
              out.stopped = `${err.message}. The watermark stays at ${state.after}, so message ${msg.id} is re-listed (with a fresh URL) next cycle.`;
              out.watermark = state.after;
              return out;
            }
            throw err;
          }
          if (r.refused) {
            out.refused.push({ message: msg.id, attachment: att.id, reason: r.refused });
            ctx.log(`#${channel.name}: refused attachment ${att.id} of message ${msg.id}: ${r.refused}`);
          } else {
            if (r.delivered) out.delivered++;
            if (r.alreadyQueued) out.alreadyQueued++;
            if (r.stripped) out.stripped++;
          }
          await ctx.record({
            a: att.id, m: msg.id, c: channel.id, g: channel.guild_id || null, u: msg.author ? msg.author.id : null,
            st: r.refused ? "refused" : r.delivered ? "posted" : "held",
            ...(r.postId ? { p: r.postId } : {}),
            // The booru post's md5: the panel's thumbnail comes from it.
            ...(r.md5 ? { h: r.md5 } : {}),
            ...(r.refused ? { why: r.refused } : {}),
          });
        }
      }
      state.after = msg.id;
      state.lastMessageAt = msg.timestamp;
      await writeChannelState(ctx.stateDir, channelId, state);
    }
    if (page.length < ctx.pageSize) break;
  }
  out.watermark = state.after;
  return out;
}

// ---- a whole pass ----------------------------------------------------------

/**
 * One pass over every allowlisted channel, with per-channel isolation: a
 * channel that cannot be read is reported and the others carry on. A bad
 * token or a missing drop directory stops the pass, because neither can be
 * fixed by trying the next channel.
 *
 * Writes discord-status.json after every pass: the "reading" lamp's evidence.
 * It records the last pass that actually READ each channel, which is the thing
 * a lamp must measure -- arrivals cannot tell a quiet channel from a dead
 * acquirer, and the gateway's presence proves only that a socket is open.
 */
async function acquireOnce(opts) {
  const ctx = {
    http: opts.http,
    stateDir: opts.stateDir,
    startFrom: opts.startFrom === "beginning" ? "beginning" : "now",
    pageSize: opts.pageSize || DEFAULT_PAGE,
    maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES,
    selfId: opts.selfId || null,
    now: opts.now || (() => Date.now()),
    log: opts.log || ((m) => console.log(m)),
    // WHAT BECAME OF EACH ATTACHMENT, checked off against the plan
    // (discordIndex.js). One row per outcome: posted, held (already on the
    // booru or already queued) or refused with its reason. Append-only; a
    // reader keys on the attachment id and the latest row wins.
    record: async (row) => {
      const at = new Date((opts.now || Date.now)()).toISOString();
      await fs.appendFile(path.join(opts.stateDir, "acquired.jsonl"), JSON.stringify({ ...row, at }) + "\n");
    },
  };
  if (!Array.isArray(opts.channels) || opts.channels.length === 0) {
    throw new Error("no channels to read. The allowlist is explicit by design: name each channel id; there is no wildcard.");
  }
  for (const c of opts.channels) {
    if (!isSnowflake(c)) throw new Error(`allowlisted channel ${JSON.stringify(c)} is not a Discord id (17-20 digits)`);
  }
  ctx.deliver = opts.deliver || dropDeliverer({ dropRoot: opts.dropRoot, stateDir: opts.stateDir, namespace: opts.namespace || SOURCE, now: ctx.now });
  await ctx.deliver.prepare();

  const results = [];
  let fatal = null;
  for (const id of opts.channels) {
    try {
      results.push(await acquireChannel(ctx, id));
    } catch (err) {
      if (err instanceof ChannelRefused || err instanceof Transient) {
        results.push({ channel: id, stopped: err.message, refused: [], delivered: 0, alreadyQueued: 0 });
        ctx.log(`channel ${id}: ${err.message}`);
        continue;
      }
      fatal = err;
      break;
    }
  }
  const status = {
    at: new Date(ctx.now()).toISOString(),
    deliver: ctx.deliver.name,
    ok: !fatal && results.every((r) => !r.stopped),
    fatal: fatal ? fatal.message : null,
    channels: results.map((r) => ({
      channel: r.channel, name: r.name || null, read: !r.stopped, watermark: r.watermark || null,
      delivered: r.delivered || 0, alreadyQueued: r.alreadyQueued || 0, refused: (r.refused || []).length,
      stopped: r.stopped || null,
    })),
  };
  await writeJsonAtomic(path.join(ctx.stateDir, "discord-status.json"), status);
  if (fatal) throw fatal;
  return { results, status };
}

module.exports = {
  API,
  SOURCE,
  DiscordHttp,
  AuthFailed,
  ChannelRefused,
  DeliveryUnavailable,
  Transient,
  userAgent,
  snowflakeCompare,
  redactUrl,
  contentWithheld,
  readChannelState,
  acquireChannel,
  acquireOnce,
  dropDeliverer,
};
