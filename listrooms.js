"use strict";

// !listrooms -- an admin asks the bots which rooms they are actually sitting in.
//
// Split this way on purpose: the parts that DECIDE things are pure and tested
// here, the parts that TALK to Synapse live in index.js. The interesting
// question is not "can we call joined_rooms" but "whose rooms, and what does
// the answer look like when a bot is in ninety of them".
//
// Why more than one identity: this appservice acts as TWO bots. @tunnel is the
// scraper and is invited-only; Fourier-chan is her own user in the same
// namespace and is in every DM she has ever opened. "The bot" is ambiguous
// here, so the answer names both rather than guessing which one was meant.

// How many rooms to name before summarising. A bot that has DMed every member
// is in dozens; a Matrix message is not a report.
const LIST_CAP = 60;

// The bot identities this appservice can act as, most significant first.
// Pure: takes what it needs rather than reaching for config.
function botIdentities({ domain, senderLocalpart, onboarding }) {
  const ids = [];
  if (senderLocalpart) {
    ids.push({ label: "bridge", userId: `@${senderLocalpart}:${domain}` });
  }
  // Fourier-chan only exists when onboarding is on; listing her otherwise would
  // report an empty set for a user that was never registered, which reads like
  // "she is in no rooms" rather than "she does not exist".
  if (onboarding && onboarding.enabled) {
    const local = onboarding.localpart || "fourier";
    const userId = `@${local}:${domain}`;
    if (!ids.some((i) => i.userId === userId)) {
      ids.push({ label: "onboarding", userId });
    }
  }
  return ids;
}

// One bot's section. `rooms` is [{ roomId, name }]; name may be null.
function formatBotSection(userId, rooms, error) {
  if (error) return `${userId}\n  could not read: ${error}`;
  if (!rooms || rooms.length === 0) return `${userId}\n  (no rooms)`;

  const shown = rooms.slice(0, LIST_CAP);
  const lines = shown.map((r) => `  ${r.name ? r.name : "(unnamed)"}  ${r.roomId}`);
  const header = `${userId} -- ${rooms.length} room${rooms.length === 1 ? "" : "s"}`;
  if (rooms.length > shown.length) {
    lines.push(`  ...and ${rooms.length - shown.length} more`);
  }
  return [header, ...lines].join("\n");
}

// The whole reply. `sections` is [{ userId, rooms, error }].
function formatRoomList(sections) {
  if (!sections || sections.length === 0) return "No bot identities are configured.";
  return sections.map((s) => formatBotSection(s.userId, s.rooms, s.error)).join("\n\n");
}

// Rooms sort by name so the list is stable between runs; unnamed rooms sink to
// the bottom rather than scattering through it under their opaque ids.
function sortRooms(rooms) {
  return [...rooms].sort((a, b) => {
    if (a.name && b.name) return a.name.localeCompare(b.name);
    if (a.name) return -1;
    if (b.name) return 1;
    return a.roomId.localeCompare(b.roomId);
  });
}

module.exports = { botIdentities, formatBotSection, formatRoomList, sortRooms, LIST_CAP };
