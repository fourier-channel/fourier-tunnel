"use strict";

// GATE 3 FOR POSTS: THE OTHER ADDRESSES OF A POST'S IMAGE.
//
// Operator rulings 2026-10-14/15 (fourier-basis docs/design/GATE3_MATRIX_POSTS.md,
// contract B in GATE3_CONTRACTS.md): a Matrix post is visible to exactly the
// viewers its image is visible to. The booru learns WHICH rooms from
// fourier-auth's answer per mxc; what it cannot learn from Synapse is that a
// re-upload of the same bytes -- a NEW mxc -- is the same post's image. Only
// the tunnel knows that: it maps the new mxc to the existing post by md5. So
// the tunnel reports (post_id, mxc), never rooms, on the per-post
// POST /posts/:id/tag_sources it already makes (no new route: operator ruling
// 2026-09-24):
//   - on create, "mxc" rides in the partition the tunnel already sends;
//   - on a duplicate and on a held-hidden post, a body carrying ONLY
//     {"mxc": ...} -- no partition, no tag change.
// The booru answers {"mxc":{"accepted":true}} or
// {"mxc":{"accepted":false,"reason":"no_such_post"|"mxc_mapped_elsewhere"}},
// UNIQUE(mxc) and idempotent, so a resend has no second effect.
//
// THE OUTBOX. A report the booru did not acknowledge is not lost: every report
// is written to <state>/gate3-aliases.json BEFORE it is sent, and leaves only
// when the booru has answered for it. A lost report NARROWS -- that room's
// members never see the post -- and nothing else would ever say so.
//   - Unacked only, keyed "<post_id>\n<mxc>", with attempts, the class and
//     text of the last failure, and when it is next due.
//   - tmp+rename, as every state file here (backfill-state.js, rooms.js).
//   - RE-READ ON EVERY USE, never a copy held across a run: the image path
//     adds while the sweep sends, and a long-lived process deciding from a
//     snapshot is the bug this org has paid for seven times (memory
//     stale-index-check-then-act). A settle removes only its own key, after
//     re-reading, so an entry added meanwhile survives (union, never replace).
//   - Every read-modify-write holds <file>.lock (O_EXCL), because a tool
//     driving the pipeline in its own process (tools/catch-up-room.js) writes
//     the same file as the bridge, and two unlocked writers lose each other's
//     entries.
//
// SCALE (operator 2026-10-14: "647 will quickly turn into 647,000" -- design
// for a million posts, not for today). Every cost here is bounded, because
// the booru answering nothing for a while -- down, or older than gate 3 until
// chanbooru's receiver is deployed -- keeps EVERY image's entry:
//   - The image path sends ONLY the report it just queued (send()), never the
//     backlog: a stuck backlog of N must not make every new image cost N
//     requests.
//   - Only the sweep retries, and only what is DUE: each kept entry waits
//     10 minutes, doubling per attempt to 2 hours, so a post hidden from this
//     account (a permanent 404 until its flag is released) costs one request
//     every two hours, not one per image.
//   - A sweep pass sends at most SWEEP_BATCH, paced, within SWEEP_BUDGET_MS,
//     and stops after SWEEP_BREAKER unanswered in a row: a booru that is down
//     costs a handful of requests per pass, and a backlog drains across passes.
//   - The file holds at most MAX_DEPTH entries (compact JSON; at worst ~420
//     bytes each, so ~2.1 MB): every add and settle rewrites it whole, so the
//     cap is what keeps one write short -- measured on vesper 2026-10-15 at a
//     full cap, 23 ms per rewrite and 12 ms per status read -- and so keeps
//     the lock's critical section hundreds of times below LOCK_STALE_MS,
//     which a takeover would otherwise race. A full pass (SWEEP_BATCH settles,
//     SWEEP_PACE_MS apart) then blocks the event loop under a tenth of its
//     time.
//     An add past it is REFUSED at error level, naming the fix: nothing is
//     lost for good, because canon's index records every image the tunnel
//     handled and tools/report-mxc-aliases.js --apply reports them all again.
//
// RETENTION (contract B):
//   accepted                          acked: removed
//   no_such_post, mxc_mapped_elsewhere  dropped, LOUDLY, one error line each:
//                                     the booru says this alias can never land
//   5xx, network                      kept, retried on the sweep
//   404, 403                          kept, and logged ONCE PER PASS with the fix
//                                     (a hundred entries are one line, not a hundred)
//   anything else (an older booru's 400, a 200 with no verdict, an unknown
//   reason)                           kept, logged once per pass with the fix --
//                                     fail closed: an answer we cannot read is
//                                     not an acknowledgement
//
// STATUS. The tunnel has no health route, and gate 3 adds no route, so the
// outbox's state goes to the bridge's log on every sweep while it is non-empty
// (status(), statusLine()): depth against the cap, what is due, what was never
// tried, the kept entries by class, and how many are over an hour and over a
// day old -- not a bare total, which cannot tell draining from wedged. An
// entry a day old, or a depth near the cap, is said at ERROR level.

