// "!bur <reason>" + script lines: file a bulk update request on the booru for
// someone holding Voice or higher in the BUR room (operator, 2026-10-19).
//
// WHAT SHE DOES AND DOES NOT DO. She FILES. The booru's own rules decide what a
// script may say (alias, imply, update, rename, nuke, category, ...) and what
// level approving it needs -- ADMIN for nearly every line on this fork -- and
// an admin approves it, from the BUR card Technetium draws under her reply or
// from the booru's own BUR page. Her booru account never approves anything:
// approval runs as the booru's system user, and a bot that could approve on a
// Voice user's say-so would make Voice an admin.
//
// THE GATE IS ONE ROOM'S POWER LEVEL, read fresh for every command. Voice is
// PL 25 (Technetium's '+'), and that honorific in THIS room is the whole
// trust grant: give someone a + here and they may file, take it away and they
// cannot. A cached copy would let a revoked + keep filing until a restart.
//
// THE REPLY CARRIES THE BUR'S ID UNDER net.41chan.bur, a POINTER and nothing
// else -- the same shape as net.41chan.media.tags' post_id. The card reads the
// BUR live from the booru as the viewer, so its status is never a copy that
// went stale. The body says the same thing in words for anything that does not
// draw the card.
//
// NO ADDRESSES INTO THE ROOM (memory bots-never-post-addresses). The booru's
// validation messages are words about the script and are relayed, through
// scrub(); everything else -- statuses, raw errors, the remedy -- goes to the
// journal and the audit log.
//
// EVERY DEPENDENCY IS INJECTED (see avatar.js for why).
"use strict";

const COMMAND = "!bur";
// Voice. Technetium's members.ts maps 25 to '+'; the room's own power levels
// decide who holds it.
const DEFAULT_LEVEL = 25;
const CONTENT_KEY = "net.41chan.bur";

const USAGE =
  "Usage: !bur <why, on the first line>\n" +
  "then one script line per line, for example:\n" +
  "  alias old_tag -> new_tag\n" +
  "  update some_tag -> another_tag\n" +
  "The booru's own rules decide what a line may do; an admin approves it.";

/**
 * Split a !bur message. Null when the message is not a !bur at all.
 *
 * The first line is the command and the reason; every following non-blank line
 * is a script line. A Markdown code fence around the script is dropped, since
 * people paste scripts that way and a fence is never a script line.
 *
 * @returns {null | {reason: string, lines: string[]}}
 */
