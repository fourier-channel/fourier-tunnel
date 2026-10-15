"use strict";

// gate3-aliases.js on its own: the outbox's file rules and its bounds, against
// a fake booru client. index.test.js drives it through the real image handler
// and the real sweep timer; these are the properties a handler test cannot
// reach -- another writer of the same file, an add during a sweep, one entry
// that throws, the lock, and what a backlog costs.
//
// Contract B (fourier-basis docs/design/GATE3_CONTRACTS.md): unacked only,
// keyed post_id+newline+mxc, attempts and last_error, tmp+rename, re-read on
// every use, never a snapshot held across a run. Scale (operator 2026-10-14):
// a backlog is bounded and costs no new image anything.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAliasOutbox, statusLine, retryDelay, OutboxUnreadable, OutboxFull } = require("./gate3-aliases");
const { BooruRefusal } = require("./danbooru");

const quiet = () => {
  const lines = [];
  const say = (k) => (...a) => lines.push(`${k}: ${a.join(" ")}`);
  return { lines, log: { log: say("log"), warn: say("warn"), error: say("error") } };
};
const MIN = 60 * 1000;
const DOWN = () => { throw new BooruRefusal("POST /posts/1/tag_sources.json (mxc) -> 503: down", 503, {}); };

function world(t, answer = () => ({ accepted: true }), extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-gate3-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gate3-aliases.json");
  const sent = [];
  const slept = [];
  const { lines, log } = quiet();
  let clock = 1_000_000;
  const danbooru = { reportMxcAlias: async (postId, mxc) => { sent.push([postId, mxc]); return answer(postId, mxc); } };
  const o = createAliasOutbox({ danbooru, file: () => file, now: () => clock, log, sleep: async (ms) => { slept.push(ms); }, ...extra });
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  return { o, file, sent, slept, lines, read, tick: (ms) => { clock += ms; } };
}

test("an add is written at once, due at once, keyed post+newline+mxc, compact; a second add of the same pair keeps the first entry", (t) => {
  const w = world(t);
  w.o.add(7, "mxc://41chan.net/a");
  const first = w.read()["7\nmxc://41chan.net/a"];
  assert.deepEqual(first, { post_id: 7, mxc: "mxc://41chan.net/a", queued_at: 1_000_000, attempts: 0, last_class: null, last_error: null, last_try_at: null, next_try_at: 1_000_000 });
  assert.equal(fs.readFileSync(w.file, "utf8").includes("\n "), false, "compact JSON: the file is rewritten whole on every add");
  w.o.settle(7, "mxc://41chan.net/a", { error: new BooruRefusal("x -> 503", 503, {}) });
  w.tick(5000);
  w.o.add(7, "mxc://41chan.net/a");
  const again = w.read()["7\nmxc://41chan.net/a"];
  assert.equal(again.attempts, 1, "the attempt already made is not forgotten");
  assert.equal(again.queued_at, 1_000_000, "and its age is its first queueing");
  assert.equal(Object.keys(w.read()).length, 1);
  assert.equal(fs.existsSync(`${w.file}.tmp`), false, "tmp+rename leaves no tmp behind");
  assert.equal(fs.existsSync(`${w.file}.lock`), false, "and no lock");
});

test("send() sends ONLY its own report: a stuck backlog costs a new image nothing", async (t) => {
  const w = world(t, (postId) => (postId === 99 ? { accepted: true } : DOWN()));
  for (const n of [1, 2, 3]) w.o.add(n, `mxc://41chan.net/stuck${n}`); // due, never sent
  w.o.add(99, "mxc://41chan.net/new");
  await w.o.send(99, "mxc://41chan.net/new");
  assert.deepEqual(w.sent, [[99, "mxc://41chan.net/new"]], "one request, for the one report just queued");
  assert.deepEqual(Object.keys(w.read()).sort(), ["1\nmxc://41chan.net/stuck1", "2\nmxc://41chan.net/stuck2", "3\nmxc://41chan.net/stuck3"]);
});

test("a sweep RE-READS the file: an entry another process wrote is sent; an entry added during the sweep survives it", async (t) => {
  const w = world(t, (postId) => {
    // While the booru answers the first report, the image path adds another
    // and sends it, as index.js reportAlias does.
    if (postId === 1) { w.o.add(2, "mxc://41chan.net/during"); w.o.send(2, "mxc://41chan.net/during"); }
    return { accepted: true };
  });
  // Written straight into the file, as tools/catch-up-room.js's process would.
  fs.writeFileSync(w.file, JSON.stringify({ "1\nmxc://41chan.net/other": { post_id: 1, mxc: "mxc://41chan.net/other", queued_at: 5, attempts: 0, last_error: null } }));
  const tally = await w.o.flush();
  await w.o.idle();
  // The pass sent what the FILE held -- not a snapshot from before -- and
  // removed only the key it settled; the report added meanwhile was sent by
  // its own send(), once.
  assert.equal(tally.sent, 1);
  assert.deepEqual(w.sent, [[1, "mxc://41chan.net/other"], [2, "mxc://41chan.net/during"]]);
  assert.deepEqual(w.read(), {});
});

