"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PresenceClient } = require("./discordPresence.js");
const G = require("./discordGateway.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-presence-"));

// Let the client's own async work settle. A single setImmediate is not enough:
// saving a session is mkdir + write + rename, and a close handler reads the
// budget off disk before it decides. Under-waiting here made eight tests fail
// for a reason that had nothing to do with what they were checking.
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => { setTimeout(resolve, 0); });
};
const TOKEN = "NOT.A.REAL.TOKEN";

// A FAKE SOCKET, which is the only way this state machine gets tested at all.
//
// Heartbeats, zombie detection, resume-versus-identify and budget exhaustion
// are all timing and protocol behaviour. Against a real socket they are
// untestable without a network and a wall clock; against this they are
// deterministic. The repo's rule is that tests build real things rather than
// mocks -- this is the exception the rule allows for, and it is confined to the
// transport: every decision it exercises comes from discordGateway.js, which is
// tested as the pure function it is.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = null;
    this.listeners = { message: [], close: [], error: [] };
    FakeSocket.opened.push(this);
  }
  addEventListener(ev, fn) { this.listeners[ev].push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const fn of this.listeners.close) fn({ code, reason });
  }
  /** Discord says something. */
  deliver(payload) { for (const fn of this.listeners.message) fn({ data: JSON.stringify(payload) }); }
  /** The network drops without a close frame. */
  drop(code) {
    this.closed = { code, reason: "" };
    for (const fn of this.listeners.close) fn({ code, reason: "" });
  }
  ops() { return this.sent.map((p) => p.op); }
  payloadFor(op) { return this.sent.find((p) => p.op === op); }
}
FakeSocket.opened = [];

/** Timers we drive by hand, so nothing waits on a real clock. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  const t = {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms, kind: "timeout" }); return id; },
    clearTimeout: (id) => pending.delete(id),
    setInterval: (fn, ms) => { const id = next++; pending.set(id, { fn, ms, kind: "interval" }); return id; },
    clearInterval: (id) => pending.delete(id),
    /**
     * Run every pending timeout once, and each interval `times` times.
     *
     * `withinMs` fires ONLY timers whose delay is at or under it. Without that
     * bound a fake timer ignores its own delay, so a test can assert that a
     * deadline exists but never that its VALUE is right -- and mutating the
     * deadline to eleven days would not fail a thing. Found by mutating it.
     */
    async run(times = 1, withinMs = Infinity) {
      for (const [id, e] of [...pending]) {
        if (e.ms > withinMs) continue;
        if (e.kind === "timeout") { pending.delete(id); await e.fn(); }
        else for (let i = 0; i < times; i++) { if (pending.has(id)) await e.fn(); }
      }
      await flush();
    },
    size: () => pending.size,
  };
  return t;
}

function rig(over = {}) {
  FakeSocket.opened = [];
  const dir = tmp();
  const timers = fakeTimers();
  const logs = [];
  const client = new PresenceClient(Object.assign({
    token: TOKEN,
    gatewayUrl: "wss://gateway.discord.gg/",
    budget: new G.IdentifyBudget(path.join(dir, "identify.jsonl")),
    sessions: new G.SessionStore(path.join(dir, "session.json")),
    status: "online",
    WebSocketImpl: FakeSocket,
    timers,
    now: () => Date.parse("2026-09-21T06:00:00.000Z"),
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  }, over));
  return { client, dir, timers, logs };
}

const hello = (interval = 41250) => ({ op: 10, d: { heartbeat_interval: interval } });
const ready = (over = {}) => ({
  op: 0, s: 1, t: "READY",
  d: Object.assign({ session_id: "sess-1", resume_gateway_url: "wss://resume.example/", user: { username: "tunnel" }, guilds: [{}] }, over),
});

test("a first connection IDENTIFIES with intents 0 and no privileged grant", async () => {
  const { client } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello());
  const id = ws.payloadFor(2);
  assert.ok(id, "an IDENTIFY must have been sent");
  assert.equal(id.d.intents, 0, "presence needs no intents, and asking for none is what makes the socket unable to read");
  assert.equal(id.d.presence.status, "online");
});

test("the identify is recorded in the ledger BEFORE the socket is opened", async () => {
  const { client, dir } = rig();
  await client.start();
  // Recorded even though no READY has arrived and no byte has been exchanged.
  // Recording after would lose an attempt that crashed in between, and
  // undercounting is the direction that empties the budget.
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  assert.equal((await b.spent(Date.parse("2026-09-21T06:00:00.000Z"))).length, 1);
});

test("READY saves the session so a later run can resume", async () => {
  const { client, dir } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello());
  ws.deliver(ready());
  await flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
  assert.equal(saved.session_id, "sess-1");
  assert.equal(saved.resume_gateway_url, "wss://resume.example/");
  assert.equal(saved.seq, 1);
});

