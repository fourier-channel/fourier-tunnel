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
  const stub = (auth) => () => ({
    post: (url, body, opts) => answer("POST", url, body, { ...opts, auth }),
    get: (url, opts) => answer("GET", url, undefined, { ...opts, auth }),
  });
  // Which door a call used is recorded: "key" puts the api_key in the query
  // string, "basic" carries it in a header.
  c._client = stub("key");
  c._raw = stub("basic");
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
    seen.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers });
    req.resume();
    req.on("end", () => {
      const out = (routes[`${req.method} ${url.pathname}`] || (() => [599, {}]))(server, req, url);
      res.writeHead(out[0], { "content-type": "application/json", ...(out[2] || {}) });
      res.end(out[0] === 304 ? undefined : JSON.stringify(out[1]));
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

// --- THE QUARANTINE DOCUMENT (chanbooru GET /fourier_jail/release.json?quarantine=1) ---
//
// The booru's flagged and banished tags, and every post carrying one, read as
// the tunnel's own account. A snapshot, paged by post id; every page carries
// the whole set's generation, and a page whose generation differs means the
// set moved under the read, which restarts from page 1 (at most 3 times).

const { QuarantineUnreadable } = require("./danbooru");
const GEN = "0123456789abcdef";
const qpost = (id, extra = {}) => ({ id, md5: id.toString(16).padStart(32, "0"), mxc: `mxc://41chan.net/m${id}`, flagged: true, banished: false, ...extra });

test("quarantine: one page read whole -- the names, the posts, the etag -- with the credentials in a header, never the URL", async () => {
  const b = await booru({
    "GET /fourier_jail/release.json": () => [200, { generation: GEN, flagged: ["secret_tag"], banished: ["gross"], posts: [qpost(1), qpost(2, { mxc: null })], next_after: null }, { etag: `"${GEN}-n"` }],
  });
  try {
    const r = await b.c.getQuarantine();
    assert.equal(r.status, "ok");
    assert.equal(r.etag, `"${GEN}-n"`);
    assert.deepEqual(r.doc, { generation: GEN, flagged: ["secret_tag"], banished: ["gross"], posts: [qpost(1), qpost(2, { mxc: null })] });
    assert.equal(b.seen.length, 1);
    assert.equal(b.seen[0].query, "?quarantine=1");
    assert.ok(!/SECRETKEY|login|api_key/.test(b.seen[0].query), "no credentials in the URL");
    assert.equal(b.seen[0].headers.authorization, `Basic ${Buffer.from("bot:SECRETKEY").toString("base64")}`);
    assert.equal(b.seen[0].headers["if-none-match"], undefined, "nothing to match on a first read");
  } finally {
    b.close();
  }
});

test("quarantine: pages are followed by next_after; a 304 to If-None-Match is not-modified, not an empty set", async () => {
  const b = await booru({
    "GET /fourier_jail/release.json": (s, req, url) => {
      if (req.headers["if-none-match"] === `"${GEN}-n"`) return [304, null];
      const after = url.searchParams.get("after");
      if (!after) return [200, { generation: GEN, flagged: ["a"], banished: [], posts: [qpost(1), qpost(2)], next_after: 2 }, { etag: `"${GEN}-n"` }];
      return [200, { generation: GEN, flagged: ["a"], banished: [], posts: [qpost(3)], next_after: null }, { etag: `"${GEN}-n"` }];
    },
  });
  try {
    const r = await b.c.getQuarantine();
    assert.deepEqual(r.doc.posts.map((p) => p.id), [1, 2, 3]);
    assert.deepEqual(b.seen.map((x) => x.query), ["?quarantine=1", "?quarantine=1&after=2"]);
    const again = await b.c.getQuarantine({ ifNoneMatch: r.etag });
    assert.deepEqual(again, { status: "not-modified" });
  } finally {
    b.close();
  }
});

test("quarantine: a generation that moves between pages restarts from page 1, and after 3 restarts the read is UNREADABLE", async () => {
  let n = 0;
  const moving = await booru({
    "GET /fourier_jail/release.json": (s, req, url) => {
      n += 1;
      const g = url.searchParams.get("after") ? "ffffffffffffffff" : GEN;
      return [200, { generation: g, flagged: [], banished: ["a"], posts: [qpost(n)], next_after: url.searchParams.get("after") ? null : 99 }];
    },
  });
  try {
    await assert.rejects(moving.c.getQuarantine(), (err) => err instanceof QuarantineUnreadable && /changed while it was being read/.test(err.message));
    assert.equal(moving.seen.filter((x) => x.query === "?quarantine=1").length, 4, "the first read and 3 restarts");
  } finally {
    moving.close();
  }
  let first = true;
  const settles = await booru({
    "GET /fourier_jail/release.json": (s, req, url) => {
      if (!url.searchParams.get("after")) return [200, { generation: GEN, flagged: [], banished: ["a"], posts: [qpost(1)], next_after: 1 }];
      if (first) { first = false; return [200, { generation: "ffffffffffffffff", flagged: [], banished: ["a"], posts: [qpost(2)], next_after: null }]; }
      return [200, { generation: GEN, flagged: [], banished: ["a"], posts: [qpost(2)], next_after: null }];
    },
  });
  try {
    const r = await settles.c.getQuarantine();
    assert.deepEqual(r.doc.posts.map((p) => p.id), [1, 2], "the restart read the set once, whole");
  } finally {
    settles.close();
  }
});

test("quarantine: an older booru, a refused account, no names, or a broken page is UNREADABLE with its remedy -- never an empty set", async () => {
  const cases = [
    // An older booru answers the tunnel 403 (jail panel only), and sample the jail-events body.
    [[200, { events: [], next_since: null }], /the booru is older than the quarantine build \(no generation\/posts in GET \/fourier_jail\/release\.json\?quarantine=1\) -- deploy chanbooru/],
    [[200, "<html>a proxy page</html>"], /the booru is older than the quarantine build/],
    [[403, { success: false, message: "the quarantine document is read by fourier_quarantine_reader_names alone" }], /-> 403: this account is not in Danbooru\.config\.fourier_quarantine_reader_names, or its api key is wrong/],
    [[401, { success: false, message: "x" }], /-> 401: this account is not in Danbooru\.config\.fourier_quarantine_reader_names/],
    // The booru's own sentence names the fix that applies: a listed reader still
    // at Member is told to have it promoted (reader hardening, 2026-10-12).
    [[403, { success: false, message: "tunnel is on fourier_quarantine_reader_names but is Member: an admin promotes it (Gold or above) at /admin/users/7/edit" }], /-> 403: .*the booru says: tunnel is on fourier_quarantine_reader_names but is Member.*\/admin\/users\/7\/edit/],
    [[200, { generation: GEN, flagged: null, banished: null, posts: [], next_after: null }], /no names.*TagBanishment\.pipeline\?/],
    [[200, { generation: GEN, flagged: [], banished: [], posts: [{ id: "x" }], next_after: null }], /a post the tunnel cannot read/],
    [[500, { error: "boom" }], /-> 500/],
  ];
  for (const [reply, re] of cases) {
    const b = await booru({ "GET /fourier_jail/release.json": () => reply });
    try {
      await assert.rejects(b.c.getQuarantine(), (err) => {
        assert.ok(err instanceof QuarantineUnreadable, `${err && err.name}: ${err && err.message}`);
        assert.match(err.message, re);
        assert.ok(!/SECRETKEY/.test(err.message));
        return true;
      });
    } finally {
      b.close();
    }
  }
});

test("quarantine: a page that does not move forward is unreadable, not an endless loop", async () => {
  const b = await booru({
    "GET /fourier_jail/release.json": () => [200, { generation: GEN, flagged: [], banished: ["a"], posts: [qpost(5)], next_after: 5 }],
  });
  try {
    await assert.rejects(b.c.getQuarantine(), (err) => err instanceof QuarantineUnreadable && /did not move forward/.test(err.message));
  } finally {
    b.close();
  }
});

test("tag projection: the booru's projection; null when the booru answers 404 (hidden from this account); anything else THROWS", async () => {
  const b = await booru({
    "GET /posts/1/tag_sources.json": () => [200, { tags: ["a"], sources: { creator: [], auto: ["a"], both: [], meta: [] } }],
    "GET /posts/2/tag_sources.json": () => [404, { success: false, message: "That record was not found." }],
    "GET /posts/3/tag_sources.json": () => [500, { error: "boom" }],
  });
  try {
    assert.deepEqual((await b.c.getTagProjection(1)).tags, ["a"]);
    assert.equal(await b.c.getTagProjection(2), null);
    await assert.rejects(b.c.getTagProjection(3), (err) => err instanceof BooruRefusal && err.status === 500);
  } finally {
    b.close();
  }
});

// --- GATE 3: THE MXC REPORT (GATE3_CONTRACTS B) ------------------------------------
//
// POST /posts/:id/tag_sources.json with a body carrying ONLY {"mxc": ...};
// the booru answers {"mxc":{"accepted":bool,"reason"?}}. A Basic header, never
// the key in the URL, and an error names the path, never the URL.

test("mxc report: the body carries ONLY the mxc, the key rides in a Basic header and nowhere in the URL; the verdict comes back", async () => {
  const bodies = [];
  const b = await booru({
    "POST /posts/7/tag_sources.json": () => [200, { mxc: { accepted: true } }],
    "POST /posts/8/tag_sources.json": () => [200, { mxc: { accepted: false, reason: "mxc_mapped_elsewhere" } }],
  });
  const raw = b.c._raw.bind(b.c);
  b.c._raw = () => { const ax = raw(); const post = ax.post.bind(ax); ax.post = (u, body, o) => { bodies.push(body); return post(u, body, o); }; return ax; };
  try {
    assert.deepEqual(await b.c.reportMxcAlias(7, "mxc://41chan.net/a"), { accepted: true });
    assert.deepEqual(await b.c.reportMxcAlias(8, "mxc://41chan.net/b"), { accepted: false, reason: "mxc_mapped_elsewhere" });
    assert.deepEqual(bodies, [{ mxc: "mxc://41chan.net/a" }, { mxc: "mxc://41chan.net/b" }]);
    for (const r of b.seen) {
      assert.equal(r.query, "", "no query string at all");
      assert.equal(r.headers.authorization, `Basic ${Buffer.from("bot:SECRETKEY").toString("base64")}`);
    }
  } finally {
    b.close();
  }
});

test("mxc report: an answer that is not a verdict THROWS -- an older booru's 200, a 404, a 5xx -- naming the path, never the URL or the key", async () => {
  const b = await booru({
    "POST /posts/1/tag_sources.json": () => [200, { post_id: 1, recorded: 0, projection: { tags: [] } }],
    "POST /posts/2/tag_sources.json": () => [404, { success: false, message: "That record was not found." }],
    "POST /posts/3/tag_sources.json": () => [503, { error: "down", fix: "wait" }],
    "POST /posts/4/tag_sources.json": () => [200, { mxc: { accepted: false } }],
  });
  try {
    await assert.rejects(b.c.reportMxcAlias(1, "mxc://41chan.net/a"), (err) => err instanceof BooruRefusal && err.status === 200 && err.reason === "no_mxc_verdict" &&
      /^POST \/posts\/1\/tag_sources\.json \(mxc\) -> 200 but the answer carries no mxc verdict: .*deploy chanbooru/.test(err.message));
    await assert.rejects(b.c.reportMxcAlias(2, "mxc://41chan.net/a"), (err) => err instanceof BooruRefusal && err.status === 404);
    await assert.rejects(b.c.reportMxcAlias(3, "mxc://41chan.net/a"), (err) => err instanceof BooruRefusal && err.status === 503 && err.message === "POST /posts/3/tag_sources.json (mxc) -> 503: down -- fix: wait");
    await assert.rejects(b.c.reportMxcAlias(4, "mxc://41chan.net/a"), (err) => err.reason === "no_mxc_verdict", "a refusal with no reason is not a verdict");
  } finally {
    b.close();
  }
  // Nobody answering: the path and the code, never the host and port.
  const gone = new DanbooruClient({ url: "http://127.0.0.1:9", username: "bot", api_key: "SECRETKEY" });
  await assert.rejects(gone.reportMxcAlias(5, "mxc://41chan.net/a"), (err) =>
    /^POST \/posts\/5\/tag_sources\.json \(mxc\): the booru did not answer \(E[A-Z]+\)$/.test(err.message) && !/SECRETKEY|127\.0\.0\.1/.test(err.message));
});

test("the raw-md5 lookup: Basic header, no key in the URL -- it runs once per image in the backfill tool, and the bridge's duplicate check makes it too", async () => {
  const b = await booru({
    [`GET /fourier/generation_metadata/raw/${RAW}.json`]: () => [200, { md5: MD5 }],
    [`GET /fourier/generation_metadata/raw/${MD5}.json`]: () => [404, { error: "no record", fix: "none" }],
  });
  try {
    assert.equal(await b.c.findGenerationByRawMd5(RAW), MD5);
    assert.equal(await b.c.findGenerationByRawMd5(MD5), null);
    assert.equal(b.seen.length, 2);
    for (const r of b.seen) {
      assert.equal(r.query, "", "no query string at all");
      assert.equal(r.headers.authorization, `Basic ${Buffer.from("bot:SECRETKEY").toString("base64")}`);
    }
  } finally {
    b.close();
  }
});

test("the create path's tag_sources write: Basic header, no key in the URL, and the mxc it carries comes back as the booru's verdict", async () => {
  const b = await booru({ "POST /posts/42/tag_sources.json": () => [200, { post_id: 42, recorded: 1, projection: { tags: [] }, mxc: { accepted: true } }] });
  try {
    const out = await b.c.recordTagSources(42, { creator: [], auto: [], both: [], meta: [], mxc: "mxc://41chan.net/a" });
    assert.deepEqual(out.mxc, { accepted: true });
    assert.equal(b.seen[0].query, "");
    assert.equal(b.seen[0].headers.authorization, `Basic ${Buffer.from("bot:SECRETKEY").toString("base64")}`);
  } finally {
    b.close();
  }
});
