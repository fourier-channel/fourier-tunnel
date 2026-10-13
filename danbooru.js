const axios = require("axios");

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class DanbooruClient {
  constructor(config) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.username = config.username;
    this.apiKey = config.api_key;
  }

  _client() {
    return axios.create({
      baseURL: this.baseUrl,
      params: {
        login: this.username,
        api_key: this.apiKey,
      },
      timeout: 30000,
    });
  }

  async createUpload(sourceUrl) {
    const resp = await this._client().post("/uploads.json", {
      upload: { source: sourceUrl },
    });
    return resp.data;
  }

  async createUploadFromBytes(buffer, filename, contentType) {
    const FormData = require("form-data");
    const form = new FormData();
    form.append("upload[files][0]", buffer, {
      filename: filename,
      contentType: contentType,
    });
    const resp = await this._client().post("/uploads.json", form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return resp.data;
  }

  // Look up an existing post by md5. Returns the post object, or null if none.
  // Used to skip re-uploading a duplicate image (Danbooru rejects a duplicate
  // md5 with a failed transaction / 500 on this fork's upload path).
  async findPostByMd5(md5) {
    const resp = await this._client().get("/posts.json", {
      params: { tags: `md5:${md5}`, limit: 1 },
      validateStatus: () => true,
    });
    if (resp.status === 200 && Array.isArray(resp.data) && resp.data.length > 0) {
      return resp.data[0];
    }
    return null;
  }

  async waitForUpload(uploadId, { intervalMs = 2000, timeoutMs = 120000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const resp = await this._client().get(`/uploads/${uploadId}.json`, {
        params: {
          login: this.username,
          api_key: this.apiKey,
          only: "id,status,error,upload_media_assets",
        },
      });
      const upload = resp.data;
      if (upload.status === "error") {
        // The booru looked at the file and said no. Tagged, so a caller can
        // tell this from a wait that ran out (canon.js records the first as
        // the booru's verdict and retries only the second).
        throw Object.assign(new Error(`Upload ${uploadId} failed: ${upload.error || "unknown error"}`), {
          code: "UPLOAD_ERROR",
          uploadError: upload.error || "unknown error",
        });
      }
      if (upload.status === "completed") {
        return upload;
      }
      await sleep(intervalMs);
    }
    throw Object.assign(new Error(`Upload ${uploadId} timed out after ${timeoutMs}ms`), { code: "UPLOAD_TIMEOUT" });
  }

  // Make a post from an upload's media asset. Returns the new post.
  //
  // A DUPLICATE IS NOT FOLLOWED. When a post already holds these bytes the
  // booru (PostsController#create, md5 taken) answers 302 to that post's page
  // instead of making one. Followed, that redirect is a GET of /posts/<id> with
  // no credentials, and a post this account may not see -- deleted, jailed --
  // answers it 404: three pictures failed the 2026-10-02 sweep as a bare
  // "Request failed with status code 404" that way, every run, because the
  // md5 lookup before it is withheld for such a post by design (chanbooru
  // "a deleted post does not exist"). So the redirect is read, not followed,
  // and thrown as a BooruDuplicate carrying the post id it names; any other
  // answer that is not a post throws a BooruRefusal naming POST /posts.json.
  async createPost(uploadMediaAssetId, { rating, tagString = "", source = "" }) {
    const resp = await this._client().post("/posts.json", {
      upload_media_asset_id: uploadMediaAssetId,
      post: {
        rating,
        tag_string: tagString,
        source,
      },
    }, { maxRedirects: 0, validateStatus: () => true });
    if ((resp.status === 200 || resp.status === 201) && resp.data && typeof resp.data === "object" && resp.data.id != null) return resp.data;
    const original = resp.status >= 300 && resp.status < 400 ? postIdFromLocation(resp.headers) : null;
    if (original != null) {
      throw new BooruDuplicate(
        `POST /posts.json -> ${resp.status}: the booru already holds these bytes as post #${original}, so no post was made`,
        resp.status, original,
      );
    }
    throw refusal("POST /posts.json", resp);
  }

  async getPost(postId) {
    const resp = await this._client().get(`/posts/${postId}.json`);
    return resp.data;
  }

  // A post as THIS account sees it: the post, or null when the booru answers
  // 404 -- no such post, or one hidden from this account (deleted, jailed),
  // which the booru answers identically on purpose. Anything else throws.
  // The booru's creator-prefix list (chanbooru /creator_prefixes.json, live
  // config there): the prefixes that are locked creator provenance, each with
  // its trailing underscore. A Discord server posts only under one of these.
  async creatorPrefixes() {
    const resp = await this._client().get("/creator_prefixes.json");
    const list = resp.data && Array.isArray(resp.data.prefixes) ? resp.data.prefixes : null;
    if (!list) throw new Error("the booru's /creator_prefixes.json carried no prefixes list");
    return list.map((e) => String(e.prefix));
  }

  async findVisiblePost(postId) {
    const resp = await this._client().get(`/posts/${postId}.json`, { validateStatus: () => true });
    if (resp.status === 404) return null;
    if (resp.status === 200 && resp.data && typeof resp.data === "object" && resp.data.id != null) return resp.data;
    throw refusal(`GET /posts/${postId}.json`, resp);
  }

  // Record the per-tag provenance partition on the booru (the single write path
  // for the tag hub). The booru stores it, marks creator-only tags private, and
  // returns the PUBLIC-SAFE projection to write into Matrix state.
  // partition = { creator, auto, both, meta } (arrays of tag strings).
  async recordTagSources(postId, partition) {
    const resp = await this._client().post(`/posts/${postId}/tag_sources.json`, partition);
    return resp.data; // { post_id, recorded, projection: { tags, sources } }
  }

  // Hand the booru the generation data strip-generation.js took out of an
  // image, to keep PRIVATELY: readable by the post's creator and whoever the
  // creator allows, never served (operator rulings 2026-09-28 and 2026-09-29).
  // Keyed by the md5 of the bytes the booru HOLDS -- the stripped ones -- and
  // upserted by it.
  //   rawMd5  the md5 of the bytes BEFORE the strip. The booru keeps the first
  //           one it is sent, and answers findGenerationByRawMd5 with it.
  //   source  "matrix" | "discord"
  //   poster  who sent these bytes (an MXID), or null for an admin's !rescan.
  //           The booru replaces an existing record's fields only when this
  //           equals the poster it already has, or is null; otherwise it
  //           answers 409 and changes nothing -- which is how a stranger's
  //           re-post of someone's picture is kept off their record.
  //   fields  { "png:parameters": "<original text>", "exif:UserComment": ..., ... }
  // The booru never echoes the text back and neither does this: an error names
  // the status and the booru's own { error, fix }, never a field and never the
  // URL, which carries the api_key in its query string. A refusal throws a
  // BooruRefusal carrying .status and the booru's machine-readable .reason, so
  // a caller can tell one 409 from another and either from a failure:
  //   poster_mismatch    a record from a different poster exists and stands
  //   raw_md5_conflict   this raw md5 is already filed under another md5;
  //                      nothing was written for this one
  //   raw_md5_mismatch   the record for this md5 names a different raw md5;
  //                      its fields were not replaced
  async recordGenerationMetadata(md5, { rawMd5, source, poster, fields }) {
    const resp = await this._client().post(
      "/fourier/generation_metadata.json",
      { md5, raw_md5: rawMd5 || null, source, poster: poster || null, fields },
      { validateStatus: () => true },
    );
    if (resp.status === 200 && resp.data && typeof resp.data === "object" && typeof resp.data.md5 === "string") return resp.data;
    throw refusal("generation_metadata", resp);
  }

  // Record who CREATED a post: the Matrix account whose event made it, once, at
  // creation (operator ruling 2026-09-29: the creator decides who sees a post's
  // private data). The booru never overwrites a recorded creator -- a different
  // one is a 409 -- because a post's tags are editable by any member and so
  // prove nothing about who made it; this record is the proof.
  async recordPostCreator(postId, mxid) {
    const resp = await this._client().post(
      `/fourier/posts/${postId}/creator.json`,
      { mxid },
      { validateStatus: () => true },
    );
    if (resp.status === 200 && resp.data && typeof resp.data === "object" && resp.data.mxid === mxid) return resp.data;
    if (resp.status === 200) throw new BooruRefusal(`posts/${postId}/creator -> 200 but the booru names ${JSON.stringify(resp.data && resp.data.mxid)}, not ${mxid}`, 200, {});
    throw refusal(`posts/${postId}/creator`, resp);
  }

  // The booru md5 of the post whose generation record was filed from these RAW
  // bytes, or null. This is how a re-post is recognised after the strip rules
  // change: md5(strip(raw)) moves with the rules, md5(raw) does not.
  async findGenerationByRawMd5(rawMd5) {
    const resp = await this._client().get(`/fourier/generation_metadata/raw/${rawMd5}.json`, { validateStatus: () => true });
    if (resp.status === 404) return null;
    if (resp.status === 200 && resp.data && typeof resp.data.md5 === "string" && /^[0-9a-f]{32}$/.test(resp.data.md5)) return resp.data.md5;
    throw refusal("generation_metadata/raw", resp);
  }

  // Fetch a post's PUBLIC-SAFE tag projection (used for a duplicate image whose
  // provenance is already recorded). Never includes private creator tags, and
  // never a flagged or banished name: the booru strips those for every caller
  // (chanbooru FourierTagSource.matrix_projection). null when the booru
  // answers 404 -- no such post, or one hidden from this account (deleted,
  // jailed, or flagged and uploaded by another bot), answered identically on
  // purpose. Anything else throws, so a caller can tell "hidden" from "could
  // not find out".
  async getTagProjection(postId) {
    const resp = await this._client().get(`/posts/${postId}/tag_sources.json`, {
      params: { scope: "public" },
      validateStatus: () => true,
    });
    if (resp.status === 200 && resp.data && Array.isArray(resp.data.tags)) return resp.data;
    if (resp.status === 404) return null;
    throw refusal(`GET /posts/${postId}/tag_sources.json`, resp);
  }

  // THE QUARANTINE DOCUMENT: the booru's flagged and banished tag names and
  // every post carrying one (chanbooru GET /fourier_jail/release.json
  // ?quarantine=1, read by the accounts in Danbooru.config
  // .fourier_quarantine_reader_names). The tunnel must never write one of
  // those names into a room's tag state (operator rulings 2026-10-12).
  //
  // Resolves { status: "ok", doc: { generation, flagged, banished, posts },
  // etag } or, when `ifNoneMatch` is the etag of the set the booru still has,
  // { status: "not-modified" }. Throws QuarantineUnreadable for every way of
  // not finding out -- never an empty document, which would read as "nothing
  // is quarantined". A snapshot, paged by post id: a page whose generation
  // differs from page 1's means the set moved under the read, which restarts
  // from page 1, at most QUARANTINE_RESTARTS times.
  //
  // The credentials go in an Authorization header, not the query string the
  // rest of this client uses, so no URL here ever carries the api key.
  async getQuarantine({ ifNoneMatch } = {}) {
    for (let attempt = 0; attempt <= QUARANTINE_RESTARTS; attempt += 1) {
      const first = await this._quarantinePage(null, ifNoneMatch);
      if (first === NOT_MODIFIED) return { status: "not-modified" };
      const { generation, flagged, banished } = first.body;
      const posts = [...first.body.posts];
      let next = first.body.next_after;
      let moved = false;
      while (next != null) {
        const last = posts.length ? posts[posts.length - 1].id : 0;
        if (!Number.isInteger(next) || next < last) {
          throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: the paging did not move forward (next_after ${JSON.stringify(next)} after post #${last}); the booru's document is broken -- check chanbooru TagQuarantine.document`);
        }
        const page = await this._quarantinePage(next, undefined);
        if (page === NOT_MODIFIED || page.body.generation !== generation) { moved = true; break; }
        if (page.body.posts.length && page.body.posts[0].id <= last) {
          throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: the paging did not move forward (page after #${next} began at #${page.body.posts[0].id}); the booru's document is broken -- check chanbooru TagQuarantine.document`);
        }
        posts.push(...page.body.posts);
        next = page.body.next_after;
      }
      if (!moved) return { status: "ok", etag: first.etag, doc: { generation, flagged, banished, posts } };
    }
    throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: the quarantine set changed while it was being read, ${QUARANTINE_RESTARTS + 1} times running; the next poll reads it again`);
  }

  async _quarantinePage(after, ifNoneMatch) {
    let resp;
    try {
      resp = await this._raw().get("/fourier_jail/release.json", {
        params: after == null ? { quarantine: 1 } : { quarantine: 1, after },
        headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
        maxRedirects: 0,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: the booru did not answer (${err.code || err.message})`);
    }
    if (resp.status === 304) return NOT_MODIFIED;
    if (resp.status === 401 || resp.status === 403) {
      // The booru's own sentence names the fix that applies (a listed reader
      // still at Member is told to have it promoted); ours lists the usual ones.
      const said = resp.data && typeof resp.data.message === "string" && resp.data.message ? `; the booru says: ${resp.data.message}` : "";
      throw new QuarantineUnreadable(`${QUARANTINE_WHAT} -> ${resp.status}: this account is not in Danbooru.config.fourier_quarantine_reader_names, or its api key is wrong${said}`);
    }
    if (resp.status !== 200) throw new QuarantineUnreadable(refusal(QUARANTINE_WHAT, resp).message);
    const body = resp.data;
    if (!body || typeof body !== "object" || typeof body.generation !== "string" || !Array.isArray(body.posts)) {
      throw new QuarantineUnreadable(`the booru is older than the quarantine build (no generation/posts in ${QUARANTINE_WHAT}) -- deploy chanbooru`);
    }
    // The names reach a pipeline account alone. The tunnel strips them, so
    // without them it cannot do its job, and says so.
    if (!Array.isArray(body.flagged) || !Array.isArray(body.banished) || ![...body.flagged, ...body.banished].every((n) => typeof n === "string")) {
      throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: the booru sent this account no names (flagged/banished not lists), so it does not count it as a pipeline account (chanbooru TagBanishment.pipeline?) and the tunnel cannot strip quarantined names -- the tunnel's booru account must be one of the pipeline accounts`);
    }
    const bad = body.posts.find((p) => !p || !Number.isInteger(p.id) || !(p.mxc === null || typeof p.mxc === "string"));
    if (bad !== undefined) {
      throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: a post the tunnel cannot read (${JSON.stringify(bad).slice(0, 120)}); the booru's document is broken -- check chanbooru TagQuarantine.document`);
    }
    if (!(body.next_after === null || body.next_after === undefined || Number.isInteger(body.next_after))) {
      throw new QuarantineUnreadable(`${QUARANTINE_WHAT}: next_after is ${JSON.stringify(body.next_after)}, not a post id or null`);
    }
    const etag = resp.headers && (typeof resp.headers.get === "function" ? resp.headers.get("etag") : resp.headers.etag);
    return { body: { ...body, next_after: body.next_after ?? null }, etag: typeof etag === "string" ? etag : null };
  }

  // The booru with the credentials in a Basic header and none in the URL.
  _raw() {
    return axios.create({
      baseURL: this.baseUrl,
      auth: { username: this.username, password: this.apiKey },
      timeout: 30000,
    });
  }

  // Find a tag by exact name. undefined when it does not exist yet.
  async findTag(name) {
    const resp = await this._client().get("/tags.json", {
      params: { "search[name]": name, limit: 1 },
      validateStatus: () => true,
    });
    if (resp.status !== 200 || !Array.isArray(resp.data) || !resp.data.length) return undefined;
    return resp.data[0];
  }

  // Put a tag in its proper category. Idempotent; "missing" when the tag does
  // not exist yet, which is not an error -- creating the artist entry will
  // mint it in the right category.
  async setTagCategory(name, category) {
    const tag = await this.findTag(name);
    if (!tag) return "missing";
    if (tag.category === category) return "already";
    await this._client().put(`/tags/${tag.id}.json`, { tag: { category } }, { validateStatus: () => true });
    return "set";
  }

  // Create an artist entry, which is what makes its tag category 1. Setting
  // Tag#category alone would colour the tag without creating the entity the
  // booru expects behind it. Already-exists comes back 422 and is success.
  async ensureArtist(name) {
    await this._client().post("/artists.json", { artist: { name } }, { validateStatus: () => true });
  }

  async updateTags(postId, newTagString, oldTagString = "") {
    const resp = await this._client().put(`/posts/${postId}.json`, {
      post: {
        tag_string: newTagString,
        old_tag_string: oldTagString,
      },
    });
    return resp.data;
  }
}

