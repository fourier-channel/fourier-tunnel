"use strict";

// ONE WALK OVER EVERY JOINED ROOM'S TAG STATE, shared by the two things that
// rewrite tag state in rooms other than the one an image was posted in:
// quarantine.js reprojectQuarantine (a flag or a release of a tag) and
// tools/repoint-merged.js (a merge of duplicate booru posts). Extracted from
// the first so the second is not a parallel copy of it (operator ruling
// 2026-09-24: build on existing modules).
//
// The shape it fixes: the room list read ONCE, skipped rooms (denied) never
// touched -- not even read, since a read through the bridge's intent re-joins
// (rooms.js) -- ONE roomState read per room, filtered to tag-state events
// that carry a tag list and match `select`; and PER-ROOM ISOLATION: a room
// whose state cannot be read is handed to `onUnreadable` and the walk goes on.
// Pacing and per-event isolation are the caller's, inside `onRoom`, because
// only the caller knows which of its events write.
//
// deps:
//   bridge                   anything with getIntent().roomState(roomId)
//   stateType                the tag state event type (index.js TAG_STATE_TYPE)
//   roomIds()                -> [roomId], read once
//   skipRoom(roomId)         -> true to pass the room by unread
//   select(event)            -> true for a tag-state event the caller wants
//   onUnreadable(roomId, err, i, n)
//   onRoom(roomId, events, i, n)   i is 0-based; n the rooms walked
// Resolves n, the number of rooms walked.
async function walkTagState({ bridge, stateType, roomIds, skipRoom = () => false, select, onUnreadable, onRoom }) {
  if (!stateType) throw new TypeError("walkTagState needs stateType, the tag state event type");
  const rooms = (await roomIds()).filter((r) => !skipRoom(r));
  for (const [i, roomId] of rooms.entries()) {
    let events;
    try {
      events = (await bridge.getIntent().roomState(roomId))
        .filter((e) => e.type === stateType && e.content && Array.isArray(e.content.tags) && select(e));
    } catch (err) {
      await onUnreadable(roomId, err, i, rooms.length);
      continue;
    }
    await onRoom(roomId, events, i, rooms.length);
  }
  return rooms.length;
}

module.exports = { walkTagState };