const fs = require("fs");
const { BooruRefusal, mxcVerdict } = require("./danbooru");

const DROP_REASONS = new Set(["no_such_post", "mxc_mapped_elsewhere"]);
const MXC = /^mxc:\/\/[A-Za-z0-9.:-]+\/[A-Za-z0-9_-]{1,255}$/;
// The lock guards a few milliseconds of file work (MAX_DEPTH bounds it);
// anything holding it this long died holding it.
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 2000;
const MAX_DEPTH = 5000;
const RETRY_FIRST_MS = 10 * 60 * 1000; // the sweep's own interval
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;
const SWEEP_PACE_MS = 250;
const SWEEP_BUDGET_MS = 5 * 60 * 1000;
const SWEEP_BREAKER = 5;
const HOUR_MS = 60 * 60 * 1000;
const STUCK_MS = 24 * HOUR_MS;
const ERROR_MAX = 160;

const keyOf = (postId, mxc) => `${postId}\n${mxc}`;
const sleepAsync = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The wait before attempt n+1, after n attempts: 10 min, doubling, capped.
function retryDelay(attempts) {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

// The outbox file could not be read as the outbox. Never treated as empty:
// writing an empty map over it would lose every report it holds.
class OutboxUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = "OutboxUnreadable";
  }
}