test("one entry that throws does not stop the rest (per-item isolation), and is kept with its error and class", async (t) => {
  const w = world(t, (postId) => {
    if (postId === 2) throw new Error("POST /posts/2/tag_sources.json (mxc): the booru did not answer (ECONNRESET)");
    return { accepted: true };
  });
  for (const n of [1, 2, 3]) w.o.add(n, `mxc://41chan.net/m${n}`);
  const tally = await w.o.flush();
  assert.deepEqual(tally, { due: 3, sent: 3, accepted: 2, dropped: 0, kept: 1, deferred: 0, stopped: null });
  assert.deepEqual(Object.keys(w.read()), ["2\nmxc://41chan.net/m2"]);
  const e = w.read()["2\nmxc://41chan.net/m2"];
  assert.equal(e.last_error, "POST /posts/2/tag_sources.json (mxc): the booru did not answer (ECONNRESET)");
  assert.equal(e.last_class, "retry");
});

test("a kept entry is NOT due again until its backoff: 10 minutes, doubling per attempt, capped at 2 hours", async (t) => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(retryDelay), [10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 120 * MIN, 120 * MIN]);
  const w = world(t, DOWN);
  w.o.add(1, "mxc://41chan.net/b");
  await w.o.flush();
  assert.equal(w.sent.length, 1);
  assert.equal(w.read()["1\nmxc://41chan.net/b"].next_try_at, 1_000_000 + 10 * MIN);
  w.tick(10 * MIN - 1);
  assert.equal((await w.o.flush()).due, 0, "not due a minute early");
  assert.equal(w.sent.length, 1);
  w.tick(1);
  await w.o.flush();
  assert.equal(w.sent.length, 2, "due at its time");
  assert.equal(w.read()["1\nmxc://41chan.net/b"].next_try_at, 1_000_000 + 10 * MIN + 20 * MIN);
});

test("a sweep pass is bounded: at most `batch`, paced, oldest-due first; the rest waits for the next pass", async (t) => {
  const w = world(t, undefined, { batch: 2, paceMs: 7 });
  for (const n of [1, 2, 3, 4, 5]) { w.o.add(n, `mxc://41chan.net/p${n}`); w.tick(1); }
  const tally = await w.o.flush();
  assert.deepEqual([tally.due, tally.sent, tally.deferred], [5, 2, 3]);
  assert.deepEqual(w.sent, [[1, "mxc://41chan.net/p1"], [2, "mxc://41chan.net/p2"]]);
  assert.deepEqual(w.slept, [7], "paced: a sleep between sends, none before the first");
  await w.o.flush();
  assert.deepEqual(w.sent.map(([n]) => n), [1, 2, 3, 4]);
});

test("a sweep pass stops after `breaker` unanswered in a row, and when its time budget is spent", async (t) => {
  const w = world(t, DOWN, { breaker: 2 });
  for (const n of [1, 2, 3, 4]) w.o.add(n, `mxc://41chan.net/d${n}`);
  const tally = await w.o.flush();
  assert.deepEqual([tally.sent, tally.deferred, tally.stopped], [2, 2, "unanswered"]);
  assert.ok(w.lines.some((l) => /^error: \[gate3\] alias sweep stopped after 2 reports in a row went unanswered: .* 2 due report\(s\) wait for the next pass/.test(l)), w.lines.join("\n"));

  const slow = world(t, () => { slow.tick(40 * 1000); return { accepted: true }; }, { budgetMs: 60 * 1000 });
  for (const n of [1, 2, 3, 4]) slow.o.add(n, `mxc://41chan.net/s${n}`);
  const s = await slow.o.flush();
  assert.deepEqual([s.sent, s.deferred, s.stopped], [2, 2, "budget"]);
});

test("the depth cap: an add past it is REFUSED, loudly, naming the fix; a pair already owed is still idempotent", (t) => {
  const w = world(t, undefined, { maxDepth: 2 });
  w.o.add(1, "mxc://41chan.net/c1");
  w.o.add(2, "mxc://41chan.net/c2");
  assert.throws(() => w.o.add(3, "mxc://41chan.net/c3"), (err) => err instanceof OutboxFull &&
    /already holds 2 unacknowledged reports, its cap, so this one was NOT queued; fix: .*tools\/report-mxc-aliases\.js --apply/.test(err.message));
  w.o.add(1, "mxc://41chan.net/c1");
  assert.deepEqual(Object.keys(w.read()).length, 2);
});

