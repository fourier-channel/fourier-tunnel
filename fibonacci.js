"use strict";

// Dynamic Reverse-Fibonacci point assignment (operator spec, fibonacci.md).
//
// Tasks arrive ordered HARDEST FIRST. Their point value comes from their
// POSITION, not from anything authored per task: the array is partitioned into
// nine brackets worth 55, 34, 21, 13, 8, 5, 3, 2 and 1, whose capacities are
// the Fibonacci sequence scaled by M = T / 144. Everything left over is worth
// 1. A user passes onboarding at GOAL points (144 by spec).
//
// This module is the DECISION and does no I/O, matching progression.js beside
// it. The numbers below are the spec's; the judgements about them are recorded
// in docs/FIBONACCI-REVIEW.md rather than argued in code.

// Points, and the bracket capacity at T = 144. Straight from the spec.
const BASE_DISTRIBUTION = [
  [55, 1],
  [34, 1],
  [21, 2],
  [13, 3],
  [8, 5],
  [5, 8],
  [3, 13],
  [2, 21],
];

const BASE_TASKS = 144;
const DEFAULT_GOAL = 144;

/**
 * Python's round(), which the reference implementation uses.
 *
 * Not the same function as JavaScript's. Python rounds a halfway case to the
 * nearest EVEN number; Math.round always rounds halves up. It changes real
 * results: at T = 72, M = 0.5, so the 8-point bracket's capacity is
 * round(5 * 0.5) = round(2.5), which is 2 in Python and 3 in JavaScript. The
 * spec ships Python, so the spec's arithmetic is what runs here.
 */
function roundHalfToEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Bracket capacities for T tasks: [{ points, capacity }], hardest first.
 *
 * `max(1, ...)` is the spec's, and it is load-bearing in a way worth naming:
 * it guarantees every bracket exists no matter how small T is, so a catalog of
 * eight tasks still has a 55-point task. That is what makes the top of the
 * scale reachable early, and also what makes the totals behave oddly at small
 * T -- see feasibility().
 */
function bracketPlan(T) {
  const M = T / BASE_TASKS;
  return BASE_DISTRIBUTION.map(([points, baseCount]) => ({
    points,
    capacity: Math.max(1, roundHalfToEven(baseCount * M)),
  }));
}

/**
 * Assign points to tasks ordered hardest first.
 *
 * Returns a NEW array of { ...task, points }. Never mutates its input, unlike
 * the reference implementation, which assigns into the caller's dicts.
 */
function assignPoints(tasksOrderedByComplexity) {
  const tasks = tasksOrderedByComplexity || [];
  const T = tasks.length;
  const out = [];
  let i = 0;

  for (const { points, capacity } of bracketPlan(T)) {
    for (let n = 0; n < capacity && i < T; n++) {
      out.push({ ...tasks[i], points });
      i++;
    }
  }
  // Everything past the named brackets is worth 1.
  while (i < T) {
    out.push({ ...tasks[i], points: 1 });
    i++;
  }
  return out;
}

/** Every point available if a user completed the entire catalog. */
function maxAchievable(assigned) {
  return assigned.reduce((sum, t) => sum + (t.points || 0), 0);
}

/**
 * Can this catalog actually reach the goal, and with how much room to spare?
 *
 * The question the spec never asks, and the reason this function exists: the
 * goal is FIXED at 144 while the point supply SCALES with T, so a small
 * catalog cannot reach it at all. Eight tasks yield 141 points in total -- a
 * user who does literally everything still fails. The caller is expected to
 * refuse to start rather than run an unwinnable onboarding.
 */
function feasibility(assigned, goal = DEFAULT_GOAL) {
  const max = maxAchievable(assigned);
  return {
    tasks: assigned.length,
    goal,
    maxAchievable: max,
    reachable: max >= goal,
    slack: max - goal,
    // What fraction of the whole catalog an average user must complete. At the
    // spec's own T = 144 this is about a third, which is what makes "speedrun
    // the hard ones or grind the easy ones" true. As T falls it climbs toward
    // 100%, and the philosophy stops holding well before it gets there.
    completionRequired: max > 0 ? goal / max : Infinity,
  };
}

/**
 * A user's score: each task counted at most ONCE.
 *
 * The spec is explicit ("A task ID can only be completed and scored once per
 * user profile"), and this is the sharpest reversal from the system it
 * replaces, where an activity could be repeated up to a per-activity cap.
 * Unknown ids score nothing, so a stale client cannot mint points.
 */
function scoreOf(assigned, completedIds) {
  const byId = new Map(assigned.map((t) => [t.id, t]));
  const seen = new Set();
  let score = 0;
  for (const id of completedIds || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const task = byId.get(id);
    if (task) score += task.points || 0;
  }
  return score;
}

/** Spec section 4C, clamped at 100. */
function progressPercent(score, goal = DEFAULT_GOAL) {
  if (!(goal > 0)) return 100;
  return Math.min(100, (score / goal) * 100);
}

function hasPassed(score, goal = DEFAULT_GOAL) {
  return score >= goal;
}

/**
 * What to suggest next: the cheapest not-yet-done task, then upward.
 *
 * Cheapest first rather than hardest, because the meter's job for a
 * non-technical user is to show that the next step is small.
 */
function nextTasks(assigned, completedIds, n = 3) {
  const done = new Set(completedIds || []);
  return assigned
    .filter((t) => !done.has(t.id))
    .sort((a, b) => a.points - b.points)
    .slice(0, n);
}

/** A fresh user profile. `completed` is a list so it round-trips through JSON. */
function emptyProfile(userId, now = Date.now()) {
  return { userId, createdAt: now, completed: [], score: 0, passedAt: null, announced: [] };
}

/**
 * Mark tasks complete. Returns the new profile and what actually changed.
 *
 * Pure, and never mutates. `newly` excludes anything already completed, which
 * is what makes a repeated action silent rather than spammy -- the spec's
 * once-per-profile rule, applied at the point where a message would be sent.
 */
function complete(assigned, profile, taskIds, goal = DEFAULT_GOAL, now = Date.now()) {
  const known = new Set(assigned.map((t) => t.id));
  const had = new Set(profile.completed || []);
  const newly = [];
  for (const id of taskIds || []) {
    if (!known.has(id) || had.has(id)) continue;
    had.add(id);
    newly.push(id);
  }
  const next = {
    ...profile,
    completed: [...had],
    score: scoreOf(assigned, [...had]),
  };
  const wasPassed = hasPassed(profile.score || 0, goal);
  const nowPassed = hasPassed(next.score, goal);
  if (nowPassed && !next.passedAt) next.passedAt = now;
  return {
    profile: next,
    newly,
    gained: next.score - (profile.score || 0),
    passed: nowPassed,
    justPassed: nowPassed && !wasPassed,
  };
}

module.exports = {
  emptyProfile,
  complete,
  BASE_DISTRIBUTION,
  BASE_TASKS,
  DEFAULT_GOAL,
  roundHalfToEven,
  bracketPlan,
  assignPoints,
  maxAchievable,
  feasibility,
  scoreOf,
  progressPercent,
  hasPassed,
  nextTasks,
};