test("a saved session makes start() RESUME, spending no identify", async () => {
  const { client, dir } = rig();
  await client.opts.sessions.save({ session_id: "sess-9", resume_gateway_url: "wss://resume.example/", seq: 77 });
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello());
  assert.equal(ws.payloadFor(2), undefined, "no IDENTIFY");
  const resume = ws.payloadFor(6);
  assert.ok(resume, "a RESUME must have been sent");
  assert.equal(resume.d.session_id, "sess-9");
  assert.equal(resume.d.seq, 77);
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  assert.equal((await b.spent(Date.parse("2026-09-21T06:00:00.000Z"))).length, 0, "resuming must cost no budget");
});

test("a dropped connection reconnects and RESUMES rather than identifying", async () => {
  const { client, dir, timers } = rig();
  await client.start();
  const first = FakeSocket.opened[0];
  first.deliver(hello());
  first.deliver(ready());
  await flush();

  first.drop(4000); // "unknown error", marked reconnectable by Discord
  await flush();
  await timers.run();

  const second = FakeSocket.opened[1];
  assert.ok(second, "it must have reconnected");
  assert.match(second.url, /resume\.example/, "and dialled the resume URL Discord gave, not the original");
  second.deliver(hello());
  assert.ok(second.payloadFor(6), "a RESUME, not an IDENTIFY");
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  assert.equal((await b.spent(Date.parse("2026-09-21T06:00:00.000Z"))).length, 1, "still only the original identify");
});

test("a session-dead close IDENTIFIES, because resuming would be refused", async () => {
  const { client, dir, timers } = rig();
  await client.start();
  const first = FakeSocket.opened[0];
  first.deliver(hello());
  first.deliver(ready());
  await flush();

  first.drop(4009); // session timed out
  await flush();
  await timers.run();

  const second = FakeSocket.opened[1];
  assert.ok(second);
  second.deliver(hello());
  assert.ok(second.payloadFor(2), "an IDENTIFY");
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  assert.equal((await b.spent(Date.parse("2026-09-21T06:00:00.000Z"))).length, 2);
});

test("a TERMINAL close stops for good and says so loudly", async () => {
  let stoppedWith = null;
  const { client, timers } = rig({ onStopped: (r) => { stoppedWith = r; } });
  await client.start();
  const first = FakeSocket.opened[0];
  first.deliver(hello());
  first.deliver(ready());
  await flush();

  first.drop(4004); // authentication failed -- Reconnect: false
  await flush();
  await timers.run();

  assert.equal(FakeSocket.opened.length, 1, "it must NOT have reconnected");
  assert.match(stoppedWith, /token/);
  assert.equal(timers.size(), 0, "and must leave no timer running");
});

test("an unacknowledged heartbeat is treated as a ZOMBIE, not as health", async () => {
  const { client, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello(1000));
  ws.deliver(ready());
  await flush();

  // Two passes, not one: the first-beat TIMEOUT is what registers the heartbeat
  // INTERVAL, and an interval added during a pass cannot fire in that same pass.
  await timers.run();   // jittered first beat -> awaitingAck, interval armed
  await timers.run();   // the interval ticks with no ACK in between
  assert.ok(ws.closed, "the socket must be closed rather than left looking connected");
  assert.equal(ws.closed.code, 4000, "and NOT with 1000/1001, which Discord reads as deliberate");
});

test("an acknowledged heartbeat keeps the connection", async () => {
  const { client, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello(1000));
  ws.deliver(ready());
  await flush();

  await timers.run();              // jittered first beat, interval armed
  ws.deliver({ op: 11 });          // ACK
  await timers.run();              // the interval ticks -- must not read as a zombie
  assert.equal(ws.closed, null);
  assert.ok(ws.ops().filter((o) => o === 1).length >= 2, "it kept beating");
});

test("an exhausted budget STOPS instead of connecting", async () => {
  const dir = tmp();
  const budget = new G.IdentifyBudget(path.join(dir, "i.jsonl"), { cap: 5, floor: 4 });
  const now = Date.parse("2026-09-21T06:00:00.000Z");
  await budget.record(now, "x");
  await budget.record(now, "x");
  let stoppedWith = null;
  const { client } = rig({ budget, onStopped: (r) => { stoppedWith = r; } });

  await client.start();
  assert.equal(FakeSocket.opened.length, 0, "no socket may be opened at all");
  assert.match(stoppedWith, /RESETS THE BOT TOKEN/);
});

test("INVALID_SESSION that is not resumable clears the session and identifies", async () => {
  const { client, timers } = rig();
  await client.start();
  const first = FakeSocket.opened[0];
  first.deliver(hello());
  first.deliver(ready());
  await flush();

  first.deliver({ op: 9, d: false });
  await flush();
  await timers.run();

  const second = FakeSocket.opened[1];
  assert.ok(second);
  second.deliver(hello());
  assert.ok(second.payloadFor(2), "an IDENTIFY, since the session cannot be resumed");
  assert.equal(second.payloadFor(6), undefined);
});

