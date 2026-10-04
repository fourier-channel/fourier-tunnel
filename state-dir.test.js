"use strict";

// installed-locations audit 2026-10-04: rooms.js:65, backfill-state.js:49,
// invites.js:10, discordGateway.js:104. A state location that was never
// installed must be REFUSED, with its absolute path and the install step, and
// must never be created or substituted by the reader.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const G = require("./discordGateway");

const ROOM = "!r:41chan.net";

function load(mod, dir) {
  if (dir === undefined) delete process.env.ONBOARDING_STATE_DIR;
  else process.env.ONBOARDING_STATE_DIR = dir;
  delete require.cache[require.resolve(mod)];
  return require(mod);
}

const missing = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sd-")), "never-installed");

test("every state module refuses an UNSET ONBOARDING_STATE_DIR and does not fall back to the code dir", () => {
  try {
    const rooms = load("./rooms");
    const bf = load("./backfill-state");
    const inv = load("./invites");
    assert.throws(() => rooms.isDenied(ROOM), /ONBOARDING_STATE_DIR is not set.*Fix:/s);
    assert.throws(() => bf.load(), /ONBOARDING_STATE_DIR is not set.*Fix:/s);
    assert.throws(() => inv.strikesPath(), /ONBOARDING_STATE_DIR is not set.*Fix:/s);
    assert.equal(fs.existsSync(path.join(__dirname, "rooms-denied.json")), false);
  } finally {
    delete process.env.ONBOARDING_STATE_DIR;
  }
});

test("a MISSING state dir is refused by name, read and write, and never created", () => {
  const dir = missing();
  try {
    const rooms = load("./rooms", dir);
    const bf = load("./backfill-state", dir);
    assert.throws(() => rooms.isDenied(ROOM), new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.throws(() => rooms.deny(ROOM, { by: "x" }), /Fix:.*mkdir -p onboarding-state/s);
    assert.throws(() => bf.put(ROOM, { head: "a" }), /Fix:.*mkdir -p onboarding-state/s);
    assert.equal(fs.existsSync(dir), false, "the reader must not create the directory");
  } finally {
    delete process.env.ONBOARDING_STATE_DIR;
  }
});

test("a state dir that is a FILE is refused", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sd-")), "afile");
  fs.writeFileSync(f, "x");
  try {
    const bf = load("./backfill-state", f);
    assert.throws(() => bf.load(), /not a directory/);
  } finally {
    delete process.env.ONBOARDING_STATE_DIR;
  }
});

test("an installed but empty dir is an ordinary first run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-"));
  try {
    const rooms = load("./rooms", dir);
    assert.equal(rooms.isDenied(ROOM), false);
    assert.equal(rooms.deny(ROOM, { by: "x" }), true);
  } finally {
    delete process.env.ONBOARDING_STATE_DIR;
  }
});

test("the identify ledger refuses a missing directory instead of reading a full budget, and never creates it", async () => {
  const dir = missing();
  const b = new G.IdentifyBudget(path.join(dir, "identify.jsonl"));
  await assert.rejects(() => b.spent(Date.now()), /does not exist.*Fix:.*mkdir -p onboarding-state/s);
  await assert.rejects(() => b.record(Date.now(), "x"), /does not exist/);
  assert.equal(fs.existsSync(dir), false);
});

test("the session store refuses a missing directory on load and save, and logs a corrupt file", async () => {
  const dir = missing();
  const s = new G.SessionStore(path.join(dir, "session.json"));
  await assert.rejects(() => s.load(), /does not exist/);
  await assert.rejects(() => s.save({ session_id: "a", resume_gateway_url: "b", seq: 1 }), /does not exist/);
  assert.equal(fs.existsSync(dir), false);

  const ok = fs.mkdtempSync(path.join(os.tmpdir(), "sd-"));
  const file = path.join(ok, "session.json");
  fs.mkdirSync(file); // EISDIR: unreadable, not absent
  const warnings = [];
  const mock = test.mock.method(console, "warn", (m) => warnings.push(m));
  try {
    assert.equal(await new G.SessionStore(file).load(), null);
  } finally {
    mock.mock.restore();
  }
  assert.match(warnings.join("\n"), /will IDENTIFY instead of RESUME/);
});
