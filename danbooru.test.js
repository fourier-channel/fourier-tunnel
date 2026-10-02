"use strict";

// danbooru.js's side of the shared interface (v2) against a stand-in HTTP
// client: the paths and bodies it sends, and what it says when the booru
// refuses -- which must name the status and the booru's own { error, fix },
// carry the status for a caller to branch on, and never include the
// generation text or the URL (the api_key rides in its query string).

const test = require("node:test");
const assert = require("node:assert/strict");
const { DanbooruClient, BooruRefusal } = require("./danbooru");

function client(reply) {
  const c = new DanbooruClient({ url: "http://booru.invalid/", username: "bot", api_key: "SECRETKEY" });
  const sent = [];
  const answer = async (method, url, body, opts) => { sent.push({ method, url, body, opts }); return typeof reply === "function" ? reply(url) : reply; };
  c._client = () => ({
    post: (url, body, opts) => answer("POST", url, body, opts),
    get: (url, opts) => answer("GET", url, undefined, opts),
  });
  return { c, sent };
}
const FIELDS = { "png:parameters": "1girl\nSteps: 20, Sampler: Euler a", "png:workflow": "{\"nodes\":[]}" };
const MD5 = "0123456789abcdef0123456789abcdef";
const RAW = "fedcba9876543210fedcba9876543210";

test("generation metadata: md5, raw_md5, source, poster and fields to the endpoint; the booru's answer back", async () => {
  const { c, sent } = client({ status: 200, data: { md5: MD5, stored: 2 } });
  const out = await c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", poster: "@alice:41chan.net", fields: FIELDS });
  assert.deepEqual(out, { md5: MD5, stored: 2 });
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, "/fourier/generation_metadata.json");
  assert.deepEqual(sent[0].body, { md5: MD5, raw_md5: RAW, source: "matrix", poster: "@alice:41chan.net", fields: FIELDS });
});

test("an absent poster is sent as null, not left out -- that is the admin re-read the booru lets replace fields", async () => {
  const { c, sent } = client({ status: 200, data: { md5: MD5, stored: 2 } });
  await c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", fields: FIELDS });
  assert.equal(sent[0].body.poster, null);
});

test("a refusal throws a BooruRefusal with the status, the booru's error and fix -- never the text, never the key", async () => {
  for (const [status, data] of [
    [409, { error: "a record from another poster exists", fix: "nothing: the creator's record stands" }],
    [413, { error: "fields total 5 MiB, over the 4 MiB cap", fix: "send less" }],
    [422, { error: "field value contains NUL", fix: "strip NUL before sending" }],
  ]) {
    const { c } = client({ status, data });
    await assert.rejects(
      c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", poster: null, fields: FIELDS }),
      (err) => err instanceof BooruRefusal && err.status === status &&
        err.message.includes(`-> ${status}: ${data.error} -- fix: ${data.fix}`) &&
        !/Steps: 20|SECRETKEY|booru\.invalid/.test(err.message),
    );
  }
});

