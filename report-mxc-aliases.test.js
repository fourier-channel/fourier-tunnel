"use strict";

// tools/report-mxc-aliases.js: gate 3's backfill of (post_id, mxc) from
// canon's index (index/local/<mediaId>.json -> md5 -> post), against fakes.
// What it must never do: send in a dry run, count "the booru could not say"
// as "no post", or carry on past a booru that is down or refuses it.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { walk, booruLookups } = require("./tools/report-mxc-aliases");
const { BooruRefusal, DanbooruClient } = require("./danbooru");

const h = (c) => c.repeat(32);
const ENTRIES = {
  "index/local/aaaaa1.json": { kind: "canonical", md5: h("a"), raw_md5: h("b") },   // a post under its stripped md5
  "index/local/aaaaa2.json": { kind: "canonical", md5: h("c"), raw_md5: h("d") },   // a post under its raw md5
  "index/local/aaaaa3.json": { kind: "canonical", md5: h("e"), raw_md5: h("e") },   // no post: an avatar, say
  "index/local/aaaaa4.json": { kind: "source", raw_md5: h("f") },                   // a webm: nothing posted
  "index/local/aaaaa5.json": { kind: "refused", reason: "x" },
};
const POSTS = { [h("a")]: { id: 11, md5: h("a") }, [h("d")]: { id: 12, md5: h("d") } };

function run(over = {}) {
  const lines = [];
  const sent = [];
  const keys = Object.keys(ENTRIES);
  const deps = {
    // Two pages, to prove the walk follows them and resumes after a key.
    listPage: async (after) => {
      const rest = after ? keys.filter((k) => k > after) : keys;
      return { keys: rest.slice(0, 3), more: rest.length > 3 };
    },
    readIndex: async (key) => Buffer.from(JSON.stringify(ENTRIES[key])),
    findPostByMd5: async (md5) => POSTS[md5] || null,
    findByRawMd5: async () => null,
    reportMxcAlias: async (postId, mxc) => { sent.push([postId, mxc]); return { accepted: true }; },
    domain: "41chan.net", apply: false, paceMs: 0, sleep: async () => {},
    out: (l) => lines.push(l),
    ...over,
  };
  return walk(deps).then((s) => ({ s, lines, sent }));
}

test("a dry run lists every canonical image whose bytes are a post, by the live path's three lookups -- and sends NOTHING", async () => {
  const { s, lines, sent } = await run();
  assert.deepEqual(lines, ["ALIAS\t11\tmxc://41chan.net/aaaaa1\tstripped", "ALIAS\t12\tmxc://41chan.net/aaaaa2\traw"]);
  assert.deepEqual(sent, []);
  assert.deepEqual([s.listed, s.canonical, s.nopost, s.aliases, s.errors, s.stopped], [5, 3, 1, 2, 0, false]);
  assert.deepEqual(s.otherKinds, { source: 1, refused: 1 });
  assert.equal(s.last, "index/local/aaaaa5.json");
});

test("--apply sends each as the live path does; a drop is said, and --start-after resumes past what was done", async () => {
  const { s, lines, sent } = await run({ apply: true, reportMxcAlias: async (postId, mxc) => { return postId === 12 ? { accepted: false, reason: "mxc_mapped_elsewhere" } : { accepted: true }; } });
  assert.deepEqual(lines, ["ALIAS\t11\tmxc://41chan.net/aaaaa1\tstripped\taccepted", "DROP\t12\tmxc://41chan.net/aaaaa2\tmxc_mapped_elsewhere"]);
  assert.deepEqual([s.accepted, s.dropped], [1, 1]);
  assert.deepEqual(sent, []);
  const resumed = await run({ apply: true, startAfter: "index/local/aaaaa1.json" });
  assert.deepEqual(resumed.sent, [[12, "mxc://41chan.net/aaaaa2"]]);
});

