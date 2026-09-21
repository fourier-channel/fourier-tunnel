"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const G = require("./discordGateway.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-gw-"));
const NOW = Date.parse("2026-09-21T06:00:00.000Z");

const session = () => ({
  session_id: "sess-abc",
  resume_gateway_url: "wss://resume.example/",
  seq: 42,
});

const okBudget = { ok: true, remaining: 900 };

test("a terminal close code STOPS instead of retrying", () => {
  // Discord's own table marks these Reconnect: false. Retrying spends the
  // identify budget against a door that is shut.
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const d = G.decide({ closeCode: code, session: session(), budget: okBudget });
    assert.equal(d.action, "stop", `close ${code} must stop`);
    assert.match(d.reason, /Reconnect: false/);
  }
});

test("4004 names the token, because that is what a person has to fix", () => {
  const d = G.decide({ closeCode: 4004, session: session(), budget: okBudget });
  assert.match(d.reason, /token/);
});

test("a recoverable close RESUMES when a session is held, spending no budget", () => {
  for (const code of [4000, 4001, 4002, 4005, 4008, 1006]) {
    const d = G.decide({ closeCode: code, session: session(), budget: okBudget, attempt: 0 });
    assert.equal(d.action, "resume", `close ${code} should resume`);
    assert.equal(d.spendsBudget, false);
    assert.equal(d.session_id, "sess-abc");
    assert.equal(d.seq, 42);
    // The resume URL Discord handed us, not the one we first dialled.
    assert.equal(d.url, "wss://resume.example/");
  }
});

test("a close meaning the SESSION is gone identifies instead of resuming", () => {
  // 4003 not authenticated, 4007 invalid seq while resuming, 4009 session
  // timed out. Resuming these would be refused, so resuming is the wrong move.
  for (const code of [4003, 4007, 4009]) {
    const d = G.decide({ closeCode: code, session: session(), budget: okBudget });
    assert.equal(d.action, "identify", `close ${code} must identify`);
    assert.equal(d.spendsBudget, true);
  }
});

test("INVALID_SESSION distinguishes resumable from not", () => {
  const resumable = G.decide({ invalidSession: "resumable", session: session(), budget: okBudget });
  assert.equal(resumable.action, "resume");
  const not = G.decide({ invalidSession: "unresumable", session: session(), budget: okBudget });
  assert.equal(not.action, "identify");
});

test("an explicit RECONNECT resumes and says so", () => {
  const d = G.decide({ askedToReconnect: true, session: session(), budget: okBudget });
  assert.equal(d.action, "resume");
  assert.match(d.why, /asked to reconnect/);
});

test("with no saved session it identifies", () => {
  const d = G.decide({ closeCode: 4000, session: null, budget: okBudget });
  assert.equal(d.action, "identify");
  assert.match(d.why, /no saved session/);
});

test("a spent budget STOPS rather than identifying, even with nothing else wrong", () => {
  const d = G.decide({
    closeCode: 4009,
    session: session(),
    budget: { ok: false, remaining: 3, reason: "only 3 of 1000 identifies remain" },
  });
  assert.equal(d.action, "stop");
  assert.match(d.reason, /identifies remain/);
});

test("an unchecked budget is not a permissive one", () => {
  // Forgetting to check must not read as permission. The absent case and the
  // refused case have to behave the same way, or a missing call becomes a
  // silent grant.
  const d = G.decide({ closeCode: 4009, session: session(), budget: undefined });
  assert.equal(d.action, "stop");
});

test("backoff has a hard floor above the rate that would exhaust the budget", () => {
  // 1000 identifies a day is one per 86.4s. Anything faster than the floor is a
  // bug, not a tuning choice -- so the floor is checkable rather than a comment.
  assert.equal(G.backoffMs(0), 5_000);
  assert.equal(G.backoffMs(1), 10_000);
  assert.equal(G.backoffMs(2), 20_000);
  // And a ceiling, so a long outage does not back off into next week.
  assert.equal(G.backoffMs(50), 300_000);
  for (let a = 0; a < 20; a++) assert.ok(G.backoffMs(a) >= 5_000);
});

test("the ledger counts only identifies inside the rolling window", async () => {
  const dir = tmp();
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  await b.record(NOW - 25 * 3600 * 1000, "old");   // outside 24h
  await b.record(NOW - 2 * 3600 * 1000, "recent");
  await b.record(NOW - 60 * 1000, "recent");
  assert.equal((await b.spent(NOW)).length, 2);
  assert.equal(await b.remaining(NOW), 998);
});

test("the ledger SURVIVES a restart, which is the whole point", async () => {
  const dir = tmp();
  const file = path.join(dir, "identify.jsonl");
  const first = new G.IdentifyBudget(file);
  for (let i = 0; i < 5; i++) await first.record(NOW - i * 1000, "burst");

  // A fresh object is a fresh process. An in-memory counter would read zero
  // here, and a crash-restart loop would spend the budget one restart at a
  // time with every individual run looking reasonable.
  const afterRestart = new G.IdentifyBudget(file);
  assert.equal((await afterRestart.spent(NOW)).length, 5);
});

