const fs = require("fs");
const yaml = require("js-yaml");
const axios = require("axios");
const { Cli, AppServiceRegistration, Bridge } = require("matrix-appservice-bridge");
const { DanbooruClient } = require("./danbooru");
const { autotag } = require("./autotagger");
const { extractCreatorTags } = require("./prompt-tags");
const invites = require("./invites");

const config = yaml.load(fs.readFileSync(require("path").join(__dirname, "config.yaml"), "utf8"));
const danbooru = new DanbooruClient(config.danbooru);

// Load the appservice token from the registration file for authenticated
// media downloads from Synapse.
/**
 * Register the bot user, on a homeserver that speaks OAuth2.
 *
 * NOT bridge.getIntent().ensureRegistered(). matrix-appservice-bridge posts a
 * plain appservice registration, and this homeserver runs MAS -- so it answers
 * IO.ELEMENT.MSC4190.M_APPSERVICE_LOGIN_UNSUPPORTED: "this server uses OAuth2,
 * so the inhibit_login parameter must be set to true for appservice
 * registrations". The bridge library has no way to pass it.
 *
 * That call has therefore been failing since MAS was introduced, and nobody
 * noticed for one reason: @bmb was registered BEFORE MAS, so the failure was
 * always a no-op on an account that already existed. It surfaced the moment the
 * bot was renamed and the user genuinely had to be created -- the bridge came
 * up, logged that it had ensured its user, and then 500'd setting a display
 * name on an account that did not exist.
 *
 * M_USER_IN_USE is success here: the account is what we wanted, and a restart
 * must not be an error.
 */
async function ensureBotUser(config, reg) {
  const localpart = reg.sender_localpart;
  const url = `${config.homeserver.url.replace(/\/+$/, "")}/_matrix/client/v3/register`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${reg.as_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.application_service",
      username: localpart,
      // The whole point. Without it, MAS refuses the registration outright.
      inhibit_login: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`[startup] bot user @${localpart} registered`);
    return;
  }
  if (body.errcode === "M_USER_IN_USE") {
    console.log(`[startup] bot user @${localpart} already exists`);
    return;
  }
  throw new Error(`${body.errcode || res.status}: ${body.error || "register failed"}`);
}

const _reg = yaml.load(fs.readFileSync(require("path").join(__dirname, "tunnel-registration.yaml"), "utf8"));
const AS_TOKEN = _reg.as_token;

const TAG_STATE_TYPE = "net.41chan.media.tags";

// Per-admin pending avatar requests: userId -> expiry epoch ms.
const avatarPending = new Map();
const AVATAR_PENDING_MS = 2 * 60 * 1000;

// Count joined members in a room (used to detect DMs = 2 members).
async function joinedMemberCount(bridge, roomId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch (e) {
    return -1; // unknown
  }
}

// True only if the bot user is currently joined to the room. Used to skip
// events from rooms the bot isn't in (e.g. backlog from a previously over-broad
// appservice namespace), so the appservice transaction is ACKed and the stream
// drains instead of wedging on an un-actionable foreign-room event.
async function botIsJoined(bridge, roomId, botUserId) {
  try {
    const state = await bridge.getIntent().roomState(roomId);
    return state.some(
      (e) =>
        e.type === "m.room.member" &&
        e.state_key === botUserId &&
        e.content.membership === "join"
    );
  } catch (e) {
    return false; // can't read state => not a member
  }
}

function isRoomDisabled(roomId) {
  return (config.bridge.disabled_rooms || []).includes(roomId);
}

async function downloadFromSynapse(mxcUrl, asToken) {
  const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
  const [, serverName, mediaId] = match;
  const url = `${config.homeserver.url}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${asToken}` },
    responseType: "arraybuffer",
    timeout: 30000,
  });
  return {
    buffer: Buffer.from(resp.data),
    contentType: resp.headers["content-type"] || "application/octet-stream",
  };
}

