"use strict";

// THE NODE CEILING, AS A RUNNING FACT RATHER THAN A COMMENT.
//
// matrix-appservice-bridge keeps its user and room stores in nedb, loaded by
// Bridge.loadDatabases() at startup. nedb calls util.isDate / util.isRegExp,
// which Node 23 REMOVED: on 23 and 24 the first store write throws
// "util.isDate is not a function". Measured 2026-10-01 with the library's own
// stores, in node:20-slim, node:22-slim, node:23-slim and on vesper's Node 24:
// 20 and 22 work, 23 and 24 break.
//
// For months this repo said "incompatible with Node 22+" and pinned Node 20,
// which reached its upstream end of life on 2026-04-30. The boundary was one
// major wrong, and nothing checked it. Now:
//   - package.json `engines` names the supported range and .npmrc's
//     engine-strict makes npm refuse to install outside it -- the image build
//     included, since the Dockerfile's `npm ci` runs on the image's Node;
//   - the Dockerfile's base image must be inside that range;
//   - and the library's store path is exercised on whatever Node runs this
//     file: inside the range it must WORK, above it it must BREAK. If a later
//     nedb or library release stops breaking above the ceiling, this fails and
//     says the ceiling can be raised -- the range is only as wide as what has
//     been measured.
//
// What it does NOT do: prove the image works. Run on vesper's Node 24 it proves
// the breakage above the ceiling; the "works" half is proven where the image's
// Node runs it -- `npm run test:image` runs this whole suite inside the same
// base image the Dockerfile names.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
    `the Dockerfile runs Node ${image}, outside engines ${pkg.engines.node}. Fix: change one to match ` +
    "the other -- and do not raise the ceiling without this file passing on the new major.");
  assert.match(dockerfile, /^COPY [^\n]*\.npmrc/m, "the image build must see .npmrc, or engine-strict does not reach it");
  assert.match(dockerfile, /^RUN npm ci /m, "the image installs exactly the lockfile");
});

// The library's own path: the stores Bridge.loadDatabases() builds at startup.
async function exerciseBridgeStores() {
  const { Bridge, AppServiceRegistration, MatrixUser, MatrixRoom } = require("matrix-appservice-bridge");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-nedb-"));
  try {
    const reg = new AppServiceRegistration("http://127.0.0.1:1");
    reg.setId("nedb-compat");
    reg.setHomeserverToken("hs");
    reg.setAppServiceToken("as");
    reg.setSenderLocalpart("tunnel");
    const bridge = new Bridge({
      homeserverUrl: "http://127.0.0.1:1",
      domain: "example.org",
      registration: reg,
      controller: { onEvent() {} },
      userStore: path.join(dir, "user-store.db"),
      roomStore: path.join(dir, "room-store.db"),
      // Every store the library opens goes in the temp dir: left to its default,
      // this one is created in the working directory -- the checkout.
      userActivityStore: path.join(dir, "user-activity-store.db"),
    });
    await bridge.loadDatabases();
    await bridge.getUserStore().setMatrixUser(new MatrixUser("@someone:example.org"));
    const back = await bridge.getUserStore().getMatrixUser("@someone:example.org");
    await bridge.getRoomStore().setMatrixRoom(new MatrixRoom("!room:example.org"));
    return back && back.getId();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// nedb directly, with the two value types whose checks Node 23 removed.
function exerciseNedb() {
  const Datastore = require("nedb");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-nedb-"));
  const db = new Datastore({ filename: path.join(dir, "x.db"), autoload: true });
  return new Promise((resolve, reject) => {
    db.insert({ at: new Date(0), pattern: /x/ }, (err) => {
      if (err) return reject(err);
      db.find({ at: new Date(0) }, (err2, docs) => (err2 ? reject(err2) : resolve(docs.length)));
    });
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test(`the bridge library's nedb stores work inside the engines range and break above it (this run: Node ${process.versions.node})`, async () => {
  assert.ok(RANGE);
  const [floor, ceiling] = [Number(RANGE[1]), Number(RANGE[2])];
  assert.ok(running >= floor,
    `Node ${process.versions.node} is below engines ${pkg.engines.node}: nothing here was measured on it. ` +
    "Fix: run the suite on a supported Node (npm run test:image).");
  if (running < ceiling) {
    assert.equal(await exerciseBridgeStores(), "@someone:example.org");
    assert.equal(await exerciseNedb(), 1);
  } else {
    await assert.rejects(exerciseBridgeStores, /util\.is(Date|RegExp) is not a function/,
      `the library's stores WORK on Node ${running}, above the ceiling. Fix: the ceiling may be raisable -- ` +
      "build the image on this major, run this file inside it, then widen engines and the Dockerfile together.");
    await assert.rejects(exerciseNedb, /util\.is(Date|RegExp) is not a function/);
    console.log(`# Node ${running} is above the ceiling: this run proves the breakage, not the image. ` +
      "`npm run test:image` runs the suite on the image's Node.");
  }
});