function parseBur(body) {
  if (typeof body !== "string") return null;
  const all = body.replace(/\r\n?/g, "\n").split("\n");
  const head = all[0].trim();
  if (head !== COMMAND && !head.startsWith(COMMAND + " ")) return null;
  const reason = head.slice(COMMAND.length).trim();
  const lines = all
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !/^```/.test(l));
  return { reason, lines };
}

/**
 * The sender's power level in a room, as Matrix decides it.
 *
 * users[sender], else users_default, else 0. In room version 12 and later the
 * room's creators hold unlimited power and are never listed in `users`, so the
 * create event is consulted too -- without it the operator, as a creator,
 * would read as level 0 in a room they own.
 */
function senderLevel(powerLevels, createContent, createSender, sender) {
  const create = createContent || {};
  const version = Number.parseInt(String(create.room_version || "1"), 10);
  if (Number.isFinite(version) && version >= 12) {
    const creators = [createSender, ...(Array.isArray(create.additional_creators) ? create.additional_creators : [])];
    if (creators.includes(sender)) return Infinity;
  }
  const pl = powerLevels || {};
  const users = pl.users || {};
  if (Object.prototype.hasOwnProperty.call(users, sender)) return Number(users[sender]) || 0;
  return Number(pl.users_default) || 0;
}

// Anything that looks like an address, gone. Booru validation messages name
// tags and lines, not hosts, but a message is foreign text and the rule is
// that no bot posts an address, so it is enforced on the way out rather than
// assumed of the source. A clock time ("01:54") is not a host:port.
function scrub(text) {
  return String(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address removed]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address removed]")
    .replace(/\b(?=[a-z0-9-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/gi, "[address removed]")
    .replace(/\b(?:localhost|[a-z][a-z0-9-]*-\d+):\d{2,5}\b/gi, "[address removed]");
}

/**
 * The booru's reasons for refusing a script, as sentences.
 *
 * Three shapes are read, newest first: a per-line `errors` array
 * [{line, text, reason}] (chanbooru's planned 422 shape), a Rails `errors`
 * hash {field: [messages]}, and a single `message`. Unknown shapes give [].
 */
function refusalReasons(data) {
  if (!data || typeof data !== "object") return [];
  const out = [];
  if (Array.isArray(data.errors)) {
    for (const e of data.errors) {
      if (!e || typeof e !== "object" || typeof e.reason !== "string") continue;
      out.push(Number.isInteger(e.line) ? `line ${e.line}: ${e.reason}` : e.reason);
    }
  } else if (data.errors && typeof data.errors === "object") {
    for (const [field, msgs] of Object.entries(data.errors)) {
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        if (typeof m !== "string") continue;
        out.push(field === "base" || field === "script" ? m : `${field} ${m}`);
      }
    }
  }
  if (!out.length && typeof data.message === "string" && data.message.trim()) out.push(data.message.trim());
  return out.map(scrub);
}

function localpart(mxid) {
  const m = /^@([^:]+)/.exec(String(mxid));
  return m ? m[1] : String(mxid);
}

/**
 * Handle one room message. Returns true when the event was a !bur and was
 * consumed (answered or deliberately ignored), false when it was not one.
 *
 * @param {object} event
 * @param {object} deps
 * @param {{room?: string, power_level?: number} | undefined} deps.settings  config.bridge.bur
 * @param {string} deps.botUserId
 * @param {(room: string) => Promise<object>} deps.readPowerLevels   fresh, every call
 * @param {(room: string) => Promise<{content: object, sender: string}>} deps.readCreate
 * @param {(body: {script: string, title: string, reason: string}) => Promise<{status: number, data: any}>} deps.createBur
 * @param {(room: string, content: object) => Promise<void>} deps.sendMessage
 * @param {(record: object) => void} deps.audit
 * @param {(line: string) => void} [deps.log]
 * @param {Set<string>} deps.seen   event ids already handled, caller-owned
 */
async function handleBurCommand(event, deps) {
  const { settings, botUserId, readPowerLevels, readCreate, createBur, sendMessage, audit, seen } = deps;
  const log = deps.log || ((l) => console.log(l));
  if (typeof audit !== "function") throw new TypeError("handleBurCommand requires audit(): a filing on someone's behalf needs a record");
  if (!(seen instanceof Set)) throw new TypeError("handleBurCommand requires seen: a Set owned by the caller, so a redelivered event files once");

  const content = event.content || {};
  const parsed = parseBur(content.body);
  if (!parsed) return false;
  // An edit of a !bur is not a second request, and her own words are never one.
  const rel = content["m.relates_to"];
  if (rel && rel.rel_type === "m.replace") return true;
  if (event.sender === botUserId) return true;
  // An appservice transaction can be delivered twice; a filing must not be.
  if (event.event_id) {
    if (seen.has(event.event_id)) return true;
    seen.add(event.event_id);
    if (seen.size > 1000) seen.delete(seen.values().next().value);
  }

  const room = event.room_id;
  const say = (body, extra) => sendMessage(room, { msgtype: "m.notice", body, ...(extra || {}) });

  if (!settings || typeof settings.room !== "string" || !settings.room) {
    log("[bur] refused: bridge.bur.room is not set in config.yaml; set it to the BUR room's id to turn !bur on");
    audit({ kind: "bur_unconfigured", sender: event.sender, room });
    await say("BUR filing is not switched on yet.");
    return true;
  }
  if (room !== settings.room) {
    audit({ kind: "bur_wrong_room", sender: event.sender, room });
    await say("I file BURs in #botsbotsbots only. Ask there.");
    return true;
  }

  const need = Number.isFinite(settings.power_level) ? settings.power_level : DEFAULT_LEVEL;
  let have;
  try {
    const [pl, create] = await Promise.all([readPowerLevels(room), readCreate(room)]);
    have = senderLevel(pl, create && create.content, create && create.sender, event.sender);
  } catch (err) {
    log(`[bur] could not read this room's power levels: ${err && err.message}`);
    audit({ kind: "bur_level_unread", sender: event.sender, room });
    await say("I could not read this room's power levels, so I cannot tell whether you may file. Nothing was filed; try again shortly.");
    return true;
  }
  if (!(have >= need)) {
    audit({ kind: "bur_denied_level", sender: event.sender, room, have, need });
    await say("Filing a BUR needs Voice (+) or higher in this room. Nothing was filed.");
    return true;
  }

  if (!parsed.reason || !parsed.lines.length) {
    await say(USAGE);
    return true;
  }

  const who = localpart(event.sender);
  // No title (and never forum_topic_id): the forum is retired, and the booru
  // refuses a request attached to it (chanbooru ca05bee43).
  const body = {
    script: parsed.lines.join("\n"),
    reason: `${parsed.reason}\n\nRequested by ${event.sender} in #botsbotsbots (Matrix event ${event.event_id || "unknown"}).`,
  };
  let res;
  try {
    res = await createBur(body);
  } catch (err) {
    log(`[bur] the booru did not answer the filing: ${err && err.message}`);
    audit({ kind: "bur_unreachable", sender: event.sender, room });
    await say("The booru did not answer, so nothing was filed. Try again shortly.");
    return true;
  }

  const data = res && res.data;
  if (res && res.status >= 200 && res.status < 300 && data && Number.isInteger(data.id)) {
    audit({ kind: "bur_filed", sender: event.sender, room, bur: data.id, lines: parsed.lines.length });
    const n = parsed.lines.length;
    await say(
      `Filed BUR #${data.id} for ${who}: ${n} line${n === 1 ? "" : "s"}. ` +
        "Nothing changes until an admin approves it.",
      { [CONTENT_KEY]: { id: data.id } },
    );
    return true;
  }

  const status = res ? res.status : 0;
  audit({ kind: "bur_refused", sender: event.sender, room, status });
  if (status === 422 || status === 400) {
    // The booru's sentence first, then the lines it names (chanbooru
    // ca05bee43: 422 {message, errors:[{line, text, reason}]}).
    const sentence = data && typeof data.message === "string" && data.message.trim() ? scrub(data.message.trim()) : null;
    const lines = data && Array.isArray(data.errors)
      ? data.errors.filter((e) => e && typeof e.reason === "string").map((e) => scrub(Number.isInteger(e.line) ? `line ${e.line}: ${e.reason}` : e.reason))
      : [];
    const reasons = sentence || lines.length ? lines : refusalReasons(data);
    log(`[bur] the booru refused the script (${status}): ${JSON.stringify({ sentence, reasons })}`);
    await say(
      sentence || reasons.length
        ? `The booru refused that BUR, so nothing was filed.${sentence ? ` ${sentence}` : ""}${reasons.length ? `\n${reasons.map((r) => `- ${r}`).join("\n")}` : ""}`
        : "The booru refused that BUR without saying why, so nothing was filed.",
    );
  } else if (status === 429) {
    log("[bur] the booru rate-limited the filing (429)");
    await say("The booru is limiting how fast I can file BURs. Nothing was filed; try again in a minute.");
  } else if (status === 401 || status === 403) {
    log(`[bur] the booru refused my account (${status}); check danbooru.username/api_key and that the account may create BURs (Member or higher, and an API key permitted bulk_update_requests:create)`);
    await say("The booru would not let my account file this, so nothing was filed. An admin has been left a note in my log.");
  } else {
    log(`[bur] unexpected answer from the booru (${status})`);
    await say("The booru gave an answer I did not expect, so I cannot say whether it was filed. An admin can check the booru's BUR list.");
  }
  return true;
}

module.exports = { handleBurCommand, parseBur, senderLevel, refusalReasons, scrub, CONTENT_KEY, DEFAULT_LEVEL };