test("a report the create path claimed is left alone by the sweep until its own answer settles it", async (t) => {
  const w = world(t);
  w.o.add(5, "mxc://41chan.net/claimed", { claim: true });
  assert.equal((await w.o.flush()).due, 0);
  assert.deepEqual(w.sent, []);
  w.o.settleAnswer(5, "mxc://41chan.net/claimed", { error: new BooruRefusal("x -> 500", 500, {}) });
  w.tick(10 * MIN);
  await w.o.flush();
  assert.deepEqual(w.sent, [[5, "mxc://41chan.net/claimed"]], "released by its answer, then due on its backoff");
});

test("status: depth against the cap, due, never tried, kept by class, and age buckets -- read from the file now", async (t) => {
  const w = world(t, (postId) => {
    if (postId === 1) throw new BooruRefusal("x -> 404", 404, {});
    if (postId === 2) throw new BooruRefusal("x -> 403", 403, {});
    return DOWN();
  });
  const empty = w.o.status();
  assert.equal(empty.depth, 0);
  assert.equal(statusLine(empty), null);
  w.o.add(1, "mxc://41chan.net/old");
  w.o.add(2, "mxc://41chan.net/refused");
  w.o.add(3, "mxc://41chan.net/down");
  await w.o.flush();
  w.tick(2 * 60 * MIN);
  w.o.add(4, "mxc://41chan.net/new");
  const s = w.o.status();
  assert.deepEqual(
    [s.depth, s.cap, s.due, s.never_tried, s.kept, s.older_than_1h, s.older_than_24h, s.oldest_age_ms, s.oldest.mxc],
    [4, 5000, 4, 1, { 404: 1, 403: 1, retry: 1, unreadable: 0 }, 3, 0, 2 * 60 * MIN, "mxc://41chan.net/old"]);
  const said = statusLine(s);
  assert.equal(said.level, "warn");
  assert.match(said.line, /^\[gate3\] alias outbox: 4 unacked of 5000; 4 due now; 1 never tried; kept as 403=1 404=1 retry=1 unreadable=0; 3 over 1h old, 0 over 24h; oldest 7200s/);
});

test("statusLine says ERROR once anything is a day old, or the depth nears the cap -- a backlog that is not draining is not a warning", (t) => {
  const w = world(t, undefined, { maxDepth: 10 });
  w.o.add(1, "mxc://41chan.net/x");
  w.tick(24 * 60 * MIN + 1);
  const day = statusLine(w.o.status());
  assert.equal(day.level, "error");
  assert.match(day.line, /1 over 24h; .* -- NOT DRAINING: /);
  const full = world(t, undefined, { maxDepth: 10 });
  for (let n = 1; n <= 8; n += 1) full.o.add(n, `mxc://41chan.net/f${n}`);
  assert.equal(statusLine(full.o.status()).level, "error");
});

test("an unknown refusal reason is NOT a drop: fail closed, kept, with the fix", (t) => {
  const w = world(t);
  w.o.add(1, "mxc://41chan.net/u");
  assert.equal(w.o.settle(1, "mxc://41chan.net/u", { verdict: { accepted: false, reason: "something_new" } }), "unreadable");
  assert.equal(w.read()["1\nmxc://41chan.net/u"].attempts, 1);
});

test("a lock held by a live writer is waited for and then refused, naming the fix; a lock left by a dead one is taken over", (t) => {
  const w = world(t, undefined, { lockWaitMs: 30, lockStaleMs: 60_000 });
  fs.writeFileSync(`${w.file}.lock`, "12345");
  assert.throws(() => w.o.add(1, "mxc://41chan.net/l"), (err) => err instanceof OutboxUnreadable && /lock .* was held for over 30 ms; fix: another process is writing the outbox/.test(err.message));
  assert.deepEqual(w.read(), {}, "nothing written around the lock");

  const stale = world(t, undefined, { lockWaitMs: 30, lockStaleMs: 50 });
  fs.writeFileSync(`${stale.file}.lock`, "12345");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(`${stale.file}.lock`, old, old);
  stale.o.add(1, "mxc://41chan.net/l");
  assert.ok(stale.read()["1\nmxc://41chan.net/l"]);
  assert.ok(stale.lines.some((l) => /^warn: \[gate3\] the alias outbox lock .* is \d+s old, so its holder died holding it; taking it over$/.test(l)), stale.lines.join("\n"));
  assert.equal(fs.existsSync(`${stale.file}.lock`), false);
});

test("not a post id, or not an mxc url: refused before anything is written", (t) => {
  const w = world(t);
  assert.throws(() => w.o.add("7", "mxc://41chan.net/a"), TypeError);
  assert.throws(() => w.o.add(0, "mxc://41chan.net/a"), TypeError);
  assert.throws(() => w.o.add(7, "https://41chan.net/a"), TypeError);
  assert.throws(() => w.o.add(7, "mxc://41chan.net/a/../b"), TypeError);
  assert.equal(fs.existsSync(w.file), false);
});
