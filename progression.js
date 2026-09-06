"use strict";
// Onboarding progression -- the DECISION, with no I/O.
//
// Operator design 2026-09-06: dedupe is not a list of who was greeted, it is
// a matrix per user of "what steps they have taken and what is yet to come".
// Every activity a user needs to be comfortable with the site (join a room,
// type into chat, post an image, use an emoji, use an interaction, enter
// domain mode, interact in domain mode, use a thread, ...) is an entry in a
// CATALOG. As Fourier-chan records a user doing one, she updates their record,
// and when they have checked off enough boxes for a tier she sends them the
// next thing to try. Tiers are the "pre-recorded new user messages".
//
// What is 100% known and encoded here; what is still being designed lives in
// the catalog file, not in code:
//   - activities have different possible VALUES with different points
//     (`values: { text: 1, long: 2 }`; a value not listed scores `default`)
//   - each activity can cap how many points it can contribute (`max_points`),
//     so repeating one thing does not carry a user through every tier
//   - a tier has a THRESHOLD (points) and optionally `requires` (activities
//     that must have happened at least once); both must hold to pass
//   - passing a tier sends that tier's message, once, ever
//
// Pure: observe() takes the catalog, a user's record and one observation and
// returns the new record plus what to say. The I/O half (onboarding.js) feeds
// it Matrix events and client reports, and sends what it returns.

function emptyRecord(userId, now) {
  return {
    userId,
    createdAt: now,
    greetedAt: null,
    dmRoom: null,
    points: 0,
    tier: 0,
    activities: {},
    sentTiers: [],
  };
}

function pointsFor(activityDef, value) {
  const values = activityDef.values || {};
  if (value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(values, value)) {
    return Number(values[value]) || 0;
  }
  if (Object.prototype.hasOwnProperty.call(values, "default")) return Number(values.default) || 0;
  return Number(activityDef.points) || 0;
}

function totalPoints(record) {
  let sum = 0;
  for (const a of Object.values(record.activities)) sum += a.points || 0;
  return sum;
}

function tierSatisfied(tier, record) {
  if ((record.points || 0) < (tier.threshold || 0)) return false;
  for (const req of tier.requires || []) {
    const a = record.activities[req];
    if (!a || a.count < 1) return false;
  }
  return true;
}

// Highest tier whose conditions hold. Tiers are ordered; a user may satisfy
// several at once (a burst of activity) and lands on the highest, which is
// the message that matches where they actually are.
function highestSatisfiedTier(catalog, record) {
  let best = 0;
  for (const t of catalog.tiers || []) {
    if (tierSatisfied(t, record)) best = Math.max(best, t.id);
  }
  return best;
}

/**
 * Record one observation. Returns { record, advanced, message, tier }.
 *
 * Unknown activities are ignored (returned unchanged, `ignored: true`): a
 * client can only report what the catalog names, so a typo or a stale client
 * cannot mint points.
 */
function observe(catalog, record, obs, now = Date.now()) {
  const def = (catalog.activities || {})[obs.activity];
  if (!def) return { record, advanced: false, message: null, tier: record.tier, ignored: true };

  const next = JSON.parse(JSON.stringify(record));
  const entry = next.activities[obs.activity] || { count: 0, points: 0, values: {}, first: now, last: now };
  const gained = pointsFor(def, obs.value);
  const cap = def.max_points === undefined ? Infinity : Number(def.max_points);
  entry.count += 1;
  entry.points = Math.min(cap, entry.points + gained);
  entry.last = now;
  if (obs.value !== undefined && obs.value !== null) {
    entry.values[obs.value] = (entry.values[obs.value] || 0) + 1;
  }
  next.activities[obs.activity] = entry;
  next.points = totalPoints(next);

  const reached = highestSatisfiedTier(catalog, next);
  if (reached > next.tier) {
    next.tier = reached;
    const tierDef = (catalog.tiers || []).find((t) => t.id === reached);
    if (tierDef && !next.sentTiers.includes(reached)) {
      next.sentTiers.push(reached);
      return { record: next, advanced: true, message: tierDef.message || null, tier: reached };
    }
  }
  return { record: next, advanced: false, message: null, tier: next.tier };
}

// The activities a user has NOT yet done at least once -- "what is yet to
// come", for a status line or a nudge.
function remaining(catalog, record) {
  return Object.keys(catalog.activities || {}).filter(
    (name) => !record.activities[name] || record.activities[name].count < 1
  );
}

// Map a Matrix event to an observation, or null. Only what a room event can
// prove; client-side actions (domain mode, interactions) arrive as explicit
// reports, see CLIENT_REPORT_EVENT.
const CLIENT_REPORT_EVENT = "net.41chan.onboarding.activity";

function observationFromEvent(event) {
  if (!event || !event.type) return null;
  const c = event.content || {};
  if (event.type === "m.room.member" && c.membership === "join") {
    return { activity: "join_room", value: "any" };
  }
  if (event.type === "m.reaction") {
    return { activity: "use_emoji", value: "reaction" };
  }
  if (event.type === "m.room.message") {
    const rel = c["m.relates_to"];
    if (rel && rel.rel_type === "m.thread") return { activity: "use_thread", value: "reply" };
    if (c.msgtype === "m.image") return { activity: "post_image", value: "image" };
    if (c.msgtype === "m.text") {
      const body = c.body || "";
      return { activity: "send_message", value: body.length > 200 ? "long" : "text" };
    }
    return null;
  }
  if (event.type === CLIENT_REPORT_EVENT) {
    if (typeof c.activity !== "string") return null;
    return { activity: c.activity, value: c.value === undefined ? "any" : String(c.value) };
  }
  return null;
}

// Catalog sanity: every tier's `requires` names a real activity, thresholds
// are numbers, ids are unique and ascending. Throws with the first problem,
// so a bad catalog fails at startup rather than silently never advancing.
function validateCatalog(catalog) {
  const acts = catalog.activities || {};
  if (Object.keys(acts).length === 0) throw new Error("catalog has no activities");
  let lastId = 0;
  for (const t of catalog.tiers || []) {
    if (typeof t.id !== "number" || t.id <= lastId) throw new Error(`tier ids must be ascending; saw ${t.id} after ${lastId}`);
    lastId = t.id;
    if (t.threshold !== undefined && typeof t.threshold !== "number") throw new Error(`tier ${t.id}: threshold must be a number`);
    for (const r of t.requires || []) {
      if (!acts[r]) throw new Error(`tier ${t.id} requires unknown activity '${r}'`);
    }
  }
  return true;
}

module.exports = {
  emptyRecord,
  observe,
  remaining,
  observationFromEvent,
  validateCatalog,
  highestSatisfiedTier,
  CLIENT_REPORT_EVENT,
};
