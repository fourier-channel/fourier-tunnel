// Replacing a picture: the creator EDITS their own picture message to carry a
// new file, and the booru post follows (operator, 2026-10-19: "a way for
// creators to upload new/higher quality versions of their posts, while still
// keeping track (though not necessarily keeping) of the original(s)"; "Creator
// only. The Matrix image link should just switch to the updated file url and
// a reload should be forced on that post. The creator can then decide to keep
// old copies of those posts, or allow them to expire after x period, at which
// point a collector grabs them to schedule for deletion.").
//
// WHY AN EDIT. A Matrix edit (m.replace) of the picture message IS "the link
// switches to the updated file url": the message itself now names the new
// mxc, every client draws the edited content, and a new URL is a reload no
// cache can stand in front of. No second picture lands in the room, and only
// the sender can edit a message -- which is the creator-only rule, enforced by
// Matrix before it reaches here and checked again below (an edit from anyone
// else is invalid and ignored).
//
// WHAT HAPPENS:
//   1. The original is the event the edit replaces: a local, unencrypted
//      picture by this same sender. The booru checks the sender against the
//      post's RECORDED creator too (FourierPostCreator).
//   2. The post is found from the original's bytes, as every duplicate is
//      (image-plan findPostForBytes): the booru says which post it is.
//   3. The new picture is made canonical (canon.js): stripped, stored once as
//      media/<md5>.<ext>, its generation data filed under ITS md5 with this
//      sender as poster, and an upload record on the booru. The replacement
//      points the post at THAT upload's media asset -- no file is sent and no
//      second object is written (memory every-image-exists-once).
//   4. The booru's PostReplacement row records the original (md5, size,
//      dimensions, source) and carries the creator's choice for the old file:
//      keep it, or let it expire for the booru's collector to schedule for
//      deletion. The choice rides on the edit as net.41chan.replace.old_file;
//      absent, it is "keep" -- nothing is lost by a default.
//   5. The new mxc gets the post's tag state and is reported as the post's
//      alias (pointRoom), and the creator tags are re-read from the NEW
//      prompt (rescan.js creatorPartition, replace_creator).
//
// An edit is never posted as a post of its own: handleImageEvent skips every
// m.replace, live and in replays (isEdit below).
//
// EVERY DEPENDENCY IS INJECTED (see avatar.js for why).
"use strict";

const { refusalReasons } = require("./bur");
const { creatorPartition } = require("./rescan");

const CHOICE_KEY = "net.41chan.replace";
// On her reply: a pointer to the booru's replacement record, which Technetium
// draws as a card where the creator can still change their mind.
const REPLACEMENT_KEY = "net.41chan.replacement";
const OLD_FILE_CHOICES = ["keep", "expire"];

/** Is this event content an edit (m.replace) of another event? Pure. */
function isEdit(content) {
  const rel = content && content["m.relates_to"];
  return !!(rel && rel.rel_type === "m.replace" && typeof rel.event_id === "string");
}

/**
 * The replacement an edit asks for, or null when it is not a picture edit.
 * Pure. `newContent` is m.new_content: the message as it now reads.
 */
function pictureEdit(content) {
  if (!isEdit(content)) return null;
  const nc = content["m.new_content"];
  if (!nc || nc.msgtype !== "m.image" || typeof nc.url !== "string") return null;
  const choice = content[CHOICE_KEY] && content[CHOICE_KEY].old_file;
  return {
    originalId: content["m.relates_to"].event_id,
    newContent: nc,
    oldFile: OLD_FILE_CHOICES.includes(choice) ? choice : "keep",
  };
}

/** The media id of a local mxc, or null. Pure. */
function localMediaId(url, domain) {
  const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(String(url || ""));
  return m && m[1] === domain ? m[2] : null;
}

function dims(w, h) {
  return Number.isInteger(w) && Number.isInteger(h) ? `${w}x${h}` : "unknown size";
}

