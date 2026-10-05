"use strict";

const { BooruDuplicate, BooruRefusal } = require("./danbooru");
const { stripGeneration } = require("./strip-generation");
const imagePlan = require("./image-plan");
const poster = require("./poster");
const { Transient, ChannelRefused } = require("./discordAcquire");

// POSTING A DISCORD IMAGE THE WAY A MATRIX IMAGE IS POSTED.
//
// Operator ruling 2026-10-04: "Tunnel can parse and post the images exactly the
// same way she does it on Matrix and the images will automatically be
// segregated." The segregation is the creator tag (poster.js): a Discord post
// carries <guild prefix>_<username>, aichan_<username> for the AIchan Discord,
// and every post has one, so provenance needs no other flag.
//
// So this is index.js handleImageEvent with the Matrix-only steps left out and
// nothing else changed: the same planImage (strip, prompt scrape, duplicate
// check by stripped and raw md5), the same upload, the same autotag, the same
// public tag list, the same single tag-hub write. Left out, each for a reason:
//
//   - canon.js. It makes a SYNAPSE file canonical; a Discord attachment is not
//     on this homeserver. The booru's upload is the one copy.
//   - recordPostCreator. A creator record names a Matrix account, and a
//     Discord author has none until they claim the tag. With no record the
//     post's private data is visible to nobody, the documented safe direction.
//   - the Matrix tag state event. Discord has nothing keyed and updatable to
//     write tags back into.
//
// Generation data, which canon.js files for a Matrix image, is filed here
// instead, after the post exists: source "discord", poster "discord:<user id>",
// both of which the booru's endpoint already accepts.

/** What the Matrix path posts: images. Video and documents are refused there too. */
const POSTABLE = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function extOf(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  return dot < 0 ? "" : String(filename).slice(dot).toLowerCase();
}

/**
 * The booru deliverer for discordAcquire.acquireOnce.
 *
 * deps: { danbooru, autotag, extractCreatorTagsFromFields, categoriseArtist,
 *         config, prefixFor(guildId) -> prefix|null, creatorFor(author) -> name, log }
 */
function booruDeliverer(deps) {
  // The caller labels the lines: the service prefixes "[discord] " itself.
  const log = deps.log || ((m) => console.log(`[discord] ${m}`));
  return {
    name: "booru",
    async prepare() {},
    accepts(att) {
      const ext = extOf(att.filename);
      if (!POSTABLE.has(ext)) {
        return `${JSON.stringify(att.filename)} (${att.content_type || "no declared type"}) is not an image; the tunnel posts images only, as it does from Matrix`;
      }
      return null;
    },
    async deliver({ channel, msg, att, bytes }) {
      return postAttachment({ ...deps, log }, { channel, msg, att, bytes });
    },
  };
}

