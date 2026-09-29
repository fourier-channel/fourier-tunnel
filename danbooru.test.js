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