// The outbox is at its cap and this report was not queued.
class OutboxFull extends Error {
  constructor(message) {
    super(message);
    this.name = "OutboxFull";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** What class of answer this was, for retention and for the per-pass log. */
function classify(outcome) {
  if (outcome.verdict) {
    if (outcome.verdict.accepted === true) return { cls: "accepted" };
    const reason = outcome.verdict.reason;
    if (DROP_REASONS.has(reason)) return { cls: reason };
    return { cls: "unreadable", message: `the booru refused the alias for a reason this tunnel does not know (${JSON.stringify(reason)})` };
  }
  const err = outcome.error;
  const status = err && (err instanceof BooruRefusal ? err.status : err.response && err.response.status);
  const message = (err && err.message) || String(err);
  if (status === 404) return { cls: "404", message };
  if (status === 403 || status === 401) return { cls: "403", message };
  if (!status || status >= 500) return { cls: "retry", message };
  return { cls: "unreadable", message };
}

// One line per class kept in a pass, naming the fix. 404 and 403 in
// particular are said once per pass (contract B), never once per entry.
const KEPT_FIX = {
  404: "the booru answered 404: the post is hidden from the tunnel's account (another bot's FLAGGED post answers as missing until the flag is released), or chanbooru predates gate 3's mxc receiver -- deploy chanbooru (GATE3_CONTRACTS D); kept, and retried on the sweep (every 10 minutes, backing off to every 2 hours)",
  403: "the booru refused the tunnel's account: POST /posts/:id/tag_sources needs Builder or above (chanbooru FourierTagSourcesController#create) and a valid api key -- promote the account or fix danbooru.api_key in config.yaml; kept, and retried on the sweep (every 10 minutes, backing off to every 2 hours)",
  retry: "the booru did not answer, or answered 5xx; kept, and retried on the sweep (every 10 minutes, backing off to every 2 hours) -- nothing to do unless it persists, then check the booru",
  unreadable: "the booru's answer is not gate 3's mxc verdict, so it is not an acknowledgement: chanbooru predates the contract (deploy chanbooru, GATE3_CONTRACTS B/D); kept, and retried on the sweep (every 10 minutes, backing off to every 2 hours)",
};
const KEPT_CLASSES = Object.keys(KEPT_FIX);

/**
 * The outbox. `file()` names gate3-aliases.json in the state directory
 * (state-dir.js statePath), resolved on every use. `danbooru` is the client
 * whose reportMxcAlias sends one report. The bounds default to the constants
 * above; tests pass smaller ones.
 */
function createAliasOutbox({
  danbooru, file, now = Date.now, log = console, sleep = sleepAsync,
  lockWaitMs = LOCK_WAIT_MS, lockStaleMs = LOCK_STALE_MS, maxDepth = MAX_DEPTH,
  batch = SWEEP_BATCH, paceMs = SWEEP_PACE_MS, budgetMs = SWEEP_BUDGET_MS, breaker = SWEEP_BREAKER,
}) {
  let flushing = null;         // the sweep pass in flight, shared by an overlapping caller
  const inFlight = new Set();  // keys being sent (or claimed by the create path) in THIS process
  const pending = new Set();   // send() promises, for idle()

  function read(path) {
    let raw;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return {};
      throw new OutboxUnreadable(`the gate 3 alias outbox ${path} cannot be read (${err.code || err.message}); fix: check the state directory's permissions`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OutboxUnreadable(
        `the gate 3 alias outbox ${path} is not a JSON object, so nothing is added to or sent from it (writing over it would lose what it owes); ` +
        `fix: inspect it, then rename it to ${path}.superseded-<date> -- a fresh outbox starts empty, and tools/report-mxc-aliases.js --apply reports every alias canon's index knows`);
    }
    return parsed;
  }

  function withLock(path, fn) {
    const lock = `${path}.lock`;
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw new OutboxUnreadable(`the gate 3 alias outbox lock ${lock} cannot be made (${err.code || err.message}); fix: check the state directory's permissions`);
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch (err) {
        if (err.code === "ENOENT") continue; // released between the two calls
        throw err;
      }
      if (age > lockStaleMs) {
        // Held for seconds around milliseconds of work: its holder died.
        log.warn(`[gate3] the alias outbox lock ${lock} is ${Math.round(age / 1000)}s old, so its holder died holding it; taking it over`);
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new OutboxUnreadable(`the gate 3 alias outbox lock ${lock} was held for over ${lockWaitMs} ms; fix: another process is writing the outbox -- if none is (no tunnel tool running), the lock is left from a crash and is taken over after ${lockStaleMs / 1000}s`);
      }
      sleepSync(5);
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  // Re-read, change, write back -- under the lock, every time. Compact: the
  // file is rewritten whole on every add and settle.
  function update(change) {
    const path = file();
    return withLock(path, () => {
      const state = read(path);
      const out = change(state);
      const tmp = `${path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, path);
      return out;
    });
  }

  function readNow() {
    const path = file();
    return withLock(path, () => read(path));
  }

  /**
   * Queue one report, due at once. Idempotent per (post, mxc): a second add
   * keeps the first entry. Refused past the cap (OutboxFull). `claim`: the
   * caller's own request carries it (the create path), so this process's
   * sweep leaves it alone until settleAnswer.
   */
  function add(postId, mxc, { claim = false } = {}) {
    if (!Number.isInteger(postId) || postId <= 0) throw new TypeError(`gate3 alias: post id ${JSON.stringify(postId)} is not a booru post id`);
    if (typeof mxc !== "string" || !MXC.test(mxc)) throw new TypeError(`gate3 alias: ${JSON.stringify(mxc)} is not an mxc url`);
    const key = update((state) => {
      const k = keyOf(postId, mxc);
      if (state[k]) return k;
      const depth = Object.keys(state).length;
      if (depth >= maxDepth) {
        throw new OutboxFull(
          `the gate 3 alias outbox already holds ${depth} unacknowledged reports, its cap, so this one was NOT queued; ` +
          "fix: the booru is not acknowledging -- the [gate3] kept lines say why (deploy chanbooru, fix the account, or wait for the booru); " +
          "once it answers, the sweep drains the outbox, and tools/report-mxc-aliases.js --apply reports every alias canon's index knows, this one included");
      }
      const t = now();
      state[k] = { post_id: postId, mxc, queued_at: t, attempts: 0, last_class: null, last_error: null, last_try_at: null, next_try_at: t };
      return k;
    });
    if (claim) inFlight.add(key);
    return key;
  }

  // Settle one entry from one answer: remove it (acked, or dropped loudly), or
  // keep it with its attempt counted and its next try pushed back. Returns the
  // class, for the pass's log.
  function settle(postId, mxc, outcome) {
    const { cls, message } = classify(outcome);
    const key = keyOf(postId, mxc);
    if (cls === "accepted" || DROP_REASONS.has(cls)) {
      update((state) => { delete state[key]; });
      if (cls === "no_such_post") {
        log.error(`[gate3] alias DROPPED: post #${postId} <- ${mxc}: the booru has no post #${postId} (no_such_post), so this mxc will never show it; nothing to retry`);
      } else if (cls === "mxc_mapped_elsewhere") {
        log.error(`[gate3] alias DROPPED: post #${postId} <- ${mxc}: the booru already maps this mxc to another post (mxc_mapped_elsewhere), and an mxc is one image; nothing to retry -- if the other mapping is wrong, it is the booru's record to correct`);
      }
      return cls;
    }
    update((state) => {
      const e = state[key];
      if (!e) return; // settled meanwhile by another process
      const t = now();
      e.attempts = (e.attempts || 0) + 1;
      e.last_class = cls;
      e.last_error = String(message).slice(0, ERROR_MAX);
      e.last_try_at = t;
      e.next_try_at = t + retryDelay(e.attempts);
    });
    return cls;
  }

  function reportKept(kept) {
    for (const [cls, { count, example }] of Object.entries(kept)) {
      log.error(`[gate3] ${count} alias report(s) kept in the outbox: ${KEPT_FIX[cls]}. First: ${example}`);
    }
  }
  const keptOne = (postId, mxc, cls, outcome) => ({ [cls]: { count: 1, example: `post #${postId} <- ${mxc}: ${classify(outcome).message}` } });

  /**
   * Settle from the answer to the create path's own POST /posts/:id/tag_sources
   * (the partition with "mxc" in it), or from the error it threw, and release
   * the claim add() took.
   */
  function settleAnswer(postId, mxc, { answer, error }) {
    try {
      let outcome;
      if (error) outcome = { error };
      else {
        try {
          outcome = { verdict: mxcVerdict(`POST /posts/${postId}/tag_sources.json`, answer) };
        } catch (err) {
          outcome = { error: err };
        }
      }
      const cls = settle(postId, mxc, outcome);
      if (KEPT_FIX[cls]) reportKept(keptOne(postId, mxc, cls, outcome));
      return cls;
    } finally {
      inFlight.delete(keyOf(postId, mxc));
    }
  }

  // Send one report and settle it. null when this process is already sending
  // it: one request per key at a time, whoever asked.
  async function sendOne(postId, mxc) {
    const key = keyOf(postId, mxc);
    if (inFlight.has(key)) return null;
    inFlight.add(key);
    try {
      let outcome;
      try {
        outcome = { verdict: await danbooru.reportMxcAlias(postId, mxc) };
      } catch (err) {
        outcome = { error: err };
      }
      return { cls: settle(postId, mxc, outcome), outcome };
    } finally {
      inFlight.delete(key);
    }
  }

  /**
   * Send ONE queued report now -- the image path's, just added -- and settle
   * it. Not the backlog: that is the sweep's. Never rejects; a failure is
   * logged, and the entry stays for the sweep.
   */
  function send(postId, mxc) {
    const p = sendOne(postId, mxc).then(
      (r) => { if (r && KEPT_FIX[r.cls]) reportKept(keptOne(postId, mxc, r.cls, r.outcome)); },
      (err) => log.error(`[gate3] post #${postId} <- ${mxc}: answered, but the outbox could not record it (${err.message}); it stays owed, and the sweep sends it again, which the booru takes as a no-op`),
    );
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  // One bounded sweep pass over what is DUE: oldest-due first, at most
  // `batch`, `paceMs` apart, within `budgetMs`, and stopped after `breaker`
  // unanswered in a row. What it does not reach waits for the next pass.
  async function runPass() {
    const started = now();
    const due = Object.values(readNow())
      .filter((e) => !inFlight.has(keyOf(e.post_id, e.mxc)) && !(e.next_try_at > started))
      .sort((a, b) => (a.next_try_at || 0) - (b.next_try_at || 0) || a.queued_at - b.queued_at);
    const tally = { due: due.length, sent: 0, accepted: 0, dropped: 0, kept: 0, deferred: 0, stopped: null };
    const kept = {};
    let silent = 0;
    for (const e of due.slice(0, batch)) {
      if (tally.sent && paceMs) await sleep(paceMs);
      if (now() - started > budgetMs) { tally.stopped = "budget"; break; }
      // Per-item isolation: one entry that throws never stops the rest.
      let r;
      try {
        r = await sendOne(e.post_id, e.mxc);
      } catch (err) {
        tally.sent += 1;
        log.error(`[gate3] post #${e.post_id} <- ${e.mxc}: answered, but the outbox could not record it (${err.message}); it is sent again on a later pass, which the booru takes as a no-op`);
        continue;
      }
      if (!r) continue; // the image path is sending it right now
      tally.sent += 1;
      if (r.cls === "accepted") tally.accepted += 1;
      else if (DROP_REASONS.has(r.cls)) tally.dropped += 1;
      else {
        tally.kept += 1;
        if (!kept[r.cls]) kept[r.cls] = { count: 0, example: `post #${e.post_id} <- ${e.mxc}: ${classify(r.outcome).message}` };
        kept[r.cls].count += 1;
      }
      silent = r.cls === "retry" ? silent + 1 : 0;
      if (silent >= breaker) { tally.stopped = "unanswered"; break; }
    }
    tally.deferred = Math.max(0, tally.due - tally.sent);
    reportKept(kept);
    if (tally.stopped === "unanswered") {
      log.error(`[gate3] alias sweep stopped after ${breaker} reports in a row went unanswered: the booru is not answering, so the other ${tally.deferred} due report(s) wait for the next pass rather than each waiting out a timeout -- nothing to do unless it persists, then check the booru`);
    } else if (tally.stopped === "budget") {
      log.warn(`[gate3] alias sweep used its ${Math.round(budgetMs / 1000)}s; ${tally.deferred} due report(s) wait for the next pass`);
    }
    return tally;
  }

  /** One sweep pass. Overlapping calls share it. */
  function flush() {
    if (flushing) return flushing;
    flushing = Promise.resolve().then(runPass).finally(() => { flushing = null; });
    return flushing;
  }

  /** Resolves when nothing is in flight (tests, and a tool before it exits). */
  async function idle() {
    while (flushing || pending.size) await Promise.allSettled([flushing, ...pending].filter(Boolean));
  }

  /**
   * What is owed, read from the file now: depth against the cap, how much is
   * due, never tried, kept by class, and over an hour and over a day old --
   * so a reader can tell draining from wedged.
   */
  function status() {
    const t = now();
    const entries = Object.values(readNow());
    const s = { depth: entries.length, cap: maxDepth, due: 0, never_tried: 0, kept: {}, older_than_1h: 0, older_than_24h: 0, oldest_age_ms: null, oldest: null };
    for (const c of KEPT_CLASSES) s.kept[c] = 0;
    for (const e of entries) {
      if (!(e.next_try_at > t)) s.due += 1;
      if (!e.attempts) s.never_tried += 1;
      else if (e.last_class in s.kept) s.kept[e.last_class] += 1;
      const age = t - e.queued_at;
      if (age > HOUR_MS) s.older_than_1h += 1;
      if (age > STUCK_MS) s.older_than_24h += 1;
      if (!s.oldest || e.queued_at < s.oldest.queued_at) s.oldest = e;
    }
    if (s.oldest) s.oldest_age_ms = t - s.oldest.queued_at;
    return s;
  }

  return { add, settle, settleAnswer, send, flush, idle, status };
}

/**
 * The status as one log line and its level: null when nothing is owed; ERROR
 * once anything is a day old or the depth is at 80% of the cap, since either
 * means it is not draining and nothing else will say so.
 */
function statusLine(s) {
  if (!s.depth) return null;
  const kept = KEPT_CLASSES.map((c) => `${c}=${s.kept[c]}`).join(" ");
  const o = s.oldest;
  const stuck = s.older_than_24h > 0 || s.depth >= 0.8 * s.cap;
  return {
    level: stuck ? "error" : "warn",
    line: `[gate3] alias outbox: ${s.depth} unacked of ${s.cap}; ${s.due} due now; ${s.never_tried} never tried; kept as ${kept}; ` +
      `${s.older_than_1h} over 1h old, ${s.older_than_24h} over 24h; oldest ${Math.round(s.oldest_age_ms / 1000)}s ` +
      `(post #${o.post_id} <- ${o.mxc}, ${o.attempts} attempt(s), last error: ${o.last_error || "none yet"})` +
      (stuck ? " -- NOT DRAINING: the [gate3] kept lines name why; past the cap new reports are refused, and tools/report-mxc-aliases.js --apply reports them again once the booru answers" : ""),
  };
}

module.exports = { createAliasOutbox, statusLine, OutboxUnreadable, OutboxFull, keyOf, classify, retryDelay };
