"use strict";

// THE BRIDGE LIBRARY, RUNNING: an appservice transaction in, onEvent out.
//
// matrix-appservice-bridge 12 (2026-09-24) removed nedb, and with it the user
// and room stores a Bridge used to open by default. The tunnel never used
// them, but the library still builds a context from them for every event: on
// 12, a Bridge given no stores and not told `disableStores` throws "Cannot call
// getBridgeContext before loading databases" from an event listener nothing
// awaits. onEvent is never called, and on Node 24 the unhandled rejection ends
// the process: the bridge dies on the first event it is sent, and restarts
// into the same death.
//
// This replaces nedb-compat.test.js (retired 2026-10-24), which held the Node
// ceiling nedb imposed. With nedb gone the ceiling went with it; what remains
// is that the engines range, engine-strict and the Dockerfile agree, and that
// the library delivers events on the Node that runs this file.
//
// Both halves are measured: with disableStores the event reaches onEvent;
// without it, the process dies of it. If a later release stops needing the
// flag the second half fails and says so.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const RANGE = /^>=(\d+)(?:\.\d+\.\d+)? <(\d+)(?:\.\d+\.\d+)?$/.exec((pkg.engines && pkg.engines.node) || "");
const running = Number(process.versions.node.split(".")[0]);

test("package.json pins one Node major, .npmrc enforces it, and the image runs inside it", () => {
  assert.ok(RANGE, `package.json engines.node must read ">=N <M", got ${JSON.stringify(pkg.engines)}`);
  const [floor, ceiling] = [Number(RANGE[1]), Number(RANGE[2])];
  assert.ok(floor < ceiling);

  const npmrc = fs.readFileSync(path.join(__dirname, ".npmrc"), "utf8");
  assert.match(npmrc, /^engine-strict=true$/m, "without engine-strict the range is advice, not a gate");

  const dockerfile = fs.readFileSync(path.join(__dirname, "Dockerfile"), "utf8");
  const from = /^FROM node:(\d+)-slim\s*$/m.exec(dockerfile);
  assert.ok(from, "the Dockerfile's base image must be node:<major>-slim");
  const image = Number(from[1]);
  assert.ok(image >= floor && image < ceiling,
    `the Dockerfile runs Node ${image}, outside engines ${pkg.engines.node}. Fix: change one to match the other.`);
  assert.match(dockerfile, /^COPY [^\n]*\.npmrc/m, "the image build must see .npmrc, or engine-strict does not reach it");
  assert.match(dockerfile, /^RUN npm ci /m, "the image installs exactly the lockfile");
});

test("index.js builds its Bridge with disableStores", () => {
  // The Bridge in index.js is built only under require.main, so this file
  // cannot construct THAT one; it holds the option to the source, and the
  // tests below show what the option decides.
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const at = src.indexOf("new Bridge({");
  assert.ok(at >= 0, "index.js no longer builds a Bridge; this file is about that Bridge");
  const block = src.slice(at, src.indexOf("controller:", at));
  assert.match(block, /^\s*disableStores: true,$/m,
    "index.js's Bridge must pass disableStores: true, or no event reaches onEvent (see the test below)");
});

const HS_TOKEN = "hs-token";