test("op 7 RECONNECT resumes without spending budget", async () => {
  const { client, dir, timers } = rig();
  await client.start();
  const first = FakeSocket.opened[0];
  first.deliver(hello());
  first.deliver(ready());
  await flush();

  first.deliver({ op: 7 });
  await flush();
  await timers.run();

  const second = FakeSocket.opened[1];
  second.deliver(hello());
  assert.ok(second.payloadFor(6), "a RESUME");
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  assert.equal((await b.spent(Date.parse("2026-09-21T06:00:00.000Z"))).length, 1);
});

test("stop() closes deliberately and does NOT reconnect", async () => {
  const { client, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello());
  ws.deliver(ready());
  await flush();

  client.stop();
  await flush();
  await timers.run();
  assert.equal(ws.closed.code, 1000, "a deliberate close, which Discord distinguishes from a fault");
  assert.equal(FakeSocket.opened.length, 1, "no reconnect after a deliberate stop");
  assert.equal(timers.size(), 0);
});

test("the token never reaches the log", async () => {
  const { client, logs, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello());
  ws.deliver(ready());
  await flush();
  ws.drop(4000);
  await flush();
  await timers.run();

  const text = JSON.stringify(logs);
  assert.equal(text.includes(TOKEN), false, "a presence client holding a live credential must never log it");
});

// ---- added 2026-09-21, from an adversarial review of this file -------------

test("a socket that opens and never says HELLO is closed, not left hanging", async () => {
  const { client, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  // No HELLO. Before this deadline existed there was nothing watching at all:
  // the zombie detector only starts once a heartbeat interval is known, so a
  // connection that opened and went silent sat forever with no timer, no log
  // and no error -- offline, and looking like nothing had gone wrong.
  assert.equal(ws.closed, null);
  // Only timers due within a minute. A deadline longer than that is not a
  // deadline for a server that sends HELLO immediately on connect -- and
  // without this bound the assertion held even against an eleven-day one.
  await timers.run(1, 60_000);
  assert.ok(ws.closed, "the hello deadline must close it, and must be short enough to matter");
  assert.equal(ws.closed.code, 4000, "and not with 1000/1001, which Discord reads as deliberate");
});

test("the hello deadline does not fire once HELLO has arrived", async () => {
  const { client, timers } = rig();
  await client.start();
  const ws = FakeSocket.opened[0];
  ws.deliver(hello(1000));
  ws.deliver(ready());
  await flush();
  await timers.run();      // the jittered first beat, not the hello deadline
  assert.equal(ws.closed, null, "a healthy connection must not be closed by the deadline");
});

test("resumes that never succeed give up on the session rather than looping forever", async () => {
  const { client, timers, dir } = rig();
  await client.opts.sessions.save({ session_id: "sess-x", resume_gateway_url: "wss://resume.example/", seq: 5 });
  await client.start();

  // Every attempt opens, is dropped, and never reaches RESUMED. A resume costs
  // no budget, which made an unbounded fixed retry look free -- but a hot loop
  // against Discord is a hot loop whether or not it spends the budget.
  let identified = false;
  for (let i = 0; i < 10 && !identified; i++) {
    const ws = FakeSocket.opened[FakeSocket.opened.length - 1];
    ws.deliver(hello());
    if (ws.payloadFor(2)) { identified = true; break; }
    ws.drop(4000);
    await flush();
    await timers.run();
  }
  assert.ok(identified, "after enough failed resumes it must discard the session and identify");
  assert.equal(fs.existsSync(path.join(dir, "session.json")), false, "and the dead session must be cleared");
});

test("a ledger that cannot be READ refuses to connect, and says so", async () => {
  const dir = tmp();
  // A directory where the ledger file should be.
  const asDirectory = path.join(dir, "identify.jsonl");
  fs.mkdirSync(asDirectory);
  let stoppedWith = null;
  const { client } = rig({
    budget: new G.IdentifyBudget(asDirectory),
    onStopped: (r) => { stoppedWith = r; },
  });

  // Must not throw out of an async handler: an unhandled rejection leaves a
  // client that is simply gone, which is the state presence exists to prevent.
  await client.start();
  assert.equal(FakeSocket.opened.length, 0, "no socket may be opened");
  assert.ok(stoppedWith, "and it must say why");
  assert.match(stoppedWith, /could not be read/);
});

test("a ledger that READS but cannot be WRITTEN refuses to send the identify", async () => {
  // A SEPARATE TEST because the read failure masked this one entirely: the
  // first version used an unreadable path, check() threw first, and the record
  // path it claimed to cover was never reached. Mutating the record guard away
  // did not fail it. Found by mutation, not by reading.
  let stoppedWith = null;
  const { client } = rig({
    budget: {
      check: async () => ({ ok: true, remaining: 900, waitMs: 0 }),
      record: async () => { throw new Error("ENOSPC: no space left on device"); },
    },
    onStopped: (r) => { stoppedWith = r; },
  });

  await client.start();
  // An identify we could not record is one the NEXT run will not count, and
  // undercounting is what empties a budget whose exhaustion resets the token.
  assert.equal(FakeSocket.opened.length, 0, "the identify must NOT be sent");
  assert.ok(stoppedWith, "and it must say why");
  assert.match(stoppedWith, /could not be recorded/);
});