/**
 * @param {object} event
 * @param {object} deps
 * @param {{enabled?: boolean} | undefined} deps.settings      config.bridge.replace
 * @param {string} deps.domain
 * @param {string} deps.botUserId
 * @param {(room: string, eventId: string) => Promise<object>} deps.readEvent   the ORIGINAL event, unedited
 * @param {(mediaId: string, opts: object) => Promise<object>} deps.canonicalize   canon.js
 * @param {(canonical: object, filename: string) => Promise<number>} deps.uploadMediaAssetFor
 * @param {(c: {rawMd5: string, strippedMd5: string}) => Promise<{post: object}|null>} deps.findPost
 * @param {(postId: number, body: object) => Promise<{status: number, data: any}>} deps.replacePost
 * @param {(postId: number) => Promise<object>} deps.getPost
 * @param {(room: string, mxc: string, post: object) => Promise<string>} deps.pointRoom
 * @param {(postId: number) => Promise<object>} deps.getTagProjection
 * @param {(postId: number, partition: object) => Promise<object>} deps.recordTagSources
 * @param {(removed: object, opts: object) => object} deps.creatorTags
 * @param {number} [deps.maxCreatorTags]
 * @param {(room: string, content: object) => Promise<void>} deps.sendMessage
 * @param {(postId: number) => Promise<Array<{room: string, mxc: string, content: object}>>} deps.mappedMxcs
 *        every tag state in her rooms naming the post
 * @param {(a: object) => Promise<{media_ids: string[], failed: object[]}>} deps.repoint   canon.js repoint
 * @param {(mediaIds: string[]) => Promise<boolean>} [deps.forget]   the gate forgets; absent, nothing is versioned
 * @param {(room: string, mxc: string, content: object, md5: string) => Promise<void>} deps.writeFileVersion
 * @param {(record: object) => void} deps.audit
 * @param {(line: string) => void} [deps.log]
 * @param {Set<string>} deps.seen
 * @returns {Promise<boolean>} true when the event was an edit and was consumed
 */
