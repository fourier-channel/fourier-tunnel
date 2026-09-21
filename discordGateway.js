"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// WHEN MAY SHE CONNECT, AND SHOULD SHE RESUME OR IDENTIFY?
//
// The decision logic for a long-lived Discord presence connection, kept apart
// from the socket on purpose. A socket is awkward to test and this is not: it
// is a pure function of a close code, a saved session and a budget ledger, and
// it is the part that can cost a credential if it is subtly wrong.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT.
//
// Discord caps IDENTIFY at 1000 per 24 hours, and exceeding it does not merely
// fail: it terminates every session and RESETS THE BOT TOKEN. That would stop
// ingest, make fourier-coherence's secrets.declaration.yaml wrong, and need a
// person in a browser to recover.
//
// A reconnect loop burns a day's budget in minutes. The loop to FEAR is not the
// one inside the process -- that one is easy to bound with a backoff -- it is
// the one a crash-restart re-enters, because a counter held in memory resets
// with the process and the restart cheerfully starts again from zero. So the
// ledger is on DISK, it is append-only, and it is re-read from disk on every
// decision rather than cached: "anything long-lived must re-read what it
// decides from" is doctrine rule 7, and six instances of that bug are already
// recorded in this org.
//
// AND IT IS RECORDED BEFORE THE IDENTIFY IS SENT, never after. Recording
// afterwards loses every attempt that crashed between the send and the write,
// which UNDERCOUNTS -- the one direction that lets the budget run out while the
// ledger still says there is room. Over-counting costs a delayed reconnect;
// under-counting costs the token.
//
// Close codes are from Discord's own table rather than memory. Terminal (the
// docs mark them Reconnect: false): 4004 authentication failed, 4010 invalid
// shard, 4011 sharding required, 4012 invalid API version, 4013 invalid
// intents, 4014 disallowed intents. Everything else is marked reconnectable.
// Of those, 4003 (not authenticated / session invalidated), 4007 (invalid seq
// while resuming) and 4009 (session timed out) mean the SESSION is gone, so a
// RESUME would be refused and an IDENTIFY is the only way forward.

/** Marked Reconnect: false by Discord. A human must act; retrying cannot help. */
const TERMINAL_CLOSE_CODES = new Map([
  [4004, "authentication failed -- the token is wrong or has been reset"],
  [4010, "invalid shard"],
  [4011, "sharding required"],
  [4012, "invalid API version"],
  [4013, "invalid intent(s) -- the intents bitfield was rejected"],
  [4014, "disallowed intent(s) -- a privileged intent was requested without approval"],
]);

/** Reconnectable, but the SESSION is dead: resuming would be refused. */
const SESSION_DEAD_CLOSE_CODES = new Set([4003, 4007, 4009]);

/** Below this many identifies left in the window, refuse to identify at all. */
const DEFAULT_FLOOR = 50;
const DEFAULT_CAP = 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The MINIMUM gap between two identifies, enforced from the LEDGER.
 *
 * cap/window is one identify every 86.4s; anything faster than that is, on a
 * sustained basis, a plan to exhaust the budget. 120s leaves 720/day against a
 * cap of 1000 -- margin for the bursts a real outage produces without ever
 * approaching the number that resets the token.
 *
 * WHY THIS AND NOT A BIGGER BACKOFF FLOOR. The backoff is keyed on an in-memory
 * attempt counter, and attempt legitimately resets when a connection succeeds.
 * So a server that accepts, sends READY, and drops -- an ordinary gateway
 * outage -- resets the counter every cycle and the backoff never grows. An
 * adversarial review found exactly that: a 5s floor and a resetting counter
 * together produce one identify every five seconds indefinitely, which spends a
 * whole day's budget in about 79 minutes.
 *
 * Deriving the spacing from the ledger instead makes it immune to that, and to
 * a crash-restart loop, because the ledger is on disk and the counter is not.
 */
const MIN_IDENTIFY_SPACING_MS = 120_000;

/**
 * The on-disk IDENTIFY ledger.
 *
 * Append-only lines of {at}. Append-only because a rewrite has a window where
 * the file is short or absent, and losing the ledger is exactly the state that
 * lets a restart loop spend the budget.
 */
class IdentifyBudget {
  constructor(file, opts = {}) {
    this.file = file;
    this.cap = opts.cap === undefined ? DEFAULT_CAP : opts.cap;
    this.floor = opts.floor === undefined ? DEFAULT_FLOOR : opts.floor;
    this.windowMs = opts.windowMs === undefined ? WINDOW_MS : opts.windowMs;
    this.spacingMs = opts.spacingMs === undefined ? MIN_IDENTIFY_SPACING_MS : opts.spacingMs;
  }

