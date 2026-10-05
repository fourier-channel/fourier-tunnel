"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const acq = require("./discordAcquire");
const { indexOnce, readTargets, readCreators, creatorNameFor, takeIndexRequest, readServers, seedServers, readJson, acquirable } = require("./discordIndex");
const speak = require("./discordSpeak");
const { booruDeliverer } = require("./discordPost");
const { PresenceClient } = require("./discordPresence");
const { IdentifyBudget, SessionStore } = require("./discordGateway");

// TONNERU-CHAN IN DISCORD, AS A RUNNING SERVICE.
//
// The pieces were built and proven by hand (tools/discord-*.js); this runs them
// inside the tunnel's own process, beside the Matrix bridge, when config.yaml
// carries a `discord:` block. Four loops, each scheduling its next pass only
// after the last one finished, so a slow pass never overlaps itself:
//
//   index     every channel she can read, into the plan  (every 5 min, and
//             within seconds when the panel's "refresh now" asks)
//   acquire   the scrape targets the panel chose, to the booru (every 2 min)
//   speak     what the operator queued on the panel            (every 3 s)
//   presence  her gateway connection, so she shows online      (held open)
//
// FAILURE IS PER LOOP, and loud. A loop that throws logs why and tries again
// next interval; the others carry on and the Matrix bridge never notices. The
// one exception is a refused token: every Discord loop stops at once, because
// Discord bans an IP after 10,000 invalid requests in ten minutes and four
// loops retrying a dead token would get there.
//
// THE STATE DIRECTORY IS SHARED with fourier-sampling's panel (FS_DISCORD_DIR
// there), which runs as another user. It is created setgid to that user's
// group, and this process writes with umask 002, so files made here stay
// writable by the group the panel runs in.
//
// presence.json is rewritten every minute with her connection state, so the
// panel's "online" lamp can tell a live connection from a stale file left by a
// tunnel that died: the stamp's age is the evidence, not the word "online".

const MIN = 60_000;