async function handleReplace(event, deps) {
  const { settings, domain, botUserId, audit, seen } = deps;
  const log = deps.log || ((l) => console.log(l));
  if (typeof audit !== "function") throw new TypeError("handleReplace requires audit(): replacing someone's picture needs a record");
  if (!(seen instanceof Set)) throw new TypeError("handleReplace requires seen: a Set owned by the caller, so a redelivered edit replaces once");

  const content = event.content || {};
  if (!isEdit(content)) return false;
  // From here every edit is consumed: an edit is never a new picture.
  const ask = pictureEdit(content);
  if (!ask || event.sender === botUserId) return true;
  if (event.event_id) {
    if (seen.has(event.event_id)) return true;
    seen.add(event.event_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  const room = event.room_id;
  const say = (body, extra) => deps.sendMessage(room, { msgtype: "m.notice", body, ...(extra || {}) });
  const record = (kind, extra) => audit({ kind, sender: event.sender, room, event: event.event_id, ...(extra || {}) });

  // 1. The original.
  let original;
  try {
    original = await deps.readEvent(room, ask.originalId);
  } catch (err) {
    log(`[replace] could not read ${ask.originalId}: ${err && err.message}`);
    record("replace_original_unread");
    await say("I could not read the picture you edited, so the booru still has the old version. Edit it again shortly to retry.");
    return true;
  }
  const oc = (original && original.content) || {};
  // An edit by anyone but the original's sender is invalid in Matrix; say
  // nothing, change nothing.
  if (!original || original.sender !== event.sender) {
    record("replace_not_sender", { original_sender: original && original.sender });
    return true;
  }
  const originalMedia = oc.msgtype === "m.image" && !oc.file ? localMediaId(oc.url, domain) : null;
  // A caption-only edit keeps the file: nothing to replace, nothing to say.
  if (!originalMedia || ask.newContent.url === oc.url) return true;
  const newMedia = !ask.newContent.file ? localMediaId(ask.newContent.url, domain) : null;
  if (!newMedia) {
    record("replace_new_not_local");
    await say("I cannot read the new picture (it is encrypted or not on this server), so the booru still has the old version.");
    return true;
  }
  if (!settings || settings.enabled !== true) {
    record("replace_off");
    await say("Replacing a picture on the booru is not switched on yet, so the booru still has the old version. Your message shows the new one.");
    return true;
  }

  // 2. The post, found from the original's bytes.
  let found;
  try {
    const was = await deps.canonicalize(originalMedia, { poster: original.sender });
    found = was && was.kind === "canonical" ? await deps.findPost({ rawMd5: was.raw_md5, strippedMd5: was.md5 }) : null;
  } catch (err) {
    log(`[replace] could not resolve the post for ${oc.url}: ${err && err.message}`);
    record("replace_post_unresolved");
    await say("I could not work out which booru post that picture is, so the booru still has the old version. Edit it again shortly to retry.");
    return true;
  }
  // Not on the booru: the edit is just an edit. Nothing to replace, and the
  // new picture is not posted -- an edit is never a new post.
  if (!found || !found.post) {
    record("replace_no_post");
    return true;
  }
  const postId = found.post.id;

  // 3. The new picture, made canonical.
  let canonical, umaId;
  try {
    canonical = await deps.canonicalize(newMedia, { withBytes: true, poster: event.sender });
    if (canonical.kind === "refused") {
      log(`[replace] new picture ${ask.newContent.url} refused by the stripper: ${canonical.reason}`);
      record("replace_new_refused", { post: postId });
      await say(`I could not safely remove the generation data from the new picture, so booru post #${postId} keeps the old version.`);
      return true;
    }
    if (canonical.kind !== "canonical") {
      record("replace_new_not_image", { post: postId });
      await say(`The new file is not an image the booru takes, so booru post #${postId} keeps the old version.`);
      return true;
    }
    if (canonical.md5 === found.post.md5) {
      record("replace_same_file", { post: postId });
      return true;
    }
    umaId = await deps.uploadMediaAssetFor(canonical, ask.newContent.filename || ask.newContent.body || "image");
  } catch (err) {
    log(`[replace] could not prepare ${ask.newContent.url}: ${err && err.message}`);
    record("replace_new_unprepared", { post: postId });
    await say(`I could not get the new picture onto the booru, so post #${postId} keeps the old version. Edit it again shortly to retry.`);
    return true;
  }

  // 4. The replacement.
  let res;
  try {
    res = await deps.replacePost(postId, {
      uploadMediaAssetId: umaId,
      finalSource: ask.newContent.url,
      onBehalfOf: event.sender,
      oldFile: ask.oldFile,
    });
  } catch (err) {
    log(`[replace] the booru did not answer for post #${postId}: ${err && err.message}`);
    record("replace_unreachable", { post: postId });
    await say(`The booru did not answer, so post #${postId} keeps the old version. Edit it again shortly to retry.`);
    return true;
  }
  const status = res ? res.status : 0;
  const data = res && res.data;
  if (!(status >= 200 && status < 300)) {
    record("replace_refused", { post: postId, status });
    if (status === 403) {
      log(`[replace] post #${postId}: the booru refused ${event.sender} as its creator (403) ${JSON.stringify(data && { error: data.error, fix: data.fix })}`);
      await say(`The booru does not record you as the creator of post #${postId}, so it keeps the old version.`);
    } else if (status === 422 || status === 400) {
      const reasons = refusalReasons(data);
      await say(reasons.length
        ? `The booru refused the new version of post #${postId}, so it keeps the old one:\n${reasons.map((r) => `- ${r}`).join("\n")}`
        : `The booru refused the new version of post #${postId} without saying why, so it keeps the old one.`);
    } else if (status === 404) {
      log("[replace] the booru answered 404 on the replacement route: it does not take creator replacements yet; turn bridge.replace.enabled off until it does");
      await say(`The booru does not take replacements yet, so post #${postId} keeps the old version.`);
    } else {
      log(`[replace] unexpected answer from the booru for post #${postId} (${status})`);
      await say(`The booru gave an answer I did not expect, so I cannot say whether post #${postId} has the new version. An admin can check its replacement history.`);
    }
    return true;
  }
  record("replace_done", { post: postId, old_md5: data && data.old_md5, md5: data && data.md5, old_file: ask.oldFile });

  // 5. EVERYWHERE (operator, 2026-10-19: a repost of the same picture "gets
  // replaced everywhere"). Every media id that carried the old file -- this
  // message's original, other people's reposts, merged duplicates -- is
  // re-pointed at the new file (canon.js repoint), which also leaves the
  // record the booru's collector reads. Then the gate forgets what it cached
  // about them, and only THEN do the rooms' tag states get the file version
  // Technetium reloads by: a version written before the gate forgot would be
  // fetched as the old bytes and kept under the new URL for a year.
  const missing = [];
  const newMd5 = canonical.md5;
  let everywhere = { repointed: 0, failed: 0, versioned: 0, forgotten: false };
  try {
    const mapped = (await deps.mappedMxcs(postId)) || [];
    const fromBooru = Array.isArray(data && data.mxcs) ? data.mxcs : [];
    const ids = [originalMedia, ...mapped.map((m) => localMediaId(m.mxc, domain)), ...fromBooru.map((u) => localMediaId(u, domain))]
      .filter((id) => id && id !== newMedia);
    const rec = await deps.repoint({ mediaIds: ids, to: canonical, toMediaId: newMedia, postId, oldMd5: (data && data.old_md5) || found.post.md5 });
    everywhere.repointed = rec.media_ids.length;
    everywhere.failed = rec.failed.length;
    if (rec.failed.length) log(`[replace] post #${postId}: ${rec.failed.length} media id(s) not re-pointed: ${JSON.stringify(rec.failed)}`);
    if (typeof deps.forget === "function" && rec.media_ids.length) {
      try {
        everywhere.forgotten = (await deps.forget(rec.media_ids)) === true;
      } catch (err) {
        log(`[replace] post #${postId}: the gate did not forget the re-pointed ids: ${err && err.message}`);
      }
    }
    if (everywhere.forgotten) {
      const done = new Set(rec.media_ids);
      for (const m of mapped) {
        if (!done.has(localMediaId(m.mxc, domain))) continue;
        try {
          await deps.writeFileVersion(m.room, m.mxc, m.content, newMd5);
          everywhere.versioned++;
        } catch (err) {
          log(`[replace] post #${postId}: file version not written for ${m.mxc} in ${m.room}: ${err && err.message}`);
        }
      }
    }
  } catch (err) {
    log(`[replace] post #${postId}: copies not re-pointed: ${err && err.message}`);
    everywhere.failed = -1;
  }
  if (everywhere.failed !== 0) missing.push("every copy of the old picture");
  else if (!everywhere.forgotten && everywhere.repointed > 0) missing.push("other copies, which switch within a day");

  try {
    const post = await deps.getPost(postId);
    const pointed = await deps.pointRoom(room, ask.newContent.url, post);
    if (pointed !== "posted") missing.push("its tags on the new picture in this room");
  } catch (err) {
    log(`[replace] post #${postId}: room not pointed at the new picture: ${err && err.message}`);
    missing.push("its tags on the new picture in this room");
  }
  try {
    const owner = /^@([^:]+):/.exec(event.sender);
    const scraped = deps.creatorTags(canonical.removed || {}, { max: deps.maxCreatorTags, owner: owner ? owner[1] : null }) || {};
    let projection = null;
    try {
      projection = await deps.getTagProjection(postId);
    } catch (err) {
      log(`[replace] post #${postId}: projection unread, creator tags rebuilt without the autotagger's rows: ${err && err.message}`);
    }
    await deps.recordTagSources(postId, creatorPartition(scraped, projection).partition);
  } catch (err) {
    log(`[replace] post #${postId}: creator tags not re-read from the new picture: ${err && err.message}`);
    missing.push("the creator tags from the new picture's prompt");
  }

  const was = dims(data && data.old_image_width, data && data.old_image_height);
  const now = dims(data && data.image_width, data && data.image_height);
  const kept = ask.oldFile === "expire"
    ? "The old version will expire and be collected for deletion."
    : "The old version is kept on record.";
  const copies = everywhere.repointed > 1 ? ` All ${everywhere.repointed} copies of it now show the new version.` : "";
  await say(
    `Booru post #${postId} now has the new version (${was} -> ${now}).${copies} ${kept}` +
      (missing.length ? ` Not yet updated: ${missing.join(" and ")}; an admin can run !rescan on the new picture.` : ""),
    Number.isInteger(data && data.id) ? { [REPLACEMENT_KEY]: { id: data.id, post_id: postId } } : undefined,
  );
  return true;
}

module.exports = { handleReplace, isEdit, pictureEdit, localMediaId, CHOICE_KEY, REPLACEMENT_KEY, OLD_FILE_CHOICES };