test("a 200 that is not the booru's answer is not taken as success -- a page, or JSON that names no md5", async () => {
  for (const data of ["<html>a proxy page</html>", { stored: 2 }, { md5: 42 }, null]) {
    const { c } = client({ status: 200, data });
    await assert.rejects(c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", poster: null, fields: FIELDS }), /-> 200: the booru gave no reason/, JSON.stringify(data));
  }
});

test("a 409 carries the booru's machine-readable reason, on the error and in its message", async () => {
  for (const reason of ["poster_mismatch", "raw_md5_conflict", "raw_md5_mismatch"]) {
    const { c } = client({ status: 409, data: { error: "e", fix: "f", reason } });
    await assert.rejects(c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", poster: null, fields: FIELDS }),
      (err) => err.status === 409 && err.reason === reason && err.message.includes(`-> 409 (${reason}): e -- fix: f`));
  }
  // A reason that is not a plain token is kept on the error but never printed.
  const { c } = client({ status: 409, data: { error: "e", fix: "f", reason: "Steps: 20 <script>" } });
  await assert.rejects(c.recordGenerationMetadata(MD5, { rawMd5: RAW, source: "matrix", poster: null, fields: FIELDS }),
    (err) => err.reason === "Steps: 20 <script>" && !err.message.includes("Steps: 20"));
});

test("the creator: POST /fourier/posts/:id/creator.json with the mxid; a 200 naming someone else is not success", async () => {
  const { c, sent } = client({ status: 200, data: { post_id: 42, mxid: "@alice:41chan.net" } });
  assert.deepEqual(await c.recordPostCreator(42, "@alice:41chan.net"), { post_id: 42, mxid: "@alice:41chan.net" });
  assert.equal(sent[0].url, "/fourier/posts/42/creator.json");
  assert.deepEqual(sent[0].body, { mxid: "@alice:41chan.net" });
  const other = client({ status: 200, data: { post_id: 42, mxid: "@mallory:41chan.net" } });
  await assert.rejects(other.c.recordPostCreator(42, "@alice:41chan.net"), /names "@mallory:41chan.net", not @alice/);
  for (const status of [409, 422, 403]) {
    const { c: refused } = client({ status, data: { error: "e", fix: "f" } });
    await assert.rejects(refused.recordPostCreator(42, "@alice:41chan.net"), (err) => err.status === status && /posts\/42\/creator -> \d+: e -- fix: f/.test(err.message));
  }
});

test("the raw lookup: GET /fourier/generation_metadata/raw/:raw_md5.json -> the booru's md5, null on 404, and anything else THROWS", async () => {
  const { c, sent } = client({ status: 200, data: { md5: MD5 } });
  assert.equal(await c.findGenerationByRawMd5(RAW), MD5);
  assert.equal(sent[0].method, "GET");
  assert.equal(sent[0].url, `/fourier/generation_metadata/raw/${RAW}.json`);
  assert.equal(await client({ status: 404, data: { error: "not found" } }).c.findGenerationByRawMd5(RAW), null);
  // An outage is not "no such post": answering null would post the picture twice.
  await assert.rejects(client({ status: 503, data: {} }).c.findGenerationByRawMd5(RAW), /generation_metadata\/raw -> 503/);
  await assert.rejects(client({ status: 200, data: { md5: "not-an-md5" } }).c.findGenerationByRawMd5(RAW), /-> 200/);
});

test("waitForUpload says WHICH way it failed: the booru's verdict (UPLOAD_ERROR) or a wait that ran out (UPLOAD_TIMEOUT)", async () => {
  // canon.js records the first as final and asks after the second, so the two
  // must never look alike.
  const refused = client({ status: 200, data: { id: 5, status: "error", error: "File type is not supported" } });
  await assert.rejects(() => refused.c.waitForUpload(5, { intervalMs: 1, timeoutMs: 50 }),
    (err) => err.code === "UPLOAD_ERROR" && err.uploadError === "File type is not supported" && !/SECRETKEY/.test(err.message));
  const slow = client({ status: 200, data: { id: 6, status: "processing" } });
  await assert.rejects(() => slow.c.waitForUpload(6, { intervalMs: 1, timeoutMs: 20 }), (err) => err.code === "UPLOAD_TIMEOUT");
  const done = client({ status: 200, data: { id: 7, status: "completed", upload_media_assets: [{ id: 70 }] } });
  assert.equal((await done.c.waitForUpload(7, { intervalMs: 1, timeoutMs: 50 })).upload_media_assets[0].id, 70);
});

// --- createPost against a booru that speaks HTTP ---------------------------------
//
// The stand-in client above cannot reproduce what axios does with a redirect,
// and that is the bug: 2026-10-02, three pictures whose booru posts were
// deleted failed every backfill sweep as a bare "Request failed with status
// code 404". The booru answers a duplicate md5 at POST /posts.json with a 302
// to the original post (chanbooru PostsController#create); axios followed it,
// and a deleted post's page answers 404 to everyone it is hidden from.

const http = require("node:http");
const { BooruDuplicate } = require("./danbooru");

async function booru(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stand-in");
    seen.push({ method: req.method, path: url.pathname, query: url.search });
    req.resume();
    req.on("end", () => {
      const out = (routes[`${req.method} ${url.pathname}`] || (() => [599, {}]))(server);
      res.writeHead(out[0], { "content-type": "application/json", ...(out[2] || {}) });
      res.end(JSON.stringify(out[1]));
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = new DanbooruClient({ url: base, username: "bot", api_key: "SECRETKEY" });
  return { c, seen, base, close: () => { server.close(); server.closeAllConnections(); } };
}

test("createPost: a duplicate's redirect is READ, not followed -- a BooruDuplicate naming the post, even one this account cannot see", async () => {
  const b = await booru({
    "POST /posts.json": (s) => [302, {}, { location: `http://127.0.0.1:${s.address().port}/posts/25` }],
    // A deleted post: hidden from this account, and answered exactly like a missing one.
    "GET /posts/25": () => [404, { success: false, message: "That record was not found." }],
    "GET /posts/25.json": () => [404, { success: false, message: "That record was not found." }],
  });
  try {
    await assert.rejects(b.c.createPost(11, { rating: "q", tagString: "1girl", source: "mxc://41chan.net/x" }), (err) => {
      assert.ok(err instanceof BooruDuplicate, `a BooruDuplicate, not ${err && err.name}: ${err && err.message}`);
      assert.equal(err.duplicateOf, 25);
      assert.equal(err.status, 302);
      assert.match(err.message, /^POST \/posts\.json -> 302: the booru already holds these bytes as post #25/);
      assert.doesNotMatch(err.message, /SECRETKEY|127\.0\.0\.1|api_key/);
      return true;
    });
    assert.deepEqual(b.seen.map((r) => `${r.method} ${r.path}`), ["POST /posts.json"], "the redirect was not followed");
    // And the post it names is looked up as THIS account sees it: hidden is null, not a throw.
    assert.equal(await b.c.findVisiblePost(25), null);
  } finally {
    b.close();
  }
});

test("createPost: a made post comes back; any other answer is a BooruRefusal naming POST /posts.json and the booru's reason", async () => {
  const b = await booru({
    "POST /posts.json": () => [201, { id: 42, md5: MD5 }],
    "GET /posts/42.json": () => [200, { id: 42, md5: MD5 }],
  });
  try {
    assert.equal((await b.c.createPost(11, { rating: "q" })).id, 42);
    assert.equal((await b.c.findVisiblePost(42)).id, 42);
    await assert.rejects(b.c.findVisiblePost(43), (err) => err instanceof BooruRefusal && /^GET \/posts\/43\.json -> 599/.test(err.message));
  } finally {
    b.close();
  }
  const refused = await booru({ "POST /posts.json": () => [422, { error: "Rating is not included in the list", fix: "send s, q or e" }] });
  try {
    await assert.rejects(refused.c.createPost(11, { rating: "x" }), (err) =>
      err instanceof BooruRefusal && !(err instanceof BooruDuplicate) && err.status === 422 &&
      err.message === "POST /posts.json -> 422: Rating is not included in the list -- fix: send s, q or e");
  } finally {
    refused.close();
  }
});