// A real Bridge listening on loopback, sent one transaction the way Synapse
// sends it. Resolves to what onEvent saw within the deadline, or null.
async function deliverOneEvent(opts) {
  const { Bridge, AppServiceRegistration } = require("matrix-appservice-bridge");
  const reg = new AppServiceRegistration("http://127.0.0.1:1");
  reg.setId("bridge-runtime");
  reg.setHomeserverToken(HS_TOKEN);
  reg.setAppServiceToken("as-token");
  reg.setSenderLocalpart("tunnel");
  let seen = null;
  let arrived;
  const delivered = new Promise((resolve) => { arrived = resolve; });
  const logs = [];
  const bridge = new Bridge({
    homeserverUrl: "http://127.0.0.1:1",
    domain: "example.org",
    registration: reg,
    ...opts,
    controller: {
      onUserQuery() { return {}; },
      onEvent(request) { seen = request.getData(); arrived(); },
      onLog(line, isError) { if (isError) logs.push(line); },
    },
  });
  await bridge.initialise();
  await bridge.listen(0, "127.0.0.1");
  try {
    const { port } = bridge.appservice.server.address();
    const event = {
      type: "m.room.message", room_id: "!room:example.org", sender: "@alice:example.org",
      event_id: "$one", origin_server_ts: 0, content: { msgtype: "m.text", body: "hello" },
    };
    const res = await fetch(`http://127.0.0.1:${port}/_matrix/app/v1/transactions/txn1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${HS_TOKEN}` },
      body: JSON.stringify({ events: [event] }),
    });
    assert.equal(res.status, 200, `the appservice refused the transaction: HTTP ${res.status}`);
    // The library acknowledges the transaction before onEvent runs, so the
    // 200 says nothing about delivery. Wait for onEvent itself, with a deadline.
    let timer;
    await Promise.race([delivered, new Promise((r) => { timer = setTimeout(r, 2000); })]);
    clearTimeout(timer);
    return { seen, logs };
  } finally {
    await bridge.close();
  }
}

test(`with disableStores, a transaction's event reaches onEvent (this run: Node ${process.versions.node})`, async () => {
  assert.ok(RANGE);
  assert.ok(running >= Number(RANGE[1]) && running < Number(RANGE[2]),
    `Node ${process.versions.node} is outside engines ${pkg.engines.node}: nothing here was measured on it. ` +
    "Fix: run the suite on a supported Node (npm run test:image).");
  const { seen, logs } = await deliverOneEvent({ disableStores: true });
  assert.ok(seen, `onEvent was never called; the library logged: ${logs.join(" | ") || "nothing"}`);
  assert.equal(seen.event_id, "$one");
  assert.equal(seen.content.body, "hello");
});

test("without disableStores, the first event kills the process", () => {
  // In a child, because that is what it does: an unhandled rejection ends a
  // Node 24 process, and inside this one the test runner would catch it first.
  const child = `
    const { Bridge, AppServiceRegistration } = require(${JSON.stringify(require.resolve("matrix-appservice-bridge"))});
    const reg = new AppServiceRegistration("http://127.0.0.1:1");
    reg.setId("bridge-runtime"); reg.setHomeserverToken("hs-token");
    reg.setAppServiceToken("as-token"); reg.setSenderLocalpart("tunnel");
    const bridge = new Bridge({ homeserverUrl: "http://127.0.0.1:1", domain: "example.org", registration: reg,
      controller: { onUserQuery() { return {}; }, onEvent() { console.log("ONEVENT"); } } });
    (async () => {
      await bridge.initialise();
      await bridge.listen(0, "127.0.0.1");
      const { port } = bridge.appservice.server.address();
      await fetch("http://127.0.0.1:" + port + "/_matrix/app/v1/transactions/txn1", {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: "Bearer hs-token" },
        body: JSON.stringify({ events: [{ type: "m.room.message", room_id: "!r:example.org",
          sender: "@a:example.org", event_id: "$one", origin_server_ts: 0, content: { body: "hello" } }] }) });
      setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 1000);
    })();
  `;
  const r = spawnSync(process.execPath, ["-e", child], { encoding: "utf8", timeout: 15000 });
  assert.doesNotMatch(r.stdout, /ONEVENT/,
    "onEvent WAS called with no stores and no disableStores: this library release no longer needs the flag. " +
    "Fix: keep the flag (it is harmless) and rewrite this half to what the release does now.");
  assert.doesNotMatch(r.stdout, /SURVIVED/, "the process outlived the dropped event; the release changed how it fails");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /getBridgeContext before loading databases/, `the child died of something else:\n${r.stderr}`);
});
