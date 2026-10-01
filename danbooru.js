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

  async createPost(uploadMediaAssetId, { rating, tagString = "", source = "" }) {
    const resp = await this._client().post("/posts.json", {
      upload_media_asset_id: uploadMediaAssetId,
      post: {
        rating,
        tag_string: tagString,
        source,
      },
    });
    return resp.data;
  }

  async getPost(postId) {
    const resp = await this._client().get(`/posts/${postId}.json`);
    return resp.data;
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
  // provenance is already recorded). Never includes private creator tags.
  async getTagProjection(postId) {
    const resp = await this._client().get(`/posts/${postId}/tag_sources.json`, {
      params: { scope: "public" },
      validateStatus: () => true,
    });
    if (resp.status === 200 && resp.data && Array.isArray(resp.data.tags)) return resp.data;
    return null;
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
function refusal(what, resp) {
  const body = resp.data && typeof resp.data === "object" ? resp.data : {};
  const why = [body.error, body.fix && `fix: ${body.fix}`].filter(Boolean).join(" -- ");
  const reason = typeof body.reason === "string" && /^[a-z0-9_]{1,64}$/.test(body.reason) ? ` (${body.reason})` : "";
  return new BooruRefusal(`${what} -> ${resp.status}${reason}${why ? `: ${why}` : ": the booru gave no reason"}`, resp.status, body);
}

module.exports = { DanbooruClient, BooruRefusal, sleep };
