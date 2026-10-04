"use strict";

// WHAT CAN SHE DO IN THIS CHANNEL? Discord's own permission algorithm.
//
// The panel's BOT PRESENCE column (operator, 2026-10-04) is this answer, so it
// is computed from her roles and the channel's overwrites, never inferred from
// whether a list call happened to return something -- an empty message list is
// the SAME response for "nothing here" and "no Read Message History" (Discord
// documents that), which is exactly the kind of green that measures something
// next to the claim.
//
// The order is Discord's documented one (topics/permissions, "Permission
// Overwrites"): the guild owner has everything; base is @everyone's role
// permissions OR'd with every role the member holds; ADMINISTRATOR means
// everything and overrides every overwrite; then, on the channel, @everyone's
// deny then allow, the member's roles' denies (accumulated) then allows, then
// the member's own deny then allow. Permissions are 64-bit strings: BigInt.
//
// One thing this cannot show, by Discord's design: Get Guild Channels OMITS a
// channel the bot cannot view, so a channel she has no view of is not "N" in
// the panel -- it is absent. The panel says so where it lists them.

const BIT = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
};
const ALL = (1n << 64n) - 1n;

function big(v) {
  try {
    return BigInt(v || 0);
  } catch {
    return 0n;
  }
}

/** Guild-level permissions of a member: @everyone plus every role held. */
function basePermissions(guild, member) {
  if (guild.owner_id && member.user && guild.owner_id === member.user.id) return ALL;
  const roles = new Map((guild.roles || []).map((r) => [r.id, r]));
  let perms = big(roles.get(guild.id) && roles.get(guild.id).permissions);
  for (const id of member.roles || []) perms |= big(roles.get(id) && roles.get(id).permissions);
  if (perms & BIT.ADMINISTRATOR) return ALL;
  return perms;
}

/** Channel-level permissions: base, then the channel's overwrites in Discord's order. */
function channelPermissions(guild, member, channel) {
  const base = basePermissions(guild, member);
  if (base === ALL) return ALL;
  let perms = base;
  const ow = channel.permission_overwrites || [];
  const everyone = ow.find((o) => o.id === guild.id);
  if (everyone) {
    perms &= ~big(everyone.deny);
    perms |= big(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  const held = new Set(member.roles || []);
  for (const o of ow) {
    if (o.type === 0 && o.id !== guild.id && held.has(o.id)) {
      allow |= big(o.allow);
      deny |= big(o.deny);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const own = member.user && ow.find((o) => o.type === 1 && o.id === member.user.id);
  if (own) {
    perms &= ~big(own.deny);
    perms |= big(own.allow);
  }
  return perms;
}

/** The three answers the panel shows. */
function presenceIn(guild, member, channel) {
  const p = channelPermissions(guild, member, channel);
  const view = Boolean(p & BIT.VIEW_CHANNEL);
  return {
    view,
    history: view && Boolean(p & BIT.READ_MESSAGE_HISTORY),
    send: view && Boolean(p & BIT.SEND_MESSAGES),
  };
}

module.exports = { BIT, basePermissions, channelPermissions, presenceIn };
