// Fourier-chan's onboarding: she opens a DM with every NEW local user, gives
// them the server rules, and asks if they agree. "Yes" earns the invite to
// the 41chan space plus a pointer to where the invite lands in their client.
// She assumes the role of the old "message the bot !join" step (which stays
// as a fallback for anyone who closes the DM).
//
// New users are found by polling the Synapse admin users API ordered by
// creation, because nothing pushes "a user registered" at an appservice. The
// watermark (creation_ts of the newest user already handled) persists in
// onboarding-state.json, and on FIRST run it seeds to "now" -- an empty state
// file must mean "greet people who arrive from here on", never "DM the whole
// backlog of existing residents".
//
// Fail-soft throughout: no admin token means the watch logs once and stays
// off (the !join path still works); a failed poll or DM is logged and
// retried on the next tick. The bot must keep tagging even when onboarding
// is broken -- instrumentation and side-quests never take down the service.

const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "onboarding-state.json");

const DEFAULT_RULES = [
  "Welcome to 41chan. Before I let you in, the rules:",
  "1. Don't be a cop.",
  "2. Don't post anything that summons real cops.",
  "3. What's posted here stays here.",
  "",
  "Do you agree? Type Yes to accept and I'll send your invite.",
].join("\n");

const DEFAULT_ACCEPT_HINT = [
  "Invite sent! Look at the top of your room list on the left -- the 41chan",
  "space shows there in green. Click it and accept, and you're in. Welcome.",
].join("\n");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch (e) {
    return null;
  }
}

function saveState(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}

class Onboarding {
  // Fourier-chan is HER OWN user (@fourier:<domain>), not the bridge bot:
  // @tunnel stays the tunnel (operator ruling 2026-09-05). The appservice
  // acts as her through bridge.getIntent(her id), which requires the
  // registration's users namespace to cover her MXID -- see the DEVLOG
  // deploy notes. `asToken` is the appservice token, used once to register
  // her through the MAS inhibit_login path.
  constructor(bridge, config, asToken, audit) {
    this.bridge = bridge;
    this.config = config;
    this.asToken = asToken;
    this.audit = audit;
    const cfg = (config.bridge && config.bridge.onboarding) || {};
    this.enabled = cfg.enabled !== false;
    this.pollMs = Math.max(15_000, cfg.poll_interval_ms || 60_000);
    this.rules = cfg.rules_text || DEFAULT_RULES;
    this.acceptHint = cfg.accept_hint || DEFAULT_ACCEPT_HINT;
    this.adminToken = (config.homeserver && config.homeserver.admin_token) || null;
    this.localpart = cfg.localpart || "fourier";
    this.userId = `@${this.localpart}:${config.homeserver.domain}`;
    this.displayName = cfg.display_name || "Fourier-chan";
    // { watermark_ts, pending: { [userId]: roomId }, greeted: { [userId]: ts } }
    this.state = loadState();
    this.timer = null;
  }

  // Her intent: every onboarding action -- the DM, the rules, the invite --
  // happens as @fourier, so the new user meets Fourier-chan, not the tunnel.
  intent() {
    return this.bridge.getIntent(this.userId);
  }

  // Register @fourier (MAS refuses plain appservice registration without
  // inhibit_login -- same trap ensureBotUser documents), name her, and seat
  // her in the space so she can send invites from inside it.
  //
  // She seats HERSELF. The tunnel does not invite her and must not: @tunnel is
  // the scraper, and its whole relationship to rooms is "a user invites ME"
  // (see invites.js). It is not in the space and has no power there, so the
  // old tunnel-invites-her step could only ever fail silently -- it was
  // swallowed by a bare catch, which is why nobody noticed it never worked.
  //
  // If she cannot join on her own, that is a REAL configuration gap and it is
  // said out loud rather than swallowed: a human must invite @fourier to the
  // space and grant her power level 50, which is what `invite` costs there.
  // Every step tolerates already-done, because a restart must not be an
  // error.
  async ensureUser() {
    const base = this.config.homeserver.url.replace(/\/+$/, "");
    const res = await fetch(`${base}/_matrix/client/v3/register`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.asToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "m.login.application_service", username: this.localpart, inhibit_login: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && body.errcode !== "M_USER_IN_USE") {
      throw new Error(`${body.errcode || res.status}: ${body.error || "register failed"}`);
    }
    await this.intent().setDisplayName(this.displayName);
    const space = this.config.bridge.onramp_room;
    if (space) {
      try {
        await this.intent().join(space);
      } catch (e) {
        console.warn(
          `[onboarding] ${this.userId} is not seated in ${space}: ${(e && e.message) || e}\n` +
          "[onboarding] invite her to the space and grant power level 50, or she cannot invite anyone.",
        );
      }
    }
    console.log(`[onboarding] ${this.userId} ready as "${this.displayName}"`);
  }