async function handleImageEvent(bridge, event) {
  const roomId = event.room_id;
  const mxcUrl = event.content && event.content.url;
  if (!mxcUrl) return;
  if (isRoomDisabled(roomId)) {
    console.log(`[skip] tagging disabled for room ${roomId}`);
    return;
  }
  console.log(`[image] ${mxcUrl} in ${roomId}`);

  const asToken = AS_TOKEN;
  const { buffer, contentType } = await downloadFromSynapse(mxcUrl, asToken);
  const filename =
    (event.content && event.content.body) || mxcUrl.split("/").pop() || "image";

  // Duplicate check: if Danbooru already has a post with this image's md5, skip
  // the (re-)upload — which on this fork fails with a 500 on duplicate md5 — and
  // just point the room's tag state at the existing post. This makes a re-posted
  // image an intended [skip], and still tags the new room correctly.
  const md5 = require("crypto").createHash("md5").update(buffer).digest("hex");
  const existing = await danbooru.findPostByMd5(md5);
  if (existing) {
    // Provenance was already recorded when this post was first created. Pull the
    // PUBLIC-SAFE projection so the new room's state matches and never carries
    // private creator tags. Fall back to tag_string for legacy posts with no
    // recorded provenance.
    let projection = null;
    try {
      projection = await danbooru.getTagProjection(existing.id);
    } catch (err) {
      console.warn(`[tag-hub] getTagProjection failed for post #${existing.id}: ${err.message}`);
    }
    if (!projection || projection.tags.length === 0) {
      const tagString = existing.tag_string || "";
      projection = {
        tags: tagString.split(/\s+/).filter(Boolean),
        sources: { creator: [], auto: [], both: [], meta: [] },
      };
    }
    await bridge.getIntent().sendStateEvent(roomId, TAG_STATE_TYPE, mxcUrl, {
      post_id: existing.id,
      tags: projection.tags,
      rating: existing.rating || config.bridge.default_rating,
      sources: projection.sources,
      updated_by: "tunnel",
      updated_at: Date.now(),
    });
    console.log(`[skip] duplicate md5 ${md5} -> existing post #${existing.id}`);
    return;
  }

  const upload = await danbooru.createUploadFromBytes(buffer, filename, contentType);
  const completed = await danbooru.waitForUpload(upload.id);
  const uma = completed.upload_media_assets && completed.upload_media_assets[0];
  const uploadMediaAssetId = uma && uma.id;
  if (!uploadMediaAssetId) throw new Error(`No upload media asset produced for upload ${upload.id}`);

  // Two tag sources on the in-flight bytes, both fail-soft:
  //   AUTO    -- fourier-spectrum (WD ViT v3).
  //   CREATOR -- the generation prompt embedded in the image (AI-gen PNGs).
  // A tagger/scrape outage posts with whatever it got rather than wedging the bridge.
  let derived = null;
  try {
    derived = await autotag(buffer, config);
  } catch (err) {
    console.warn(`[autotag] fourier-spectrum unavailable, posting untagged: ${err.message}`);
  }
  const autoTags = (derived && derived.tags) || [];
  let creatorTags = [], metaTags = [];
  try {
    const scraped = extractCreatorTags(buffer, contentType, { max: config.autotagger && config.autotagger.max_creator_tags });
    creatorTags = scraped.tags;
    metaTags = scraped.meta;
  } catch (err) {
    console.warn(`[creator-tags] prompt scrape failed: ${err.message}`);
  }
  // Provenance partition (UI: creator=green, auto=orange, both=gradient; meta =
  // de-emphasised quality/meta section). Creator-only display is privacy-gated
  // chanbooru-side (hidden by default); the bridge still records it.
  const creatorSet = new Set(creatorTags);
  const autoSet = new Set(autoTags);
  const both = autoTags.filter((t) => creatorSet.has(t));
  const autoOnly = autoTags.filter((t) => !creatorSet.has(t));
  const creatorOnly = creatorTags.filter((t) => !autoSet.has(t));
  // The booru's tag_string carries only PUBLIC tags. Creator-ONLY tags (prompt-
  // derived, may leak model names / private notes) never enter it; they travel
  // solely in the provenance partition below, where the booru stores them
  // private-by-default and withholds them from every public projection.
  const publicTags = [...new Set([...autoTags, ...metaTags])];
  const rating = (derived && derived.rating) || config.bridge.default_rating;

  const post = await danbooru.createPost(uploadMediaAssetId, {
    rating,
    tagString: publicTags.join(" "),
    source: mxcUrl,
  });

  // Single write path (the tag hub): hand the FULL partition to the booru. It
  // records it, keeps creator-only tags private, fans out to consumers, and hands
  // back the PUBLIC-SAFE projection we write into the room-public Matrix state.
  const partition = { creator: creatorOnly, auto: autoOnly, both, meta: metaTags };
  let projection = null;
  try {
    const recorded = await danbooru.recordTagSources(post.id, partition);
    projection = recorded && recorded.projection;
  } catch (err) {
    console.warn(`[tag-hub] recordTagSources failed for post #${post.id}: ${err.message}`);
  }
  // If the hub is unreachable, fall back to the booru's tag_string -- still
  // public-safe, since creator-only tags were never written to it.
  if (!projection) {
    const fullPost = await danbooru.getPost(post.id);
    projection = {
      tags: (fullPost.tag_string || "").split(/\s+/).filter(Boolean),
      sources: { creator: [], auto: autoOnly, both, meta: metaTags },
    };
  }

  const intent = bridge.getIntent();
  await intent.sendStateEvent(roomId, TAG_STATE_TYPE, mxcUrl, {
    post_id: post.id,
    tags: projection.tags,
    rating,
    // PUBLIC-SAFE provenance for the redesigned tag buckets. Creator-only tags are
    // withheld by the booru and surface only via its identity-gated read.
    sources: projection.sources,
    updated_by: "tunnel",
    updated_at: Date.now(),
  });
  console.log(`[done] post #${post.id} tagged (${creatorOnly.length} creator[private] / ${autoOnly.length} auto / ${both.length} both / ${metaTags.length} meta)`);
}

