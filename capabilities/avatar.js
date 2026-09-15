// "!setavatar": an admin says it in a DM, sends a picture, the bot wears it.
//
// WHY THIS IS ITS OWN FILE. It existed TWICE in this repo -- index.js
// handleAvatarFlow for the bridge bot and onboarding.js handleAvatarFlow for
// the greeter -- and the second copy's own comment said so: "the same flow the
// tunnel has (index.js handleAvatarFlow)". Two copies, one repo, one language,
// before a third bot existed.
//
// They had already drifted, which is the harm rather than the tidiness: the
// greeter wrote an audit record when an avatar changed and the bridge bot did
// not. Same command, two behaviours, and only one of them leaves evidence.
//
// EVERY DEPENDENCY IS INJECTED, and that is deliberate rather than stylistic.
// This is the first capability of the bot hub (fourier-basis
// docs/design/BOT_HUB.md), where it will be called on behalf of several bots by
// a process that owns none of their internals. A module that reaches for a
// module-scope Map, a config object or a bridge singleton cannot be moved
// there; one that is handed its pending store, its admin list and its audit
// sink can be moved by changing its import. Dependency injection is the
// migration.
//
// NOTHING HERE TALKS TO MATRIX DIRECTLY. It is handed `intent`, which is the
// only thing that does, so the same flow serves any bot and the tests need no
// homeserver.

"use strict";

/** How long an admin has to follow "!setavatar" with a picture. */
const AVATAR_PENDING_MS = 2 * 60 * 1000;

const PROMPT = "Send me an image and I'll use it as my avatar (within 2 minutes).";
const DONE = "Avatar updated.";

/**
 * @param {object} event   the Matrix event, as received
 * @param {object} deps
 * @param {(mxc: string) => Promise<void>} deps.setAvatarUrl
 * @param {(room: string, text: string) => Promise<void>} deps.sendText
 * @param {(room: string) => Promise<number>} deps.joinedMemberCount
 * @param {readonly string[]} deps.admins    who may run this
 * @param {Map<string, number>} deps.pending sender -> expiry, caller-owned so
 *        one bot's half-finished request can never satisfy another's
 * @param {(record: object) => void} deps.audit
 * @param {() => number} [deps.now]
 * @returns {Promise<boolean>} true when the event was CONSUMED -- the caller
 *          must not go on to treat it as ordinary traffic. An image that
 *          becomes an avatar is not also an image to tag.
 */
async function handleAvatarFlow(event, deps) {
  const { setAvatarUrl, sendText, joinedMemberCount, admins, pending, audit } = deps;
  const now = deps.now ?? Date.now;

  // Required, not defaulted. An audit sink that quietly defaults to a no-op is
  // how one of these two copies came to leave no evidence while the other did.
  if (typeof audit !== "function") {
    throw new TypeError("handleAvatarFlow requires audit(): a capability that changes a bot's face without a record is not auditable");
  }
  if (!(pending instanceof Map)) {
    throw new TypeError("handleAvatarFlow requires pending: a Map owned by the caller, so two bots cannot share one half-finished request");
  }

  if (event.type !== "m.room.message") return false;
  const content = event.content;
  if (!content) return false;

  const sender = event.sender;
  const roomId = event.room_id;
  if (!admins.includes(sender)) return false;

  if (content.msgtype === "m.text" && (content.body || "").trim() === "!setavatar") {
    // DM ONLY. A two-member room is the test: the command arms a state that
    // consumes the NEXT image from this sender, and in a populated room that
    // would swallow somebody else's picture.
    if ((await joinedMemberCount(roomId)) !== 2) return false;
    pending.set(sender, now() + AVATAR_PENDING_MS);
    await sendText(roomId, PROMPT);
    audit({ kind: "avatar_armed", admin: sender, room: roomId });
    return true;
  }

  if (content.msgtype === "m.image") {
    const expiry = pending.get(sender);
    if (!expiry) return false;
    if (now() > expiry) {
      // Expired requests are cleared on sight rather than left to accumulate,
      // and the image is NOT consumed -- it is an ordinary picture again.
      pending.delete(sender);
      audit({ kind: "avatar_expired", admin: sender, room: roomId });
      return false;
    }
    if ((await joinedMemberCount(roomId)) !== 2) return false;
    if (!content.url) return false;
    pending.delete(sender);
    try {
      await setAvatarUrl(content.url);
      await sendText(roomId, DONE);
      audit({ kind: "avatar_set", admin: sender, room: roomId, mxc: content.url });
    } catch (e) {
      // Said in the room, because the person who asked is standing there, AND
      // recorded, because a failure nobody can read later is not a report.
      await sendText(roomId, "Failed to set avatar: " + e.message);
      audit({ kind: "avatar_failed", admin: sender, room: roomId, error: e.message });
    }
    return true;   // consumed either way: it was an answer to the prompt
  }

  return false;
}

module.exports = { handleAvatarFlow, AVATAR_PENDING_MS, PROMPT, DONE };