async function postAttachment(deps, { channel, msg, att, bytes }) {
  const { danbooru, log } = deps;
  const author = msg.author || {};
  if (author.bot) return { refused: `message ${msg.id} was sent by a bot or webhook, which is not a creator; every post needs a person behind it` };

  const prefix = deps.prefixFor(channel.guild_id);
  if (!prefix) {
    throw new ChannelRefused(
      `no creator prefix is configured for guild ${channel.guild_id}, so nothing from channel ${channel.id} can be attributed and ` +
      "every post must have a creator. Fix: give the guild its prefix in the tunnel's Discord config (aichan for the AIchan Discord).",
    );
  }
  // Posted under the MASTER name when the operator merged this account under
  // one (creators.json, from the panel), else under its own username.
  const name = deps.creatorFor ? await deps.creatorFor(author) : author.username;
  const posterTag = poster.discordPosterTagFor(name, prefix);
  if (!posterTag) {
    return {
      refused:
        `no creator tag for Discord user ${author.id} (posting name ${JSON.stringify(name)}) under prefix ${JSON.stringify(prefix)}: ` +
        "the username is outside [a-z0-9_-] or the prefix is not a legal one. Not posted, because a post needs a creator and the tag " +
        "must match the name exactly for a claim to mean anything. Fix: rule on how such usernames are tagged.",
    };
  }
  const posterRef = `discord:${author.id}`;
  const permalink = `https://discord.com/channels/${channel.guild_id}/${channel.id}/${msg.id}`;
  const contentType = att.content_type || null;

  const plan = await imagePlan.planImage({ buffer: bytes, contentType, sender: posterRef }, {
    strip: stripGeneration,
    creatorTags: deps.extractCreatorTagsFromFields,
    findPostByMd5: (md5) => danbooru.findPostByMd5(md5),
    findByRawMd5: (rawMd5) => danbooru.findGenerationByRawMd5(rawMd5),
    maxCreatorTags: deps.config && deps.config.autotagger && deps.config.autotagger.max_creator_tags,
    log: (line) => log(line),
  }).catch((err) => { throw new Transient(`looking up ${JSON.stringify(att.filename)} on the booru failed: ${err.message}`); });

  if (plan.action === "refuse") return { refused: `${JSON.stringify(att.filename)} was not posted: ${plan.reason}` };
  if (plan.action === "duplicate") {
    log(`${permalink}: already on the booru as post #${plan.post && plan.post.id} (${plan.via} bytes); not reposted`);
    // The post it already is, so the panel can link and show it.
    return { alreadyQueued: true, ...(plan.post && plan.post.id ? { postId: plan.post.id } : {}), ...(plan.post && plan.post.md5 ? { md5: plan.post.md5 } : {}) };
  }

  let uploadMediaAssetId;
  try {
    const upload = await danbooru.createUploadFromBytes(plan.upload.buffer, att.filename, contentType);
    const completed = await danbooru.waitForUpload(upload.id);
    const uma = completed.upload_media_assets && completed.upload_media_assets[0];
    uploadMediaAssetId = uma && uma.id;
    if (!uploadMediaAssetId) throw new Error(`no upload media asset produced for upload ${upload.id}`);
  } catch (err) {
    if (err instanceof BooruRefusal && err.status >= 400 && err.status < 500) {
      return { refused: `the booru refused the upload of ${JSON.stringify(att.filename)}: ${err.message}` };
    }
    throw new Transient(`uploading ${JSON.stringify(att.filename)} failed: ${err.message}`);
  }

  // The tag sources, exactly as the Matrix path splits them (index.js).
  let derived = null;
  try {
    derived = await deps.autotag(plan.upload.buffer, deps.config);
  } catch (err) {
    log(`[autotag] fourier-spectrum unavailable, posting untagged: ${err.message}`);
  }
  const autoTags = (derived && derived.tags) || [];
  const creatorTags = plan.scraped.tags || [];
  const metaTags = plan.scraped.meta || [];
  const ocTags = plan.scraped.characters || [];
  const creatorSet = new Set(creatorTags);
  const autoSet = new Set(autoTags);
  const both = autoTags.filter((t) => creatorSet.has(t));
  const autoOnly = autoTags.filter((t) => !creatorSet.has(t));
  const creatorOnly = creatorTags.filter((t) => !autoSet.has(t));
  const publicTags = imagePlan.publicTagsFor({ autoTags, metaTags, ocTags, posterTag, aiGenerated: plan.aiGenerated });
  const rating = (derived && derived.rating) || (deps.config && deps.config.bridge && deps.config.bridge.default_rating) || "q";

  let post;
  try {
    post = await danbooru.createPost(uploadMediaAssetId, { rating, tagString: publicTags.join(" "), source: permalink });
  } catch (err) {
    if (err instanceof BooruDuplicate) {
      log(`${permalink}: the booru already holds these bytes as post #${err.duplicateOf}; not reposted`);
      return { alreadyQueued: true, ...(err.duplicateOf ? { postId: Number(err.duplicateOf) } : {}), md5: plan.upload.md5 };
    }
    if (err instanceof BooruRefusal && err.status === 422 && err.reason === "unpostable") {
      return { refused: `the booru holds these bytes (md5 ${plan.upload.md5}) under a post this account cannot see, deleted or jailed; not reposted` };
    }
    if (err instanceof BooruRefusal && err.status >= 400 && err.status < 500) {
      return { refused: `the booru refused the post for ${JSON.stringify(att.filename)}: ${err.message}` };
    }
    throw new Transient(`creating the post for ${JSON.stringify(att.filename)} failed: ${err.message}`);
  }

  // THE POST EXISTS. Everything from here is fail-soft and loud: a later
  // failure must not report the picture as lost, nor hold the watermark and
  // post it twice.
  const fields = plan.removed || {};
  if (Object.keys(fields).length) {
    const rec = imagePlan.generationRecord({ md5: plan.upload.md5, rawMd5: plan.rawMd5, poster: posterRef, removed: fields, source: "discord" });
    try {
      await danbooru.recordGenerationMetadata(rec.md5, { rawMd5: rec.rawMd5, source: rec.source, poster: rec.poster, fields: rec.fields });
    } catch (err) {
      log(
        `[generation] NOT RECORDED for post #${post.id} (md5 ${rec.md5}, ${Object.keys(rec.fields).length} field(s)): ${err.message}. ` +
        `The file on the booru is stripped either way; the text still exists in the original at ${permalink}.`,
      );
    }
  }
  try {
    await deps.categoriseArtist(posterTag);
  } catch (err) {
    log(`[poster] artist tag ${posterTag} not categorised for post #${post.id}: ${err.message}`);
  }
  const partition = { creator: creatorOnly, auto: autoOnly, both, meta: metaTags, oc: ocTags, spectrum: [...autoOnly, ...both, ...metaTags] };
  try {
    await danbooru.recordTagSources(post.id, partition);
  } catch (err) {
    log(`[tag-hub] recordTagSources failed for post #${post.id}: ${err.message}`);
  }
  log(`post #${post.id} from ${permalink} as ${posterTag} (${creatorOnly.length} creator[private] / ${autoOnly.length} auto / ${both.length} both / ${metaTags.length} meta)`);
  return { delivered: true, postId: post.id, md5: plan.upload.md5, stripped: Object.keys(fields).length > 0 };
}

module.exports = { booruDeliverer, postAttachment, POSTABLE };
