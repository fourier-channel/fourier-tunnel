# Reverse-Fibonacci onboarding: what was built, and what needs a ruling

Implemented 2026-09-08 from `fibonacci.md`. The engine is written, tested and
deployed, **whitelisted to @saber only**, and the previous point system is
switched off. Nothing scores any other user right now.

Every number below is produced by the code and pinned by a test, so if the
engine changes these claims fail with it rather than quietly ageing.

---

## The one that blocks launch

**A fixed goal of 144 against a point supply that scales with task count means
a small catalog cannot be finished.** The spec sets brackets from
`M = T / 144`, so the points available shrink with the catalog while the goal
does not move.

| Tasks | Points available | Passable? | Share of the catalog a user must complete |
|---|---|---|---|
| 8 (the live catalog before this change) | 141 | **no** | 102% |
| 11 | 145 | yes | 99% |
| 18 (the catalog I built from section 3) | 155 | yes | 93% |
| 72 | 255 | yes | 56% |
| 144 (the spec's design point) | 421 | yes | 34% |

At 144 tasks a user passes on about a third of the board, which is what makes
"speedrun the hard ones or grind the easy ones" true. At 18 they must do
essentially all of it, including starting a video call and creating a room.
That is not a choice between two routes; it is a checklist.

**The stated power-user path does not exist below 108 tasks.** The spec's own
example, 55 + 34 + 21 + 21 + 13 = 144, needs *two* 21-point tasks. The 21
bracket only holds two when `round(2M) >= 2`, i.e. `T >= 108`. With 18 tasks
there is exactly one, so the fast route is arithmetically impossible.

Three ways out, and this is your call:

1. **Grow the catalog** toward 144 tasks. Faithful to the spec, and a lot of
   tasks to invent that are all genuinely detectable.
2. **Scale the goal with the catalog**, e.g. goal = 34% of the points
   available. Keeps the philosophy at any size; abandons "exactly 144".
3. **Keep 144 and accept** that onboarding is near-total completion until the
   catalog grows.

Nothing is guessed in the code: the goal is read from the catalog file, and
the bot logs a loud warning at startup when the goal is unreachable or needs
more than 80% completion.

---

## The one that blocks it working at all

**Only 43 of the 144 points can be earned from Matrix events.** The rest
depend on Technetium reporting them, and it does not do so today.

Worse, the two most valuable tasks are the two the server can never witness:

| Task | Points | Detected by |
|---|---|---|
| Contributed to a gallery-mode thread | 55 | client report |
| Created a room with topic and avatar | 34 | client report |

That is 89 points, 57% of the goal, **asserted by the client rather than
proven by the server**. The report path is already restricted so a client can
only claim tasks the catalog marks as client-detected, and only from its own
DM with the bot, so one user cannot report for another. It still means a
modified client can award itself most of onboarding. Acceptable for a
trust-the-user community, and worth knowing before privileges hang off it.

---

## Genuine 180s from the system this replaces

The tier engine (`progression.js`, your design of 2026-09-06) is still in the
tree and reachable with `engine: tiers`. It is not deleted, because these are
reversals of decisions that were made deliberately and recently.

1. **Repeatable becomes once-only.** The old design scored an activity every
   time up to a per-activity cap (`max_points`), so a chatty user kept
   earning. The spec says "a task ID can only be completed and scored once per
   user profile". Posting a second image is now worth nothing.

2. **Authored values become positional.** The old catalog stated what each
   thing was worth, including different values for variants (`text: 1,
   long: 2`). Points now come only from a task's rank in the list. Nothing in
   the task file names a number, deliberately: a second source of truth would
   silently disagree with the engine. To make something worth more, move it up.

3. **Tiers disappear.** The old design's centre was a ladder of thresholds
   with `requires` gates, each sending a written message once. Your comment in
   `progression.js` calls these "the pre-recorded new user messages". The spec
   has one threshold and one celebration, so the four tier messages have
   nowhere to go. **I did not delete them**; they sit unused in
   `progression.yaml`. If the ladder mattered, it can be rebuilt on top of the
   new scores as score checkpoints.

4. **Scale changes by a factor of four.** Old catalog: 8 activities, 38 points
   in total. New: 18 tasks, 155 points, goal 144.

---

## Errors in the spec document itself

5. **The base profile covers 143 tasks, not 144.** `1+1+2+3+5+8+13+21 = 54`
   named slots plus the stated 89 one-pointers is 143. The remainder for 144
   is 90; the document's "(34 + 55 remainder slots)" is where the 89 comes
   from. Harmless in practice, because the implementation derives the
   remainder rather than trusting the number.

6. **Section 3's point values contradict section 2's algorithm** at any task
   count other than 144. Section 3 says notification overrides are worth 21
   and uploads 13; with 18 tasks the algorithm gives them 13 and 8. I made the
   **algorithm authoritative** and treat section 3 as guidance for *ordering*,
   since section 2 is the mechanism and section 3 says tasks must "fit cleanly
   into these profiles". Say if you meant the opposite.

7. **`round()` in the reference implementation is Python's**, which rounds a
   halfway case to the nearest even number. JavaScript's `Math.round` rounds
   halves up. This is not academic: at 72 tasks the 8-point bracket is
   `round(5 * 0.5) = round(2.5)`, which is 2 in Python and 3 in JavaScript. I
   implemented Python's, so the spec's arithmetic is what runs.

---

## The thing I built but left switched off

8. **Automatic privilege change on passing.** Section 4C ends with firing an
   API command to alter the user's access policy. It is implemented
   (`applyPassPolicy`) and **disabled by default**. It is the only step in the
   system that grants authority automatically; it does so partly on the
   strength of what a client says about itself (see above); and nothing here
   removes it again. Given the mass-DM incident of 2026-09-05, an automatic
   privilege grant seemed like something to turn on deliberately rather than
   discover. Set `on_pass.enabled` with a room and a level when you want it.

---

## What is running right now

- `engine: fibonacci`, whitelist `@saber:41chan.net` only.
- The tier engine is off for everyone, including you.
- Any user not on the whitelist is scored by nothing at all.
- The meter is published as `net.41chan.onboarding.meter` room state in the
  user's DM, keyed by their MXID: score, goal, percent, completed, passed.
  State rather than messages, because it is a current value and a timeline of
  thirty progress bars is not a progress bar.
- Six of the eighteen tasks work end to end today. The other twelve wait on
  Technetium.

## Two permission limits found by checking, not by testing

**The meter needs Fourier-chan to hold power in the DM, and she only does when
she opened it.** The meter is room state, and `state_default` in these rooms is
50. In both DMs that exist today she is at 100 because she created them, so it
works. A DM a USER opens with her leaves her at 0, and the meter write is
refused. It degrades rather than breaking: the failure is caught and logged,
the points are still awarded, and the text message still states the score --
only the machine-readable meter is missing, so a client could not draw a bar.
The same shape as the media-tag write-back that had never worked in a
community room.

**Backfill into a NEW room will not write tag state.** On 2026-09-08 the bot
was granted level 10 and the `net.41chan.media.tags` event in the eighteen
rooms it was in at the time. A room it enters later has neither, so
`state_default` 50 applies again and every backfilled image fails its tag
write. The bot cannot grant itself power. Re-run `grant-tag-write.sh` after the
bot joins anywhere new; it is idempotent and skips rooms that are already
correct.

## Tests

`fibonacci.test.js` (17), `taskDetect.test.js` (12). They pin the spec's
arithmetic and, deliberately, its problems: that eight tasks yield 141, that
the speedrun path needs 108 tasks, that only 43 points are server-earnable.
If someone later fixes the scaling, those tests fail and bring you back here.
