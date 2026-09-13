// One homeserver URL, resolved once, reaching every part of the process.
//
// The bug these pin is not "the resolver is wrong" -- the resolver was right
// the first time. It is that a SECOND resolution existed, so the pager and the
// media downloader disagreed and a whole run failed after reporting the URL it
// was using. Two of these tests therefore assert against SOURCE, because the
// defect lives in which module resolves what and in what order, and nothing
// about the values themselves can show it.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { resolveHomeserverUrl } = require("./homeserver");

test("the configured url is used when nothing overrides it", () => {
  assert.equal(resolveHomeserverUrl({}, "http://synapse:8008"), "http://synapse:8008");
});

test("a trailing slash never survives, so no caller has to strip it again", () => {
  assert.equal(resolveHomeserverUrl({}, "http://synapse:8008/"), "http://synapse:8008");
  assert.equal(resolveHomeserverUrl({ HOMESERVER_URL: "http://localhost:8008//" }, "x"), "http://localhost:8008");
});

test("HOMESERVER_URL overrides the config", () => {
  assert.equal(
    resolveHomeserverUrl({ HOMESERVER_URL: "http://localhost:8008" }, "http://synapse:8008"),
    "http://localhost:8008",
  );
});

test("an empty override is nobody setting it, not a url of nothing", () => {
  // `HOMESERVER_URL= node tool.js` is how a shell spells unset by accident.
  assert.equal(resolveHomeserverUrl({ HOMESERVER_URL: "" }, "http://synapse:8008"), "http://synapse:8008");
  assert.equal(resolveHomeserverUrl({ HOMESERVER_URL: "   " }, "http://synapse:8008"), "http://synapse:8008");
});

test("a url that is not a url is refused here, not at the first request", () => {
  for (const bad of ["synapse:8008", "localhost:8008", "", undefined, null, "http://"]) {
    assert.throws(
      () => resolveHomeserverUrl({}, bad),
      /absolute http\(s\) URL/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("index.js resolves the url once and writes it back into the config", () => {
  // index.js cannot be required off the box -- config.yaml and the registration
  // are gitignored -- so this reads it. Every call site builds its URL from
  // config.homeserver.url, so resolving INTO that key is what makes the five of
  // them agree by construction instead of by everyone remembering.
  const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(src, /config\.homeserver\.url\s*=\s*resolveHomeserverUrl\(/,
    "index.js must resolve the homeserver url into config.homeserver.url");
  assert.doesNotMatch(src, /process\.env\.HOMESERVER_URL/,
    "index.js must read the override through the resolver, not directly a second time");
});

test("the tool sets the override BEFORE it requires index", () => {
  // The ordering is the whole fix. index.js resolves at module scope, so a
  // --homeserver flag applied after the require would move the pager and leave
  // the media download pointed at the container's hostname -- which is exactly
  // the run that failed 419 times while printing a reachable URL.
  const src = fs.readFileSync(path.join(__dirname, "tools", "catch-up-room.js"), "utf8");
  const setsEnv = src.indexOf("process.env.HOMESERVER_URL =");
  const requiresIndex = src.search(/require\([^)]*"index"\)/);
  assert.ok(setsEnv !== -1, "the tool must put --homeserver into the environment");
  assert.ok(requiresIndex !== -1, "the tool must require index.js");
  assert.ok(setsEnv < requiresIndex,
    "--homeserver must reach the environment before index.js resolves it at module scope");
});

test("the dry run never reaches the pipeline", () => {
  // --apply used to gate only the Matrix state write while handleImageEvent
  // still downloaded, uploaded and posted every image. The guard must come
  // FIRST inside onImage, before the pipeline is called at all.
  const src = fs.readFileSync(path.join(__dirname, "tools", "catch-up-room.js"), "utf8");
  const onImage = src.indexOf("onImage: async (ev)");
  const call = src.indexOf("handleImageEvent(bridge", onImage);
  const guard = src.indexOf("if (!apply)", onImage);
  assert.ok(onImage !== -1 && call !== -1 && guard !== -1, "expected onImage, its guard and the pipeline call");
  assert.ok(guard < call, "the dry-run guard must return before handleImageEvent is called");
});
