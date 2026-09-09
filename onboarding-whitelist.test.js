"use strict";

// The operator set one condition on the whole reverse-Fibonacci point system
// (instruction 2026-09-08): it must not reach any user but them until they have
// reviewed it. That gate had exactly one test, and it read onboarding.js as a
// STRING and regexed the body of observeFibonacci for a whitelist check.
//
// That asserts the code CONTAINS a gate, not that the gate WORKS. It passes
// unchanged if the whitelist is loaded with every user on the server, if
// isLocalHuman starts answering true for everyone, or if some other path scores
// people without consulting it. The class was never instantiated in this suite.
//
// These run the gate. The one that matters most is the POSITIVE case: without
// it, every assertion here passes for a gate that is simply always shut, which
// is a different bug wearing the same green.

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// Set BEFORE requiring onboarding.js: it resolves these paths at module load,
// and STATE_DIR falls back to __dirname -- so leaving ONBOARDING_STATE_DIR
// unset makes this test write onboarding-state.json into the repo.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fib-whitelist-"));
process.env.ONBOARDING_STATE_DIR = tmp;
process.env.ONBOARDING_TASKS = path.join(tmp, "tasks.yaml");
process.env.ONBOARDING_CATALOG = path.join(tmp, "no-tier-catalog.yaml");
fs.writeFileSync(process.env.ONBOARDING_TASKS,
  "goal: 999\ntasks:\n" +
  "  - id: reacted\n    label: Reacted to something\n    detect: server:reaction\n" +
  "  - id: spoke\n    label: Said something\n    detect: server:message\n");

const test = require("node:test");
const assert = require("node:assert/strict");
const { Onboarding } = require("./onboarding");

const OPERATOR = "@saber:41chan.net";
const STRANGER = "@someone-else:41chan.net";

// The constructor reports feasibility on stderr; goal 999 is deliberately
// unreachable so nothing here trips the pass path, and the warning it prints
// about that is expected rather than a symptom.
function build(onboarding) {
  const audits = [];
  // Seed the state file rather than assigning ob.state afterwards, so the test
  // goes through loadState/migrateState the way production does. start() writes
  // exactly this shape on first run; it is gated on an admin token, which a
  // test has no business holding.
  fs.writeFileSync(path.join(tmp, "onboarding-state.json"),
    JSON.stringify({ watermark_ts: Date.now(), pending: {}, greeted: {}, users: {} }));
  const config = {
    homeserver: { domain: "41chan.net" },
    bridge: { onboarding: Object.assign({ enabled: true, localpart: "fourier" }, onboarding) },
  };
  const bridge = { getIntent: () => ({ sendStateEvent: async () => {}, sendText: async () => {} }) };
  const log = console.log, warn = console.warn;
  console.log = console.warn = () => {};
  let ob;
  try {
    ob = new Onboarding(bridge, config, "as-token", (a) => audits.push(a));
  } finally {
    console.log = log; console.warn = warn;
  }
  ob.sendToUser = async () => {};
  return { ob, audits };
}

const reaction = (sender) => ({
  sender, type: "m.reaction", room_id: "!room:41chan.net", content: {},
});

const scored = (audits, user) =>
  audits.some((a) => a.kind === "fib_progress" && a.user === user);

test("the whitelisted operator IS scored", async () => {
  // FIRST, because it is what stops the rest of this file from passing
  // vacuously. If the engine scores nobody at all, these tests must fail here.
  const { ob, audits } = build({ engine: "fibonacci", fibonacci: { whitelist: [OPERATOR] } });
  assert.equal(await ob.observeEvent(reaction(OPERATOR)), true);
  assert.ok(scored(audits, OPERATOR), "the operator must actually earn points");
});

test("a local human who is not on the whitelist is scored by nothing", async () => {
  const { ob, audits } = build({ engine: "fibonacci", fibonacci: { whitelist: [OPERATOR] } });
  assert.equal(await ob.observeEvent(reaction(STRANGER)), false);
  assert.ok(!scored(audits, STRANGER), "a stranger must earn nothing");
  assert.equal(ob.state.users[STRANGER] && ob.state.users[STRANGER].fib, undefined,
    "and must not even acquire a fibonacci profile");
});

test("a missing whitelist means NOBODY, including the operator", async () => {
  // Fails closed: `(cfg.fibonacci && cfg.fibonacci.whitelist) || []`. If that
  // default ever becomes "everyone", this is the test that says so.
  const { ob } = build({ engine: "fibonacci" });
  assert.equal(await ob.observeEvent(reaction(OPERATOR)), false);
  assert.equal(await ob.observeEvent(reaction(STRANGER)), false);
});

test("an empty whitelist is not a wildcard", async () => {
  const { ob } = build({ engine: "fibonacci", fibonacci: { whitelist: [] } });
  assert.equal(await ob.observeEvent(reaction(OPERATOR)), false);
  assert.equal(await ob.observeEvent(reaction(STRANGER)), false);
});

test("naming no engine scores nobody, whitelist or not", async () => {
  // The default is "off" rather than either engine, so an upgrade never
  // silently starts scoring people.
  const { ob } = build({ fibonacci: { whitelist: [OPERATOR] } });
  assert.equal(ob.engine, "off");
  assert.equal(await ob.observeEvent(reaction(OPERATOR)), false);
});