  start() {
    if (!this.enabled) {
      console.log("[onboarding] disabled by config");
      return;
    }
    if (!this.adminToken) {
      console.log("[onboarding] no homeserver.admin_token configured; new-user watch OFF (!join still works)");
      return;
    }
    if (!this.state) {
      // First run: greet arrivals from now on, not the existing residents.
      this.state = { watermark_ts: Date.now(), pending: {}, greeted: {} };
      saveState(this.state);
      console.log("[onboarding] state seeded; greeting users created after now");
    }
    const tick = () => {
      this.poll().catch((e) => console.error("[onboarding] poll failed:", e.message));
    };
    tick();
    this.timer = setInterval(tick, this.pollMs);
    console.log(`[onboarding] watching for new users every ${this.pollMs}ms`);
  }

  // One admin-API page of the newest users, newest first.
  async fetchNewestUsers() {
    const base = this.config.homeserver.url.replace(/\/+$/, "");
    const url = `${base}/_synapse/admin/v2/users?limit=50&order_by=creation_ts&dir=b&guests=false&deactivated=false`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.adminToken}` } });
    if (!res.ok) throw new Error(`admin users API ${res.status}`);
    const body = await res.json();
    return body.users || [];
  }

  isBotLike(userId) {
    const local = userId.slice(1).split(":")[0];
    return ["tunnel", "fourier", "bmb", "__oidc_admin"].includes(local) || local.startsWith("_");
  }

  async poll() {
    const users = await this.fetchNewestUsers();
    // creation_ts is SECONDS in the admin API; the watermark is ms.
    const fresh = users
      .filter((u) => (u.creation_ts || 0) * 1000 > this.state.watermark_ts)
      .sort((a, b) => (a.creation_ts || 0) - (b.creation_ts || 0));
    for (const user of fresh) {
      const userId = user.name;
      this.state.watermark_ts = Math.max(this.state.watermark_ts, (user.creation_ts || 0) * 1000);
      if (this.isBotLike(userId) || this.state.greeted[userId]) {
        saveState(this.state);
        continue;
      }
      await this.greet(userId);
      saveState(this.state);
    }
  }

  async greet(userId) {
    const intent = this.intent();
    try {
      const { room_id } = await intent.createRoom({
        createAsClient: false,
        options: {
          invite: [userId],
          is_direct: true,
          preset: "trusted_private_chat",
        },
      });
      await intent.sendText(room_id, this.rules);
      this.state.pending[userId] = room_id;
      this.state.greeted[userId] = Date.now();
      this.audit({ kind: "onboarding_greeted", user: userId, room: room_id });
      console.log(`[onboarding] greeted ${userId} in ${room_id}`);
    } catch (e) {
      // Not marked greeted: the next poll retries, because a user who never
      // got the rules must not be silently skipped past forever.
      this.audit({ kind: "onboarding_greet_failed", user: userId, error: (e.message || "").slice(0, 300) });
      console.error(`[onboarding] greet failed for ${userId}:`, e.message);
    }
  }

  // The reply handler: only fires in a DM this class opened, only for the
  // user it was opened for. Returns true when the event was consumed.
  async handleReply(event) {
    if (!this.state || event.type !== "m.room.message" || !event.content) return false;
    const userId = event.sender;
    const roomId = this.state.pending && this.state.pending[userId];
    if (!roomId || roomId !== event.room_id) return false;

    const body = (event.content.body || "").trim().toLowerCase();
    const intent = this.intent();

    if (body === "yes" || body === "yes.") {
      const targetRoom = this.config.bridge.onramp_room;
      try {
        // Hers, and only hers. There is deliberately no fallback: the tunnel
        // is the scraper and never invites anyone, so routing through it could
        // not have worked (it is not even in the space) and served only to
        // turn a precise permission error into "something broke".
        await intent.invite(targetRoom, userId);
        await intent.sendText(roomId, this.acceptHint);
        delete this.state.pending[userId];
        saveState(this.state);
        this.audit({ kind: "onboarding_agreed", user: userId, room: targetRoom });
      } catch (e) {
        const msg = (e && e.message) || "";
        if (/already|in room|is already (in|joined)/i.test(msg)) {
          await intent.sendText(roomId, "You already have an invite -- check the top of your room list to accept it.");
          delete this.state.pending[userId];
          saveState(this.state);
          this.audit({ kind: "onboarding_invite_noop", user: userId });
        } else if (/forbidden|not permitted|power level|M_FORBIDDEN/i.test(msg)) {
          // The one failure a human must act on, named as itself rather than
          // hidden inside a generic apology.
          await intent.sendText(roomId, "I can't send invites yet -- an admin has been told. Hang tight.");
          console.error(
            `[onboarding] CANNOT INVITE: ${this.userId} lacks permission in ${targetRoom}. ` +
            "Grant her power level 50 there.",
          );
          this.audit({ kind: "onboarding_invite_forbidden", user: userId, error: msg.slice(0, 300) });
        } else {
          await intent.sendText(roomId, "Something broke sending your invite; try again in a minute, or type !join.");
          this.audit({ kind: "onboarding_invite_failed", user: userId, error: msg.slice(0, 300) });
        }
      }
      return true;
    }

    // Anything that is not agreement gets the ask again, plainly. Never an
    // invite: agreement is the one GO.
    await intent.sendText(roomId, 'Type "Yes" (just that) when you agree to the rules, and I\'ll send your invite.');
    this.audit({ kind: "onboarding_nonyes", user: userId });
    return true;
  }
}

module.exports = { Onboarding };
