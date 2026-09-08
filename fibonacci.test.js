"use strict";

// Tests for the reverse-Fibonacci scorer.
//
// Two jobs. Most of these pin the spec's arithmetic so it cannot drift. The
// last group pins the spec's PROBLEMS, so the numbers in
// docs/FIBONACCI-REVIEW.md are checked rather than asserted in prose -- if
// someone later changes the engine to make small catalogs winnable, those
// tests fail and the review document gets revisited with them.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bracketPlan, assignPoints, maxAchievable, feasibility, scoreOf,
  progressPercent, hasPassed, nextTasks, roundHalfToEven, BASE_DISTRIBUTION,
} = require("./fibonacci");

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
const pointsOf = (assigned) => assigned.map((t) => t.points);

test("at T=144 the brackets are exactly the spec's base profile", () => {
  const plan = bracketPlan(144);
  assert.deepEqual(plan.map((b) => [b.points, b.capacity]), BASE_DISTRIBUTION);
});

test("the spec's own base profile covers 143 tasks, not 144", () => {
  // 1+1+2+3+5+8+13+21 = 54 named slots, plus the spec's stated 89 one-pointers
  // = 143. The document says "Exactly 144 Tasks" and "(34 + 55 remainder
  // slots)". The remainder is 90. Harmless, because the implementation derives
  // the remainder instead of trusting the number, but it is an error in the
  // document and this is where that is written down.
  const named = BASE_DISTRIBUTION.reduce((s, [, c]) => s + c, 0);
  assert.equal(named, 54);
  assert.equal(named + 89, 143);
  assert.equal(144 - named, 90);
});

test("assignment fills brackets hardest first, then ones", () => {
  const a = assignPoints(mk(12));
  // T=12, so M = 1/12. Every bracket floors to 1 EXCEPT the 2-pointer, whose
  // base capacity of 21 gives 21/12 = 1.75 and rounds to 2. Worth pinning
  // precisely because it is the first place the scaling stops being uniform.
  assert.deepEqual(pointsOf(a), [55, 34, 21, 13, 8, 5, 3, 2, 2, 1, 1, 1]);
});

test("input is never mutated", () => {
  const input = mk(3);
  assignPoints(input);
  assert.equal(input[0].points, undefined);
});

test("Python's banker's rounding, not JavaScript's", () => {
  // The divergence is real at T=72: 5 * 0.5 = 2.5, which Python rounds to 2 and
  // Math.round would make 3.
  assert.equal(roundHalfToEven(2.5), 2);
  assert.equal(roundHalfToEven(3.5), 4);
  assert.equal(Math.round(2.5), 3, "guarding the assumption this test exists for");
  const eight = bracketPlan(72).find((b) => b.points === 8);
  assert.equal(eight.capacity, 2);
});

test("every bracket survives however small the catalog is", () => {
  for (const T of [1, 2, 5, 8]) {
    const plan = bracketPlan(T);
    assert.ok(plan.every((b) => b.capacity >= 1), `T=${T}`);
  }
  // With one task it is the 55-pointer, because brackets fill hardest first.
  assert.deepEqual(pointsOf(assignPoints(mk(1))), [55]);
});

test("a task is scored ONCE however many times it is reported", () => {
  const a = assignPoints(mk(12));
  assert.equal(scoreOf(a, ["t0"]), 55);
  assert.equal(scoreOf(a, ["t0", "t0", "t0"]), 55);
  assert.equal(scoreOf(a, ["t0", "t1"]), 89);
});

test("an unknown task id scores nothing", () => {
  const a = assignPoints(mk(12));
  assert.equal(scoreOf(a, ["nope", "t0"]), 55);
});

test("progress is a clamped percentage of the goal", () => {
  assert.equal(progressPercent(0), 0);
  assert.equal(progressPercent(72), 50);
  assert.equal(progressPercent(144), 100);
  assert.equal(progressPercent(1000), 100);
  assert.equal(hasPassed(143), false);
  assert.equal(hasPassed(144), true);
});