// Build the deps object handleInvite needs, backed by a bot Intent.
function inviteDeps(bridge) {
  const intent = bridge.getIntent();
  return {
    join: (roomId) => intent.join(roomId),
    leave: (roomId) => intent.leave(roomId),
    readPowerLevels: (roomId) =>
      intent.getStateEvent(roomId, "m.room.power_levels", ""),
    sendDM: async (userId, text) => {
      // Create (or reuse) a direct room with the user, then send.
      const room = await intent.createRoom({
        createAsClient: true,
        options: {
          preset: "trusted_private_chat",
          invite: [userId],
          is_direct: true,
        },
      });
      const roomId = room.room_id || room.roomId;
      await intent.sendText(roomId, text);
    },
  };
}

// Handle the !join on-ramp command. DM-only: a local (:<domain>) user messages
// "!join" to the bot and is invited into the main space. Invite-and-accept, NOT
// force-join -- the Synapse admin join endpoint acts as @__oidc_admin (not in
// the room) and refuses, so invite-and-accept is the mechanism (D-80cec7 /
// G-6f1488). Remote users are refused with a helpful message.
async function handleJoinCommand(bridge, event) {
  const body = event.content && event.content.body;
  if (!body || body.trim() !== "!join") return false;
  const sender = event.sender;
  const roomId = event.room_id;
  const intent = bridge.getIntent();
  // DM only: exactly two joined members (bot + user).
  if ((await joinedMemberCount(bridge, roomId)) !== 2) return false;
  // Local-only gate: sender MXID must be on this homeserver. This is a
  // deliberate policy choice (local users self-serve; remote users need a
  // human invite), NOT a technical constraint -- @tunnel can invite any MXID
  // regardless of server. Revisit this gate if the server privacy model opens
  // up (e.g. self-service on-ramp for all users).
  const domain = config.homeserver.domain;
  if (!sender.endsWith(":" + domain)) {
    await intent.sendText(
      roomId,
      "The !join command is for " + domain + " members only. " +
      "If you're on another server, message @saber:41chan.net to be invited to the space."
    );
    invites.audit({ kind: "onramp_refused_remote", sender });
    return true;
  }
  const targetRoom = config.bridge.onramp_room;
  // @tunnel (PL 100, seated in the space) invites the user. The user accepts the
  // invite in their client to enter. We do NOT force-join: the Synapse admin
  // join endpoint acts as @__oidc_admin (not in the room) and refuses, so
  // invite-and-accept is the mechanism. Tolerate "already invited/joined".
  try {
    await intent.invite(targetRoom, sender);
    await intent.sendText(
      roomId,
      "I've sent you an invite to the 41chan space. Accept it in your client to join. Welcome."
    );
    invites.audit({ kind: "onramp_invited", sender, room: targetRoom });
  } catch (e) {
    const msg = (e && e.message) || "";
    if (/already|in room|is already (in|joined)/i.test(msg)) {
      await intent.sendText(
        roomId,
        "You already have an invite to (or membership in) the 41chan space. Check your invites to accept."
      );
      invites.audit({ kind: "onramp_invite_noop", sender });
    } else {
      await intent.sendText(roomId, "Sorry, I couldn't invite you right now. Please message @saber:41chan.net.");
      invites.audit({ kind: "onramp_invite_failed", sender, error: msg.slice(0, 300) });
    }
  }
  return true;
}

// Handle the !resetstrikes admin command. DM-only: requires sender in the
// admin list AND a two-member room (bot + admin).
async function handleResetCommand(bridge, event) {
  const body = event.content && event.content.body;
  if (!body || !body.startsWith("!resetstrikes")) return false;

  const sender = event.sender;
  if (!(config.bridge.strike_reset_admins || []).includes(sender)) {
    invites.audit({ kind: "reset_denied_not_admin", sender });
    return true;
  }

  const intent = bridge.getIntent();
  // Confirm this is a DM: exactly two members.
  let memberCount = 0;
  try {
    const state = await intent.roomState(event.room_id);
    memberCount = state.filter(
      (e) => e.type === "m.room.member" && e.content.membership === "join"
    ).length;
  } catch (e) {
    memberCount = 0;
  }
  if (memberCount !== 2) {
    invites.audit({ kind: "reset_denied_not_dm", sender, room: event.room_id });
    return true;
  }

  const target = body.split(/\s+/)[1];
  if (!target) {
    await intent.sendText(event.room_id, "Usage: !resetstrikes @user:domain");
    return true;
  }

  const state = invites.loadStrikes();
  const had = state[target] ? state[target].strikes : 0;
  delete state[target];
  invites.saveStrikes(state);
  invites.audit({ kind: "strikes_reset", admin: sender, target, cleared: had });
  await intent.sendText(
    event.room_id,
    `Cleared ${had} strike${had === 1 ? "" : "s"} for ${target}.`
  );
  return true;
}