const QUARANTINE_WHAT = "GET /fourier_jail/release.json?quarantine=1";
const QUARANTINE_RESTARTS = 3;
const NOT_MODIFIED = Symbol("not-modified");

// The quarantine document could not be read: the booru is down, older than the
// quarantine build, refuses this account, or sent something that is not the
// document. The message is the reason and its remedy.
class QuarantineUnreadable extends Error {
  constructor(message) {
    super(message);
    this.name = "QuarantineUnreadable";
  }
}

// A booru answer that is not success, told by its status and, where the booru
// gives one, its machine-readable `reason`. The message names the endpoint,
// the status, the reason and the booru's own { error, fix } -- never a field
// and never the URL.
class BooruRefusal extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "BooruRefusal";
    this.status = status;
    this.error = body && body.error;
    this.fix = body && body.fix;
    this.reason = body && typeof body.reason === "string" ? body.reason : undefined;
  }
}
// The booru declined to make a post because one already holds these bytes.
// `duplicateOf` is the post its redirect named -- which may be one this
// account cannot see.
class BooruDuplicate extends BooruRefusal {
  constructor(message, status, postId) {
    super(message, status, { reason: "duplicate" });
    this.name = "BooruDuplicate";
    this.duplicateOf = postId;
  }
}

// The post id in a redirect's Location (/posts/<id>, absolute or not, with or
// without .json), or null. Only the path is read, and none of it is logged.
function postIdFromLocation(headers) {
  const loc = headers && (typeof headers.get === "function" ? headers.get("location") : headers.location);
  if (typeof loc !== "string") return null;
  let pathname;
  try {
    pathname = new URL(loc, "http://booru.invalid").pathname;
  } catch {
    return null;
  }
  const m = /^\/posts\/(\d+)(?:\.json)?$/.exec(pathname);
  return m ? Number(m[1]) : null;
}

function refusal(what, resp) {
  const body = resp.data && typeof resp.data === "object" ? resp.data : {};
  const why = [body.error, body.fix && `fix: ${body.fix}`].filter(Boolean).join(" -- ");
  const reason = typeof body.reason === "string" && /^[a-z0-9_]{1,64}$/.test(body.reason) ? ` (${body.reason})` : "";
  return new BooruRefusal(`${what} -> ${resp.status}${reason}${why ? `: ${why}` : ": the booru gave no reason"}`, resp.status, body);
}

module.exports = { DanbooruClient, BooruRefusal, BooruDuplicate, QuarantineUnreadable, sleep };
