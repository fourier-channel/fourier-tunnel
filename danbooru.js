const axios = require("axios");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        throw new Error(`Upload ${uploadId} failed: ${upload.error || "unknown error"}`);
      }
      if (upload.status === "completed") {
        return upload;
      }
      await sleep(intervalMs);
    }
    throw new Error(`Upload ${uploadId} timed out after ${timeoutMs}ms`);
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

module.exports = { DanbooruClient, sleep };