  /** Every identify in the rolling window. Re-read from disk on every call. */
  async spent(now) {
    let raw;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      // A ledger we cannot read is NOT an empty ledger. Treating an unreadable
      // file as "no identifies yet" is precisely the undercount that empties
      // the budget, so this refuses rather than assuming.
      throw new Error(`cannot read the identify ledger at ${this.file}: ${err.code || err.message}. Refusing to connect rather than assume it is empty.`);
    }
    const cutoff = now - this.windowMs;
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (typeof rec.at === "number" && rec.at > cutoff) out.push(rec.at);
    }
    return out;
  }

  async remaining(now) {
    return Math.max(0, this.cap - (await this.spent(now)).length);
  }

  /**
   * How long to wait before another identify may be sent, from the ledger.
   *
   * 0 when enough time has passed. This is the absolute rate limit, and it is
   * the one that survives both a resetting attempt counter and a restart.
   */
  async waitMs(now) {
    const at = await this.spent(now);
    if (at.length === 0) return 0;
    const newest = Math.max(...at);
    return Math.max(0, this.spacingMs - (now - newest));
  }

  /**
   * Record an identify. CALL THIS BEFORE SENDING ONE.
   *
   * fsync'd, because the whole point is that it survives the crash that the
   * in-memory version would not.
   */
  async record(now, why) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const fh = await fs.open(this.file, "a");
    try {
      await fh.writeFile(JSON.stringify({ at: now, why: why || "identify" }) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** May we identify right now? Never throws for a spent budget -- it reports. */
  async check(now) {
    const remaining = await this.remaining(now);
    if (remaining > this.floor) return { ok: true, remaining, waitMs: await this.waitMs(now) };
    return {
      ok: false,
      remaining,
      reason:
        `only ${remaining} of ${this.cap} identifies remain in the rolling ${Math.round(this.windowMs / 3600000)}h window ` +
        `(floor ${this.floor}). REFUSING to identify. Exceeding the cap terminates every session and RESETS THE BOT ` +
        "TOKEN, which needs a browser to recover. If the budget is draining, something is reconnect-looping -- find it " +
        "before connecting again.",
    };
  }
}

/**
 * Saved session state, so a reconnect can RESUME instead of spending budget.
 *
 * RESUME costs no identify. That is the entire reason to keep this, and it is
 * what makes a flaky network survivable rather than expensive.
 */
class SessionStore {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const s = JSON.parse(raw);
      if (typeof s.session_id === "string" && typeof s.resume_gateway_url === "string" && typeof s.seq === "number") {
        return s;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Written atomically: a half-written session file is worse than none. */
  async save(state) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state) + "\n");
    await fs.rename(tmp, this.file);
  }

  async clear() {
    await fs.rm(this.file, { force: true });
  }
}

/**
 * What to do after a disconnect. PURE -- takes state, returns a decision.
 *
 * Returns one of:
 *   {action:"resume",   url, session_id, seq}
 *   {action:"identify", delayMs}
 *   {action:"stop",     reason}            a human must act
 */
function decide(input) {
  const { closeCode, invalidSession, askedToReconnect, session, budget, attempt } = input;

  const terminal = TERMINAL_CLOSE_CODES.get(closeCode);
  if (terminal !== undefined) {
    return {
      action: "stop",
      reason:
        `Discord closed with ${closeCode}: ${terminal}. Its own table marks this code Reconnect: false, so ` +
        "retrying cannot help and would only spend the identify budget against a door that is shut. A person " +
        "has to fix what the code names.",
    };
  }

  // Discord asked for a reconnect, or invalidated the session but said it is
  // resumable. Both are resume-first, and neither costs budget.
  const sessionDead =
    SESSION_DEAD_CLOSE_CODES.has(closeCode) ||
    invalidSession === "unresumable";

  if (!sessionDead && session && session.session_id && session.resume_gateway_url) {
    return {
      action: "resume",
      url: session.resume_gateway_url,
      session_id: session.session_id,
      seq: session.seq,
      // RESUMES BACK OFF TOO, on their own shorter ladder. They cost no budget,
      // which made an unbounded fixed retry look free -- but a server that
      // accepts a socket and drops it produces an unbounded hot loop against
      // Discord either way, and "free" is not the same as "harmless".
      delayMs: resumeBackoffMs(attempt || 0),
      // Resuming does NOT spend an identify, which is why it is always tried
      // first when the session might still be alive.
      spendsBudget: false,
      why: askedToReconnect ? "asked to reconnect" : invalidSession === "resumable" ? "invalid session, resumable" : `closed ${closeCode}`,
    };
  }

  if (!budget || budget.ok !== true) {
    return {
      action: "stop",
      reason: (budget && budget.reason) || "the identify budget was not checked, so identifying is refused",
    };
  }

  // The delay is the LARGER of the ladder and the ledger-derived spacing. The
  // ladder handles a burst; the spacing is what stops a sustained loop, and it
  // is the half that cannot be defeated by a resetting counter or a restart.
  const ladder = backoffMs(attempt || 0);
  const spacing = (budget && typeof budget.waitMs === "number") ? budget.waitMs : 0;
  return {
    action: "identify",
    delayMs: Math.max(ladder, spacing),
    ladderMs: ladder,
    spacingMs: spacing,
    spendsBudget: true,
    why: sessionDead ? `the session is gone (close ${closeCode})` : "no saved session to resume",
  };
}

/**
 * Backoff between RESUME attempts. Cheaper than identify because a resume
 * spends no budget, but bounded because a hot loop is a hot loop.
 */
function resumeBackoffMs(attempt) {
  const FLOOR = 1_000;
  const CEILING = 30_000;
  return Math.min(FLOOR * Math.pow(2, Math.max(0, attempt)), CEILING);
}

/**
 * Backoff between identify attempts.
 *
 * A FLOOR that is not negotiable and a ceiling that is reached quickly. With a
 * cap of 1000 a day, an average of one identify every 86 seconds would exhaust
 * it exactly -- so the floor is above that, and anything faster than the floor
 * is a bug rather than a tuning choice.
 *
 * Deterministic: a test can assert the schedule. Jitter belongs at the call
 * site, added to this, so the shape stays checkable.
 */
function backoffMs(attempt) {
  const FLOOR = 5_000;
  const CEILING = 300_000;
  const ms = FLOOR * Math.pow(2, Math.max(0, attempt));
  return Math.min(ms, CEILING);
}

module.exports = {
  resumeBackoffMs,
  MIN_IDENTIFY_SPACING_MS,
  IdentifyBudget,
  SessionStore,
  decide,
  backoffMs,
  TERMINAL_CLOSE_CODES,
  SESSION_DEAD_CLOSE_CODES,
  DEFAULT_FLOOR,
  DEFAULT_CAP,
  WINDOW_MS,
};