test("an unreadable ledger REFUSES rather than reading as empty", async () => {
  const dir = tmp();
  const asDirectory = path.join(dir, "identify.jsonl");
  fs.mkdirSync(asDirectory); // something that is not a readable file
  const b = new G.IdentifyBudget(asDirectory);
  // An empty ledger and an unreadable one must not look the same: treating
  // unreadable as empty is the undercount that empties the budget.
  await assert.rejects(() => b.spent(NOW), /Refusing to connect/);
});

test("a missing ledger is genuinely empty, and that is different from unreadable", async () => {
  const b = new G.IdentifyBudget(path.join(tmp(), "never-written.jsonl"));
  assert.deepEqual(await b.spent(NOW), []);
  assert.equal((await b.check(NOW)).ok, true);
});

test("the floor refuses before the cap is reached, not at it", async () => {
  const dir = tmp();
  const b = new G.IdentifyBudget(path.join(dir, "i.jsonl"), { cap: 10, floor: 3 });
  for (let i = 0; i < 6; i++) await b.record(NOW - i, "x");
  const fine = await b.check(NOW);
  assert.equal(fine.ok, true, "4 remaining, floor 3 -- still allowed");

  await b.record(NOW, "x");
  const refused = await b.check(NOW);
  assert.equal(refused.ok, false, "3 remaining is AT the floor -- refuse");
  assert.match(refused.reason, /RESETS THE BOT TOKEN/);
});

test("a garbled ledger line is skipped without discarding the rest", async () => {
  const dir = tmp();
  const file = path.join(dir, "i.jsonl");
  const b = new G.IdentifyBudget(file);
  await b.record(NOW - 1000, "good");
  await fsp.appendFile(file, "{ this is not json\n");
  await b.record(NOW - 500, "good");
  // One bad row must not cost the count of every other -- and the count must
  // not silently drop to zero, which would read as a full budget.
  assert.equal((await b.spent(NOW)).length, 2);
});

test("session state round-trips and is written atomically", async () => {
  const dir = tmp();
  const s = new G.SessionStore(path.join(dir, "session.json"));
  assert.equal(await s.load(), null);
  await s.save(session());
  assert.deepEqual(await s.load(), session());
  // No temp file left behind to be read as a session later.
  assert.deepEqual(fs.readdirSync(dir), ["session.json"]);
  await s.clear();
  assert.equal(await s.load(), null);
});

test("a malformed session file reads as NO session, so the next step identifies", async () => {
  const dir = tmp();
  const file = path.join(dir, "session.json");
  fs.writeFileSync(file, '{"session_id":"only-this"}');
  const s = new G.SessionStore(file);
  // A half-valid session would make RESUME fail and cost a round trip; treating
  // it as absent costs one identify and is correct.
  assert.equal(await s.load(), null);
});

test("end to end: a flaky network resumes repeatedly and spends NO budget", async () => {
  const dir = tmp();
  const budget = new G.IdentifyBudget(path.join(dir, "i.jsonl"));
  const store = new G.SessionStore(path.join(dir, "session.json"));
  await store.save(session());

  for (let i = 0; i < 40; i++) {
    const d = G.decide({
      closeCode: 4000,
      session: await store.load(),
      budget: await budget.check(NOW),
      attempt: i,
    });
    assert.equal(d.action, "resume");
    if (d.spendsBudget) await budget.record(NOW, "identify");
  }
  // Forty drops, zero identifies. This is what keeping the session buys.
  assert.equal((await budget.spent(NOW)).length, 0);
});

test("end to end: a session that keeps dying stops before the budget is gone", async () => {
  const dir = tmp();
  const budget = new G.IdentifyBudget(path.join(dir, "i.jsonl"), { cap: 10, floor: 2 });
  const store = new G.SessionStore(path.join(dir, "session.json"));

  let identifies = 0;
  let stopped = null;
  for (let i = 0; i < 50 && stopped === null; i++) {
    const d = G.decide({
      closeCode: 4009, // session timed out -- resume is not available
      session: await store.load(),
      budget: await budget.check(NOW),
      attempt: i,
    });
    if (d.action === "stop") { stopped = d.reason; break; }
    assert.equal(d.action, "identify");
    // RECORDED BEFORE THE SEND. Recording after would lose every attempt that
    // crashed in between, and undercounting is the direction that spends the
    // token rather than merely delaying a reconnect.
    await budget.record(NOW, "identify");
    identifies += 1;
  }
  assert.ok(stopped !== null, "it must stop rather than loop until the cap");
  assert.equal(identifies, 8, "cap 10 minus floor 2");
  assert.match(stopped, /RESETS THE BOT TOKEN/);
});