test("a lookup the booru could not answer STOPS the run at the last key done -- never counted as no post", async () => {
  const { s, lines } = await run({
    findPostByMd5: async (md5) => {
      if (md5 === h("c")) throw Object.assign(new Error("GET /posts.json (md5 lookup) -> 503"), { lookup: true });
      return POSTS[md5] || null;
    },
  });
  assert.equal(s.stopped, true);
  assert.equal(s.nopost, 0);
  assert.equal(s.last, "index/local/aaaaa1.json");
  assert.match(lines[lines.length - 1], /^STOP\tindex\/local\/aaaaa2\.json\tGET \/posts\.json \(md5 lookup\) -> 503; .*resume with --start-after index\/local\/aaaaa1\.json/);
});

test("a booru that is down or predates gate 3 stops an --apply run; a 404 is kept and the run goes on; one bad entry is an ERR, not a stop", async () => {
  const down = await run({ apply: true, reportMxcAlias: async () => { throw new BooruRefusal("POST /posts/11/tag_sources.json (mxc) -> 503", 503, {}); } });
  assert.equal(down.s.stopped, true);
  assert.equal(down.s.last, null, "nothing done: resume from the start");
  assert.match(down.lines[0], /^STOP\t.*wait for it; resume with --start-after \(omit\)$/);
  const old = await run({ apply: true, reportMxcAlias: async () => { throw new BooruRefusal("x -> 200 but the answer carries no mxc verdict", 200, { reason: "no_mxc_verdict" }); } });
  assert.match(old.lines[0], /deploy chanbooru/);
  const hidden = await run({ apply: true, reportMxcAlias: async (postId) => { if (postId === 11) throw new BooruRefusal("x -> 404", 404, {}); return { accepted: true }; } });
  assert.deepEqual([hidden.s.kept, hidden.s.accepted, hidden.s.stopped], [1, 1, false]);
  const bad = await run({ readIndex: async (key) => (key.endsWith("aaaaa1.json") ? Buffer.from("{ half") : Buffer.from(JSON.stringify(ENTRIES[key]))) });
  assert.equal(bad.s.errors, 1);
  assert.equal(bad.s.aliases, 1, "the rest still walked");
});

test("the tool's lookups as main() wires them: the key in a Basic header and NEVER in a URL, and a booru that cannot answer is a STOP, not no post", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stand-in");
    seen.push({ path: url.pathname, query: url.search, authorization: req.headers.authorization });
    req.resume();
    const [status, body] =
      url.pathname === "/posts.json" ? (url.searchParams.get("tags") === `md5:${h("a")}` ? [200, [{ id: 11, md5: h("a") }]] : [200, []]) :
      url.pathname === `/fourier/generation_metadata/raw/${h("b")}.json` ? [200, { md5: h("a") }] :
      url.pathname === `/fourier/generation_metadata/raw/${h("e")}.json` ? [503, { error: "down" }] :
      [404, { error: "no record" }];
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const l = booruLookups(new DanbooruClient({ url: `http://127.0.0.1:${server.address().port}`, username: "tunnel", api_key: "SECRETKEY" }));
    assert.deepEqual(await l.findPostByMd5(h("a")), { id: 11, md5: h("a") });
    assert.equal(await l.findPostByMd5(h("c")), null);
    assert.equal(await l.findByRawMd5(h("b")), h("a"));
    assert.equal(await l.findByRawMd5(h("d")), null);
    await assert.rejects(l.findByRawMd5(h("e")), (err) => err.lookup === true && /raw-md5 lookup\): generation_metadata\/raw -> 503/.test(err.message));
    assert.equal(seen.length, 5);
    for (const r of seen) {
      assert.equal(r.query.includes("SECRETKEY") || r.query.includes("api_key"), false, `${r.path}${r.query}`);
      assert.equal(r.authorization, `Basic ${Buffer.from("tunnel:SECRETKEY").toString("base64")}`, r.path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
  const gone = booruLookups(new DanbooruClient({ url: "http://127.0.0.1:9", username: "tunnel", api_key: "SECRETKEY" }));
  await assert.rejects(gone.findByRawMd5(h("b")), (err) => err.lookup === true && /the booru did not answer \(E[A-Z]+\)$/.test(err.message) && !/SECRETKEY/.test(err.message));
});