test("next suggestions are the CHEAPEST undone tasks", () => {
  const a = assignPoints(mk(12));
  const next = nextTasks(a, ["t11"], 2);
  assert.deepEqual(next.map((t) => t.points), [1, 1]);
  assert.ok(!next.some((t) => t.id === "t11"), "a done task is never suggested");
});

// ---- the problems, pinned ------------------------------------------------

test("EIGHT tasks cannot reach 144: today's catalog is unwinnable", () => {
  // The live catalog has 8 activities. 55+34+21+13+8+5+3+2 = 141.
  const f = feasibility(assignPoints(mk(8)));
  assert.equal(f.maxAchievable, 141);
  assert.equal(f.reachable, false);
});

test("the goal is only sanely reachable near the spec's own T=144", () => {
  // The philosophy is "speedrun the hard ones OR grind the easy ones". That is
  // only true when a user can pass on a fraction of the catalog. Small
  // catalogs demand almost all of it, which is neither speedrun nor choice.
  const at = (T) => feasibility(assignPoints(mk(T))).completionRequired;
  assert.ok(at(11) > 0.98, "11 tasks: essentially everything");
  assert.ok(at(18) > 0.9, "18 tasks: still essentially everything");
  assert.ok(at(144) < 0.4, "144 tasks: about a third, as designed");
});

test("a speedrun needs TWO 21-point tasks, which small catalogs do not have", () => {
  // 55 + 34 + 21 + 21 + 13 = 144 exactly: the spec's intended power-user path.
  // It requires the 21 bracket to hold 2, which needs round(2M) >= 2, i.e.
  // T >= 108. Below that the fast path does not exist at all.
  const twentyOnes = (T) => bracketPlan(T).find((b) => b.points === 21).capacity;
  assert.equal(twentyOnes(18), 1);
  assert.equal(twentyOnes(107), 1);
  assert.equal(twentyOnes(108), 2);
  assert.equal(55 + 34 + 21 + 21 + 13, 144);
});

// ---- per-user profiles ---------------------------------------------------

const { emptyProfile, complete } = require("./fibonacci");

test("completing a task raises the score once and only once", () => {
  const a = assignPoints(mk(12));
  let p = emptyProfile("@u:x");
  let r = complete(a, p, ["t0"]);
  assert.equal(r.profile.score, 55);
  assert.deepEqual(r.newly, ["t0"]);
  r = complete(a, r.profile, ["t0"]);
  assert.equal(r.profile.score, 55, "no change");
  assert.deepEqual(r.newly, [], "and nothing to announce");
  assert.equal(r.gained, 0);
});

test("profiles are never mutated", () => {
  const a = assignPoints(mk(12));
  const p = emptyProfile("@u:x");
  complete(a, p, ["t0"]);
  assert.deepEqual(p.completed, []);
  assert.equal(p.score, 0);
});

test("passing is reported once, on the crossing", () => {
  const a = assignPoints(mk(144));
  let p = emptyProfile("@u:x");
  // 55 + 34 + 21 + 21 + 13 = 144, the spec's power-user path.
  let r = complete(a, p, ["t0", "t1", "t2", "t3"]);
  assert.equal(r.profile.score, 131);
  assert.equal(r.passed, false);
  r = complete(a, r.profile, ["t4"]);
  assert.equal(r.profile.score, 144);
  assert.equal(r.justPassed, true, "the crossing");
  assert.ok(r.profile.passedAt);
  const again = complete(a, r.profile, ["t5"]);
  assert.equal(again.passed, true);
  assert.equal(again.justPassed, false, "not announced twice");
});

test("an unknown task id changes nothing", () => {
  const a = assignPoints(mk(12));
  const r = complete(a, emptyProfile("@u:x"), ["ghost"]);
  assert.equal(r.profile.score, 0);
  assert.deepEqual(r.newly, []);
});