// Handle avatar-setting flow in a DM from an admin.
// Returns true if the event was consumed by this handler.
async function handleAvatarFlow(bridge, event) {
  const sender = event.sender;
  const roomId = event.room_id;
  const isAdmin = (config.bridge.strike_reset_admins || []).includes(sender);
  if (!isAdmin) return false;

  const intent = bridge.getIntent();
  const content = event.content || {};

  // The !setavatar command (text message)
  if (content.msgtype === "m.text" && content.body && content.body.trim() === "!setavatar") {
    if ((await joinedMemberCount(bridge, roomId)) !== 2) return false; // DM only
    avatarPending.set(sender, Date.now() + AVATAR_PENDING_MS);
    await intent.sendText(roomId, "Send me an image and I'll use it as my avatar (within 2 minutes).");
    return true;
  }

  // A following image, if this admin has a live pending request in a DM
  if (content.msgtype === "m.image") {
    const expiry = avatarPending.get(sender);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      avatarPending.delete(sender);
      return false;
    }
    if ((await joinedMemberCount(bridge, roomId)) !== 2) return false;
    const mxc = content.url;
    if (!mxc) return false;
    avatarPending.delete(sender);
    try {
      await intent.setAvatarUrl(mxc);
      await intent.sendText(roomId, "Avatar updated.");
    } catch (e) {
      await intent.sendText(roomId, "Failed to set avatar: " + e.message);
    }
    return true; // consumed — do not tag
  }

  return false;
}

new Cli({
  registrationPath: "tunnel-registration.yaml",
  generateRegistration: function (reg, callback) {
    reg.setId("fourier-tunnel");
    reg.setHomeserverToken(AppServiceRegistration.generateToken());
    reg.setAppServiceToken(AppServiceRegistration.generateToken());
    reg.setSenderLocalpart("tunnel");
    reg.addRegexPattern("users", "@.*", false);
    callback(reg);
  },
  run: function (port) {
    const bridge = new Bridge({
      homeserverUrl: config.homeserver.url,
      domain: config.homeserver.domain,
      registration: "tunnel-registration.yaml",
      controller: {
        onUserQuery: function () {
          return {};
        },
        onEvent: async function (request) {
          const event = request.getData();
          // The robot wanted me to erase this, but I think it's funny, so I'm leaving it here
          const botUserId = `@tunnel:${config.homeserver.domain}`;

          try {
            // Invite directed at the bot
            if (
              event.type === "m.room.member" &&
              event.content &&
              event.content.membership === "invite" &&
              event.state_key === botUserId
            ) {
              const verdict = await invites.handleInvite(event, inviteDeps(bridge), config);
              console.log(`[invite] ${event.sender} -> ${event.room_id}: ${verdict}`);
              return;
            }

            // Skip any non-invite event from a room the bot isn't joined to.
            // This ACKs (drains) backlog left over from a previously over-broad
            // appservice namespace, and is correct defense-in-depth: the bridge
            // only ever acts in rooms it was invited into and joined.
            if (!(await botIsJoined(bridge, event.room_id, botUserId))) {
              return;
            }

            if (event.type === "m.room.message" && event.content) {
              // Local on-ramp command (DM only)
              if (await handleJoinCommand(bridge, event)) return;
              // Admin reset command (DM only)
              if (await handleResetCommand(bridge, event)) return;
              // Avatar-setting flow (admin DM) — checked before tagging
              if (await handleAvatarFlow(bridge, event)) return;
              // Image tagging
              if (event.content.msgtype === "m.image") {
                // DM policy: skip tagging in 2-member rooms unless tag_in_dms is on
                if (!config.bridge.tag_in_dms) {
                  const members = await joinedMemberCount(bridge, event.room_id);
                  if (members === 2) {
                    console.log(`[skip] DM tagging disabled, room ${event.room_id}`);
                    return;
                  }
                }
                await handleImageEvent(bridge, event);
              }
            }
          } catch (err) {
            console.error(`[error] onEvent:`, err.message);
          }
        },
      },
    });
    console.log(`fourier-tunnel listening on port ${port}`);
    bridge.run(port).then(async () => {
      try {
        await ensureBotUser(config, _reg);
        await bridge.getIntent().setDisplayName("Fourier");
        console.log("[startup] display name set to Fourier");
      } catch (e) {
        console.error("[startup] failed to register bot user:", e.message);
      }
    });
  },
}).run();