function startDiscord(deps) {
  const { config, log = console } = deps;
  const dc = config.discord;
  if (!dc || dc.enabled === false) return null;
  const say = (level, msg) => log[level === "error" ? "error" : level === "warn" ? "warn" : "log"](`[discord] ${msg}`);

  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  const stateDir = dc.state_dir;
  // THE SERVERS ARE THE PANEL'S (servers.json in state_dir, operator
  // 2026-10-05), re-read every pass. config.yaml's discord.guilds only seeds
  // that file the first time, so an older deployment keeps its servers.
  const problems = [];
  if (!token) problems.push("DISCORD_BOT_TOKEN is not set in the tunnel's .env");
  if (!stateDir) problems.push("discord.state_dir is not set (the directory shared with the panel; /discord in the container)");
  if (problems.length) {
    say("error", `NOT STARTED -- ${problems.join("; ")}. The Matrix bridge runs as normal.`);
    return null;
  }
  process.umask(0o002);

  const pkgVersion = require("./package.json").version;
  const ua = acq.userAgent(dc.ua_url || process.env.DISCORD_UA_URL || "https://github.com/fourier-channel/fourier-tunnel", pkgVersion);
  const http = new acq.DiscordHttp({ token, ua, fetchImpl: deps.fetchImpl });
  const speakHttp = new acq.DiscordHttp({ token, ua, spacingMs: 250, fetchImpl: deps.fetchImpl });
  const timers = new Set();
  let stopped = false;
  let selfId = null;
  const presenceState = { state: dc.presence === false ? "disabled" : "starting", since: new Date().toISOString(), detail: null };

  const stopAll = (why) => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) clearTimeout(t);
    if (presence) presence.stop();
    presenceState.state = "stopped";
    presenceState.detail = why;
    void stampPresence();
    say("error", `EVERY DISCORD LOOP STOPPED: ${why}`);
  };

  async function stampPresence() {
    try {
      const tmp = path.join(stateDir, `presence.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify({ ...presenceState, at: new Date().toISOString() }) + "\n");
      await fs.rename(tmp, path.join(stateDir, "presence.json"));
    } catch (err) {
      say("warn", `could not stamp presence.json: ${err.message}`);
    }
  }

  function loop(name, everyMs, firstMs, fn) {
    const run = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (err) {
        if (err instanceof acq.AuthFailed) return stopAll(err.message);
        say("warn", `${name} pass failed: ${err && err.message ? err.message : String(err)}; next pass in ${Math.round(everyMs / 1000)} s`);
      }
      if (!stopped) schedule(everyMs);
    };
    const schedule = (ms) => {
      const t = setTimeout(() => { timers.delete(t); void run(); }, ms);
      timers.add(t);
    };
    schedule(firstMs);
  }

  const categorised = new Set();
  let prefixMap = new Map();
  // The booru's creator-prefix list as last read: null until it has been read.
  let allowedPrefixes = null;
  const deliver = booruDeliverer({
    danbooru: deps.danbooru,
    autotag: deps.autotag,
    extractCreatorTagsFromFields: deps.extractCreatorTagsFromFields,
    config,
    // The servers that passed the last index pass's checks (configured, on
    // the booru's prefix list, and she is a member), refreshed before every
    // acquisition pass.
    prefixFor: (guildId) => prefixMap.get(guildId) || null,
    creatorFor: async (author) => creatorNameFor(await readCreators(stateDir), author),
    categoriseArtist: async (tag) => {
      if (!tag || categorised.has(tag)) return;
      await deps.danbooru.setTagCategory(tag, 1);
      await deps.danbooru.ensureArtist(tag);
      categorised.add(tag);
    },
    log: (m) => say("log", m),
  });

  let presence = null;

  (async () => {
    try {
      await fs.mkdir(stateDir, { recursive: true });
      await speak.initOutbox(stateDir);
      if (await seedServers(stateDir, dc.guilds)) {
        say("warn", "copied config.yaml discord.guilds into servers.json; the panel manages servers from now on and that config key is ignored -- remove it");
      } else if (dc.guilds && Object.keys(dc.guilds).length) {
        say("warn", "config.yaml discord.guilds is ignored: servers are managed on the panel (servers.json) -- remove the key");
      }
      const me = await http.getJson("/users/@me", "the bot's own user");
      selfId = me.id;
      const servers = (await readServers(stateDir)) || [];
      say("log", `started as ${me.username} (${me.id}) for ${servers.length} configured server(s); state in ${stateDir}`);
    } catch (err) {
      if (err instanceof acq.AuthFailed) return stopAll(err.message);
      say("error", `NOT STARTED -- could not reach Discord or the state directory: ${err.message}`);
      return;
    }

    // ONE index pass at a time, whichever loop asked for it: the timer and the
    // panel's request share this, so a request during a pass waits for it.
    let indexing = null;
    const indexNow = (why) => {
      if (!indexing) {
        indexing = (async () => {
          try {
            try {
              allowedPrefixes = new Set(await deps.danbooru.creatorPrefixes());
            } catch (err) {
              say("warn", `could not read the booru's creator-prefix list (${err.message}); ${allowedPrefixes ? "using the last one read" : "no server is indexed until it can be read"}`);
            }
            const r = await indexOnce({ http, stateDir, allowedPrefixes, channels: [], selfId, log: (m) => say("log", m) });
            for (const x of r.servers) if (x.state !== "indexed") say("log", `server ${x.guild_id} (${x.prefix}_): ${x.state} -- ${x.why}`);
            const rows = r.results.reduce((s, x) => s + (x.rows || 0), 0);
            if (rows || why === "requested") say("log", `index (${why}): ${rows} new attachment(s) listed across ${r.results.length} channel(s)`);
          } finally {
            indexing = null;
          }
        })();
      }
      return indexing;
    };
    loop("index", (dc.index_every_minutes || 5) * MIN, 5_000, () => indexNow("scheduled"));
    loop("index-request", 3_000, 3_000, async () => {
      if (await takeIndexRequest(stateDir)) await indexNow("requested");
    });

    loop("acquire", (dc.acquire_every_seconds || 120) * 1000, 60_000, async () => {
      // Only targets on servers the last index pass accepted: a server removed
      // on the panel, refused, or not yet joined collects nothing.
      const pick = acquirable(await readJson(path.join(stateDir, "guilds.json"), { guilds: [], channels: [] }), await readTargets(stateDir));
      prefixMap = pick.prefixMap;
      const { channels } = pick;
      if (!channels.length) return;
      const { results } = await acq.acquireOnce({
        http, deliver, channels, stateDir, selfId,
        startFrom: dc.start_from === "now" ? "now" : "beginning",
        log: (m) => say("log", m),
      });
      for (const x of results) if (x.delivered) say("log", `#${x.name || x.channel}: ${x.delivered} posted`);
    });

    loop("speak", (dc.speak_every_seconds || 3) * 1000, 3_000, async () => {
      await speak.processOutbox({ http: speakHttp, stateDir, channels: await speak.speakableChannels(stateDir), log: (m) => say("log", m) });
    });

    loop("presence-stamp", MIN, 1_000, stampPresence);

    if (dc.presence !== false) {
      try {
        const gw = await http.getJson("/gateway/bot", "the gateway address");
        presence = new PresenceClient({
          token,
          gatewayUrl: `${gw.url}/?v=10&encoding=json`,
          budget: new IdentifyBudget(path.join(stateDir, "identify-budget.jsonl")),
          sessions: new SessionStore(path.join(stateDir, "gateway-session.json")),
          status: "online",
          WebSocketImpl: globalThis.WebSocket,
          log: (level, message) => {
            if (/^(ready|resumed)/.test(message)) { presenceState.state = "online"; presenceState.since = new Date().toISOString(); presenceState.detail = null; void stampPresence(); }
            else if (/^reconnecting|^socket error|^zombied|^no HELLO/.test(message)) { presenceState.state = "connecting"; presenceState.detail = message; }
            else if (/presence STOPPED/.test(message)) { presenceState.state = "stopped"; presenceState.detail = message; void stampPresence(); }
            say(level, `presence: ${message}`);
          },
        });
        await presence.start();
      } catch (err) {
        if (err instanceof acq.AuthFailed) return stopAll(err.message);
        presenceState.state = "stopped";
        presenceState.detail = err.message;
        say("error", `presence NOT STARTED: ${err.message}; she will show offline, and acquisition is unaffected`);
      }
    }
  })();

  return { stop: () => stopAll("stopped by the tunnel") };
}

module.exports = { startDiscord };
